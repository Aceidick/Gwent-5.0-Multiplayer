"use strict"

// ═══════════════════════════════════════════════════════════════════
// server.js — WebSocket relay + static file server for Gwent 5.0.
//
// Serves the game files (HTML, JS, CSS, images, audio) from the repo
// root AND handles WebSocket relay connections on the same port.
// Pairs two players by room code (or quick-match) and forwards
// messages between them verbatim. Holds NO game state — all simulation
// runs client-side in lockstep.
//
// Run:  node server.js
//   or: PORT=8080 node server.js
// ═══════════════════════════════════════════════════════════════════

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8765;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null; // e.g. "https://example.com"
const ROOM_CODE_LEN = 5;
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars
const RATE_LIMIT_WINDOW = 1000;   // ms
const RATE_LIMIT_MAX = 30;         // messages per window per socket
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 min idle room cleanup
const PING_INTERVAL = 30 * 1000;   // 30 s ping/pong keepalive

// Static files live in the repo root (parent of server/)
const STATIC_ROOT = path.resolve(__dirname, "..");

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js":   "text/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif":  "image/gif",
    ".ico":  "image/x-icon",
    ".svg":  "image/svg+xml",
    ".ttf":  "font/ttf",
    ".woff": "font/woff",
    ".woff2":"font/woff2",
    ".mp3":  "audio/mpeg",
    ".wav":  "audio/wav",
    ".ogg":  "audio/ogg",
    ".txt":  "text/plain; charset=utf-8",
    ".map":  "application/json",
};

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

// ── Static file serving ────────────────────────────────────────────

function serveStatic(req, res) {
    let urlPath = req.url.split("?")[0];
    if (urlPath === "/") urlPath = "/index.html";

    // Decode and prevent path traversal
    let decoded;
    try { decoded = decodeURIComponent(urlPath); }
    catch (e) { res.writeHead(400); res.end("Bad request"); return; }

    // Block any path containing ..
    if (decoded.indexOf("..") !== -1) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    const filePath = path.join(STATIC_ROOT, decoded);

    // Ensure resolved path stays within STATIC_ROOT
    if (!filePath.startsWith(STATIC_ROOT)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });
        fs.createReadStream(filePath).pipe(res);
    });
}

// ── HTTP + WebSocket server ─────────────────────────────────────────

const server = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            ok: true,
            rooms: rooms.size,
            qmQueue: quickMatchQueue.length,
            uptime: process.uptime()
        }));
        return;
    }
    // Everything else: serve static game files
    serveStatic(req, res);
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
    console.log(`Gwent server listening on http://0.0.0.0:${PORT}`);
    console.log(`  Game:    http://<this-host>:${PORT}/`);
    console.log(`  Health:  http://<this-host>:${PORT}/health`);
    console.log(`  Static root: ${STATIC_ROOT}`);
    if (ALLOWED_ORIGIN)
        console.log(`Origin check enabled: ${ALLOWED_ORIGIN}`);
});
