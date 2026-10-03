import { INK, MIN_SCALE, MAX_SCALE, ERASER_FACTOR } from './config.js';
import { clamp, round1, uid } from './utils.js';

const TAU = Math.PI * 2;

/**
 * CanvasEngine — everything about the drawing surface, and nothing about the network.
 *
 *  • Strokes live in a Map keyed by UUID. A stroke is { id, tool, color, size, points[], seq? }.
 *    `points` is a flat [x0,y0,x1,y1,…] array in WORLD coordinates.
 *  • The viewport is { x, y, scale }; screen = world * scale + (x, y).
 *  • Rendering replays all strokes ordered by server `seq` (local, un-acked strokes last).
 *    Because the eraser is itself a stroke (destination-out), the picture is a pure function
 *    of the ordered stroke list → every client converges to the same image.
 *  • The engine reports user intent through callbacks (onStrokeStart/Points/End, onCursor,
 *    onViewChange); the caller decides what to do with them (send over a socket, record history…).
 */
export class CanvasEngine {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks;

    this.strokes = new Map();
    this._sorted = null;          // cached render order (null = dirty)
    this._order = 0;              // local insertion counter (tie-breaker)

    this.view = { x: 0, y: 0, scale: 1 };
    this.tool = 'pen';
    this.color = INK;
    this.size = 4;
    this.dark = false;
    this.spaceDown = false;

    this.pointers = new Map();    // active pointers (for pinch)
    this._active = null;          // stroke currently being drawn by this user
    this._pan = null;
    this._pinch = null;
    this._raf = 0;
    this._dpr = 1;
    this._centered = false;
    this._ready = false;

    this._bindEvents();
    this._resize();
  }

  /* ------------------------------ Lifecycle ------------------------------ */
  /** Call once callbacks' dependencies exist. */
  start() {
    this._ready = true;
    this.cb.onViewChange?.(this.view);
    this.invalidate();
  }

  get strokeCount() { return this.strokes.size; }

  /* ----------------------------- Tool settings --------------------------- */
  setTool(tool) { this.tool = tool; this._setCursor(); }
  setColor(color) { this.color = color; }
  setSize(size) { this.size = size; }
  setTheme(dark) { this.dark = dark; this.invalidate(); }
  setSpace(down) { this.spaceDown = down; this._setCursor(); }

  _setCursor(force) {
    this.canvas.style.cursor = force || (this.tool === 'pan' || this.spaceDown ? 'grab' : 'crosshair');
  }

  /* ------------------------------ Stroke store --------------------------- */
  /** Idempotent insert/update. Used for remote strokes, redo, and reconnect replays. */
  upsertStroke(s) {
    const existing = this.strokes.get(s.id);
    if (existing) {
      existing.tool = s.tool; existing.color = s.color; existing.size = s.size;
      if (existing !== this._active && s.points) { existing.points = s.points.slice(); existing._b = null; }
      if (s.seq != null) existing.seq = s.seq;
    } else {
      this.strokes.set(s.id, {
        id: s.id, tool: s.tool, color: s.color, size: s.size,
        points: s.points.slice(), seq: s.seq, order: this._order++,
      });
    }
    this._sorted = null;
    this.invalidate();
  }

  appendPoints(id, pts) {
    const s = this.strokes.get(id);
    if (!s) return;
    for (const v of pts) s.points.push(v);
    s._b = null;
    this.invalidate();
  }

  setSeq(id, seq) {
    const s = this.strokes.get(id);
    if (!s) return;
    s.seq = seq;
    this._sorted = null;
    this.invalidate();
  }

  removeStroke(id) {
    if (this.strokes.delete(id)) { this._sorted = null; this.invalidate(); }
  }

  clear() { this.strokes.clear(); this._sorted = null; this.invalidate(); }

  /** Replace everything with a server snapshot, preserving the stroke being drawn right now. */
  replaceAll(list) {
    const keep = this._active;
    this.strokes.clear();
    if (keep) this.strokes.set(keep.id, keep);
    for (const s of list) {
      if (keep && s.id === keep.id) continue;
      this.strokes.set(s.id, { id: s.id, tool: s.tool, color: s.color, size: s.size, points: s.points.slice(), seq: s.seq, order: this._order++ });
    }
    this._sorted = null;
    this.invalidate();
  }

  /* -------------------------------- Viewport ----------------------------- */
  screenToWorld(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    return [(cx - r.left - this.view.x) / this.view.scale, (cy - r.top - this.view.y) / this.view.scale];
  }
  worldToScreen(wx, wy) { return [wx * this.view.scale + this.view.x, wy * this.view.scale + this.view.y]; }

  panBy(dx, dy) { this.view.x += dx; this.view.y += dy; this._viewChanged(); }

  /** Zoom keeping the world point under (cx, cy) [client coords] fixed. */
  zoomAt(factor, cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const next = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
    const k = next / this.view.scale;
    this.view.x = px - (px - this.view.x) * k;
    this.view.y = py - (py - this.view.y) * k;
    this.view.scale = next;
    this._viewChanged();
  }
  zoomBy(factor) {
    const r = this.canvas.getBoundingClientRect();
    this.zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
  }
  resetView() {
    this.view = { x: this._w / 2, y: this._h / 2, scale: 1 };
    this._viewChanged();
  }
  _viewChanged() { this.invalidate(); this.cb.onViewChange?.(this.view); }

  /* --------------------------------- Input ------------------------------- */
  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e));
    c.addEventListener('pointerleave', () => this.cb.onCursor?.(null, null));
    c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this._resize()).observe(c);
  }

  _down(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2) {               // two fingers → pinch/zoom, abandon stroke
      this._finishStroke();
      this._pan = null;
      this._startPinch();
      return;
    }
    if (this.pointers.size > 2) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;

    if (e.button === 1 || this.tool === 'pan' || this.spaceDown) {
      e.preventDefault();
      this._pan = { x: e.clientX, y: e.clientY };
      this._setCursor('grabbing');
      return;
    }
    this._beginStroke(e);
  }

  _move(e) {
    const [wx, wy] = this.screenToWorld(e.clientX, e.clientY);
    this.cb.onCursor?.(wx, wy);

    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pinch && this.pointers.size === 2) return this._updatePinch();
    if (this._pan) {
      this.panBy(e.clientX - this._pan.x, e.clientY - this._pan.y);
      this._pan = { x: e.clientX, y: e.clientY };
      return;
    }
    if (this._active && this.pointers.has(e.pointerId)) this._extendStroke(e);
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (this.pointers.size < 2) this._pinch = null;
    if (this._pan) { this._pan = null; this._setCursor(); }
    if (this._active) this._finishStroke();
  }

  _wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) this.zoomAt(Math.exp(-e.deltaY * 0.0075), e.clientX, e.clientY); // pinch / ctrl+wheel
    else this.panBy(-e.deltaX, -e.deltaY);                                                         // trackpad / wheel scroll
  }

  _startPinch() {
    const [a, b] = [...this.pointers.values()];
    this._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
  _updatePinch() {
    const [a, b] = [...this.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const p = this._pinch;
    this.panBy(cx - p.cx, cy - p.cy);
    this.zoomAt(d / p.d, cx, cy);
    this._pinch = { d, cx, cy };
  }

  /* ------------------------------- Drawing ------------------------------- */
  _beginStroke(e) {
    const [x, y] = this.screenToWorld(e.clientX, e.clientY);
    const eraser = this.tool === 'eraser';
    const stroke = {
      id: uid(),
      tool: eraser ? 'eraser' : 'pen',
      color: this.color,
      size: eraser ? this.size * ERASER_FACTOR : this.size,
      points: [round1(x), round1(y)],
      order: this._order++,
    };
    this.strokes.set(stroke.id, stroke);
    this._sorted = null;
    this._active = stroke;
    this.invalidate();
    this.cb.onStrokeStart?.(stroke);
  }

  _extendStroke(e) {
    const s = this._active;
    // Coalesced events recover the points the browser would otherwise drop at high speed.
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const minDist = 0.6 / this.view.scale;
    const added = [];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = this.screenToWorld(ev.clientX, ev.clientY);
      const n = s.points.length;
      const dx = x - s.points[n - 2], dy = y - s.points[n - 1];
      if (dx * dx + dy * dy < minDist * minDist) continue;
      const px = round1(x), py = round1(y);
      s.points.push(px, py);
      added.push(px, py);
    }
    if (added.length) {
      s._b = null;
      this.invalidate();
      this.cb.onStrokePoints?.(s.id, added);
    }
  }

  _finishStroke() {
    if (!this._active) return;
    const s = this._active;
    this._active = null;
    this.cb.onStrokeEnd?.(s);
  }

  /* ------------------------------- Rendering ----------------------------- */
  invalidate() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr; this._w = r.width; this._h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    if (!this._centered && r.width > 0) {          // put world origin mid-screen on first layout
      this.view.x = r.width / 2; this.view.y = r.height / 2; this._centered = true;
      if (this._ready) this.cb.onViewChange?.(this.view);
    }
    this.invalidate();
  }

  /** Strokes ordered by server sequence; un-acked local strokes (seq undefined) go last. */
  _ordered() {
    if (!this._sorted) {
      this._sorted = [...this.strokes.values()].sort(
        (a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || a.order - b.order,
      );
    }
    return this._sorted;
  }

  _render() {
    const { ctx, view, _dpr: dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    const cull = {            // visible rectangle in world space → skip off-screen strokes
      x0: -view.x / view.scale, y0: -view.y / view.scale,
      x1: (this._w - view.x) / view.scale, y1: (this._h - view.y) / view.scale,
    };
    this._paint(ctx, this._ordered(), cull);
  }

  _paint(ctx, list, cull) {
    for (const s of list) {
      if (cull && !this._intersects(s, cull)) continue;
      this._drawStroke(ctx, s);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawStroke(ctx, s) {
    const p = s.points, n = p.length / 2;
    if (!n) return;
    const eraser = s.tool === 'eraser';
    const color = eraser ? '#000' : this._resolveColor(s.color);
    ctx.globalCompositeOperation = eraser ? 'destination-out' : 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = s.size;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    if (n === 1) {                                   // single tap → dot
      ctx.beginPath();
      ctx.arc(p[0], p[1], s.size / 2, 0, TAU);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    // Quadratic smoothing through segment midpoints → silky curves from sparse input.
    for (let i = 1; i < n - 1; i++) {
      const cx = p[2 * i], cy = p[2 * i + 1];
      ctx.quadraticCurveTo(cx, cy, (cx + p[2 * i + 2]) / 2, (cy + p[2 * i + 3]) / 2);
    }
    ctx.lineTo(p[2 * (n - 1)], p[2 * (n - 1) + 1]);
    ctx.stroke();
  }

  _resolveColor(c) { return c === INK ? (this.dark ? '#f1f5f9' : INK) : c; }

  _bounds(s) {
    if (s._b) return s._b;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < s.points.length; i += 2) {
      const x = s.points[i], y = s.points[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return (s._b = [x0, y0, x1, y1]);
  }

  _intersects(s, c) {
    const b = this._bounds(s), pad = s.size;
    return !(b[2] + pad < c.x0 || b[0] - pad > c.x1 || b[3] + pad < c.y0 || b[1] - pad > c.y1);
  }

  /* --------------------------------- Export ------------------------------ */
  /** Render all ink to a PNG blob (cropped to content, 2× resolution, themed background). */
  exportPNG(background) {
    const list = this._ordered();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of list) {
      if (s.tool === 'eraser') continue;
      const b = this._bounds(s), pad = s.size;
      x0 = Math.min(x0, b[0] - pad); y0 = Math.min(y0, b[1] - pad);
      x1 = Math.max(x1, b[2] + pad); y1 = Math.max(y1, b[3] + pad);
    }
    if (!isFinite(x0)) return Promise.resolve(null);
    const margin = 40;
    x0 -= margin; y0 -= margin; x1 += margin; y1 += margin;
    const scale = Math.min(2, 8000 / Math.max(x1 - x0, y1 - y0));
    const w = Math.ceil((x1 - x0) * scale), h = Math.ceil((y1 - y0) * scale);

    const layer = document.createElement('canvas');   // ink on transparency (so erasers work)
    layer.width = w; layer.height = h;
    const lctx = layer.getContext('2d');
    lctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
    this._paint(lctx, list, null);

    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    octx.fillStyle = background;
    octx.fillRect(0, 0, w, h);
    octx.drawImage(layer, 0, 0);
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  }
}