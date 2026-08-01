import { TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import type { Subscription } from 'rxjs';
import { KeyboardShortcutsService } from './keyboard-shortcuts.service';
import { PlayerService } from './player.service';
import { TvNavGroupDirective } from '../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../directives/tv-nav-item.directive';

function dispatchKeydown(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    code: key === ' ' ? 'Space' : key,
    bubbles: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe('KeyboardShortcutsService', () => {
  let playerStub: {
    isPlaying: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    playPrev: ReturnType<typeof vi.fn>;
    playNext: ReturnType<typeof vi.fn>;
    toggleVocalMute: ReturnType<typeof vi.fn>;
    setNowPlayingOpen: ReturnType<typeof vi.fn>;
    currentTime: ReturnType<typeof signal<number>>;
    seek: ReturnType<typeof vi.fn>;
  };
  let sub: Subscription;

  function setup(initialIsPlaying: boolean) {
    playerStub = {
      isPlaying: vi.fn(() => initialIsPlaying),
      pause: vi.fn(),
      resume: vi.fn(),
      playPrev: vi.fn(),
      playNext: vi.fn(),
      toggleVocalMute: vi.fn(),
      setNowPlayingOpen: vi.fn(),
      currentTime: signal(0),
      seek: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        KeyboardShortcutsService,
        { provide: PlayerService, useValue: playerStub },
      ],
    });
    const service = TestBed.inject(KeyboardShortcutsService);
    const router = TestBed.inject(Router);
    sub = service.initialize();
    return { service, router };
  }

  afterEach(() => {
    sub?.unsubscribe();
    document.body.innerHTML = '';
  });

  it('Space resumes playback when paused and nothing is focused', () => {
    setup(false);
    dispatchKeydown(window, ' ');
    expect(playerStub.resume).toHaveBeenCalled();
    expect(playerStub.pause).not.toHaveBeenCalled();
  });

  it('Space pauses playback when playing', () => {
    setup(true);
    dispatchKeydown(window, ' ');
    expect(playerStub.pause).toHaveBeenCalled();
  });

  it('K also toggles play/pause', () => {
    setup(false);
    dispatchKeydown(window, 'k');
    expect(playerStub.resume).toHaveBeenCalled();
  });

  it('Space is ignored while a text input is focused', () => {
    setup(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    dispatchKeydown(input, ' ');
    expect(playerStub.resume).not.toHaveBeenCalled();
  });

  it('K is ignored while a text input is focused', () => {
    setup(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    dispatchKeydown(input, 'k');
    expect(playerStub.resume).not.toHaveBeenCalled();
  });

  it('Space is ignored while a button is focused (lets its own activation win)', () => {
    setup(false);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    dispatchKeydown(button, ' ');
    expect(playerStub.resume).not.toHaveBeenCalled();
  });

  it('K still toggles play/pause even when a button is focused (letters have no native button activation)', () => {
    setup(false);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    dispatchKeydown(button, 'k');
    expect(playerStub.resume).toHaveBeenCalled();
  });

  it('Space is ignored while a select is focused (lets its own dropdown-open win)', () => {
    setup(false);
    const select = document.createElement('select');
    document.body.appendChild(select);
    select.focus();
    dispatchKeydown(select, ' ');
    expect(playerStub.resume).not.toHaveBeenCalled();
  });

  it('Space is ignored while a role="switch" element is focused', () => {
    setup(false);
    const button = document.createElement('button');
    button.setAttribute('role', 'switch');
    document.body.appendChild(button);
    button.focus();
    dispatchKeydown(button, ' ');
    expect(playerStub.resume).not.toHaveBeenCalled();
  });

  it('J calls playPrev', () => {
    setup(false);
    dispatchKeydown(window, 'j');
    expect(playerStub.playPrev).toHaveBeenCalled();
  });

  it('L calls playNext', () => {
    setup(false);
    dispatchKeydown(window, 'l');
    expect(playerStub.playNext).toHaveBeenCalled();
  });

  it('M toggles vocal mute', () => {
    setup(false);
    dispatchKeydown(window, 'm');
    expect(playerStub.toggleVocalMute).toHaveBeenCalled();
  });

  it('N opens Now Playing', () => {
    setup(false);
    dispatchKeydown(window, 'n');
    expect(playerStub.setNowPlayingOpen).toHaveBeenCalledWith(true);
  });

  it('J/L/M/N are ignored while a text input is focused', () => {
    setup(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    for (const key of ['j', 'l', 'm', 'n']) {
      dispatchKeydown(input, key);
    }
    expect(playerStub.playPrev).not.toHaveBeenCalled();
    expect(playerStub.playNext).not.toHaveBeenCalled();
    expect(playerStub.toggleVocalMute).not.toHaveBeenCalled();
    expect(playerStub.setNowPlayingOpen).not.toHaveBeenCalled();
  });

  it('ArrowRight seeks forward 10s from the current position', () => {
    setup(false);
    playerStub.currentTime.set(30);
    dispatchKeydown(window, 'ArrowRight');
    expect(playerStub.seek).toHaveBeenCalledWith(40);
  });

  it('ArrowLeft seeks backward 10s, clamped to 0', () => {
    setup(false);
    playerStub.currentTime.set(5);
    dispatchKeydown(window, 'ArrowLeft');
    expect(playerStub.seek).toHaveBeenCalledWith(0);
  });

  it('does not seek when the keydown event was already handled (defaultPrevented) by a D-pad nav group', () => {
    setup(false);
    playerStub.currentTime.set(30);
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault(); // simulates a TvNavGroupDirective having already moved focus
    window.dispatchEvent(event);
    expect(playerStub.seek).not.toHaveBeenCalled();
  });

  it('ArrowLeft/ArrowRight are ignored while a text input is focused', () => {
    setup(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    dispatchKeydown(input, 'ArrowRight');
    dispatchKeydown(input, 'ArrowLeft');
    expect(playerStub.seek).not.toHaveBeenCalled();
  });

  it('/ navigates to the Acquire page', () => {
    const { router } = setup(false);
    const navigateSpy = vi.spyOn(router, 'navigate');
    dispatchKeydown(window, '/');
    expect(navigateSpy).toHaveBeenCalledWith(['/acquire']);
  });

  it('/ is ignored while a text input is focused (so typing a literal "/" in a field works normally)', () => {
    const { router } = setup(false);
    const navigateSpy = vi.spyOn(router, 'navigate');
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    dispatchKeydown(input, '/');
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

/**
 * Cross-directive integration: a REAL `TvNavGroupDirective`/`TvNavItemDirective`
 * pair alongside a REAL `KeyboardShortcutsService` both listening on the same
 * real `window`, so the precedence between "D-pad moved focus" and "global
 * seek shortcut" is exercised through actual event bubbling rather than each
 * side's isolated unit test asserting its own half in a vacuum (the seam that
 * has hidden real cross-directive bugs elsewhere in this effort).
 */
describe('KeyboardShortcutsService + TvNavGroupDirective (cross-directive precedence)', () => {
  @Component({
    standalone: true,
    imports: [TvNavGroupDirective, TvNavItemDirective],
    template: `
      <div appTvNavGroup axis="horizontal">
        <button appTvNavItem>one</button>
        <button appTvNavItem>two</button>
      </div>
      <button class="outside">outside</button>
    `,
  })
  class IntegrationHost {}

  let playerStub: {
    currentTime: ReturnType<typeof signal<number>>;
    seek: ReturnType<typeof vi.fn>;
  };
  let sub: Subscription;

  function setupIntegration() {
    playerStub = { currentTime: signal(30), seek: vi.fn() };
    TestBed.configureTestingModule({
      imports: [IntegrationHost],
      providers: [
        provideRouter([]),
        KeyboardShortcutsService,
        { provide: PlayerService, useValue: playerStub },
      ],
    });
    const fixture = TestBed.createComponent(IntegrationHost);
    fixture.detectChanges();
    const service = TestBed.inject(KeyboardShortcutsService);
    sub = service.initialize();
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('button.outside, [appTvNavItem]'),
    );
    return { fixture, buttons };
  }

  afterEach(() => {
    sub?.unsubscribe();
  });

  it('a real ArrowRight inside a nav group moves D-pad focus and the global seek shortcut defers', () => {
    const { fixture, buttons } = setupIntegration();
    const [first, second] = buttons;
    first!.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    first!.dispatchEvent(event);
    fixture.detectChanges();

    // (a) the nav group's own D-pad handling still works.
    expect(document.activeElement).toBe(second);
    // (b) the global shortcut correctly deferred to the earlier handler.
    expect(playerStub.seek).not.toHaveBeenCalled();
  });

  it('a real ArrowRight outside any nav group still triggers the global seek shortcut', () => {
    const { buttons } = setupIntegration();
    const outside = buttons.find((b) => b.classList.contains('outside'))!;
    outside.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    outside.dispatchEvent(event);

    expect(playerStub.seek).toHaveBeenCalledWith(40);
  });
});
