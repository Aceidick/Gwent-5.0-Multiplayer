"use strict"

// ═══════════════════════════════════════════════════════════════════
// netplay.js — Lockstep deterministic online multiplayer layer
// for Gwent 5.0.  Loaded after gwent.js.  When mp.active is false every
// override degrades to the original behaviour, so single-player and
// hot-seat modes are unaffected.
// ═══════════════════════════════════════════════════════════════════

// ── Row perspective translation ───────────────────────────────────
// board.row[0..2] = opponent, [3..5] = local player (player_me).
// Wire references are relative to the SENDER: {o:"me"|"op"|"weather",
// r:"close"|"ranged"|"siege"|"weather"}.

function destToWire(row) {
    if (row === weather) return { o: "weather", r: "weather" };
    let idx = board.row.indexOf(row);
    if (idx < 0) return { o: "me", r: "close" };
    let isSelf = idx >= 3;                       // player_me's rows
    let r = (idx % 3 === 0) ? "close" : (idx % 3 === 1) ? "ranged" : "siege";
    return { o: isSelf ? "me" : "op", r: r };
}

function destFromWire(ref) {
    if (ref.o === "weather") return weather;
    let r = ref.r === "close" ? 0 : ref.r === "ranged" ? 1 : 2;
    // Sender is always player_op on the receiving side.
    // "me" = sender's own rows (0-2), "op" = sender's opponent (3-5).
    let offset = (ref.o === "me") ? 0 : 3;
    return board.row[offset + r];
}

// ── MPSession ─────────────────────────────────────────────────────
// Manages the multiplayer session state, message routing, and desync
// detection.

var mp = {
    active: false,
    role: null,          // "host" | "guest"
    seed: null,
    _shuffleRole: null,  // set during deck initialization
    _queue: [],          // received messages awaiting consumption
    _waiters: [],        // pending next() calls
    _lastAction: null,   // captured action for local player
    _desync: false,

    activate(role) {
        this.active = true;
        this.role = role;
        this._queue = [];
        this._waiters = [];
        this._desync = false;
    },

    deactivate() {
        this.active = false;
        this.role = null;
        this._shuffleRole = null;
    },

    send(msg) {
        Net.send(msg);
    },

    // Await a message whose type matches one of the given strings.
    // If a matching message is already queued, returns immediately.
    next(...types) {
        return new Promise(resolve => {
            for (let i = 0; i < this._queue.length; i++) {
                if (types.includes(this._queue[i].t)) {
                    resolve(this._queue.splice(i, 1)[0]);
                    return;
                }
            }
            this._waiters.push({ types, resolve });
        });
    },

    // Called by Net.onMessage for every payload from the peer.
    route(msg) {
        if (msg.t === "sum") {
            this._checkChecksum(msg.h);
            return;
        }
        for (let i = 0; i < this._waiters.length; i++) {
            if (this._waiters[i].types.includes(msg.t)) {
                this._waiters[i].resolve(msg);
                this._waiters.splice(i, 1)[0];
                return;
            }
        }
        this._queue.push(msg);
    },

    // Simple game-state checksum for desync detection.
    checksum() {
        let p = [];
        for (let pl of [player_me, player_op]) {
            p.push(pl.total, pl.health, pl.passed ? 1 : 0,
                   pl.hand.cards.length, pl.deck.cards.length);
        }
        for (let i = 0; i < 6; i++)
            p.push(board.row[i].total, board.row[i].cards.length);
        p.push(weather.cards.length, game.roundCount);
        return p.join(",");
    },

    _checkChecksum(remote) {
        if (this._desync) return;
        let local = this.checksum();
        if (local !== remote) {
            this._desync = true;
            console.error("[netplay] DESYNC detected!");
            console.error("Local:  " + local);
            console.error("Remote: " + remote);
            if (typeof ui !== "undefined" && ui.notification) {
                ui.notification("desync", 3000);
            }
        }
    },

    // Send current checksum to peer (called after each turn ends).
    sendChecksum() {
        if (this.active && !this._desync)
            this.send({ t: "sum", h: this.checksum() });
    }
};

// ── ControllerRemote ──────────────────────────────────────────────
// Drives the remote (opponent) player by replaying wire messages.
// Does NOT extend ControllerAI so that `instanceof ControllerAI` checks
// in abilities.js take the human (carousel/popup) path — the carousel
// and popup hooks below intercept those and resolve them via the wire.

class ControllerRemote {
    constructor(player) {
        this.player = player;
        this.isRemote = true;
        this._wireRow = null;
        this._wireTargetIndex = -1;
    }

    async startTurn(player) {
        if (mp._desync) return;
        const msg = await mp.next("play", "pass", "leader");

        if (msg.t === "pass") {
            await player.passRound();
        } else if (msg.t === "leader") {
            await player.activateLeader();
            // Some leader abilities (meve_princess, cyrus_hemmelfart,
            // alzur_maker, anna_henrietta_duchess) require a secondary
            // action (row or card selection) that is NOT handled by the
            // ability itself.  If the turn hasn't ended, wait for the
            // follow-up wire message and replay it.
            if (game.currPlayer === player) {
                await this._handleLeaderFollowUp(player);
            }
        } else if (msg.t === "play") {
            const card = player.hand.cards[msg.i];
            if (!card) {
                console.error("[netplay] Card not found at hand index " + msg.i);
                return;
            }
            this._wireRow = msg.d ? destFromWire(msg.d) : null;
            this._wireTargetIndex = msg.ti !== undefined ? msg.ti : -1;
            await this._dispatch(card);
        }
    }

    // Handles the secondary action after a leader ability that doesn't
    // end the turn (e.g., meve_princess needs a row, alzur_maker needs a
    // card on the board, anna_henrietta_duchess needs a row for the hero,
    // francesca_pureblood/hope need multiple card+row rearrangements).
    async _handleLeaderFollowUp(player) {
        // Loop until the turn actually ends (handles multi-step abilities
        // like board rearrangement, and failed leader activations that
        // fall back to normal play/pass).
        while (game.currPlayer === player && !mp._desync) {
            const msg = await mp.next("lrow", "lcard", "play", "rearr",
                                       "pass", "leader");
            if (msg.t === "lrow") {
                // Leader row selection (meve_princess, cyrus_hemmelfart, etc.)
                const row = destFromWire(msg.d);
                await ui.selectRow(row);
            } else if (msg.t === "lcard") {
                // Leader card selection on the board (alzur_maker)
                const row = destFromWire(msg.d);
                const targetIndex = msg.ti !== undefined ? msg.ti : -1;
                if (row && targetIndex >= 0 && row.cards[targetIndex]) {
                    this._wireRow = row;
                    this._wireTargetIndex = targetIndex;
                    ui.lastRow = row;  // selectCard reads this.lastRow
                    await ui.selectCard(row.cards[targetIndex]);
                }
            } else if (msg.t === "play") {
                // Card added to hand by leader ability (anna_henrietta_duchess)
                // OR normal card play after failed leader activation
                const card = player.hand.cards[msg.i];
                if (card) {
                    this._wireRow = msg.d ? destFromWire(msg.d) : null;
                    this._wireTargetIndex = msg.ti !== undefined ? msg.ti : -1;
                    await this._dispatch(card);
                }
            } else if (msg.t === "rearr") {
                // Board rearrangement: select source card, then destination row
                const srcRow = destFromWire(msg.src);
                const srcIndex = msg.si !== undefined ? msg.si : -1;
                const dstRow = destFromWire(msg.dst);
                if (srcRow && srcIndex >= 0 && srcRow.cards[srcIndex]) {
                    ui.lastRow = srcRow;
                    await ui.selectCard(srcRow.cards[srcIndex]);
                    await ui.selectRow(dstRow);
                }
            } else if (msg.t === "pass") {
                await player.passRound();
            } else if (msg.t === "leader") {
                // Leader re-activation after previous failure
                await player.activateLeader();
            }
        }
    }

    async _dispatch(card) {
        const p = this.player;

        // Special cards that don't go to a row
        if (card.faction === "special" && card.abilities.includes("scorch"))
            return await p.playScorch(card);
        if (card.faction === "special" && card.abilities.includes("cull"))
            return await p.playCull(card);
        if (card.faction === "special" && card.abilities.includes("cintra_slaughter"))
            return await p.playSlaughterCintra(card);
        if (card.faction === "special" && card.abilities.includes("seize"))
            return await p.playSeize(card);
        if (card.faction === "special" && card.abilities.includes("bank"))
            return await p.playBank(card);
        if (card.faction === "special" && card.abilities.includes("skellige_fleet"))
            return await p.playSkelligeFleet(card);
        if (card.faction === "special" && card.abilities.includes("royal_decree"))
            return await p.playRoyalDecree(card);
        if (card.faction === "special" && card.abilities.includes("veles"))
            return await p.playVeles(card);
        if (card.faction === "special" && card.abilities.includes("chernobog"))
            return await p.playChernobog(card);
        if (card.faction === "special" && card.abilities.includes("perun"))
            return await p.playPerun(card);
        if (card.faction === "special" && card.abilities.includes("svarog"))
            return await p.playSvarog(card);
        if (card.faction === "special" && card.abilities.includes("morana"))
            return await p.playMorana(card);
        if (card.faction === "special" && card.abilities.includes("zoria"))
            return await p.playZoria(card);
        if (card.faction === "special" && card.abilities.includes("stribog"))
            return await p.playStribog(card);
        if (card.faction === "special" && card.abilities.includes("devana"))
            return await p.playDevana(card);
        if (card.faction === "special" && card.abilities.includes("triglav"))
            return await p.playTriglav(card);

        // Knockback needs the wire row passed to the ability
        if (card.faction === "special" && card.abilities.includes("knockback"))
            return await p.playCardAction(card, async () =>
                await ability_dict["knockback"].activated(card, this._wireRow));

        // Decoy: target a unit on the board
        if (card.abilities.includes("decoy")) {
            const row = this._wireRow;
            const targetCard = (row && this._wireTargetIndex >= 0)
                ? row.cards[this._wireTargetIndex] : null;
            if (targetCard) {
                targetCard.decoyTarget = true;
                setTimeout(() => board.toHand(targetCard, row), 1000);
            }
            return await p.playCardToRow(card, row);
        }

        // alzur_maker: destroy a unit and summon a token
        if (card.abilities.includes("alzur_maker")) {
            const row = this._wireRow;
            const targetCard = (row && this._wireTargetIndex >= 0)
                ? row.cards[this._wireTargetIndex] : null;
            if (targetCard) {
                await p.playCardAction(card, async () => {
                    await board.toGrave(targetCard, row);
                    let target = new Card(ability_dict["alzur_maker"].target,
                        card_dict[ability_dict["alzur_maker"].target], card.holder);
                    await board.addCardToRow(target, target.row, card.holder);
                });
            } else {
                await p.playCardToRow(card, this._wireRow);
            }
            return;
        }

        // anna_henrietta_duchess: remove a horn from the selected row
        if (card.abilities.includes("anna_henrietta_duchess")) {
            const row = this._wireRow;
            await p.playCardAction(card, async () => {
                if (row) {
                    let horn = row.special.cards.filter(c => c.abilities.includes("horn"))[0];
                    if (horn)
                        await board.toGrave(horn, row);
                }
            });
            return;
        }

        // meve_princess / carlo_varese: scorch the selected row
        if (card.abilities.includes("meve_princess") || card.abilities.includes("carlo_varese")) {
            const row = this._wireRow;
            await p.playCardAction(card, async () => {
                if (row && !game.scorchCancelled)
                    await row.scorch();
            });
            return;
        }

        // cyrus_hemmelfart: create a dimeritium shackles on the selected row
        if (card.abilities.includes("cyrus_hemmelfart")) {
            const row = this._wireRow;
            await p.playCardAction(card, async () => {
                if (row) {
                    let new_card = new Card("spe_dimeritium_shackles",
                        card_dict["spe_dimeritium_shackles"], card.holder);
                    await board.moveTo(new_card, row);
                }
            });
            return;
        }

        // spe_lyria_rivia_morale: move card to row (same as default)
        // — handled by default case below

        // Default: play card to the wire row (or auto-determine for
        // weather / non-agile cards where row is implicit)
        if (this._wireRow) {
            return await p.playCardToRow(card, this._wireRow);
        }
        return await p.playCard(card);
    }

    // Expose AI-controller interface so getAIController() and weight
    // functions in abilities.js can call them (used for programmatic
    // decisions during ability resolution, not player choices).
    getWeights(cards) { return cards.map(c => ({ weight: 0, card: c })); }
    getHighestWeightCard(cards) { return cards[0] || null; }
    getLowestWeightCard(cards) { return cards[0] || null; }
}

// ── RNG overrides (active only when mp.active) ───────────────────

var _origRandomInt = randomInt;
randomInt = function(n) {
    if (typeof mp !== "undefined" && mp.active) {
        if (mp._shuffleRole)
            return GameRNG.deckFor(mp._shuffleRole).int(n);
        return GameRNG.game.int(n);
    }
    return _origRandomInt(n);
};

var _origMathRandom = Math.random;
Math.random = function() {
    if (typeof mp !== "undefined" && mp.active) {
        if (mp._shuffleRole)
            return GameRNG.deckFor(mp._shuffleRole).float();
        return GameRNG.game.float();
    }
    return _origMathRandom.call(Math);
};

// ── UI hooks ──────────────────────────────────────────────────────
// Capture local player choices and replay remote player choices.

(function installHooks() {

    // ── selectRow: capture local card play ──
    const _origSelectRow = ui.selectRow;
    ui.selectRow = async function(row, isSpecial) {
        if (mp.active && !mp._desync && game.currPlayer === player_me
                && this.previewCard) {
            const card = this.previewCard;
            // Skip decoy / alzur_maker (handled in selectCard)
            if (!card.abilities.includes("decoy")
                    && !card.abilities.includes("alzur_maker")) {
                const handIndex = player_me.hand.cards.indexOf(card);
                if (this.underRearrangement) {
                    // Board rearrangement: send source card + destination row
                    const srcRow = card.currentLocation;
                    const srcIndex = srcRow ? srcRow.cards.indexOf(card) : -1;
                    mp.send({ t: "rearr",
                              src: destToWire(srcRow), si: srcIndex,
                              dst: destToWire(row) });
                } else if (handIndex >= 0) {
                    mp.send({ t: "play", i: handIndex, d: destToWire(row) });
                } else {
                    // Card is not in hand (leader ability) — send as lrow
                    mp.send({ t: "lrow", d: destToWire(row) });
                }
            }
        }
        return _origSelectRow.call(this, row, isSpecial);
    };

    // ── selectCard: capture decoy / alzur_maker target ──
    const _origSelectCard = ui.selectCard;
    ui.selectCard = async function(card) {
        if (mp.active && !mp._desync && game.currPlayer === player_me
                && this.previewCard) {
            const pCard = this.previewCard;
            if ((pCard.abilities.includes("decoy")
                    || pCard.abilities.includes("alzur_maker"))
                    && !card.holder.hand.cards.includes(card)) {
                const handIndex = player_me.hand.cards.indexOf(pCard);
                const row = this.lastRow;
                const targetIndex = row ? row.cards.indexOf(card) : -1;
                if (handIndex >= 0) {
                    // Card is in hand (decoy / alzur_maker card)
                    mp.send({ t: "play", i: handIndex, d: destToWire(row),
                              ti: targetIndex });
                } else {
                    // Card is a leader (alzur_maker leader) — send as lcard
                    mp.send({ t: "lcard", d: destToWire(row), ti: targetIndex });
                }
            }
        }
        return _origSelectCard.call(this, card);
    };

    // ── queueCarousel: intercept for remote player sub-choices ──
    const _origQueueCarousel = ui.queueCarousel;
    ui.queueCarousel = async function(container, count, action, predicate,
            bSort, bQuit, title) {
        if (!mp.active || mp._desync)
            return _origQueueCarousel.call(this, container, count, action,
                predicate, bSort, bQuit, title);

        // Determine if this carousel is for the remote player.
        let isRemote = false;
        if (game.currPlayer === player_op) {
            isRemote = true;
        } else if (!game.currPlayer) {
            // During initial redraw — check container ownership by reference
            isRemote = (container === player_op.hand
                    || container === player_op.grave
                    || container === player_op.deck);
        }

        if (isRemote) {
            for (let i = 0; i < count; i++) {
                const msg = await mp.next("pick");
                await action(container, msg.i);
            }
            return;
        }

        // Local player — wrap action to capture the choice
        const wrapped = async function(c, idx) {
            mp.send({ t: "pick", i: idx });
            await action(c, idx);
        };
        return _origQueueCarousel.call(this, container, count, wrapped,
            predicate, bSort, bQuit, title);
    };

    // ── popup: intercept for remote player binary choices ──
    const _origPopup = ui.popup;
    ui.popup = async function(yesName, yes, noName, no, title, description) {
        if (!mp.active || mp._desync)
            return _origPopup.call(this, yesName, yes, noName, no, title,
                description);

        // The forced-action popup in Player.startTurn is part of the turn
        // flow, not a sub-choice — don't capture/replay it.
        if (title === "Play card or pass?")
            return _origPopup.call(this, yesName, yes, noName, no, title,
                description);

        let isRemote = false;
        if (game.currPlayer === player_op) {
            isRemote = true;
        } else if (!game.currPlayer) {
            isRemote = false; // popups during redraw are for local player
        }

        if (isRemote) {
            const msg = await mp.next("popup");
            return msg.c;
        }

        // Local player — capture result
        const result = await _origPopup.call(this, yesName, yes, noName, no,
            title, description);
        mp.send({ t: "popup", c: result });
        return result;
    };

})();

// ── Player method wrappers (local capture) ───────────────────────

(function wrapPlayerMethods() {
    const _origPassRound = Player.prototype.passRound;
    Player.prototype.passRound = async function() {
        if (mp.active && !mp._desync && this === player_me
                && game.currPlayer === player_me)
            mp.send({ t: "pass" });
        return _origPassRound.call(this);
    };

    const _origActivateLeader = Player.prototype.activateLeader;
    Player.prototype.activateLeader = async function(endTurn, disableLeader) {
        if (mp.active && !mp._desync && this === player_me
                && game.currPlayer === player_me)
            mp.send({ t: "leader" });
        return _origActivateLeader.call(this, endTurn, disableLeader);
    };

    // After each turn ends, exchange checksums
    const _origPlayerEndTurn = Player.prototype.endTurn;
    Player.prototype.endTurn = async function(noEffects) {
        await _origPlayerEndTurn.call(this, noEffects);
        if (mp.active && !mp._desync)
            mp.sendChecksum();
    };
})();

// ── Wire Net.onMessage to MPSession ───────────────────────────────

Net.onMessage = function(data) {
    if (typeof mp !== "undefined" && mp.active)
        mp.route(data);
};
