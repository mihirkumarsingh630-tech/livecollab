/** Shared constants. Keep magic numbers here so every module agrees. */

// "Ink" is a theme-aware colour: rendered near-black in light mode and
// near-white in dark mode, so default strokes are always readable.
export const INK = '#0f172a';

export const PALETTE = [INK, '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 4;
export const ERASER_FACTOR = 3;        // eraser is 3× the brush slider value
export const CURSOR_INTERVAL_MS = 40;  // ~25 cursor updates / second
export const POINT_BATCH_MS = 30;      // stroke points are batched into one message per ~30 ms

export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // For restrictive corporate networks add a TURN server here.
];