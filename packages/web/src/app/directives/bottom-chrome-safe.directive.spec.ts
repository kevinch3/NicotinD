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
});
