import { PALETTE, INK, CURSOR_INTERVAL_MS, POINT_BATCH_MS } from './config.js';
import { CanvasEngine } from './canvas.js';
import { History } from './history.js';
import { SocketClient } from './socket.js';
import { Cursors } from './cursors.js';
import { VoiceChat } from './voice.js';
import * as ui from './ui.js';
import { uid, throttle, local, session, clamp } from './utils.js';

/**
 * main.js — the composition root. It owns no drawing, networking or DOM details itself;
 * it only wires CanvasEngine ⇄ SocketClient ⇄ UI ⇄ VoiceChat together.
 */
const $ = ui.$;

let roomId = null, selfId = null;
let engine, socket, voice, cursors, sendPoints;
const stack = new History({ onChange: () => ui.setHistory(stack.canUndo, stack.canRedo) });
const users = new Map();          // id → { id, name, color, voice }
const speaking = new Set();
const brush = { tool: 'pen', color: INK, size: 4 };

/** The wire format of a stroke (no client-only fields). */
const wire = (s) => ({ id: s.id, tool: s.tool, color: s.color, size: s.size, points: s.points });

boot();

/* ================================ Landing ================================== */
function boot() {
  ui.initTheme((dark) => engine?.setTheme(dark));

  const params = new URLSearchParams(location.search);
  const nameInput = $('#name-input');
  nameInput.value = local.get('lc:name') || '';
  if (params.get('room')) {                      // opened via an invite link
    $('#code-input').value = params.get('room').toUpperCase();
    nameInput.focus();
  }

  const enter = async (code) => {
    const name = (nameInput.value.trim() || `Guest ${Math.floor(1000 + Math.random() * 9000)}`).slice(0, 24);
    if (code !== null && !code.trim()) return ui.setLandingError('Enter a room code to join.');
    ui.setLandingError('');
    ui.setLandingBusy(true);
    try {
      const res = await fetch('/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(code === null ? {} : { roomId: code.trim() }),
      });
      if (res.status === 404) throw new Error('Room not found — check the code and try again.');
      if (!res.ok) throw new Error('Could not reach the server.');
      const { roomId: id } = await res.json();
      local.set('lc:name', name);
      startSession(id, name);
    } catch (err) {
      ui.setLandingError(err.message || 'Something went wrong.');
    } finally {
      ui.setLandingBusy(false);
    }
  };

  $('#create-btn').addEventListener('click', () => enter(null));
  $('#join-form').addEventListener('submit', (e) => { e.preventDefault(); enter($('#code-input').value); });
}

/* ================================ Session ================================== */
function startSession(id, name) {
  roomId = id;
  window.history.replaceState(null, '', `?room=${id}`);
  ui.showApp(id);

  // A per-tab identity that survives refreshes → the server recognises us on reconnect.
  const key = `lc:cid:${id}`;
  let clientId = session.get(key);
  if (!clientId) { clientId = uid(); session.set(key, clientId); }
  selfId = clientId;

  /* ---- Canvas: user intent → network + history ---- */
  sendPoints = createBatcher((sid, pts) => socket.send({ type: 'stroke:points', id: sid, points: pts }), POINT_BATCH_MS);
  const sendCursor = throttle((x, y) => socket.send({ type: 'cursor', x, y }), CURSOR_INTERVAL_MS);

  engine = new CanvasEngine($('#board'), {
    onStrokeStart: (s) => { ui.hideHint(); socket.send({ type: 'stroke:start', stroke: wire(s) }); },
    onStrokePoints: (sid, pts) => sendPoints.add(sid, pts),
    onStrokeEnd: (s) => {
      sendPoints.flush();
      socket.sendReliable({ type: 'stroke:end', stroke: wire(s) }); // full stroke → idempotent, survives lost packets
      stack.record(s);
    },
    onCursor: (x, y) => {
      if (x === null) { sendCursor.cancel(); socket.send({ type: 'cursor', x: null, y: null }); }
      else sendCursor(x, y);
    },
    onViewChange: (view) => { cursors?.refresh(); ui.setZoom(view.scale); ui.updateGrid(view); },
  });
  engine.setTheme(document.documentElement.classList.contains('dark'));

  cursors = new Cursors($('#cursor-layer'), engine);
  socket = new SocketClient({ roomId: id, name, clientId });
  voice = new VoiceChat({
    socket,
    getSelfId: () => selfId,
    sink: $('#audio-sink'),
    onState: () => {
      const me = users.get(selfId);
      if (me) me.voice = voice.active;
      ui.setVoiceUI(voice.active, voice.muted);
      refreshUsers();
    },
    onSpeaking: (uidd, on) => { on ? speaking.add(uidd) : speaking.delete(uidd); refreshUsers(); },
  });

  bindSocket();
  bindToolbar();
  bindKeyboard();
  setTool('pen');
  setColor(INK);
  setSize(4);
  engine.start();
  socket.connect();
}

/* ============================ Socket → local state ========================= */
function bindSocket() {
  socket.on('status', ui.setStatus);

  socket.on('init', (m) => {
    selfId = m.selfId;
    users.clear();
    m.users.forEach((u) => users.set(u.id, u));
    // Authoritative snapshot replaces local state…
    engine.replaceAll(m.strokes);
    if (m.strokes.length) ui.hideHint();
    // …then we re-apply our own not-yet-acknowledged ops on top, so offline work never disappears.
    for (const op of socket.unackedOps()) applyLocal(op);
    socket.resendUnacked();

    // Rebuild cursors for the current roster.
    cursors.ids().forEach((cid) => { if (!users.has(cid)) cursors.remove(cid); });
    users.forEach((u) => { if (u.id !== selfId) cursors.upsert(u); });
    refreshUsers();
    voice.resync([...users.values()]);
  });

  socket.on('user:join', ({ user }) => {
    users.set(user.id, user);
    cursors.upsert(user);
    refreshUsers();
    ui.toast(`${user.name} joined`);
  });
  socket.on('user:leave', ({ id }) => {
    const u = users.get(id);
    users.delete(id); speaking.delete(id);
    cursors.remove(id);
    voice.peerVoiceOff(id);
    refreshUsers();
    if (u) ui.toast(`${u.name} left`);
  });

  socket.on('cursor', (m) => (m.x === null ? cursors.hide(m.id) : cursors.move(m.id, m.x, m.y)));

  socket.on('stroke:start', (m) => { engine.upsertStroke(m.stroke); ui.hideHint(); });
  socket.on('stroke:points', (m) => engine.appendPoints(m.id, m.points));
  socket.on('stroke:end', (m) => engine.upsertStroke(m.stroke));
  socket.on('stroke:remove', (m) => engine.removeStroke(m.id));
  socket.on('board:clear', () => { engine.clear(); stack.clear(); ui.toast('Board cleared'); });
  socket.on('ack', (m) => { if (m.id && m.seq) engine.setSeq(m.id, m.seq); });

  socket.on('rtc:signal', (m) => voice.handleSignal(m.from, m.data));
  socket.on('voice:state', (m) => {
    const u = users.get(m.id);
    if (u) u.voice = m.on;
    if (m.on) voice.peerVoiceOn(m.id); else { voice.peerVoiceOff(m.id); speaking.delete(m.id); }
    refreshUsers();
  });

  socket.on('gone', () => ui.toast('This room has expired. Create a new one.', 'error', 10000));
  socket.on('replaced', () => ui.toast('Opened in another tab — this one was disconnected.', 'error', 10000));
}

/** Re-apply a queued op to local state (used after a snapshot replaces it). */
function applyLocal(op) {
  if (op.type === 'stroke:end') engine.upsertStroke(op.stroke);
  else if (op.type === 'stroke:remove') engine.removeStroke(op.id);
  else if (op.type === 'board:clear') engine.clear();
}

function refreshUsers() {
  const list = [...users.values()].sort((a, b) => (a.id === selfId ? -1 : b.id === selfId ? 1 : 0));
  ui.renderUsers(list, selfId, speaking);
}

/* ================================ Toolbar ================================== */
function setTool(tool) {
  brush.tool = tool;
  engine.setTool(tool);
  ui.setTool(tool);
  ui.setBrushPreview(brush);
}
function setColor(color) {
  brush.color = color;
  if (brush.tool !== 'pen') setTool('pen');       // picking a colour implies drawing
  engine.setColor(color);
  ui.setColor(color);
  ui.setBrushPreview(brush);
}
function setSize(size) {
  brush.size = clamp(Math.round(size), 1, 60);
  engine.setSize(brush.size);
  $('#size-input').value = brush.size;
  ui.setBrushPreview(brush);
}

function undo() {
  const s = stack.undo();
  if (!s) return;
  engine.removeStroke(s.id);
  socket.sendReliable({ type: 'stroke:remove', id: s.id });
}
function redo() {
  const s = stack.redo();
  if (!s) return;
  delete s.seq;                                   // server assigns a fresh position in the order
  engine.upsertStroke(s);
  socket.sendReliable({ type: 'stroke:end', stroke: wire(s) });
}

async function clearBoard() {
  const ok = await ui.confirmDialog({
    title: 'Clear the board?',
    text: 'This removes every stroke for everyone in the room and can’t be undone.',
    okLabel: 'Clear for everyone',
  });
  if (!ok) return;
  engine.clear();
  stack.clear();
  socket.sendReliable({ type: 'board:clear' });
}

async function exportPng() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff';
  const blob = await engine.exportPNG(bg);
  if (!blob) return ui.toast('Nothing to export yet.');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `livecollab-${roomId}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function copyInvite() {
  const url = `${location.origin}/?room=${roomId}`;
  try { await navigator.clipboard.writeText(url); ui.toast('Invite link copied', 'ok'); }
  catch { window.prompt('Copy this invite link:', url); }
}

function micError(err) {
  if (err?.name === 'NotAllowedError') return 'Microphone permission was denied.';
  if (err?.name === 'NotFoundError') return 'No microphone found.';
  return err?.message || 'Could not start voice chat.';
}

function bindToolbar() {
  $('#app').querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  ui.buildSwatches(PALETTE, setColor);
  $('#color-input').addEventListener('input', (e) => setColor(e.target.value));
  $('#size-input').addEventListener('input', (e) => setSize(Number(e.target.value)));

  $('#undo-btn').addEventListener('click', undo);
  $('#redo-btn').addEventListener('click', redo);
  $('#clear-btn').addEventListener('click', clearBoard);
  $('#export-btn').addEventListener('click', exportPng);
  $('#room-code').addEventListener('click', copyInvite);
  $('#zoom-in').addEventListener('click', () => engine.zoomBy(1.25));
  $('#zoom-out').addEventListener('click', () => engine.zoomBy(0.8));
  $('#zoom-label').addEventListener('click', () => engine.resetView());

  $('#voice-btn').addEventListener('click', async () => {
    if (voice.active) { voice.leave(); ui.toast('Left voice chat'); return; }
    try { await voice.join(users.values()); ui.toast('Voice connected — say hi!', 'ok'); }
    catch (err) { ui.toast(micError(err), 'error', 5000); }
  });
  $('#mute-btn').addEventListener('click', () => voice.setMuted(!voice.muted));

  $('#leave-btn').addEventListener('click', () => {
    voice.leave();
    socket.close();
    window.location.href = '/';
  });
}

/* ================================ Shortcuts ================================ */
function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t.matches?.('input[type="text"], input:not([type]), textarea, select, [contenteditable]');
    if (typing || document.querySelector('dialog[open]')) return;

    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;

    if (e.code === 'Space') {
      if (t.closest?.('button, input, select')) return;   // keep native keyboard activation
      e.preventDefault();
      engine.setSpace(true);
      return;
    }
    switch (k) {
      case 'p': setTool('pen'); break;
      case 'e': setTool('eraser'); break;
      case 'h': setTool('pan'); break;
      case '[': setSize(brush.size - 2); break;
      case ']': setSize(brush.size + 2); break;
      case '+': case '=': engine.zoomBy(1.25); break;
      case '-': engine.zoomBy(0.8); break;
      case '0': engine.resetView(); break;
      default: break;
    }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') engine.setSpace(false); });
  window.addEventListener('blur', () => engine.setSpace(false));
}

/* ================================== Utils ================================== */
/** Coalesce many tiny point arrays into one network message per `ms`. Local drawing is never delayed. */
function createBatcher(send, ms) {
  let id = null, buf = [], timer = null;
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (id && buf.length) send(id, buf);
    id = null; buf = [];
  };
  return {
    add(sid, pts) {
      if (id && id !== sid) flush();
      id = sid;
      for (const v of pts) buf.push(v);
      if (!timer) timer = setTimeout(flush, ms);
    },
    flush,
  };
}