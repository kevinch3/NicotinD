import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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

  it('ArrowUp at the first item does not move focus and does not preventDefault (no wrap)', () => {
    const { fixture, buttons } = setup();
    buttons[0]!.focus();
    const event = keydown(buttons[0]!, 'ArrowUp');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[0]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ArrowDown at the last item does not move focus and does not preventDefault (no wrap)', () => {
    const { fixture, buttons } = setup();
    buttons[2]!.focus();
    fixture.detectChanges();
    const event = keydown(buttons[2]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[2]);
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
    buttons[0]!.focus();
    keydown(buttons[0]!, 'ArrowRight');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]);
    // ArrowDown must NOT move focus in a horizontal group.
    keydown(buttons[1]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('the group host carries role="toolbar" for assistive tech', () => {
    const { fixture } = setup();
    const group: HTMLElement = fixture.nativeElement.querySelector('[appTvNavGroup]');
    expect(group.getAttribute('role')).toBe('toolbar');
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
