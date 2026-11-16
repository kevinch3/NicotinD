import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { By } from '@angular/platform-browser';
import { MenuPanelComponent, naturalPanelHeight } from './menu-panel.component';
import { BackButtonService } from '../../services/native/back-button.service';

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
    // Escape now routes through the shared BackHandlerStack (issue #398): the
    // open menu registered a closer there, and one press closes it.
    expect(TestBed.inject(BackButtonService).stack.handleBack()).toBe(true);
    expect(c.open()).toBe(false);
  });
});

describe('MenuPanelComponent D-pad support (issue #389)', () => {
  @Component({
    standalone: true,
    imports: [MenuPanelComponent],
    template: `
      <app-menu-panel #menu>
        <button menuTrigger class="trig">open</button>
        <div menuPanel>
          <button class="a1" (click)="menu.close()">one</button>
          <button class="a2">two</button>
          <button class="a3">three</button>
        </div>
      </app-menu-panel>
    `,
  })
  class MenuHost {}

  function setupHost() {
    TestBed.configureTestingModule({ imports: [MenuHost] });
    const fixture = TestBed.createComponent(MenuHost);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    const trig = root.querySelector<HTMLButtonElement>('.trig')!;
    const menu = fixture.debugElement.query(By.directive(MenuPanelComponent))
      .componentInstance as MenuPanelComponent;
    // jsdom cannot measure, and signal view queries never populate here, so
    // `reposition()` never runs, nor the view check after it: `place()`
    // stands in for both.
    const place = () => {
      menu.positioned.set(true);
      fixture.detectChanges();
      menu.ngAfterViewChecked();
    };
    const openMenu = async () => {
      trig.focus();
      trig.click();
      fixture.detectChanges();
      await fixture.whenStable();
      place();
    };
    const q = (sel: string) => root.querySelector<HTMLButtonElement>(sel)!;
    const key = (el: HTMLElement, key: string): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event;
    };
    return { fixture, trig, openMenu, place, q, key };
  }

  it('opening the menu focuses the first action', async () => {
    const { openMenu, q } = setupHost();
    await openMenu();
    expect(document.activeElement).toBe(q('.a1'));
  });

  it('waits for the panel to be positioned before focusing the first action (#1862)', async () => {
    const { fixture, trig, place, q } = setupHost();
    trig.focus();
    trig.click();
    fixture.detectChanges();
    await fixture.whenStable();
    // Still visibility:hidden — focus() there is a no-op in a real browser.
    expect(document.activeElement).toBe(trig);
    place();
    expect(document.activeElement).toBe(q('.a1'));
  });

  it('ArrowDown/ArrowUp move between actions, clamped at the ends, and never leak to ancestors', async () => {
    const { fixture, openMenu, q, key } = setupHost();
    await openMenu();
    const down = key(q('.a1'), 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(q('.a2'));
    expect(down.defaultPrevented).toBe(true);
    key(q('.a2'), 'ArrowDown');
    key(q('.a3'), 'ArrowDown'); // clamped at the last action
    fixture.detectChanges();
    expect(document.activeElement).toBe(q('.a3'));
    key(q('.a3'), 'ArrowUp');
    fixture.detectChanges();
    expect(document.activeElement).toBe(q('.a2'));
  });

  it('Escape restores focus to the trigger', async () => {
    const { fixture, openMenu, trig, q } = setupHost();
    await openMenu();
    expect(document.activeElement).toBe(q('.a1'));
    TestBed.inject(BackButtonService).stack.handleBack();
    fixture.detectChanges();
    expect(document.activeElement).toBe(trig);
  });

  it('activating an action (which closes the menu) restores focus to the trigger', async () => {
    const { fixture, openMenu, trig, q } = setupHost();
    await openMenu();
    q('.a1').click();
    fixture.detectChanges();
    expect(document.activeElement).toBe(trig);
  });
});

// #2009: a submenu flyout hangs outside the menu's body and must not make the
// menu look taller than it is.
describe('naturalPanelHeight', () => {
  const el = (offsetHeight: number, scrollHeight = offsetHeight) => {
    const d = document.createElement('div');
    Object.defineProperty(d, 'offsetHeight', { value: offsetHeight });
    Object.defineProperty(d, 'scrollHeight', { value: scrollHeight });
    return d;
  };

  it('is the height of the projected body, not what overflows beside it', () => {
    const panel = el(300, 620);
    panel.appendChild(el(300));
    expect(naturalPanelHeight(panel, 300)).toBe(300);
  });

  it("is the body's full height while a max-height caps the box", () => {
    const panel = el(200, 480);
    panel.appendChild(el(480));
    expect(naturalPanelHeight(panel, 200)).toBe(480);
  });

  it('adds up several bodies, and falls back to the scroll height with none', () => {
    const two = el(0);
    two.appendChild(el(120));
    two.appendChild(el(80));
    expect(naturalPanelHeight(two, 0)).toBe(200);
    expect(naturalPanelHeight(el(100, 240), 100)).toBe(240);
  });
});
