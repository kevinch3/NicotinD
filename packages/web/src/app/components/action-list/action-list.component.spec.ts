import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActionListComponent,
  FLYOUT_WIDTH_PX,
  filterRows,
  flyoutSide,
} from './action-list.component';
import { BackButtonService } from '../../services/native/back-button.service';
import { TranslateService } from '../../services/translate.service';
import type { TrackAction } from '../track-row/track-row.component';

@Component({
  imports: [ActionListComponent],
  template: `<app-action-list
    [actions]="actions"
    [drillIn]="drillIn"
    (picked)="picked.push($event.label); $event.action()"
  />`,
})
class HostComponent {
  actions: TrackAction[] = [];
  drillIn = false;
  picked: string[] = [];
}

const noop = () => {};

function setup(actions: TrackAction[], drillIn: boolean) {
  TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [
      {
        provide: TranslateService,
        useValue: { t: (k: string) => `T(${k})`, lang: () => 'en', revision: () => 0 },
      },
    ],
  });
  const fixture = TestBed.createComponent(HostComponent);
  Object.assign(fixture.componentInstance, { actions, drillIn });
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
  };
  const row = (label: string) =>
    el.querySelector<HTMLElement>(`[data-testid="track-action-${label}"]`);
  const labels = (root: Element = el.querySelector('app-action-list')!) =>
    Array.from(root.querySelectorAll(':scope > button, :scope > div > input')).map((b) =>
      (b as HTMLElement).dataset['testid']!.slice('track-action-'.length),
    );
  return { fixture, el, settle, row, labels, back: TestBed.inject(BackButtonService) };
}

const MENU = (ran: string[]): TrackAction[] => [
  { label: 'Like', group: 'play', action: () => ran.push('Like') },
  {
    label: 'Go to artist',
    group: 'goto',
    action: noop,
    children: () => [
      { label: 'First Artist', action: () => ran.push('First Artist') },
      { label: 'Second Artist', action: () => ran.push('Second Artist') },
    ],
  },
  { label: 'Song info', group: 'info', action: noop },
];

describe('flyoutSide', () => {
  it('opens to the right when there is room, to the left when only the left has it', () => {
    expect(flyoutSide({ left: 100, right: 300 }, 1280)).toBe('right');
    expect(flyoutSide({ left: 900, right: 1200 }, 1280)).toBe('left');
    expect(flyoutSide({ left: 1056, right: 1280 - FLYOUT_WIDTH_PX }, 1280)).toBe('right');
  });

  it('stays on the right when neither side fits: clipped is better than off-screen left', () => {
    expect(flyoutSide({ left: 50, right: 350 }, 400)).toBe('right');
  });
});

describe('filterRows', () => {
  const rows: TrackAction[] = [
    { label: 'Find', action: noop, field: { kind: 'filter', placeholderKey: 'k' } },
    { label: 'Road Trip', action: noop },
    { label: 'Gym', action: noop },
  ];
  it('keeps field rows and the rows whose label contains the text, any case', () => {
    expect(filterRows(rows, 'ROAD').map((r) => r.label)).toEqual(['Find', 'Road Trip']);
    expect(filterRows(rows, '  ').map((r) => r.label)).toEqual(['Find', 'Road Trip', 'Gym']);
    expect(filterRows(rows, 'zzz').map((r) => r.label)).toEqual(['Find']);
  });
});

describe('ActionListComponent (#2009)', () => {
  it('draws rows as direct children, with a separator where the group changes', () => {
    const { el, labels } = setup(MENU([]), false);
    const list = el.querySelector('app-action-list')!;
    expect(labels()).toEqual(['Like', 'Go to artist', 'Song info']);
    expect(list.querySelectorAll(':scope > [role="separator"]')).toHaveLength(2);
    expect(Array.from(list.children).every((c) => c.parentElement === list)).toBe(true);
  });

  it('emits picked for a leaf row and runs nothing for a parent row', async () => {
    const ran: string[] = [];
    const { fixture, row, settle } = setup(MENU(ran), true);
    row('Like')!.click();
    expect(fixture.componentInstance.picked).toEqual(['Like']);
    row('Go to artist')!.click();
    await settle();
    expect(fixture.componentInstance.picked).toEqual(['Like']);
    expect(ran).toEqual(['Like']);
  });

  it('marks a parent row as one that opens a menu', () => {
    const { row } = setup(MENU([]), false);
    expect(row('Go to artist')!.getAttribute('aria-haspopup')).toBe('menu');
    expect(row('Go to artist')!.querySelector('[data-menu-item-submenu]')).not.toBeNull();
    expect(row('Like')!.hasAttribute('aria-haspopup')).toBe(false);
  });

  describe('drill-in (phone sheet, TV)', () => {
    it('replaces the list with the submenu under a Back row, and Back returns', async () => {
      const ran: string[] = [];
      const { fixture, el, row, labels, settle } = setup(MENU(ran), true);
      row('Go to artist')!.click();
      await settle();
      expect(labels()).toEqual(['Back', 'First Artist', 'Second Artist']);
      expect(el.querySelector('[data-testid="menu-flyout"]')).toBeNull();

      row('Second Artist')!.click();
      expect(fixture.componentInstance.picked).toEqual(['Second Artist']);
      expect(ran).toEqual(['Second Artist']);

      row('Back')!.click();
      await settle();
      expect(labels()).toEqual(['Like', 'Go to artist', 'Song info']);
    });

    it('hardware Back leaves the submenu first, and is not held once back at the top', async () => {
      const { row, labels, settle, back } = setup(MENU([]), true);
      expect(back.stack.handleBack()).toBe(false);
      row('Go to artist')!.click();
      await settle();
      expect(back.stack.handleBack()).toBe(true);
      await settle();
      expect(labels()).toEqual(['Like', 'Go to artist', 'Song info']);
      expect(back.stack.handleBack()).toBe(false);
    });

    it('Right on a parent row opens it and Left returns', async () => {
      const { row, labels, settle } = setup(MENU([]), true);
      row('Go to artist')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      await settle();
      expect(labels()).toEqual(['Back', 'First Artist', 'Second Artist']);
      row('First Artist')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
      await settle();
      expect(labels()).toEqual(['Like', 'Go to artist', 'Song info']);
    });

    it('stays in the submenu when the menu rebuilds its rows underneath', async () => {
      const { fixture, row, labels, settle } = setup(MENU([]), true);
      row('Go to artist')!.click();
      await settle();
      // What a like or a download's progress does: a new list of new objects.
      fixture.componentInstance.actions = MENU([]);
      fixture.changeDetectorRef.markForCheck();
      await settle();
      expect(labels()).toEqual(['Back', 'First Artist', 'Second Artist']);
    });
  });

  describe('flyout (desktop popover)', () => {
    it('opens the submenu beside the row and leaves the list in place', async () => {
      const ran: string[] = [];
      const { fixture, el, row, labels, settle } = setup(MENU(ran), false);
      row('Go to artist')!.click();
      await settle();
      expect(labels()).toEqual(['Like', 'Go to artist', 'Song info']);
      const flyout = el.querySelector<HTMLElement>('[data-testid="menu-flyout"]')!;
      expect(flyout.classList.contains('absolute')).toBe(true);
      expect(labels(flyout.querySelector('app-action-list')!)).toEqual([
        'First Artist',
        'Second Artist',
      ]);
      expect(row('Go to artist')!.getAttribute('aria-expanded')).toBe('true');

      flyout.querySelector<HTMLElement>('[data-testid="track-action-First Artist"]')!.click();
      expect(fixture.componentInstance.picked).toEqual(['First Artist']);
      expect(ran).toEqual(['First Artist']);
    });

    it('a second click on the parent row, or Back, closes the flyout', async () => {
      const { el, row, settle, back } = setup(MENU([]), false);
      row('Go to artist')!.click();
      await settle();
      row('Go to artist')!.click();
      await settle();
      expect(el.querySelector('[data-testid="menu-flyout"]')).toBeNull();
      row('Go to artist')!.click();
      await settle();
      expect(back.stack.handleBack()).toBe(true);
      await settle();
      expect(el.querySelector('[data-testid="menu-flyout"]')).toBeNull();
      expect(back.stack.handleBack()).toBe(false);
    });
  });

  describe('field rows', () => {
    const withFields = (created: string[]): TrackAction[] => [
      { label: 'Find a playlist', action: noop, field: { kind: 'filter', placeholderKey: 'find' } },
      {
        label: 'New playlist',
        action: noop,
        field: { kind: 'submit', placeholderKey: 'new', submit: (name) => created.push(name) },
      },
      { label: 'Road Trip', action: noop },
      { label: 'Gym', action: noop },
    ];
    const type = (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    it('a filter field narrows the rows beside it as you type', async () => {
      const { row, labels, settle } = setup(withFields([]), true);
      type(row('Find a playlist') as HTMLInputElement, 'gy');
      await settle();
      expect(labels()).toEqual(['Find a playlist', 'New playlist', 'Gym']);
    });

    it('a submit field runs with the trimmed text on Enter, and not when empty', () => {
      const created: string[] = [];
      const { fixture, row } = setup(withFields(created), true);
      const input = row('New playlist') as HTMLInputElement;
      input.value = '   ';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(created).toEqual([]);
      input.value = '  Sunday  ';
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      input.dispatchEvent(enter);
      expect(created).toEqual(['Sunday']);
      // Consumed, so the same key press cannot reopen the menu from its trigger.
      expect(enter.defaultPrevented).toBe(true);
      expect(fixture.componentInstance.picked).toEqual(['New playlist']);
    });

    it("an arrow key inside a field is the field's own: it does not leave the submenu", async () => {
      const menu: TrackAction[] = [{ label: 'Add', action: noop, children: () => withFields([]) }];
      const { row, labels, settle } = setup(menu, true);
      row('Add')!.click();
      await settle();
      row('Find a playlist')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
      await settle();
      expect(labels()[0]).toBe('Back');
    });
  });

  it('a submit field inside a flyout reaches the menu that owns the list', async () => {
    const created: string[] = [];
    const menu: TrackAction[] = [
      {
        label: 'Add',
        action: noop,
        children: async () => [
          {
            label: 'New playlist',
            action: noop,
            field: { kind: 'submit', placeholderKey: 'new', submit: (n) => created.push(n) },
          },
        ],
      },
    ];
    const { fixture, el, row, settle } = setup(menu, false);
    row('Add')!.click();
    await settle();
    const input = el.querySelector<HTMLInputElement>(
      '[data-testid="menu-flyout"] [data-testid="track-action-New playlist"]',
    )!;
    input.value = 'Sunday';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(created).toEqual(['Sunday']);
    expect(fixture.componentInstance.picked).toEqual(['New playlist']);
  });

  it('uses ARIA menu roles only when asked: rows, Back and the flyout together', async () => {
    const plain = setup(MENU([]), false);
    expect(plain.row('Like')!.hasAttribute('role')).toBe(false);
    plain.row('Go to artist')!.click();
    await plain.settle();
    expect(plain.el.querySelector('[data-testid="menu-flyout"]')!.getAttribute('role')).toBe(
      'group',
    );
  });

  it('waits for an async submenu', async () => {
    const menu: TrackAction[] = [
      { label: 'Add', action: noop, children: async () => [{ label: 'Loaded', action: noop }] },
    ];
    const { row, labels, settle } = setup(menu, true);
    row('Add')!.click();
    await settle();
    expect(labels()).toEqual(['Back', 'Loaded']);
  });
});
