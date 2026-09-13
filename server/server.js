"use strict"

// ═══════════════════════════════════════════════════════════════════
// server.js — WebSocket relay server for Gwent 5.0 online multiplayer.
//
// Pairs two players by room code (or quick-match) and forwards messages
// between them verbatim. Holds NO game state — all simulation runs
// client-side in lockstep.
//
// Run:  node server.js
//   or: PORT=8080 node server.js
// ═══════════════════════════════════════════════════════════════════

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8765;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null; // e.g. "https://example.com"
const ROOM_CODE_LEN = 5;
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars
const RATE_LIMIT_WINDOW = 1000;   // ms
const RATE_LIMIT_MAX = 30;         // messages per window per socket
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 min idle room cleanup
const PING_INTERVAL = 30 * 1000;   // 30 s ping/pong keepalive

// ── Room ────────────────────────────────────────────────────────────

class Room {
    constructor(code) {
        this.code = code;
        this.host = null;
        this.guest = null;
        this.createdAt = Date.now();
        this.lastActivity = Date.now();
        this.quickMatch = false;
    }

    get full() { return this.host && this.guest; }
    get empty() { return !this.host && !this.guest; }

    touch() { this.lastActivity = Date.now(); }

    sendToPeer(from, msg) {
        const peer = (from === this.host) ? this.guest : this.host;
        if (peer && peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify(msg));
        }
    }

    broadcast(msg, except) {
        for (const sock of [this.host, this.guest]) {
            if (sock && sock !== except && sock.readyState === WebSocket.OPEN)
                sock.send(JSON.stringify(msg));
        }
    }

    destroy() {
        for (const sock of [this.host, this.guest]) {
            if (sock && sock.readyState === WebSocket.OPEN) {
                sock.send(JSON.stringify({ type: "peer-left" }));
            }
        }
        rooms.delete(this.code);
    }

    removePeer(sock) {
        if (this.host === sock) this.host = null;
        if (this.guest === sock) this.guest = null;
        // Notify remaining peer
        this.broadcast({ type: "peer-left" });
        if (this.empty) rooms.delete(this.code);
    }
}

const rooms = new Map();       // code → Room
const quickMatchQueue = [];    // [socket, ...]
const socketRooms = new Map();  // socket → Room

// ── Helpers ────────────────────────────────────────────────────────

function genCode() {
    let code;
    do {
        code = "";
        for (let i = 0; i < ROOM_CODE_LEN; i++)
            code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    } while (rooms.has(code));
    return code;
}

function rateLimited(sock) {
    if (!sock._msgTimes) sock._msgTimes = [];
    const now = Date.now();
    sock._msgTimes = sock._msgTimes.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (sock._msgTimes.length >= RATE_LIMIT_MAX) return true;
    sock._msgTimes.push(now);
    return false;
}

// ── WebSocket server ────────────────────────────────────────────────

const server = http.createServer((req, res) => {
    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            ok: true,
            rooms: rooms.size,
            qmQueue: quickMatchQueue.length,
            uptime: process.uptime()
        }));
    } else {
        res.writeHead(404);
        res.end("Not found");
    }
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (sock, req) => {
    // Origin check
    if (ALLOWED_ORIGIN) {
        const origin = req.headers.origin;
        if (origin && origin !== ALLOWED_ORIGIN) {
            sock.close(4001, "origin not allowed");
            return;
        }
    }

    sock.send(JSON.stringify({ type: "qm-status", online: wss.clients.size }));

    sock.on("message", (raw) => {
        if (rateLimited(sock)) {
            sock.send(JSON.stringify({ type: "error", code: "rate_limited" }));
            return;
        }

        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }

        switch (msg.type) {
            case "create": {
                const room = new Room(genCode());
                room.host = sock;
                socketRooms.set(sock, room);
                rooms.set(room.code, room);
                sock.send(JSON.stringify({ type: "created", code: room.code }));
                break;
            }

            case "join": {
                const room = rooms.get((msg.code || "").toUpperCase());
                if (!room) {
                    sock.send(JSON.stringify({ type: "error", code: "not_found" }));
                    return;
                }
                if (room.guest) {
                    sock.send(JSON.stringify({ type: "error", code: "room_full" }));
                    return;
                }
                room.guest = sock;
                room.touch();
                socketRooms.set(sock, room);
                sock.send(JSON.stringify({ type: "joined", code: room.code }));
                // Notify host that a guest joined
                if (room.host && room.host.readyState === WebSocket.OPEN)
                    room.host.send(JSON.stringify({ type: "peer-joined" }));
                break;
            }

            case "quickmatch": {
                // Remove from existing room if any
                const existing = socketRooms.get(sock);
                if (existing) existing.removePeer(sock);

                // Check if someone is already queued
                if (quickMatchQueue.length > 0) {
                    const partner = quickMatchQueue.shift();
                    if (partner.readyState === WebSocket.OPEN) {
                        const room = new Room(genCode());
                        room.quickMatch = true;
                        room.host = partner;
                        room.guest = sock;
                        socketRooms.set(partner, room);
                        socketRooms.set(sock, room);
                        rooms.set(room.code, room);
                        partner.send(JSON.stringify({ type: "created", code: room.code }));
                        sock.send(JSON.stringify({ type: "joined", code: room.code }));
                        partner.send(JSON.stringify({ type: "peer-joined" }));
                    } else {
                        // Partner disconnected, queue self
                        quickMatchQueue.push(sock);
                        sock.send(JSON.stringify({ type: "qm-status", online: wss.clients.size }));
                    }
                } else {
                    quickMatchQueue.push(sock);
                    sock.send(JSON.stringify({ type: "qm-status", online: wss.clients.size }));
                }
                break;
            }

            case "msg": {
                const room = socketRooms.get(sock);
                if (room) {
                    room.touch();
                    room.sendToPeer(sock, { type: "msg", data: msg.data });
                }
                break;
            }

            case "leave": {
                const room = socketRooms.get(sock);
                if (room) {
                    room.removePeer(sock);
                    socketRooms.delete(sock);
                }
                break;
            }

            default:
                break;
        }
    });

    sock.on("close", () => {
        // Remove from quick-match queue
        const qmIdx = quickMatchQueue.indexOf(sock);
        if (qmIdx >= 0) quickMatchQueue.splice(qmIdx, 1);

        // Remove from room
        const room = socketRooms.get(sock);
        if (room) {
            room.removePeer(sock);
            socketRooms.delete(sock);
        }

        // Broadcast updated online count
        wss.clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN && !socketRooms.has(c))
                c.send(JSON.stringify({ type: "qm-status", online: wss.clients.size }));
        });
    });
});

// ── Periodic cleanup ────────────────────────────────────────────────

setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (now - room.lastActivity > IDLE_TIMEOUT) {
            room.destroy();
        }
    }
    // Clean up stale quick-match entries
    for (let i = quickMatchQueue.length - 1; i >= 0; i--) {
        if (quickMatchQueue[i].readyState !== WebSocket.OPEN)
            quickMatchQueue.splice(i, 1);
    }
}, 60 * 1000);

// ── Ping/pong keepalive ─────────────────────────────────────────────

setInterval(() => {
    wss.clients.forEach(sock => {
        if (sock.readyState === WebSocket.OPEN)
            sock.ping();
    });
}, PING_INTERVAL);

// ── Start ───────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`Gwent relay server listening on ws://localhost:${PORT}`);
    if (ALLOWED_ORIGIN)
        console.log(`Origin check enabled: ${ALLOWED_ORIGIN}`);
});
