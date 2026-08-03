import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PullToRefreshService } from './pull-to-refresh.service';

const calls: string[] = [];

@Component({ standalone: true, template: '' })
class RegistrantComponent {
  /** Set before each createComponent; captured per instance so two live
   *  registrants stay distinguishable (a shared static handler could not
   *  prove WHICH registration ran). */
  static nextHandler: () => Promise<void> | void = () => {};
  private readonly handler = RegistrantComponent.nextHandler;
  constructor() {
    inject(PullToRefreshService).register(() => this.handler());
  }
}

describe('PullToRefreshService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function svc(): PullToRefreshService {
    return TestBed.inject(PullToRefreshService);
  }

  it('has no handler until one registers; trigger is a no-op', async () => {
    const s = svc();
    expect(s.hasHandler()).toBe(false);
    await s.trigger();
    expect(s.refreshing()).toBe(false);
  });

  it('runs the last-registered handler and unregisters on host destroy', async () => {
    const s = svc();
    calls.length = 0;

    RegistrantComponent.nextHandler = () => void calls.push('first');
    const first = TestBed.createComponent(RegistrantComponent);

    RegistrantComponent.nextHandler = () => void calls.push('second');
    const second = TestBed.createComponent(RegistrantComponent);
    expect(s.hasHandler()).toBe(true);

    const t1 = s.trigger();
    await vi.advanceTimersByTimeAsync(400);
    await t1;
    expect(calls).toEqual(['second']); // last registered wins

    second.destroy();
    const t2 = s.trigger();
    await vi.advanceTimersByTimeAsync(400);
    await t2;
    expect(calls).toEqual(['second', 'first']); // stack fell back to the survivor

    first.destroy();
    expect(s.hasHandler()).toBe(false);
  });

  it('holds refreshing for at least the minimum visible duration', async () => {
    const s = svc();
    RegistrantComponent.nextHandler = () => {}; // instant
    TestBed.createComponent(RegistrantComponent).detectChanges();

    const t = s.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.refreshing()).toBe(true);
    await vi.advanceTimersByTimeAsync(399);
    expect(s.refreshing()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await t;
    expect(s.refreshing()).toBe(false);
  });

  it('clears refreshing when the handler rejects', async () => {
    const s = svc();
    RegistrantComponent.nextHandler = () => Promise.reject(new Error('boom'));
    TestBed.createComponent(RegistrantComponent).detectChanges();

    const t = s.trigger();
    await vi.advanceTimersByTimeAsync(400);
    await t;
    expect(s.refreshing()).toBe(false);
  });

  it('times out a hung handler after 15s', async () => {
    const s = svc();
    RegistrantComponent.nextHandler = () => new Promise<void>(() => {}); // never settles
    TestBed.createComponent(RegistrantComponent).detectChanges();

    const t = s.trigger();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(s.refreshing()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await t;
    expect(s.refreshing()).toBe(false);
  });

  it('is re-entrancy guarded — a second trigger during a refresh is a no-op', async () => {
    const s = svc();
    let calls = 0;
    let resolveFirst: () => void = () => {};
    RegistrantComponent.nextHandler = () => {
      calls++;
      return new Promise<void>((r) => (resolveFirst = r));
    };
    TestBed.createComponent(RegistrantComponent).detectChanges();

    const t1 = s.trigger();
    const t2 = s.trigger();
    resolveFirst();
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([t1, t2]);
    expect(calls).toBe(1);
  });
});
