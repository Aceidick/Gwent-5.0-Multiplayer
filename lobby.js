"use strict"

// ═══════════════════════════════════════════════════════════════════
// lobby.js — Pre-game lobby UI and match setup for online multiplayer.
// Loaded after gwent.js and netplay.js.
// ═══════════════════════════════════════════════════════════════════

var Lobby = {
    overlay: null,
    status: null,
    codeInput: null,
    codeDisplay: null,
    btnCreate: null,
    btnJoin: null,
    btnQuick: null,
    btnCancel: null,

    remoteDeck: null,
    localDeck: null,
    ready: false,
    peerReady: false,

    init() {
        this._buildOverlay();
        Net.onPeerJoined = () => this._onPeerJoined();
        Net.onPeerLeft = () => this._onPeerLeft();
        Net.onMessage = (data) => this._onMessage(data);
    },

    _buildOverlay() {
        let ov = document.createElement("div");
        ov.id = "mp-lobby";
        ov.style.cssText = [
            "position:fixed", "top:0", "left:0", "width:100%", "height:100%",
            "background:rgba(10,12,18,0.94)", "z-index:9999",
            "display:flex", "flex-direction:column", "align-items:center",
            "justify-content:center", "color:#d4c4a0", "font-family:serif",
            "text-align:center"
        ].join(";");
        ov.innerHTML = `
            <div id="mp-find" style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%">
                <h2 style="font-size:28px;margin-bottom:6px;color:#e8d5a3">Online Multiplayer</h2>
                <p id="mp-status" style="font-size:14px;margin-bottom:20px;min-height:20px;color:#9a8c6e"></p>
                <div id="mp-code-display" style="font-size:22px;letter-spacing:4px;margin:10px 0;display:none;color:#e8d5a3"></div>
                <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;max-width:480px">
                    <button id="mp-create" style="padding:10px 22px;font-size:15px;cursor:pointer;background:#3a3528;color:#e8d5a3;border:1px solid #5a4f3a">Create Room</button>
                    <button id="mp-quick" style="padding:10px 22px;font-size:15px;cursor:pointer;background:#3a3528;color:#e8d5a3;border:1px solid #5a4f3a">Quick Match</button>
                    <input id="mp-code-input" placeholder="Room code" maxlength="6"
                        style="padding:8px 10px;font-size:15px;width:120px;text-transform:uppercase;background:#1a1812;color:#e8d5a3;border:1px solid #5a4f3a;text-align:center" />
                    <button id="mp-join" style="padding:10px 22px;font-size:15px;cursor:pointer;background:#3a3528;color:#e8d5a3;border:1px solid #5a4f3a">Join</button>
                </div>
                <button id="mp-cancel" style="margin-top:24px;padding:10px 28px;font-size:14px;cursor:pointer;background:#2a251c;color:#e8d5a3;border:1px solid #8a6000">Close</button>
                <div style="margin-top:20px;display:flex;flex-direction:column;align-items:center;gap:6px;max-width:480px">
                    <label for="mp-server-url" style="font-size:12px;color:#7a6e58">Relay server (optional — leave blank to auto-detect)</label>
                    <input id="mp-server-url" placeholder="ws://host:port" spellcheck="false"
                        style="padding:6px 10px;font-size:13px;width:280px;background:#1a1812;color:#e8d5a3;border:1px solid #5a4f3a;text-align:center" />
                </div>
            </div>
            <div id="mp-ready" style="display:none;position:absolute;left:50%;bottom:18px;transform:translateX(-50%);max-width:520px;width:92%;padding:10px 18px;background:rgba(20,18,14,0.96);border:1px solid #8a6000;border-radius:8px;z-index:9999;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap">
                <span id="mp-ready-status" style="font-size:14px;color:#e8d5a3;flex:1;min-width:200px;text-align:left"></span>
                <button id="mp-ready-close" style="padding:8px 18px;font-size:13px;cursor:pointer;background:#2a251c;color:#e8d5a3;border:1px solid #8a6000">Leave</button>
            </div>
        `;
        document.body.appendChild(ov);
        this.overlay = ov;
        this.findView = ov.querySelector("#mp-find");
        this.readyBar = ov.querySelector("#mp-ready");
        this.status = ov.querySelector("#mp-status");
        this.codeDisplay = ov.querySelector("#mp-code-display");
        this.codeInput = ov.querySelector("#mp-code-input");
        this.btnCreate = ov.querySelector("#mp-create");
        this.btnJoin = ov.querySelector("#mp-join");
        this.btnQuick = ov.querySelector("#mp-quick");
        this.btnCancel = ov.querySelector("#mp-cancel");
        this.readyStatus = ov.querySelector("#mp-ready-status");
        this.readyClose = ov.querySelector("#mp-ready-close");

        this.btnCreate.addEventListener("click", () => this.createRoom());
        this.btnJoin.addEventListener("click", () => this.joinRoom());
        this.btnQuick.addEventListener("click", () => this.quickMatch());
        this.btnCancel.addEventListener("click", () => this.close());
        if (this.readyClose)
            this.readyClose.addEventListener("click", () => this.close());
    },

    // Switch the lobby to the 'find opponent' full-screen view.
    _showFindView() {
        if (this.findView) this.findView.style.display = "flex";
        if (this.readyBar) this.readyBar.style.display = "none";
    },

    // Switch to the compact 'ready' bar so the deck builder stays usable while
    // waiting for the opponent / before pressing Start game.
    _showReadyBar() {
        if (this.findView) this.findView.style.display = "none";
        if (this.readyBar) this.readyBar.style.display = "flex";
    },

    show() {
        if (!this.overlay) this.init();
        // Validate local deck before connecting
        if (typeof dm !== "undefined" && dm.stats) {
            if (dm.stats.units < 22) {
                if (typeof aviso === "function") aviso("Your deck must have at least 22 unit cards.");
                return;
            }
            if (dm.stats.special > 10) {
                if (typeof aviso === "function") aviso("Your deck must have no more than 10 special cards.");
                return;
            }
        }
        this.overlay.style.display = "flex";
        this._showFindView();
        this._reset();
        this.status.textContent = "Connect to a relay server to play online.";
        this.codeDisplay.style.display = "none";
        this.codeInput.value = "";
        let urlInput = this.overlay.querySelector("#mp-server-url");
        if (urlInput) {
            let saved = (typeof localStorage !== "undefined")
                ? localStorage.getItem("gc-server-url") : null;
            urlInput.value = saved || "";
        }
    },

    close() {
        if (this.overlay) this.overlay.style.display = "none";
        if (Net.code) Net.leave();
        this._reset();
    },

    _reset() {
        this.remoteDeck = null;
        this.localDeck = null;
        this.ready = false;
        this.peerReady = false;
    },

    _setStatus(msg) {
        if (this.status) this.status.textContent = msg;
    },

    _resolveServerURL() {
        let urlInput = this.overlay && this.overlay.querySelector("#mp-server-url");
        let url = urlInput ? urlInput.value.trim() : "";
        if (url && typeof localStorage !== "undefined")
            localStorage.setItem("gc-server-url", url);
        return url || null;
    },

    async _ensureConnected() {
        if (Net.connected) return true;
        let url = this._resolveServerURL();
        this._setStatus("Connecting to relay server...");
        try {
            await Net.connect(url);
            this._setStatus("Connected! Choose how to find an opponent.");
            return true;
        } catch (e) {
            this._setStatus("Could not reach the relay server. Check the server URL or leave it blank to auto-detect.");
            return false;
        }
    },

    async createRoom() {
        if (!(await this._ensureConnected())) return;
        this._setStatus("Creating room...");
        try {
            let code = await Net.createRoom();
            this.codeDisplay.textContent = "Room Code: " + code;
            this.codeDisplay.style.display = "block";
            this._setStatus("Share the code with your opponent. Waiting for them to join...");
        } catch (e) {
            this._setStatus("Failed to create room: " + e.message);
        }
    },

    async joinRoom() {
        if (!(await this._ensureConnected())) return;
        let code = this.codeInput.value.trim().toUpperCase();
        if (!code) { this._setStatus("Enter a room code first."); return; }
        this._setStatus("Joining room " + code + "...");
        try {
            await Net.joinRoom(code);
            this._setStatus("Joined room! Exchanging deck data...");
        } catch (e) {
            this._setStatus("Failed to join: " + (e.message || "room not found or full."));
        }
    },

    async quickMatch() {
        if (!(await this._ensureConnected())) return;
        this._setStatus("Searching for an opponent...");
        try {
            await Net.quickMatch();
            // If we get a code back, we're waiting; if joined, peer-joined fires
            if (Net.role === "host") {
                this._setStatus("Waiting for an opponent to quick-match...");
            }
        } catch (e) {
            this._setStatus("Quick match failed: " + e.message);
        }
    },

    _onPeerJoined() {
        // Opponent connected. Switch to the compact ready bar so the player
        // can finish building their deck, then press 'Start game' to ready up.
        this.peerReady = false;
        this.ready = false;
        this.remoteDeck = null;
        this._showReadyBar();
        this._showReadyState();
    },

    _onPeerLeft() {
        if (mp.active) {
            mp.deactivate();
        }
        this.peerReady = false;
        this.ready = false;
        this.remoteDeck = null;
        this._showReadyState();
        if (this.readyStatus)
            this.readyStatus.textContent = "Opponent disconnected. You can close or wait for a new opponent.";
        setTimeout(() => {
            // Back to the find view so the player can look for a new opponent.
            if (this.overlay && this.overlay.style.display !== "none" && !mp.active) {
                this._showFindView();
                this._setStatus("Opponent disconnected. Find a new opponent or close.");
            }
        }, 1800);
    },

    // Whether the local player can use 'Start game' to ready up (an opponent
    // is connected and the match hasn't started yet).
    canReady() {
        return Net.connected && Net.code !== null && !mp.active && !this.ready;
    },

    // Called when the local player presses 'Start game' while connected to an
    // opponent. Sends the local deck and marks the player as ready.
    ready() {
        if (this.ready) return;
        // Validate the deck one more time before sending.
        if (typeof dm !== "undefined" && dm.stats) {
            if (dm.stats.units < 22) {
                if (typeof aviso === "function") aviso("Your deck must have at least 22 unit cards.");
                return;
            }
            if (dm.stats.special > 10) {
                if (typeof aviso === "function") aviso("Your deck must have no more than 10 special cards.");
                return;
            }
        }
        let raw = dm.deckToJSON();
        this.localDeck = (typeof raw === "string") ? JSON.parse(raw) : raw;
        Net.send({ t: "lobby-ready", deck: this.localDeck });
        this.ready = true;
        this._showReadyState();
        this._maybeStart();
    },

    _showReadyState() {
        if (!Net.connected || Net.code === null) {
            this._setStatus("Waiting for an opponent to connect...");
            return;
        }
        let me = this.ready ? "You are ready" : "Not ready";
        let peer = this.peerReady ? "Opponent is ready" : "Opponent not ready";
        let msg = me + "  •  " + peer + "  —  Press 'Start game' when ready.";
        if (this.readyStatus) this.readyStatus.textContent = msg;
        this._setStatus(msg);
    },

    _onMessage(data) {
        if (data.t === "lobby-ready") {
            this.remoteDeck = (typeof data.deck === "string") ? JSON.parse(data.deck) : data.deck;
            this.peerReady = true;
            this._showReadyState();
            this._maybeStart();
        } else if (data.t === "lobby-start") {
            // Guest receives seed from host
            if (Net.role === "guest") {
                this._startMatch(data.seed);
            }
        } else {
            // Route game messages to MPSession
            if (mp.active) mp.route(data);
        }
    },

    _maybeStart() {
        // Only start once both players are ready (decks exchanged).
        if (!this.ready || !this.peerReady || !this.remoteDeck) return;
        if (Net.role === "host") {
            // Host generates seed and starts; guest starts on lobby-start.
            let seed = GameRNG.randomSeed();
            Net.send({ t: "lobby-start", seed: seed });
            this._startMatch(seed);
        }
        // Guest waits for lobby-start message
    },

    _startMatch(seed) {
        this._setStatus("Starting match...");

        // Convert remote deck wire format to engine deck format
        let remoteDeckData = {
            faction: this.remoteDeck.faction,
            leader: {
                index: this.remoteDeck.leader,
                card: card_dict[this.remoteDeck.leader]
            },
            cards: this.remoteDeck.cards.map(c => ({ index: c[0], count: c[1] })),
            title: "Online Opponent"
        };
        dm.start_op_deck = remoteDeckData;
        game.randomOPDeck = false;

        // Reset shared RNG
        GameRNG.reset(seed);

        // Activate multiplayer session
        mp.activate(Net.role);

        // Hide lobby
        this.overlay.style.display = "none";

        // Start the game in mode 4
        dm.startNewGame(4);
    }
};
