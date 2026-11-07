import { TestBed } from '@angular/core/testing';
import { HomeViewSwitchComponent, homeViewIcon } from './home-view-switch.component';
import { setInputValue } from '../../../testing/signal-input';

describe('homeViewIcon', () => {
  it('gives each view its glyph', () => {
    expect(homeViewIcon('mosaic')).toBe('layout-grid');
    expect(homeViewIcon('shelves')).toBe('rows-3');
  });
});

describe('HomeViewSwitchComponent', () => {
  function setup(view: 'mosaic' | 'shelves') {
    TestBed.configureTestingModule({ imports: [HomeViewSwitchComponent] });
    const fixture = TestBed.createComponent(HomeViewSwitchComponent);
    setInputValue(fixture.componentInstance.view, view);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    return { fixture, el };
  }

  it('is a radiogroup with one checked option matching the view', () => {
    const { el } = setup('shelves');
    const group = el.querySelector('[data-testid="home-view-switch"]')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(
      el.querySelector('[data-testid="home-view-shelves"]')!.getAttribute('aria-checked'),
    ).toBe('true');
    expect(el.querySelector('[data-testid="home-view-mosaic"]')!.getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('emits the other view on click, never the current one', () => {
    const { fixture, el } = setup('mosaic');
    const emitted: string[] = [];
    fixture.componentInstance.viewSelected.subscribe((v: string) => emitted.push(v));
    (el.querySelector('[data-testid="home-view-mosaic"]') as HTMLButtonElement).click();
    (el.querySelector('[data-testid="home-view-shelves"]') as HTMLButtonElement).click();
    expect(emitted).toEqual(['shelves']);
  });

  it('clears the 44px touch floor on both options', () => {
    const { el } = setup('mosaic');
    for (const id of ['home-view-mosaic', 'home-view-shelves']) {
      const cls = el.querySelector(`[data-testid="${id}"]`)!.className;
      expect(cls, id).toMatch(/\bmin-h-11\b/);
    }
  });

  it('labels only the active option, keeping both names accessible', () => {
    const { el } = setup('shelves');
    const label = (id: string) =>
      el.querySelector(`[data-testid="${id}"] [data-testid="home-view-label"]`) as HTMLElement;
    const shelves = label('home-view-shelves');
    const mosaic = label('home-view-mosaic');
    expect(shelves).not.toBeNull();
    expect(mosaic).not.toBeNull();
    expect(shelves.classList.contains('sr-only')).toBe(false);
    expect(mosaic.classList.contains('sr-only')).toBe(true);
    expect(shelves.textContent!.trim()).not.toBe('');
    expect(mosaic.textContent!.trim()).not.toBe('');
  });

  it('every option carries an icon', () => {
    const { el } = setup('mosaic');
    for (const id of ['home-view-mosaic', 'home-view-shelves']) {
      expect(el.querySelectorAll(`[data-testid="${id}"] app-icon`).length, id).toBe(1);
    }
  });

  it('floats semi-opaque with no blur, so it never paints under the open sheet (#1649)', () => {
    const { el } = setup('mosaic');
    const classes = [...el.querySelector('[data-testid="home-view-switch"]')!.classList];
    expect(classes.filter((c) => c.startsWith('backdrop-blur'))).toEqual([]);
    expect(classes).toContain('bg-theme-surface-2/90');
  });

  it('an icon-only option still clears the 44px floor', () => {
    const { el } = setup('mosaic');
    const cls = el.querySelector('[data-testid="home-view-shelves"]')!.className;
    expect(cls).toMatch(/\bmin-w-11\b/);
    expect(cls).toMatch(/\bmin-h-11\b/);
  });
});
