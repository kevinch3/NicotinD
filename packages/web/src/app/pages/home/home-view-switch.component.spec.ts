import { TestBed } from '@angular/core/testing';
import { HomeViewSwitchComponent } from './home-view-switch.component';
import { setInputValue } from '../../../testing/signal-input';

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
});
