/**
 * SocketClient — a resilient WebSocket wrapper.
 *
 *  • Auto-reconnect with exponential backoff + jitter (also on `online` / tab-visible).
 *  • App-level heartbeat detects half-open connections that the browser can't see.
 *  • sendReliable(): ops get an `opId`, stay in an outbox until the server acks them,
 *    and are resent after every reconnect. Server ops are idempotent, so resending is safe.
 *  • Emits: 'status' (connecting|open|reconnecting|closed), 'gone' (room deleted),
 *    'replaced' (same identity opened elsewhere), plus every server message by `type`.
 */
const MAX_BACKOFF_MS = 8000;

export class SocketClient {
  constructor({ roomId, name, clientId }) {
    Object.assign(this, { roomId, name, clientId });
    this.ws = null;
    this.handlers = new Map();
    this.unacked = new Map();     // opId → message (the outbox)
    this.opSeq = 0;
    this.retries = 0;
    this.closed = false;
    this._timer = null;
    this._hb = null;
    this._pong = null;

    window.addEventListener('online', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectNow();
    });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }
  _emit(type, payload) { (this.handlers.get(type) || []).forEach((fn) => fn(payload)); }

  get isOpen() { return this.ws?.readyState === WebSocket.OPEN; }

  connect() {
    if (this.closed) return;
    clearTimeout(this._timer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this._emit('status', this.retries ? 'reconnecting' : 'connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = new URLSearchParams({ room: this.roomId, name: this.name, clientId: this.clientId });
    const ws = new WebSocket(`${proto}://${location.host}/connect?${qs}`);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retries = 0;
      this._startHeartbeat();
      this._emit('status', 'open');
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'pong') { clearTimeout(this._pong); return; }
      if (msg.type === 'ack' && msg.opId !== undefined) this.unacked.delete(msg.opId);
      this._emit(msg.type, msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      if (ev.code === 4000) {                       // same identity connected elsewhere
        this.ws = null; this.closed = true; this._stopHeartbeat();
        this._emit('status', 'closed'); this._emit('replaced');
        return;
      }
      this._onClosed(ws);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _onClosed(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    this._stopHeartbeat();
    if (this.closed) return;
    this._emit('status', 'reconnecting');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    const delay = Math.min(MAX_BACKOFF_MS, 400 * 2 ** this.retries) + Math.random() * 300;
    this.retries += 1;
    clearTimeout(this._timer);
    this._timer = setTimeout(async () => {
      if (this.closed) return;
      if (this.retries >= 3) {                     // is the room even still there?
        try {
          const res = await fetch(`/room/${this.roomId}`, { cache: 'no-store' });
          if (res.status === 404) { this.closed = true; this._emit('status', 'closed'); this._emit('gone'); return; }
        } catch { /* server unreachable — keep retrying */ }
      }
      this.connect();
    }, delay);
  }

  reconnectNow() {
    if (this.closed || this.isOpen || this.ws?.readyState === WebSocket.CONNECTING) return;
    clearTimeout(this._timer);
    this.connect();
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._hb = setInterval(() => {
      if (!this.isOpen) return;
      const ws = this.ws;
      ws.send('{"type":"ping"}');
      clearTimeout(this._pong);
      this._pong = setTimeout(() => { this._onClosed(ws); try { ws.close(); } catch { /* noop */ } }, 8000);
    }, 15000);
  }
  _stopHeartbeat() { clearInterval(this._hb); clearTimeout(this._pong); }

  /** Fire-and-forget (cursor, stroke:start, stroke:points, signalling). */
  send(msg) {
    if (!this.isOpen) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** At-least-once delivery (stroke:end, stroke:remove, board:clear). */
  sendReliable(msg) {
    msg.opId = ++this.opSeq;
    this.unacked.set(msg.opId, msg);
    if (this.unacked.size > 5000) this.unacked.delete(this.unacked.keys().next().value);
    this.send(msg);
  }

  unackedOps() { return [...this.unacked.values()]; }
  resendUnacked() { for (const m of this.unacked.values()) this.send(m); }

  close() {
    this.closed = true;
    clearTimeout(this._timer);
    this._stopHeartbeat();
    try { this.ws?.close(); } catch { /* noop */ }
  }
}