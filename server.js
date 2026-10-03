'use strict';
/**
 * LiveCollab — server.js
 * ---------------------------------------------------------------------------
 *  • Express   : serves /public, exposes POST /room (create / join) and GET /room/:id
 *  • ws        : WS /connect?room=ID&name=NAME&clientId=ID  (realtime channel)
 *  • Room state lives in memory: an ordered stroke log + a user table.
 *
 * Sync model (conflict-free by construction):
 *  1. Every stroke has a client-generated UUID  → ops are idempotent upserts.
 *  2. The server stamps each new stroke with a monotonic `seq` → all clients
 *     render in the same order, so concurrent strokes/erasers converge.
 *  3. Mutations the client must not lose (stroke:end, stroke:remove,
 *     board:clear) carry an `opId` and are acknowledged; clients resend
 *     un-acked ops after a reconnect.
 *  4. A dropped socket gets a grace period: the user keeps their identity
 *     (clientId), cursor and voice state if they reconnect in time.
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

/* ------------------------------ Configuration ----------------------------- */
const PORT = Number(process.env.PORT) || 3000;
const GRACE_MS = 8_000;              // how long a disconnected user is kept "online"
const ROOM_TTL_MS = 30 * 60_000;     // empty rooms are deleted after this
const MAX_STROKES = 20_000;          // per room
const MAX_STROKE_COORDS = 40_000;    // numbers per stroke (x,y pairs → 20k points)
const MAX_BATCH_COORDS = 4_000;      // numbers per stroke:points message
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const USER_COLORS = [
  '#6366f1', '#ec4899', '#f97316', '#10b981', '#06b6d4',
  '#eab308', '#8b5cf6', '#ef4444', '#14b8a6', '#3b82f6',
];

/** @type {Map<string, Room>} */
const rooms = new Map();

/* --------------------------------- Helpers -------------------------------- */
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const normalizeRoomId = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function makeRoomId() {
  let id;
  do {
    id = Array.from({ length: 6 }, () => ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function createRoom(id) {
  const room = { id, strokes: new Map(), seq: 0, users: new Map(), emptySince: Date.now() };
  rooms.set(id, room);
  return room;
}

function pickColor(room) {
  const used = new Set([...room.users.values()].map((u) => u.color));
  return USER_COLORS.find((c) => !used.has(c)) || USER_COLORS[crypto.randomInt(USER_COLORS.length)];
}

const publicUser = (u) => ({ id: u.id, name: u.name, color: u.color, voice: u.voice });
const publicUsers = (room) => [...room.users.values()].map(publicUser);
const publicStroke = (s) => ({ id: s.id, tool: s.tool, color: s.color, size: s.size, points: s.points, seq: s.seq });
const snapshot = (room) => [...room.strokes.values()].sort((a, b) => a.seq - b.seq).map(publicStroke);

function send(user, obj) {
  if (user.ws && user.ws.readyState === WebSocket.OPEN) user.ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const u of room.users.values()) {
    if (u.id !== exceptId && u.ws && u.ws.readyState === WebSocket.OPEN) u.ws.send(data);
  }
}

/** Acknowledge a reliable op so the client can drop it from its outbox. */
function ack(user, msg, extra = {}) {
  if (msg.opId !== undefined) send(user, { type: 'ack', opId: msg.opId, ...extra });
}

/** Flat [x0,y0,x1,y1,…] → validated flat array. */
function sanitizePoints(arr, limit) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const n = Math.min(arr.length, limit);
  for (let i = 0; i + 1 < n; i += 2) {
    const x = arr[i], y = arr[i + 1];
    if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e7 && Math.abs(y) < 1e7) out.push(x, y);
  }
  return out;
}

function sanitizeStroke(s, limit) {
  if (!s || typeof s.id !== 'string' || s.id.length > 64) return null;
  const points = sanitizePoints(s.points, limit);
  if (!points.length) return null;
  return {
    id: s.id,
    tool: s.tool === 'eraser' ? 'eraser' : 'pen',
    color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#0f172a',
    size: clamp(Number(s.size) || 4, 1, 200),
    points,
  };
}

function removeUser(room, user) {
  if (room.users.get(user.id) !== user) return;
  room.users.delete(user.id);
  broadcast(room, { type: 'user:leave', id: user.id });
  if (room.users.size === 0) room.emptySince = Date.now();
}

/* ------------------------------ Message router ---------------------------- */
function handleMessage(room, user, msg) {
  switch (msg.type) {
    case 'ping':
      return send(user, { type: 'pong' });

    /* Live cursor (world coordinates). x === null means "pointer left canvas". */
    case 'cursor': {
      const hide = msg.x === null;
      if (!hide && !(Number.isFinite(msg.x) && Number.isFinite(msg.y))) return;
      return broadcast(room, { type: 'cursor', id: user.id, x: hide ? null : msg.x, y: hide ? null : msg.y }, user.id);
    }

    /* A stroke begins: store it immediately so late joiners see in-progress ink. */
    case 'stroke:start': {
      const s = sanitizeStroke(msg.stroke, MAX_BATCH_COORDS);
      if (!s) return;
      let stored = room.strokes.get(s.id);
      if (!stored) {
        if (room.strokes.size >= MAX_STROKES) return;
        stored = { ...s, seq: ++room.seq, owner: user.id };
        room.strokes.set(s.id, stored);
      } else if (stored.owner !== user.id) return;
      return broadcast(room, { type: 'stroke:start', stroke: publicStroke(stored) }, user.id);
    }

    /* Incremental points (batched by the client ~every 30 ms). */
    case 'stroke:points': {
      const stored = room.strokes.get(msg.id);
      if (!stored || stored.owner !== user.id) return;
      const pts = sanitizePoints(msg.points, MAX_BATCH_COORDS);
      if (!pts.length || stored.points.length + pts.length > MAX_STROKE_COORDS) return;
      for (const v of pts) stored.points.push(v);
      return broadcast(room, { type: 'stroke:points', id: msg.id, points: pts }, user.id);
    }

    /* Stroke finished — carries the FULL stroke, so it's an idempotent upsert.
       Also used for redo and for resending after a reconnect. */
    case 'stroke:end': {
      const s = sanitizeStroke(msg.stroke, MAX_STROKE_COORDS);
      if (!s) return ack(user, msg);
      let stored = room.strokes.get(s.id);
      if (stored && stored.owner !== user.id) return ack(user, msg);
      if (!stored) {
        if (room.strokes.size >= MAX_STROKES) return ack(user, msg);
        stored = { ...s, seq: ++room.seq, owner: user.id };
        room.strokes.set(s.id, stored);
      } else {
        stored.points = s.points; // authoritative final geometry
      }
      ack(user, msg, { id: stored.id, seq: stored.seq });
      return broadcast(room, { type: 'stroke:end', stroke: publicStroke(stored) }, user.id);
    }

    /* Undo = remove my stroke by id (only the owner may remove it). */
    case 'stroke:remove': {
      const stored = room.strokes.get(msg.id);
      if (stored && stored.owner === user.id) {
        room.strokes.delete(msg.id);
        broadcast(room, { type: 'stroke:remove', id: msg.id }, user.id);
      }
      return ack(user, msg);
    }

    case 'board:clear':
      room.strokes.clear();
      broadcast(room, { type: 'board:clear', by: user.id }, user.id);
      return ack(user, msg);

    /* WebRTC signalling relay (offer / answer / ICE). The server never sees audio. */
    case 'rtc:signal': {
      const target = room.users.get(String(msg.to));
      if (target) send(target, { type: 'rtc:signal', from: user.id, data: msg.data });
      return;
    }

    case 'voice:state':
      user.voice = Boolean(msg.on);
      return broadcast(room, { type: 'voice:state', id: user.id, on: user.voice }, user.id);

    default:
      return;
  }
}

/* ------------------------------- HTTP (REST) ------------------------------ */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** POST /room  {}            → create a new room
 *  POST /room  {roomId}      → validate & join an existing room (404 if missing) */
app.post('/room', (req, res) => {
  const requested = req.body && req.body.roomId;
  if (requested) {
    const id = normalizeRoomId(requested);
    if (!rooms.has(id)) return res.status(404).json({ error: 'Room not found' });
    return res.json({ roomId: id, created: false });
  }
  const room = createRoom(makeRoomId());
  return res.status(201).json({ roomId: room.id, created: true });
});

/** GET /room/:id — used by clients to decide whether a reconnect is hopeless. */
app.get('/room/:id', (req, res) => {
  const room = rooms.get(normalizeRoomId(req.params.id));
  if (!room) return res.status(404).json({ exists: false });
  return res.json({ exists: true, users: room.users.size, strokes: room.strokes.size });
});

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/* ------------------------------ WebSocket (WS) ---------------------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });

// Manual upgrade so we can reject unknown paths / rooms before the handshake completes.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/connect') return socket.destroy();

  const room = rooms.get(normalizeRoomId(url.searchParams.get('room')));
  if (!room) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }

  const rawId = url.searchParams.get('clientId') || '';
  const clientId = /^[A-Za-z0-9_-]{8,40}$/.test(rawId) ? rawId : crypto.randomUUID();
  const name = (url.searchParams.get('name') || '').trim().slice(0, 24) || `Guest ${crypto.randomInt(1000, 9999)}`;

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { room, name, clientId }));
});

wss.on('connection', (ws, _req, { room, name, clientId }) => {
  /* ---- identity: new user, or a reconnect that takes over its old slot ---- */
  let user = room.users.get(clientId);
  const isReconnect = Boolean(user);
  if (user) {
    clearTimeout(user.graceTimer);
    if (user.ws && user.ws !== ws) user.ws.close(4000, 'replaced');
    user.ws = ws;
    user.name = name;
  } else {
    user = { id: clientId, name, color: pickColor(room), voice: false, ws, graceTimer: null };
    room.users.set(clientId, user);
  }
  room.emptySince = null;
  ws.isAlive = true;

  /* ---- full authoritative snapshot: this is what makes reconnects lossless ---- */
  send(user, { type: 'init', selfId: user.id, users: publicUsers(room), strokes: snapshot(room) });
  if (!isReconnect) broadcast(room, { type: 'user:join', user: publicUser(user) }, user.id);

  /* ---- tiny token bucket: ~600 msgs/s sustained per connection ---- */
  let tokens = 600, last = Date.now();
  const allow = () => {
    const now = Date.now();
    tokens = Math.min(600, tokens + (now - last) * 0.6);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary || user.ws !== ws || !allow()) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg && typeof msg.type === 'string') handleMessage(room, user, msg);
  });

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  ws.on('close', () => {
    if (user.ws !== ws) return; // already replaced by a newer connection
    user.ws = null;
    user.graceTimer = setTimeout(() => removeUser(room, user), GRACE_MS);
  });
});

/* ------------------------------- Housekeeping ----------------------------- */
// Protocol-level heartbeat: drop half-open sockets.
setInterval(() => {
  for (const room of rooms.values()) {
    for (const u of room.users.values()) {
      const ws = u.ws;
      if (!ws) continue;
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30_000);

// Garbage-collect abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.users.size === 0 && room.emptySince && now - room.emptySince > ROOM_TTL_MS) rooms.delete(id);
  }
}, 60_000);

server.listen(PORT, () => console.log(`\n  ✦ LiveCollab running → http://localhost:${PORT}\n`));