import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createPointerDrag, PointerDrag } from './pointer-drag';

// jsdom lacks a PointerEvent constructor; MouseEvent carries clientX/Y + button
// and dispatches under any type string, so it stands in for pointer events here.
function pointer(type: string, clientY: number, button = 0): PointerEvent {
  return new MouseEvent(type, { clientY, button }) as unknown as PointerEvent;
}

@Component({ standalone: true, template: '' })
class HostComponent {
  starts = 0;
  moves: Array<{ e: PointerEvent; start: PointerEvent }> = [];
  ends: Array<{ e: PointerEvent; start: PointerEvent }> = [];

  readonly drag: PointerDrag = createPointerDrag({
    onStart: () => this.starts++,
    onMove: (e, start) => this.moves.push({ e, start }),
    onEnd: (e, start) => this.ends.push({ e, start }),
  });
}

describe('createPointerDrag', () => {
  function setup() {
    const fixture = TestBed.createComponent(HostComponent);
    return { fixture, host: fixture.componentInstance };
  }

  it('activates dragging on start and forwards document pointermove with the start event', () => {
    const { host } = setup();

    host.drag.start(pointer('pointerdown', 100));
    expect(host.drag.dragging()).toBe(true);
    expect(host.starts).toBe(1);

    document.dispatchEvent(pointer('pointermove', 150));
    expect(host.moves.length).toBe(1);
    expect(host.moves[0].e.clientY).toBe(150);
    expect(host.moves[0].start.clientY).toBe(100);
  });

  it('runs onEnd on pointerup, resets dragging, and stops further moves', () => {
    const { host } = setup();

    host.drag.start(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointerup', 200));

    expect(host.ends.length).toBe(1);
    expect(host.ends[0].e.clientY).toBe(200);
    expect(host.ends[0].start.clientY).toBe(100);
    expect(host.drag.dragging()).toBe(false);

    document.dispatchEvent(pointer('pointermove', 300));
    expect(host.moves.length).toBe(0);
  });

  it('ignores non-primary buttons', () => {
    const { host } = setup();

    host.drag.start(pointer('pointerdown', 100, 2)); // right-click
    expect(host.drag.dragging()).toBe(false);
    expect(host.starts).toBe(0);

    document.dispatchEvent(pointer('pointermove', 150));
    expect(host.moves.length).toBe(0);
  });

  it('detaches document listeners when the injection context is destroyed mid-drag', () => {
    const { fixture, host } = setup();

    host.drag.start(pointer('pointerdown', 100));
    fixture.destroy();

    document.dispatchEvent(pointer('pointermove', 150));
    expect(host.moves.length).toBe(0);
    expect(host.drag.dragging()).toBe(false);
  });
});

@Component({ standalone: true, template: '' })
class CancelHostComponent {
  ends: PointerEvent[] = [];
  cancels: PointerEvent[] = [];
  readonly dragWithCancel: PointerDrag = createPointerDrag({
    onEnd: (e) => this.ends.push(e),
    onCancel: (e) => this.cancels.push(e),
  });
  readonly dragWithoutCancel: PointerDrag = createPointerDrag({
    onEnd: (e) => this.ends.push(e),
  });
}

describe('pointercancel', () => {
  function setupCancel() {
    const fixture = TestBed.createComponent(CancelHostComponent);
    return { host: fixture.componentInstance };
  }

  it('routes pointercancel to onEnd when no onCancel handler is given', () => {
    const { host } = setupCancel();
    host.dragWithoutCancel.start(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointercancel', 150));
    expect(host.ends.length).toBe(1);
    expect(host.dragWithoutCancel.dragging()).toBe(false);
  });

  it('prefers onCancel over onEnd when provided', () => {
    const { host } = setupCancel();
    host.dragWithCancel.start(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointercancel', 150));
    expect(host.cancels.length).toBe(1);
    expect(host.ends.length).toBe(0);
  });

  it('detaches all listeners after a cancel — no further moves or ups fire', () => {
    const { host } = setupCancel();
    host.dragWithCancel.start(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointercancel', 150));
    document.dispatchEvent(pointer('pointermove', 200));
    document.dispatchEvent(pointer('pointerup', 200));
    expect(host.cancels.length).toBe(1);
    expect(host.ends.length).toBe(0);
  });
});
