import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
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
    const openMenu = async () => {
      trig.focus();
      trig.click();
      fixture.detectChanges();
      // The autofocus lives in an injector effect keyed on the panel
      // viewChild — let the scheduler flush it, then render the outcome.
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const q = (sel: string) => root.querySelector<HTMLButtonElement>(sel)!;
    const key = (el: HTMLElement, key: string): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event;
    };
    return { fixture, trig, openMenu, q, key };
  }

  it('opening the menu focuses the first action', async () => {
    const { openMenu, q } = setupHost();
    await openMenu();
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
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
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
