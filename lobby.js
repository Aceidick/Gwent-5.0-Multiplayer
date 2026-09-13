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
            <button id="mp-cancel" style="margin-top:24px;padding:8px 20px;font-size:13px;cursor:pointer;background:none;color:#7a6e58;border:1px solid #3a3528">Cancel</button>
        `;
        document.body.appendChild(ov);
        this.overlay = ov;
        this.status = ov.querySelector("#mp-status");
        this.codeDisplay = ov.querySelector("#mp-code-display");
        this.codeInput = ov.querySelector("#mp-code-input");
        this.btnCreate = ov.querySelector("#mp-create");
        this.btnJoin = ov.querySelector("#mp-join");
        this.btnQuick = ov.querySelector("#mp-quick");
        this.btnCancel = ov.querySelector("#mp-cancel");

        this.btnCreate.addEventListener("click", () => this.createRoom());
        this.btnJoin.addEventListener("click", () => this.joinRoom());
        this.btnQuick.addEventListener("click", () => this.quickMatch());
        this.btnCancel.addEventListener("click", () => this.close());
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
        this._reset();
        this.status.textContent = "Connect to a relay server to play online.";
        this.codeDisplay.style.display = "none";
        this.codeInput.value = "";
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

    async _ensureConnected() {
        if (Net.connected) return true;
        this._setStatus("Connecting to relay server...");
        try {
            await Net.connect();
            this._setStatus("Connected! Choose how to find an opponent.");
            return true;
        } catch (e) {
            this._setStatus("Could not reach the relay server. Check the server URL (?server=ws://host:port).");
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
        this._setStatus("Opponent connected! Exchanging deck data...");
        this._exchangeDecks();
    },

    _onPeerLeft() {
        this._setStatus("Opponent disconnected.");
        if (mp.active) {
            mp.deactivate();
        }
        setTimeout(() => this.show(), 1500);
    },

    _exchangeDecks() {
        // Build local deck JSON from DeckMaker
        this.localDeck = dm.deckToJSON();
        Net.send({ t: "lobby-ready", deck: this.localDeck });
        this._setStatus("Waiting for opponent's deck...");
    },

    _onMessage(data) {
        if (data.t === "lobby-ready") {
            this.remoteDeck = data.deck;
            this._setStatus("Received opponent's deck. Preparing match...");
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
        if (!this.remoteDeck) return;
        if (Net.role === "host") {
            // Host generates seed and starts
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
