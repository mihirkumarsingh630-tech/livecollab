import { INK, ERASER_FACTOR } from './config.js';
import { initials, local } from './utils.js';

/** DOM-only helpers. No networking and no canvas logic live here. */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* --------------------------------- Theme ---------------------------------- */
export function initTheme(onChange) {
  const apply = (dark) => {
    document.documentElement.classList.toggle('dark', dark);
    local.set('lc:theme', dark ? 'dark' : 'light');
    $$('.js-theme-toggle').forEach((b) => b.setAttribute('aria-pressed', String(dark)));
    onChange?.(dark);
  };
  apply(document.documentElement.classList.contains('dark'));
  $$('.js-theme-toggle').forEach((b) =>
    b.addEventListener('click', () => apply(!document.documentElement.classList.contains('dark'))));
}

/* --------------------------------- Landing -------------------------------- */
export function setLandingError(msg) { $('#landing-error').textContent = msg || ''; }
export function setLandingBusy(busy) {
  $('#create-btn').disabled = busy;
  $('#create-btn').textContent = busy ? 'Just a moment…' : 'Create a new room';
}
export function showApp(roomId) {
  $('#landing').hidden = true;
  $('#app').hidden = false;
  $('#room-code-text').textContent = roomId;
}

/* --------------------------------- Toasts --------------------------------- */
export function toast(message, kind = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 320); }, ms);
}

/* ----------------------------- Connection status -------------------------- */
const STATUS_TEXT = { open: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', closed: 'Disconnected' };
export function setStatus(state) {
  $('#status-dot').dataset.state = state;
  $('#status-text').textContent = STATUS_TEXT[state] || state;
  $('#offline-banner').hidden = state !== 'reconnecting';
}

/* --------------------------------- Toolbar -------------------------------- */
export function buildSwatches(palette, onPick) {
  const wrap = $('#swatches');
  wrap.replaceChildren();
  palette.forEach((color) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (color === INK ? ' swatch-ink' : '');
    if (color !== INK) b.style.background = color;
    b.dataset.color = color;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('aria-label', color === INK ? 'Ink (adapts to theme)' : `Colour ${color}`);
    b.addEventListener('click', () => onPick(color));
    wrap.appendChild(b);
  });
}

export function setTool(tool) {
  $$('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
}
export function setColor(color) {
  $$('.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.color === color)));
  if (/^#[0-9a-f]{6}$/i.test(color)) $('#color-input').value = color;
}
export function setBrushPreview({ size, color, tool }) {
  const dot = $('#size-dot');
  const d = Math.min(28, Math.max(4, tool === 'eraser' ? size * ERASER_FACTOR : size));
  dot.style.width = dot.style.height = `${d}px`;
  dot.classList.toggle('eraser', tool === 'eraser');
  dot.style.background = tool === 'eraser' ? '' : color === INK ? 'var(--ink)' : color;
}
export function setHistory(canUndo, canRedo) {
  $('#undo-btn').disabled = !canUndo;
  $('#redo-btn').disabled = !canRedo;
}
export function setZoom(scale) { $('#zoom-label').textContent = `${Math.round(scale * 100)}%`; }
export function hideHint() { $('#empty-hint').classList.add('gone'); }

/** Move the dotted background in lock-step with the viewport (infinite-canvas illusion). */
export function updateGrid(view) {
  let gs = 32 * view.scale;
  while (gs < 16) gs *= 2;
  const wrap = $('#board-wrap');
  wrap.style.setProperty('--gs', `${gs}px`);
  wrap.style.setProperty('--gx', `${((view.x % gs) + gs) % gs}px`);
  wrap.style.setProperty('--gy', `${((view.y % gs) + gs) % gs}px`);
}

/* ---------------------------------- People -------------------------------- */
export function renderUsers(list, selfId, speaking) {
  const MAX = 4;
  const stack = $('#user-stack');
  stack.replaceChildren();
  list.slice(0, MAX).forEach((u) => {
    const a = document.createElement('div');
    a.className = 'avatar' + (speaking.has(u.id) ? ' speaking' : '');
    a.style.background = u.color;
    a.textContent = initials(u.name);
    a.title = u.id === selfId ? `${u.name} (you)` : u.name;
    if (u.voice) { const m = document.createElement('i'); m.className = 'mic'; a.appendChild(m); }
    stack.appendChild(a);
  });
  if (list.length > MAX) {
    const more = document.createElement('div');
    more.className = 'avatar more';
    more.textContent = `+${list.length - MAX}`;
    stack.appendChild(more);
  }
  $('#user-count').textContent = `${list.length} online`;
}

export function setVoiceUI(active, muted) {
  const btn = $('#voice-btn');
  btn.setAttribute('aria-pressed', String(active));
  btn.title = active ? 'Leave voice chat' : 'Join voice chat';
  $('#voice-label').textContent = active ? 'Voice on' : 'Join voice';
  $('#mute-btn').hidden = !active;
  $('#mute-btn').setAttribute('aria-pressed', String(muted));
  $('#mute-btn').setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
}

/* --------------------------------- Dialog --------------------------------- */
export function confirmDialog({ title, text, okLabel }) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  dlg.querySelector('[value="ok"]').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}