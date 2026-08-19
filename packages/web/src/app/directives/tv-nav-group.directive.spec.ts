import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TvNavGroupDirective } from './tv-nav-group.directive';
import { TvNavItemDirective } from './tv-nav-item.directive';

@Component({
  standalone: true,
  imports: [TvNavGroupDirective, TvNavItemDirective],
  template: `
    <div appTvNavGroup axis="vertical">
      @for (label of items; track label) {
        <button appTvNavItem>{{ label }}</button>
      }
      <button class="plain-non-item">plain</button>
    </div>
  `,
})
class TestHostComponent {
  items = ['a', 'b', 'c'];
}

function setup() {
  TestBed.configureTestingModule({ imports: [TestHostComponent] });
  const fixture = TestBed.createComponent(TestHostComponent);
  fixture.detectChanges();
  const allButtons: HTMLButtonElement[] = Array.from(
    fixture.nativeElement.querySelectorAll('button'),
  );
  const buttons = allButtons.filter((b) => !b.classList.contains('plain-non-item'));
  const plainButton = allButtons.find((b) => b.classList.contains('plain-non-item'))!;
  return { fixture, buttons, plainButton };
}

function keydown(el: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

describe('TvNavGroupDirective + TvNavItemDirective', () => {
  it('the first item defaults to tabindex 0, the rest -1', () => {
    const { buttons } = setup();
    expect(buttons[0]!.getAttribute('tabindex')).toBe('0');
    expect(buttons[1]!.getAttribute('tabindex')).toBe('-1');
    expect(buttons[2]!.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowDown moves focus and roving tabindex to the next item', () => {
    const { fixture, buttons } = setup();
    buttons[0]!.focus();
    keydown(buttons[0]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1]!.getAttribute('tabindex')).toBe('0');
    expect(buttons[0]!.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowUp moves focus back to the previous item', () => {
    const { fixture, buttons } = setup();
    buttons[1]!.focus();
    keydown(buttons[1]!, 'ArrowDown');
    fixture.detectChanges();
    keydown(buttons[2]!, 'ArrowUp');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('ArrowUp at the first item does not move focus (no wrap) but IS preventDefaulted', () => {
    const { fixture, buttons } = setup();
    buttons[0]!.focus();
    const event = keydown(buttons[0]!, 'ArrowUp');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[0]);
    // Focus does not move, but the press is NOT prevented — see the issue #436
    // cases below. The seek-shortcut leak this used to guard against is
    // ArrowLeft/Right only, which the horizontal-axis test still pins.
    expect(event.defaultPrevented).toBe(false);
  });

  it('ArrowDown at the last item does not move focus (no wrap)', () => {
    const { fixture, buttons } = setup();
    buttons[2]!.focus();
    fixture.detectChanges();
    const event = keydown(buttons[2]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[2]);
  });

  it('a key this axis does not navigate by is left un-prevented and keeps bubbling', () => {
    const { fixture, buttons } = setup();
    buttons[0]!.focus();
    const event = keydown(buttons[0]!, 'ArrowRight'); // vertical group: not a nav key
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[0]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('End jumps to the last item, Home jumps back to the first', () => {
    const { fixture, buttons } = setup();
    buttons[0]!.focus();
    keydown(buttons[0]!, 'End');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[2]);
    keydown(buttons[2]!, 'Home');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('clicking/tabbing directly into a non-active item updates roving tabindex via focusin', () => {
    const { fixture, buttons } = setup();
    buttons[2]!.focus();
    fixture.detectChanges();
    expect(buttons[2]!.getAttribute('tabindex')).toBe('0');
    expect(buttons[0]!.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowDown clamped at the last item is left un-prevented so spatial nav can escape (issue #436)', () => {
    // The WebView's spatial navigation is what carries focus OUT of a list and
    // down into the player chrome. preventDefault stopped the WebView seeing
    // the press at all, so focus was trapped: DOWN x8 on the last track row
    // never left the list, and the mini-player below was unreachable by D-pad.
    const { fixture, buttons } = setup();
    buttons[2]!.focus();
    fixture.detectChanges();
    const event = keydown(buttons[2]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[2]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ArrowUp clamped at the first item is left un-prevented too (issue #436)', () => {
    const { fixture, buttons } = setup();
    buttons[0]!.focus();
    const event = keydown(buttons[0]!, 'ArrowUp');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[0]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('a clamped Home/End is still prevented — they are not spatial-nav keys', () => {
    const { fixture, buttons } = setup();
    buttons[0]!.focus();
    fixture.detectChanges();
    const event = keydown(buttons[0]!, 'Home');
    fixture.detectChanges();
    expect(event.defaultPrevented).toBe(true);
  });

  it('a clamped ArrowRight in a HORIZONTAL group is still prevented — the seek guard (issue #436)', async () => {
    // The counter-test for the #436 fix. Vertical escape must not come at the
    // cost of the thing the unconditional preventDefault was protecting: the
    // global shortcut binds ArrowLeft/Right, so an un-prevented edge press on a
    // horizontal group would turn every clamp into a +/-10s seek.
    TestBed.resetTestingModule();
    @Component({
      standalone: true,
      imports: [TvNavGroupDirective, TvNavItemDirective],
      template: `
        <div appTvNavGroup axis="horizontal">
          @for (label of items; track label) {
            <button appTvNavItem>{{ label }}</button>
          }
        </div>
      `,
    })
    class SeekGuardHost {
      items = ['a', 'b'];
    }
    TestBed.configureTestingModule({ imports: [SeekGuardHost] });
    const fixture = TestBed.createComponent(SeekGuardHost);
    fixture.detectChanges();
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    );
    buttons[1]!.focus();
    fixture.detectChanges();
    const event = keydown(buttons[1]!, 'ArrowRight');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('a horizontal group responds to ArrowLeft/ArrowRight instead of ArrowUp/ArrowDown', async () => {
    TestBed.resetTestingModule();
    @Component({
      standalone: true,
      imports: [TvNavGroupDirective, TvNavItemDirective],
      template: `
        <div appTvNavGroup axis="horizontal">
          @for (label of items; track label) {
            <button appTvNavItem>{{ label }}</button>
          }
        </div>
      `,
    })
    class HorizontalHost {
      items = ['a', 'b', 'c'];
    }
    TestBed.configureTestingModule({ imports: [HorizontalHost] });
    const fixture = TestBed.createComponent(HorizontalHost);
    fixture.detectChanges();
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    );
    const group: HTMLElement = fixture.nativeElement.querySelector('[appTvNavGroup]');
    expect(group.getAttribute('role')).toBe('toolbar');
    expect(group.getAttribute('aria-orientation')).toBe('horizontal');
    buttons[0]!.focus();
    keydown(buttons[0]!, 'ArrowRight');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]);
    // ArrowDown must NOT move focus in a horizontal group.
    keydown(buttons[1]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('a vertical group carries role="toolbar" + aria-orientation="vertical"', () => {
    const { fixture } = setup();
    const group: HTMLElement = fixture.nativeElement.querySelector('[appTvNavGroup]');
    expect(group.getAttribute('role')).toBe('toolbar');
    expect(group.getAttribute('aria-orientation')).toBe('vertical');
  });

  /**
   * A **pure reorder**: `@for` tracked by a stable id, re-rendered with the
   * same items in a new order. Angular moves the existing views, so no item is
   * destroyed or created and no register/unregister fires — the registration
   * array keeps its identity. This is what `ListControlsService.filtered()`
   * does to every Library card grid when the user changes the sort dropdown
   * (a plain client-side `[...items()].sort(...)`), so it is a production
   * path, not a synthetic one. `items()` must re-derive the order rather than
   * serve its memo.
   */
  it('a pure reorder (same items, new DOM order, no re-registration) is reflected on the next read', async () => {
    TestBed.resetTestingModule();
    @Component({
      standalone: true,
      imports: [TvNavGroupDirective, TvNavItemDirective],
      template: `
        <div appTvNavGroup axis="vertical">
          @for (label of order(); track label) {
            <button appTvNavItem>{{ label }}</button>
          }
        </div>
      `,
    })
    class ReorderHost {
      readonly order = signal(['a', 'b', 'c']);
    }
    TestBed.configureTestingModule({ imports: [ReorderHost] });
    const fixture = TestBed.createComponent(ReorderHost);
    fixture.detectChanges();
    const read = (): HTMLButtonElement[] =>
      Array.from(fixture.nativeElement.querySelectorAll('button'));
    const group = fixture.debugElement
      .query(By.directive(TvNavGroupDirective))
      .injector.get(TvNavGroupDirective);

    const [a, b, c] = read();
    expect(group.items().map((i) => i.nativeElement.textContent?.trim())).toEqual(['a', 'b', 'c']);

    fixture.componentInstance.order.set(['c', 'b', 'a']);
    fixture.detectChanges();

    // The SAME element objects, moved — proving Angular reordered rather than
    // re-created them. A re-creation would fire unregister/register and
    // invalidate the memo the easy way, making this test prove nothing.
    expect(read()).toEqual([c, b, a]);
    expect(group.items().length).toBe(3);

    // items() is correct SYNCHRONOUSLY — the read-time order check, which is
    // what onKeydown/notifyFocused rely on during a real interaction.
    expect(group.items().map((i) => i.nativeElement.textContent?.trim())).toEqual(['c', 'b', 'a']);

    // The rendered roving tabindex follows too, once the MutationObserver
    // microtask has invalidated the item tabIndex computeds: activeIndex 0 is
    // now `c`. (A pure reorder writes to no signal, so nothing else would ask
    // items() again.)
    await Promise.resolve();
    fixture.detectChanges();
    expect(c!.getAttribute('tabindex')).toBe('0');
    expect(a!.getAttribute('tabindex')).toBe('-1');

    // ...and so does arrow-key navigation.
    c!.focus();
    keydown(c!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(b);
  });

  it('indexOf returns the same answer as items().indexOf, via the memoized index map (issue #357)', () => {
    const { fixture, buttons } = setup();
    const group = fixture.debugElement
      .query(By.directive(TvNavGroupDirective))
      .injector.get(TvNavGroupDirective);
    const items = group.items();
    items.forEach((item, i) => {
      expect(group.indexOf(item)).toBe(i);
      expect(group.indexOf(item)).toBe(items.indexOf(item));
    });
  });

  it('resolves the acting index from the keydown event target rather than a stale activeIndex (issue #358)', () => {
    const { fixture, buttons } = setup();
    const group = fixture.debugElement
      .query(By.directive(TvNavGroupDirective))
      .injector.get(TvNavGroupDirective);
    // Simulate activeIndex having drifted from real DOM focus (e.g. a pure
    // reorder moved the focused element to a new ordinal position before the
    // next focusin resyncs it) — the keydown's own target should still win.
    group.activeIndex.set(2);
    keydown(buttons[0]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('an arrow key on a focusable descendant that is not an appTvNavItem does not move focus (stale-activeIndex guard)', () => {
    const { fixture, buttons, plainButton } = setup();
    // Move activeIndex to 1 first via a real item, then focus the plain
    // non-item button and fire an arrow key on it — onKeydown must bail
    // rather than acting on the now-stale activeIndex.
    buttons[0]!.focus();
    keydown(buttons[0]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]);

    plainButton.focus();
    const event = keydown(plainButton, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(plainButton);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('TvNavGroupDirective grid axis', () => {
  function setupGrid(rowSizes: number[]) {
    @Component({
      standalone: true,
      imports: [TvNavGroupDirective, TvNavItemDirective],
      template: `
        <div appTvNavGroup axis="grid">
          @for (label of items; track label) {
            <button appTvNavItem>{{ label }}</button>
          }
        </div>
      `,
    })
    class GridHost {
      items = Array.from({ length: rowSizes.reduce((a, b) => a + b, 0) }, (_, i) => `item-${i}`);
    }
    TestBed.configureTestingModule({ imports: [GridHost] });
    const fixture = TestBed.createComponent(GridHost);
    fixture.detectChanges();
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    );
    // Stub offsetTop so buttons form rows of the given sizes (e.g. [3, 2] -> a
    // 3-column grid, 5 items, 2 rows, the last row incomplete).
    let idx = 0;
    rowSizes.forEach((size, row) => {
      for (let i = 0; i < size; i++) {
        Object.defineProperty(buttons[idx]!, 'offsetTop', { value: row * 100, configurable: true });
        idx++;
      }
    });
    return { fixture, buttons };
  }

  it('carries role="grid" and omits aria-orientation (which only allows horizontal/vertical)', () => {
    const { fixture } = setupGrid([3, 2]);
    const group: HTMLElement = fixture.nativeElement.querySelector('[appTvNavGroup]');
    expect(group.getAttribute('role')).toBe('grid');
    expect(group.hasAttribute('aria-orientation')).toBe(false);
  });

  it('ArrowRight moves within a row, clamped at the row end (no wrap to next row)', () => {
    const { fixture, buttons } = setupGrid([3, 2]);
    buttons[0]!.focus();
    keydown(buttons[0]!, 'ArrowRight');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]);
    const event = keydown(buttons[2]!, 'ArrowRight'); // idx 2 is the last item in row 0
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[2]);
    // Recognized grid nav key: owned (preventDefaulted) even when clamped, so
    // it can't also reach the global seek shortcut.
    expect(event.defaultPrevented).toBe(true);
  });

  it('ArrowLeft moves within a row, clamped at the row start', () => {
    const { fixture, buttons } = setupGrid([3, 2]);
    buttons[1]!.focus();
    keydown(buttons[1]!, 'ArrowLeft');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[0]);
    const event = keydown(buttons[0]!, 'ArrowLeft');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[0]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ArrowDown jumps a full row, landing on the same column', () => {
    const { fixture, buttons } = setupGrid([3, 2]);
    buttons[0]!.focus();
    keydown(buttons[0]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[3]); // row 1, column 0
  });

  it('ArrowDown into a shorter final row clamps to its last item', () => {
    const { fixture, buttons } = setupGrid([3, 2]);
    buttons[2]!.focus(); // row 0, column 2 — row 1 only has columns 0-1
    keydown(buttons[2]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[4]); // clamped to the last item, not off the end
  });

  it('ArrowUp jumps back a full row, landing on the same column', () => {
    const { fixture, buttons } = setupGrid([3, 2]);
    buttons[4]!.focus(); // row 1, column 1
    keydown(buttons[4]!, 'ArrowUp');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]); // row 0, column 1
  });

  it('ArrowUp at the first row does not move focus and does not preventDefault', () => {
    const { fixture, buttons } = setupGrid([3, 2]);
    buttons[1]!.focus();
    const event = keydown(buttons[1]!, 'ArrowUp');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ArrowDown at the last row does not move focus and does not preventDefault', () => {
    const { fixture, buttons } = setupGrid([3, 2]);
    buttons[3]!.focus();
    const event = keydown(buttons[3]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[3]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('Home/End still jump to the first/last item across the whole grid', () => {
    const { fixture, buttons } = setupGrid([3, 2]);
    buttons[1]!.focus();
    keydown(buttons[1]!, 'End');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[4]);
    keydown(buttons[4]!, 'Home');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[0]);
  });
});

describe('TvNavGroupDirective nested child groups (issue #356)', () => {
  // Mirrors the Now Playing queue: a vertical "rows" group nesting one
  // horizontal group per row ([jump, remove]) — ArrowDown/Up move between
  // rows, ArrowLeft/Right move within a row to reach Remove.
  @Component({
    standalone: true,
    imports: [TvNavGroupDirective, TvNavItemDirective],
    template: `
      <div appTvNavGroup axis="vertical">
        @for (row of rows; track row) {
          <div appTvNavGroup axis="horizontal">
            <button appTvNavItem class="jump">{{ row }}-jump</button>
            <button appTvNavItem class="remove">{{ row }}-remove</button>
          </div>
        }
      </div>
    `,
  })
  class QueueHost {
    rows = ['a', 'b', 'c'];
  }

  function setupQueue() {
    TestBed.configureTestingModule({ imports: [QueueHost] });
    const fixture = TestBed.createComponent(QueueHost);
    fixture.detectChanges();
    const jump = (i: number): HTMLButtonElement =>
      fixture.nativeElement.querySelectorAll('.jump')[i];
    const remove = (i: number): HTMLButtonElement =>
      fixture.nativeElement.querySelectorAll('.remove')[i];
    return { fixture, jump, remove };
  }

  it('only the first row default to tabindex 0 on its jump button; every remove button starts at -1', () => {
    const { jump, remove } = setupQueue();
    expect(jump(0).getAttribute('tabindex')).toBe('0');
    expect(jump(1).getAttribute('tabindex')).toBe('-1');
    expect(jump(2).getAttribute('tabindex')).toBe('-1');
    expect(remove(0).getAttribute('tabindex')).toBe('-1');
    expect(remove(1).getAttribute('tabindex')).toBe('-1');
    expect(remove(2).getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowRight from jump moves within the row to remove (inner horizontal group)', () => {
    const { fixture, jump, remove } = setupQueue();
    jump(0).focus();
    keydown(jump(0), 'ArrowRight');
    fixture.detectChanges();
    expect(document.activeElement).toBe(remove(0));
    expect(remove(0).getAttribute('tabindex')).toBe('0');
    expect(jump(0).getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowDown from jump moves to the next row (outer vertical group over child groups)', () => {
    const { fixture, jump } = setupQueue();
    jump(0).focus();
    keydown(jump(0), 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(jump(1));
  });

  it("ArrowDown from a row whose remove button is focused lands on the next row's own active item, not necessarily the same column", () => {
    const { fixture, jump, remove } = setupQueue();
    // Move row 0 to remove, but never touch row 1 — row 1's own activeIndex
    // stays at its default (jump).
    jump(0).focus();
    keydown(jump(0), 'ArrowRight');
    fixture.detectChanges();
    expect(document.activeElement).toBe(remove(0));
    keydown(remove(0), 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(jump(1));
  });

  it("moving to a different row demotes the previous row's items and promotes the new row's (single Tab-stop invariant)", () => {
    const { fixture, jump } = setupQueue();
    jump(0).focus();
    keydown(jump(0), 'ArrowDown');
    fixture.detectChanges();
    expect(jump(0).getAttribute('tabindex')).toBe('-1');
    expect(jump(1).getAttribute('tabindex')).toBe('0');
  });

  it('ArrowUp moves back to the previous row', () => {
    const { fixture, jump } = setupQueue();
    jump(1).focus();
    keydown(jump(1), 'ArrowUp');
    fixture.detectChanges();
    expect(document.activeElement).toBe(jump(0));
  });

  it('ArrowDown at the last row does not move focus (no wrap) and stays un-prevented', () => {
    // Un-prevented since issue #436: a nested group clamping at its last row is
    // the exact shape of the trap (a track list inside a page), so the escape
    // has to work here too, not just on a flat group.
    const { fixture, jump } = setupQueue();
    jump(2).focus();
    const event = keydown(jump(2), 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(jump(2));
    expect(event.defaultPrevented).toBe(false);
  });

  it("Home/End jump to the first/last row's active item", () => {
    const { fixture, jump } = setupQueue();
    jump(1).focus();
    keydown(jump(1), 'End');
    fixture.detectChanges();
    expect(document.activeElement).toBe(jump(2));
    keydown(jump(2), 'Home');
    fixture.detectChanges();
    expect(document.activeElement).toBe(jump(0));
  });

  it("clicking directly into a different row's remove button re-syncs both levels of roving tabindex", () => {
    const { fixture, jump, remove } = setupQueue();
    remove(2).focus();
    fixture.detectChanges();
    expect(remove(2).getAttribute('tabindex')).toBe('0');
    expect(jump(0).getAttribute('tabindex')).toBe('-1');
  });
});

describe('TvNavGroupDirective mixed direct items + child groups (issue #389)', () => {
  // Mirrors the TV Now Playing root: a vertical group owning a close button
  // (direct item), a nested horizontal transport group, and a radio button
  // (direct item) — one merged, DOM-ordered navigation sequence.
  @Component({
    standalone: true,
    imports: [TvNavGroupDirective, TvNavItemDirective],
    template: `
      <div appTvNavGroup axis="vertical">
        <button appTvNavItem class="close">close</button>
        <div appTvNavGroup axis="horizontal">
          <button appTvNavItem class="prev">prev</button>
          <button appTvNavItem class="play">play</button>
        </div>
        <button appTvNavItem class="radio">radio</button>
      </div>
    `,
  })
  class MixedHost {}

  function setupMixed() {
    TestBed.configureTestingModule({ imports: [MixedHost] });
    const fixture = TestBed.createComponent(MixedHost);
    fixture.detectChanges();
    const q = (sel: string): HTMLButtonElement => fixture.nativeElement.querySelector(sel);
    return { fixture, close: q('.close'), prev: q('.prev'), play: q('.play'), radio: q('.radio') };
  }

  it('exactly one Tab stop: the first entry (a direct item) starts at tabindex 0', () => {
    const { close, prev, play, radio } = setupMixed();
    expect(close.getAttribute('tabindex')).toBe('0');
    expect(prev.getAttribute('tabindex')).toBe('-1');
    expect(play.getAttribute('tabindex')).toBe('-1');
    expect(radio.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowDown walks item -> child group -> item in DOM order', () => {
    const { fixture, close, prev, radio } = setupMixed();
    close.focus();
    keydown(close, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(prev);
    keydown(prev, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(radio);
  });

  it("ArrowUp from an item after the group re-enters the group's own remembered active item", () => {
    const { fixture, close, prev, play, radio } = setupMixed();
    close.focus();
    keydown(close, 'ArrowDown');
    fixture.detectChanges();
    keydown(prev, 'ArrowRight'); // move within the transport to play
    fixture.detectChanges();
    expect(document.activeElement).toBe(play);
    keydown(play, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(radio);
    keydown(radio, 'ArrowUp');
    fixture.detectChanges();
    expect(document.activeElement).toBe(play); // remembered, not prev
  });

  it('focus inside the child group demotes direct items to -1 (single Tab stop across kinds)', () => {
    const { fixture, close, prev } = setupMixed();
    prev.focus();
    fixture.detectChanges();
    expect(prev.getAttribute('tabindex')).toBe('0');
    expect(close.getAttribute('tabindex')).toBe('-1');
  });

  it('the inner group still owns its own axis (ArrowRight moves prev -> play, never to radio)', () => {
    const { fixture, prev, play } = setupMixed();
    prev.focus();
    keydown(prev, 'ArrowRight');
    fixture.detectChanges();
    expect(document.activeElement).toBe(play);
    const event = keydown(play, 'ArrowRight'); // clamped at the row edge
    fixture.detectChanges();
    expect(document.activeElement).toBe(play);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Home/End jump across the merged sequence', () => {
    const { fixture, close, prev, radio } = setupMixed();
    close.focus();
    keydown(close, 'ArrowDown');
    fixture.detectChanges();
    keydown(prev, 'End');
    fixture.detectChanges();
    expect(document.activeElement).toBe(radio);
    keydown(radio, 'Home');
    fixture.detectChanges();
    expect(document.activeElement).toBe(close);
  });

  it('a childGroups-first container starts its Tab stop inside the group', () => {
    @Component({
      standalone: true,
      imports: [TvNavGroupDirective, TvNavItemDirective],
      template: `
        <div appTvNavGroup axis="vertical">
          <div appTvNavGroup axis="horizontal">
            <button appTvNavItem class="first">first</button>
          </div>
          <button appTvNavItem class="after">after</button>
        </div>
      `,
    })
    class GroupFirstHost {}
    TestBed.configureTestingModule({ imports: [GroupFirstHost] });
    const fixture = TestBed.createComponent(GroupFirstHost);
    fixture.detectChanges();
    const first: HTMLButtonElement = fixture.nativeElement.querySelector('.first');
    const after: HTMLButtonElement = fixture.nativeElement.querySelector('.after');
    expect(first.getAttribute('tabindex')).toBe('0');
    expect(after.getAttribute('tabindex')).toBe('-1');
  });
});

describe('TvNavItemDirective activation passthrough (issue #396)', () => {
  // A `<label>` (the Admin duplicates rows) is focusable as a nav item but not
  // natively Enter/Space-activatable the way a button is — the passthrough
  // synthesizes the click so a D-pad Enter toggles the wrapped checkbox.
  @Component({
    standalone: true,
    imports: [TvNavGroupDirective, TvNavItemDirective],
    template: `
      <div appTvNavGroup axis="vertical">
        <label appTvNavItem class="row" (click)="labelClicks = labelClicks + 1">
          <input type="checkbox" />
        </label>
        <button appTvNavItem class="btn" (click)="buttonClicks = buttonClicks + 1">go</button>
      </div>
    `,
  })
  class PassthroughHost {
    labelClicks = 0;
    buttonClicks = 0;
  }

  function setupPassthrough() {
    TestBed.configureTestingModule({ imports: [PassthroughHost] });
    const fixture = TestBed.createComponent(PassthroughHost);
    fixture.detectChanges();
    const label: HTMLLabelElement = fixture.nativeElement.querySelector('.row');
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.btn');
    return { fixture, label, button, host: fixture.componentInstance };
  }

  function keydown(el: HTMLElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  }

  it('Enter on a focused label item clicks it (checkbox rows toggle once)', () => {
    const { fixture, label, host } = setupPassthrough();
    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('input');
    label.focus();
    const event = keydown(label, 'Enter');
    // The label forwards activation to its checkbox, whose click bubbles back
    // through the label — so the label sees 2 click events but the checkbox
    // toggles exactly once, same as a real mouse click on a label.
    expect(checkbox.checked).toBe(true);
    expect(host.labelClicks).toBeGreaterThan(0);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Space on a focused label item clicks it too', () => {
    const { fixture, label } = setupPassthrough();
    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('input');
    label.focus();
    keydown(label, ' ');
    expect(checkbox.checked).toBe(true);
  });

  it('a natively-activatable button gets no synthesized click (no double-fire)', () => {
    const { button, host } = setupPassthrough();
    button.focus();
    const event = keydown(button, 'Enter');
    // The browser's own Enter→click on buttons is the real activation path;
    // the passthrough must stay out of it entirely.
    expect(host.buttonClicks).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('a key from the nested checkbox itself is left alone', () => {
    const { fixture, host } = setupPassthrough();
    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('input');
    checkbox.focus();
    keydown(checkbox, 'Enter');
    expect(host.labelClicks).toBe(0);
  });
});
