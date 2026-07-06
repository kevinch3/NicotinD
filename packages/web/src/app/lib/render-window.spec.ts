import { describe, it, expect } from 'vitest';
import { signal } from '@angular/core';
import { createRenderWindow } from './render-window';

describe('createRenderWindow', () => {
  it('shows only the first page of a larger source', () => {
    const source = signal(Array.from({ length: 250 }, (_, i) => i));
    const win = createRenderWindow(source, 100);
    expect(win.visible()).toHaveLength(100);
    expect(win.hasMore()).toBe(true);
  });

  it('grows by one page each showMore(), then stops at the source length', () => {
    const source = signal(Array.from({ length: 250 }, (_, i) => i));
    const win = createRenderWindow(source, 100);

    win.showMore();
    expect(win.visible()).toHaveLength(200);
    expect(win.hasMore()).toBe(true);

    win.showMore();
    // Only 250 exist — the window never exceeds the source.
    expect(win.visible()).toHaveLength(250);
    expect(win.hasMore()).toBe(false);
  });

  it('reflects a shrinking source (e.g. after a delete) without exceeding it', () => {
    const source = signal(Array.from({ length: 150 }, (_, i) => i));
    const win = createRenderWindow(source, 100);
    win.showMore(); // count 200, source 150 → shows 150
    expect(win.visible()).toHaveLength(150);

    source.set(Array.from({ length: 10 }, (_, i) => i));
    expect(win.visible()).toHaveLength(10);
    expect(win.hasMore()).toBe(false);
  });

  it('never reports hasMore for a source smaller than a page', () => {
    const source = signal([1, 2, 3]);
    const win = createRenderWindow(source, 100);
    expect(win.visible()).toEqual([1, 2, 3]);
    expect(win.hasMore()).toBe(false);
  });

  it('reset() collapses back to the first page', () => {
    const source = signal(Array.from({ length: 500 }, (_, i) => i));
    const win = createRenderWindow(source, 100);
    win.showMore();
    win.showMore();
    expect(win.visible()).toHaveLength(300);
    win.reset();
    expect(win.visible()).toHaveLength(100);
  });
});
