/**
 * Minimal LIFO stack of "close the topmost overlay" handlers for the Android
 * hardware Back button (issue #394). An overlay (Now Playing sheet, track-info
 * sheet, an open menu) pushes a handler while it can consume Back; the
 * native BackButtonService walks the stack top-down and stops at the first
 * handler that reports it consumed the press. Deliberately NOT a
 * consolidation of the app's per-component Escape handlers — that
 * arbitration is a tracked follow-up.
 */
export type BackHandler = () => boolean;

export class BackHandlerStack {
  private readonly handlers: BackHandler[] = [];

  /** Registers `handler` on top of the stack; returns an idempotent
   *  unregister function that removes exactly this registration. */
  push(handler: BackHandler): () => void {
    this.handlers.push(handler);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  /** Runs handlers newest-first until one consumes the press. */
  handleBack(): boolean {
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      if (this.handlers[i]!()) return true;
    }
    return false;
  }
}
