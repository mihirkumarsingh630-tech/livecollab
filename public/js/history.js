/**
 * History — LOCAL undo/redo (you can only undo your own strokes, like Figma/Miro).
 *
 * An undo is expressed as "remove stroke <id>" and a redo as "upsert stroke <id>",
 * both of which are idempotent network operations, so history never needs
 * to rewrite shared state — it only replays small, safe ops.
 */
const MAX_DEPTH = 200;

export class History {
  constructor({ onChange } = {}) {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = onChange;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** Record a freshly completed stroke. A new action invalidates the redo branch. */
  record(stroke) {
    this.undoStack.push(stroke);
    if (this.undoStack.length > MAX_DEPTH) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onChange?.();
  }

  undo() {
    const s = this.undoStack.pop();
    if (s) { this.redoStack.push(s); this.onChange?.(); }
    return s || null;
  }

  redo() {
    const s = this.redoStack.pop();
    if (s) { this.undoStack.push(s); this.onChange?.(); }
    return s || null;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.onChange?.();
  }
}