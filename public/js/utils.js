/** Small, dependency-free helpers. */

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const round1 = (v) => Math.round(v * 10) / 10;

/** Unique id. crypto.randomUUID needs a secure context, so we keep a fallback. */
export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Leading + trailing throttle with .cancel(). */
export function throttle(fn, ms) {
  let last = 0, timer = null, pending;
  const run = (args) => { last = performance.now(); timer = null; fn(...args); };
  const throttled = (...args) => {
    const wait = ms - (performance.now() - last);
    if (wait <= 0) { clearTimeout(timer); timer = null; run(args); }
    else { pending = args; if (!timer) timer = setTimeout(() => run(pending), wait); }
  };
  throttled.cancel = () => { clearTimeout(timer); timer = null; };
  return throttled;
}

export const initials = (name) =>
  (name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();

/** Storage that never throws (private mode, blocked cookies…). */
const safe = (getStore) => ({
  get(key) { try { return getStore().getItem(key); } catch { return null; } },
  set(key, value) { try { getStore().setItem(key, value); } catch { /* ignore */ } },
});
export const local = safe(() => localStorage);
export const session = safe(() => sessionStorage);