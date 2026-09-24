import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { EntityActionsDirective, HOLD_MS, HOLD_SLOP_PX } from './entity-actions.directive';
import { EntityMenuService } from '../services/entity-menu.service';

@Component({
  standalone: true,
  imports: [EntityActionsDirective],
  template: `
    <a href="/x" data-testid="tile" [appEntityActions]="actions" (click)="clicks = clicks + 1">
      <button type="button" data-testid="inner">inner</button>
    </a>
  `,
})
class HostComponent {
  clicks = 0;
  actions = () => [{ label: 'Play', action: () => {} }];
}

function pointer(
  type: string,
  init: Partial<PointerEventInit> & { clientX?: number; clientY?: number } = {},
) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 10,
    ...init,
  });
  Object.defineProperty(e, 'pointerType', { value: init.pointerType ?? 'touch' });
  Object.defineProperty(e, 'isPrimary', { value: true });
  return e;
}

describe('EntityActionsDirective', () => {
  function setup() {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const menu = TestBed.inject(EntityMenuService);
    const open = vi.spyOn(menu, 'open');
    const el = fixture.nativeElement as HTMLElement;
    const tile = el.querySelector<HTMLElement>('[data-testid="tile"]')!;
    return { fixture, host: fixture.componentInstance, tile, el, menu, open };
  }

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove('tv-build');
  });

  it("right-click opens the menu at the pointer with the tile's actions, and suppresses the browser menu", () => {
    const { tile, open } = setup();
    const e = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 50,
    });
    tile.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith({
      actions: [expect.objectContaining({ label: 'Play' })],
      at: { x: 40, y: 50 },
    });
  });

  it('a touch hold opens the menu after HOLD_MS and eats the click that follows', () => {
    const { tile, host, open } = setup();
    tile.dispatchEvent(pointer('pointerdown', { clientX: 20, clientY: 30 }));
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledWith({
      actions: expect.any(Array),
      at: { x: 20, y: 30 },
    });

    tile.dispatchEvent(pointer('pointerup'));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    tile.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(host.clicks).toBe(0);

    // Only that one click: the next tap is a tap again.
    tile.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(host.clicks).toBe(1);
  });

  it('a hold that moves past slop is a pan, not a hold', () => {
    const { tile, open } = setup();
    tile.dispatchEvent(pointer('pointerdown', { clientX: 20, clientY: 30 }));
    tile.dispatchEvent(pointer('pointermove', { clientX: 20, clientY: 30 + HOLD_SLOP_PX + 1 }));
    vi.advanceTimersByTime(HOLD_MS);
    expect(open).not.toHaveBeenCalled();
  });

  it('a release or a cancel before HOLD_MS opens nothing', () => {
    const { tile, open } = setup();
    tile.dispatchEvent(pointer('pointerdown'));
    tile.dispatchEvent(pointer('pointerup'));
    vi.advanceTimersByTime(HOLD_MS);
    tile.dispatchEvent(pointer('pointerdown'));
    tile.dispatchEvent(pointer('pointercancel'));
    vi.advanceTimersByTime(HOLD_MS);
    expect(open).not.toHaveBeenCalled();
  });

  it('a mouse press is not a hold (desktop has hover and right-click)', () => {
    const { tile, open } = setup();
    tile.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(HOLD_MS);
    expect(open).not.toHaveBeenCalled();
  });

  it('a hold on a button or link inside the tile belongs to that control', () => {
    const { el, open } = setup();
    el.querySelector<HTMLElement>('[data-testid="inner"]')!.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(HOLD_MS);
    expect(open).not.toHaveBeenCalled();
  });

  it('does nothing on the TV build', () => {
    document.documentElement.classList.add('tv-build');
    const { tile, open } = setup();
    tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    tile.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(HOLD_MS);
    expect(open).not.toHaveBeenCalled();
  });
});
