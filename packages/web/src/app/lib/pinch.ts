/**
 * A two-finger pinch over one element (#2020).
 *
 * `down()` is fed every touch pointerdown on the element and answers whether
 * that touch made a second finger: the caller then stops treating the first
 * one as a drag. While two fingers are down, `onChange` reports their spread
 * as a ratio of the spread when the pinch began. The pinch ends when either
 * finger lifts; a finger left on the glass does nothing until it lifts too.
 *
 * Pointer ids are tracked here rather than in the caller's one-finger drag,
 * which follows whichever pointer moved last and so cannot tell two apart.
 */
export interface PinchHandlers {
  onStart?: () => void;
  /** The fingers' spread, as a ratio of what it was when the pinch began. */
  onChange: (ratio: number) => void;
  onEnd?: () => void;
}

export interface Pinch {
  /** Returns true when this touch began a pinch. */
  down: (e: PointerEvent) => boolean;
  /** Two fingers are down, or one of a pinch has not lifted yet. */
  active: () => boolean;
  destroy: () => void;
}

export function createPinch(handlers: PinchHandlers, doc: Document = document): Pinch {
  const touches = new Map<number, { x: number; y: number }>();
  let startSpread = 0;
  let pinching = false;
  /** A pinch ended with a finger still down: ignore it until every finger is up. */
  let spent = false;

  const spread = (): number => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onMove = (e: PointerEvent): void => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinching && startSpread > 0) handlers.onChange(spread() / startSpread);
  };

  const onUp = (e: PointerEvent): void => {
    if (!touches.delete(e.pointerId)) return;
    if (pinching) {
      pinching = false;
      spent = touches.size > 0;
      handlers.onEnd?.();
    }
    if (touches.size === 0) {
      spent = false;
      detach();
    }
  };

  function detach(): void {
    doc.removeEventListener('pointermove', onMove);
    doc.removeEventListener('pointerup', onUp);
    doc.removeEventListener('pointercancel', onUp);
  }

  return {
    down(e) {
      if (e.pointerType !== 'touch') return false;
      if (touches.size === 0) {
        doc.addEventListener('pointermove', onMove);
        doc.addEventListener('pointerup', onUp);
        doc.addEventListener('pointercancel', onUp);
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size !== 2 || pinching || spent) return false;
      startSpread = spread();
      if (startSpread <= 0) return false;
      pinching = true;
      handlers.onStart?.();
      return true;
    },
    active: () => pinching || spent,
    destroy() {
      touches.clear();
      pinching = false;
      spent = false;
      detach();
    },
  };
}
