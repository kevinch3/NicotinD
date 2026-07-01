import { TestBed } from '@angular/core/testing';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  let svc: ToastService;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(ToastService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('show() adds a toast and returns an ID', () => {
    const id = svc.show({ message: 'Hello', kind: 'info' });
    expect(typeof id).toBe('string');
    expect(svc.toasts().find((t) => t.id === id)?.message).toBe('Hello');
  });

  it('dismiss() removes the toast by ID', () => {
    const id = svc.show({ message: 'Hi', kind: 'success' });
    svc.dismiss(id);
    expect(svc.toasts().find((t) => t.id === id)).toBeUndefined();
  });

  it('auto-dismisses non-countdown toasts after duration (default 4s)', () => {
    const id = svc.show({ message: 'Auto', kind: 'info' });
    expect(svc.toasts().find((t) => t.id === id)).toBeDefined();
    vi.advanceTimersByTime(4000);
    expect(svc.toasts().find((t) => t.id === id)).toBeUndefined();
  });

  it('respects custom duration', () => {
    const id = svc.show({ message: 'Custom', kind: 'info', duration: 2 });
    vi.advanceTimersByTime(1999);
    expect(svc.toasts().find((t) => t.id === id)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(svc.toasts().find((t) => t.id === id)).toBeUndefined();
  });

  it('getCountdownPct() returns 100 at start and decreases toward 0', () => {
    const id = svc.show({ message: 'Count', kind: 'info', countdown: 3 });
    expect(svc.getCountdownPct(id)).toBe(100);
    vi.advanceTimersByTime(1500);
    const pct = svc.getCountdownPct(id);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
  });

  it('fires first action and dismisses when countdown expires', () => {
    const cb = vi.fn();
    const id = svc.show({
      message: 'Count',
      kind: 'info',
      countdown: 3,
      actions: [{ label: 'Go', callback: cb }],
    });
    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(svc.toasts().find((t) => t.id === id)).toBeUndefined();
  });

  it('countdown toasts do not auto-dismiss early on non-countdown timer path', () => {
    const cb = vi.fn();
    const id = svc.show({
      message: 'Count',
      kind: 'info',
      countdown: 10,
      actions: [{ label: 'Go', callback: cb }],
    });
    vi.advanceTimersByTime(4000); // default auto-dismiss would fire at 4s
    expect(svc.toasts().find((t) => t.id === id)).toBeDefined();
    expect(cb).not.toHaveBeenCalled();
  });

  it('caps at 3 active toasts, evicting oldest non-countdown toast', () => {
    const id1 = svc.show({ message: '1', kind: 'info', duration: 60 });
    const id2 = svc.show({ message: '2', kind: 'info', duration: 60 });
    const id3 = svc.show({ message: '3', kind: 'info', duration: 60 });
    svc.show({ message: '4', kind: 'info', duration: 60 });
    const ids = svc.toasts().map((t) => t.id);
    expect(ids).not.toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).toContain(id3);
    expect(ids).toHaveLength(3);
  });

  it('drops the 4th toast when all existing toasts are countdowns', () => {
    svc.show({ message: 'CD1', kind: 'info', countdown: 10 });
    svc.show({ message: 'CD2', kind: 'info', countdown: 10 });
    svc.show({ message: 'CD3', kind: 'info', countdown: 10 });
    const id4 = svc.show({ message: 'CD4', kind: 'info', countdown: 10 });
    expect(svc.toasts()).toHaveLength(3);
    expect(svc.toasts().find((t) => t.id === id4)).toBeUndefined();
  });

  it('does not evict countdown toasts when at capacity', () => {
    const cdId = svc.show({ message: 'CD', kind: 'info', countdown: 10 });
    svc.show({ message: '2', kind: 'info', duration: 60 });
    svc.show({ message: '3', kind: 'info', duration: 60 });
    svc.show({ message: '4', kind: 'info', duration: 60 }); // evicts oldest non-countdown
    expect(svc.toasts().find((t) => t.id === cdId)).toBeDefined();
  });
});
