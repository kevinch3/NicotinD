import { TestBed } from '@angular/core/testing';
import { MenuPanelComponent } from './menu-panel.component';

// The JIT harness can't drive `input()` or measure layout (jsdom), so the
// viewport math is covered by computeMenuPosition's pure spec. Here we test the
// component's own responsibility: the open/close state machine.
function setup() {
  TestBed.configureTestingModule({ imports: [MenuPanelComponent] });
  const fixture = TestBed.createComponent(MenuPanelComponent);
  fixture.detectChanges();
  return fixture.componentInstance;
}

describe('MenuPanelComponent', () => {
  it('starts closed', () => {
    expect(setup().open()).toBe(false);
  });

  it('toggles open/closed and stops the opening click from bubbling', () => {
    const c = setup();
    let stopped = 0;
    const evt = { stopPropagation: () => stopped++ } as unknown as Event;
    c.toggle(evt);
    expect(c.open()).toBe(true);
    c.toggle(evt);
    expect(c.open()).toBe(false);
    expect(stopped).toBe(2);
  });

  it('closes on outside click and on Escape', () => {
    const c = setup();
    c.toggle({ stopPropagation: () => {} } as unknown as Event);
    expect(c.open()).toBe(true);
    c.onDocClick();
    expect(c.open()).toBe(false);

    c.toggle({ stopPropagation: () => {} } as unknown as Event);
    c.onEsc();
    expect(c.open()).toBe(false);
  });
});
