/**
 * Cursors — renders other participants' pointers as DOM elements above the canvas.
 * Positions arrive in WORLD coordinates and are projected to screen space here, so
 * cursors stay glued to the right spot while anyone pans or zooms.
 */
const ARROW = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3l16 7-7 2.5L10.5 20z" fill="currentColor" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

export class Cursors {
  constructor(layer, engine) {
    this.layer = layer;
    this.engine = engine;
    this.items = new Map();
    this._t = 0;
  }

  /** Create or update the cursor element for a user. */
  upsert(user) {
    let it = this.items.get(user.id);
    if (!it) {
      const el = document.createElement('div');
      el.className = 'remote-cursor is-hidden';
      el.innerHTML = ARROW;
      const tag = document.createElement('span');
      tag.className = 'tag';
      el.appendChild(tag);
      this.layer.appendChild(el);
      it = { el, tag, x: null, y: null };
      this.items.set(user.id, it);
    }
    it.tag.textContent = user.name;          // textContent → names can't inject HTML
    it.el.style.color = user.color;
    it.tag.style.background = user.color;
  }

  move(id, x, y) {
    const it = this.items.get(id);
    if (!it) return;
    it.x = x; it.y = y;
    it.el.classList.remove('is-hidden');
    this._place(it);
  }

  hide(id) { this.items.get(id)?.el.classList.add('is-hidden'); }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return;
    it.el.remove();
    this.items.delete(id);
  }

  has(id) { return this.items.has(id); }
  ids() { return [...this.items.keys()]; }

  /** Re-project everything after pan/zoom (transitions off so cursors don't lag the canvas). */
  refresh() {
    this.layer.classList.add('instant');
    for (const it of this.items.values()) if (it.x != null) this._place(it);
    clearTimeout(this._t);
    this._t = setTimeout(() => this.layer.classList.remove('instant'), 120);
  }

  _place(it) {
    const [sx, sy] = this.engine.worldToScreen(it.x, it.y);
    it.el.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;
  }
}