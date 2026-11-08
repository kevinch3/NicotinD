import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverflowRevealDirective } from './overflow-reveal.directive';
import { REVEAL_PAUSE_MS } from '../lib/overflow-reveal';

@Component({
  standalone: true,
  imports: [OverflowRevealDirective],
  template: `
    <button>
      <p class="truncate playing" appOverflowReveal="always">{{ title }}</p>
    </button>
    <button>
      <p class="truncate listed" appOverflowReveal>{{ title }}</p>
    </button>
  `,
})
class HostComponent {
  title = 'A title far too long for the row it sits in';
}

/** jsdom has no layout: give an element a 200px box with `overflow` px more text. */
function overflowing(el: HTMLElement, overflow: number): void {
  let left = 0;
  Object.defineProperty(el, 'clientWidth', { get: () => 200 });
  Object.defineProperty(el, 'scrollWidth', { get: () => 200 + overflow });
  Object.defineProperty(el, 'scrollLeft', { get: () => left, set: (v: number) => (left = v) });
}

/** What the stub IntersectionObserver reports. One observer serves every name on the page. */
let onScreen = true;

class InViewObserver {
  constructor(private readonly cb: IntersectionObserverCallback) {}
  observe(el: Element): void {
    queueMicrotask(() =>
      this.cb(
        [
          {
            isIntersecting: onScreen,
            intersectionRatio: onScreen ? 1 : 0,
            target: el,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      ),
    );
  }
  unobserve(): void {}
}

function mount(pointer: boolean, visible = true) {
  onScreen = visible;
  vi.stubGlobal('IntersectionObserver', InViewObserver);
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: pointer && q.includes('hover: hover') }));
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  const root = fixture.nativeElement as HTMLElement;
  const playing = root.querySelector<HTMLElement>('.playing')!;
  const listed = root.querySelector<HTMLElement>('.listed')!;
  overflowing(playing, 120);
  overflowing(listed, 120);
  fixture.detectChanges();
  return { fixture, playing, listed };
}

describe('OverflowRevealDirective', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reads `="always"` as the playing title and a bare attribute as a list row', async () => {
    const { playing, listed } = mount(true);
    await Promise.resolve();
    vi.advanceTimersByTime(REVEAL_PAUSE_MS + 1500);
    expect(playing.scrollLeft).toBeGreaterThan(0);
    // A desktop list row waits for hover or focus.
    expect(listed.scrollLeft).toBe(0);
  });

  it('plays a list row on its own on touch, once it has settled', async () => {
    const { listed } = mount(false);
    await Promise.resolve();
    vi.advanceTimersByTime(3 * REVEAL_PAUSE_MS);
    expect(listed.scrollLeft).toBeGreaterThan(0);
  });

  it('keeps a name that is off screen still, even the playing title', async () => {
    const { playing, listed } = mount(false, false);
    await Promise.resolve();
    vi.advanceTimersByTime(4 * REVEAL_PAUSE_MS);
    expect(playing.scrollLeft).toBe(0);
    expect(listed.scrollLeft).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives an overflowing name its full text as a title, and stops on destroy', async () => {
    const { fixture, playing } = mount(true);
    expect(playing.getAttribute('title')).toBe('A title far too long for the row it sits in');
    await Promise.resolve();
    vi.advanceTimersByTime(REVEAL_PAUSE_MS + 1000);
    fixture.destroy();
    expect(playing.scrollLeft).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
