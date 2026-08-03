import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BottomChromeSafeDirective } from './bottom-chrome-safe.directive';

@Component({
  standalone: true,
  imports: [BottomChromeSafeDirective],
  template: `<div appBottomChromeSafe class="backdrop" style="padding-bottom: 16px">
    <div class="dialog">content</div>
  </div>`,
})
class TestHostComponent {}

/** Stubs a `[data-bottom-chrome]` layer's `getBoundingClientRect` so
 *  `bottomChromeInset` sees it as overlapping the bottom `heightPx` of the
 *  viewport, mirroring how the real mini-player/tab-bar are measured. */
function addChromeLayer(heightPx: number, viewportHeight = 800): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-bottom-chrome', '');
  el.getBoundingClientRect = () =>
    ({ top: viewportHeight - heightPx, height: heightPx }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function setup() {
  TestBed.configureTestingModule({ imports: [TestHostComponent] });
  const fixture = TestBed.createComponent(TestHostComponent);
  const backdrop: HTMLElement = fixture.nativeElement.querySelector('.backdrop');
  return { fixture, backdrop };
}

describe('BottomChromeSafeDirective', () => {
  afterEach(() => {
    document.querySelectorAll('[data-bottom-chrome]').forEach((el) => el.remove());
  });

  it('leaves the backdrop padding untouched when no bottom chrome is present', () => {
    const { fixture, backdrop } = setup();
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    fixture.detectChanges();
    expect(backdrop.style.paddingBottom).toBe('16px');
  });

  it('adds the measured chrome height on top of the backdrop’s own padding', () => {
    addChromeLayer(144);
    const { fixture, backdrop } = setup();
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    fixture.detectChanges();
    // base 16px (from the inline style) + 144px measured chrome
    expect(backdrop.style.paddingBottom).toBe('160px');
  });

  it('makes the backdrop scrollable so content taller than the reserved space is reachable', () => {
    const { fixture, backdrop } = setup();
    fixture.detectChanges();
    expect(backdrop.style.overflowY).toBe('auto');
  });

  it('recomputes on window resize (e.g. the mini-player appearing after the modal opened)', () => {
    const { fixture, backdrop } = setup();
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    fixture.detectChanges();
    expect(backdrop.style.paddingBottom).toBe('16px');

    addChromeLayer(72);
    window.dispatchEvent(new Event('resize'));
    expect(backdrop.style.paddingBottom).toBe('88px');
  });

  it('ignores a chrome layer slid off-screen (e.g. the mini-player with no track loaded)', () => {
    // top at the viewport bottom — bottomChromeInset treats this as not overlapping.
    const el = document.createElement('div');
    el.setAttribute('data-bottom-chrome', '');
    el.getBoundingClientRect = () => ({ top: 800, height: 72 }) as DOMRect;
    document.body.appendChild(el);
    const { fixture, backdrop } = setup();
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    fixture.detectChanges();
    expect(backdrop.style.paddingBottom).toBe('16px');
  });

  it('publishes the measured inset as --bottom-chrome-inset so panels can self-bound', () => {
    addChromeLayer(144);
    const { fixture, backdrop } = setup();
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    fixture.detectChanges();
    expect(backdrop.style.getPropertyValue('--bottom-chrome-inset')).toBe('144px');
  });

  it('contains overscroll so backdrop scrolling never chains to the page behind', () => {
    const { fixture, backdrop } = setup();
    fixture.detectChanges();
    expect(backdrop.style.overscrollBehavior).toBe('contain');
  });

  it('recomputes when a chrome layer finishes a transition (mini-player slide-in)', () => {
    const { fixture, backdrop } = setup();
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    fixture.detectChanges();
    expect(backdrop.style.paddingBottom).toBe('16px');

    // The mini-player shows/hides via a transform *transition* — invisible to a
    // ResizeObserver (its box never changes size) — so the directive listens for
    // transitionend bubbling from any [data-bottom-chrome] layer.
    const chrome = addChromeLayer(72);
    chrome.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(backdrop.style.paddingBottom).toBe('88px');
  });

  describe('with ResizeObserver available', () => {
    let observed: Element[];
    let trigger: (() => void) | null;
    let disconnected: boolean;

    beforeEach(() => {
      observed = [];
      trigger = null;
      disconnected = false;
      // jsdom ships no ResizeObserver (the directive guards for that); install a
      // spec-local stub capturing the callback + observed targets. Never a global
      // polyfill in test-setup.ts — that would mask the guard.
      class ResizeObserverStub {
        constructor(cb: () => void) {
          trigger = cb;
        }
        observe(el: Element): void {
          observed.push(el);
        }
        disconnect(): void {
          disconnected = true;
        }
      }
      (globalThis as Record<string, unknown>)['ResizeObserver'] = ResizeObserverStub;
    });

    afterEach(() => {
      delete (globalThis as Record<string, unknown>)['ResizeObserver'];
    });

    it('re-measures when the dialog panel grows after async content loads', () => {
      const { fixture, backdrop } = setup();
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
      fixture.detectChanges();
      expect(backdrop.style.paddingBottom).toBe('16px');
      // Directive watches both the backdrop and the dialog panel inside it.
      expect(observed).toContain(backdrop);
      expect(observed).toContain(backdrop.firstElementChild);

      addChromeLayer(144);
      trigger?.();
      expect(backdrop.style.paddingBottom).toBe('160px');
    });

    it('disconnects the observer when the backdrop is destroyed', () => {
      const { fixture } = setup();
      fixture.detectChanges();
      fixture.destroy();
      expect(disconnected).toBe(true);
    });
  });
});
