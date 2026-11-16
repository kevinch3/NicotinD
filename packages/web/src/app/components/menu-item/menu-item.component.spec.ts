import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MenuItemComponent } from './menu-item.component';
import { TranslateService } from '../../services/translate.service';
import type { TrackAction } from '../track-row/track-row.component';

@Component({
  imports: [MenuItemComponent],
  template: `
    <div>
      @for (a of actions; track a.label) {
        <button
          [appMenuItem]="a"
          [testidPrefix]="prefix"
          [tall]="tall"
          (click)="ran.push(a.label)"
        ></button>
      }
    </div>
  `,
})
class HostComponent {
  actions: TrackAction[] = [];
  prefix = 'track-action-';
  tall = false;
  ran: string[] = [];
}

function setup(actions: TrackAction[], over: Partial<HostComponent> = {}) {
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
  Object.assign(fixture.componentInstance, { actions, ...over });
  fixture.detectChanges();
  const buttons = Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
  );
  return { fixture, buttons };
}

const noop = () => {};

describe('MenuItemComponent (#2005)', () => {
  it('stays a plain button that is a direct child of its menu, with the test id e2e selects on', () => {
    const { fixture, buttons } = setup([{ label: 'Play next', action: noop }]);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.parentElement).toBe(
      (fixture.nativeElement as HTMLElement).firstElementChild,
    );
    expect(buttons[0]!.getAttribute('type')).toBe('button');
    expect(buttons[0]!.dataset['testid']).toBe('track-action-Play next');
  });

  it('keeps the untranslated label in the test id and shows the translated one', () => {
    const { buttons } = setup([{ label: 'Like', labelKey: 'song.like', action: noop }]);
    expect(buttons[0]!.dataset['testid']).toBe('track-action-Like');
    expect(buttons[0]!.textContent?.trim()).toBe('T(song.like)');
  });

  it('falls back to the label when there is no key', () => {
    const { buttons } = setup([{ label: 'Custom', action: noop }]);
    expect(buttons[0]!.textContent?.trim()).toBe('Custom');
  });

  it('takes the prefix of the menu it is in', () => {
    const { buttons } = setup([{ label: 'Open', action: noop }], { prefix: 'entity-action-' });
    expect(buttons[0]!.dataset['testid']).toBe('entity-action-Open');
  });

  it('names its icon, and keeps the icon column when an action has none so labels line up', () => {
    const { buttons } = setup([
      { label: 'Radio', icon: 'radio', action: noop },
      { label: 'Bare', action: noop },
    ]);
    expect(buttons[0]!.dataset['icon']).toBe('radio');
    expect(buttons[0]!.querySelector('[data-menu-item-icon] app-icon')).not.toBeNull();
    expect(buttons[1]!.hasAttribute('data-icon')).toBe(false);
    expect(buttons[1]!.querySelector('[data-menu-item-icon]')).not.toBeNull();
    expect(buttons[1]!.querySelector('app-icon')).toBeNull();
  });

  it('styles a destructive action as an error and the rest as secondary text', () => {
    const { buttons } = setup([
      { label: 'Remove', destructive: true, action: noop },
      { label: 'Keep', action: noop },
    ]);
    expect(buttons[0]!.classList.contains('text-status-error')).toBe(true);
    expect(buttons[0]!.classList.contains('text-theme-secondary')).toBe(false);
    expect(buttons[1]!.classList.contains('text-theme-secondary')).toBe(true);
  });

  it('is 44px tall only where the menu asks for it', () => {
    expect(setup([{ label: 'A', action: noop }]).buttons[0]!.classList.contains('min-h-11')).toBe(
      false,
    );
    TestBed.resetTestingModule();
    expect(
      setup([{ label: 'A', action: noop }], { tall: true }).buttons[0]!.classList.contains(
        'min-h-11',
      ),
    ).toBe(true);
  });

  it('leaves the click to the menu that owns it', () => {
    const { fixture, buttons } = setup([{ label: 'A', action: noop }]);
    buttons[0]!.click();
    expect(fixture.componentInstance.ran).toEqual(['A']);
  });
});
