/**
 * createPointerDrag — the shared skeleton behind every pointer-drag gesture in the
 * app (sheet dismiss, panel resize, seek scrub). Wires `document` pointermove +
 * a one-shot pointerup on `start()`, exposes a `dragging` signal, and — crucially —
 * detaches its listeners automatically when the owning injection context is
 * destroyed, so a gesture interrupted by teardown can't leak document listeners.
 *
 * Call sites keep their own math/threshold logic in the handlers; the primitive
 * owns only the left-button guard and the listener lifecycle.
 *
 * Must be called within an injection context (component field/constructor).
 */
import { DestroyRef, inject, signal, type Signal } from '@angular/core';

export interface PointerDragHandlers {
  /** Capture start coordinates / state. Receives the originating pointerdown. */
  onStart?: (e: PointerEvent) => void;
  /** Fires on each document pointermove with the move event and the start event. */
  onMove?: (e: PointerEvent, start: PointerEvent) => void;
  /** Fires once on pointerup with the up event and the start event. */
  onEnd?: (e: PointerEvent, start: PointerEvent) => void;
}

export interface PointerDrag {
  /** True between a successful `start()` and the following pointerup/teardown. */
  readonly dragging: Signal<boolean>;
  /** Bind to `(pointerdown)`. No-op for non-primary buttons. */
  start: (e: PointerEvent) => void;
}

export function createPointerDrag(handlers: PointerDragHandlers): PointerDrag {
  const dragging = signal(false);
  let startEvent: PointerEvent | null = null;

  const onMove = (e: PointerEvent): void => {
    if (startEvent) handlers.onMove?.(e, startEvent);
  };

  const detach = (): void => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    startEvent = null;
    dragging.set(false);
  };

  function onUp(e: PointerEvent): void {
    const start = startEvent;
    detach();
    if (start) handlers.onEnd?.(e, start);
  }

  const start = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    startEvent = e;
    handlers.onStart?.(e);
    dragging.set(true);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp, { once: true });
  };

  inject(DestroyRef).onDestroy(detach);

  return { dragging, start };
}
