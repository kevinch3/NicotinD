import { TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import type { Subscription } from 'rxjs';
import { KeyboardShortcutsService } from './keyboard-shortcuts.service';
import { PlayerService } from './player.service';
import { TvNavGroupDirective } from '../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../directives/tv-nav-item.directive';
import * as platform from '../lib/platform';

// The arrow-seek shortcut is gated on the build flavor: on a TV build,
// ArrowLeft/Right belong to the WebView's spatial focus navigation (issue
// #387). Module-mocking `isTvBuild` lets each test pick the flavor — same
// pattern as remote-playback.service.spec.ts.
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    isTvBuild: vi.fn().mockReturnValue(false),
  };
});

beforeEach(() => {
  vi.mocked(platform.isTvBuild).mockReturnValue(false);
});

function dispatchKeydown(
  target: EventTarget,
  key: string,
  modifiers: Partial<Pick<KeyboardEventInit, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    code: key === ' ' ? 'Space' : key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
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

  it('on a TV build, ArrowLeft/Right neither seek nor preventDefault (WebView spatial nav owns them)', () => {
    vi.mocked(platform.isTvBuild).mockReturnValue(true);
    setup(false);
    playerStub.currentTime.set(30);
    const right = dispatchKeydown(window, 'ArrowRight');
    const left = dispatchKeydown(window, 'ArrowLeft');
    expect(playerStub.seek).not.toHaveBeenCalled();
    // The un-prevented event IS the fix: preventDefault() is what cancelled
    // the WebView's D-pad focus move (issue #387).
    expect(right.defaultPrevented).toBe(false);
    expect(left.defaultPrevented).toBe(false);
  });

  it('on a TV build, Space/K/J/L still work (only the arrow-seek shortcut is gated)', () => {
    vi.mocked(platform.isTvBuild).mockReturnValue(true);
    setup(false);
    dispatchKeydown(window, ' ');
    dispatchKeydown(window, 'j');
    dispatchKeydown(window, 'l');
    expect(playerStub.resume).toHaveBeenCalled();
    expect(playerStub.playPrev).toHaveBeenCalled();
    expect(playerStub.playNext).toHaveBeenCalled();
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

  it('ArrowLeft/ArrowRight are ignored while a select is focused (native option change wins)', () => {
    setup(false);
    const select = document.createElement('select');
    document.body.appendChild(select);
    select.focus();
    const right = dispatchKeydown(select, 'ArrowRight');
    const left = dispatchKeydown(select, 'ArrowLeft');
    expect(playerStub.seek).not.toHaveBeenCalled();
    expect(right.defaultPrevented).toBe(false);
    expect(left.defaultPrevented).toBe(false);
  });

  it('Alt+ArrowLeft/Right (browser Back/Forward) neither seeks nor preventDefaults', () => {
    setup(false);
    playerStub.currentTime.set(30);
    const back = dispatchKeydown(window, 'ArrowLeft', { altKey: true });
    const forward = dispatchKeydown(window, 'ArrowRight', { altKey: true });
    expect(playerStub.seek).not.toHaveBeenCalled();
    expect(back.defaultPrevented).toBe(false);
    expect(forward.defaultPrevented).toBe(false);
  });

  it('Meta+ArrowLeft/Right (macOS back/forward) neither seeks nor preventDefaults', () => {
    setup(false);
    playerStub.currentTime.set(30);
    dispatchKeydown(window, 'ArrowLeft', { metaKey: true });
    dispatchKeydown(window, 'ArrowRight', { metaKey: true });
    expect(playerStub.seek).not.toHaveBeenCalled();
  });

  it('Ctrl/Meta + a letter (reserved browser shortcuts) does not fire the player action', () => {
    const { router } = setup(false);
    const navigateSpy = vi.spyOn(router, 'navigate');
    dispatchKeydown(window, 'l', { ctrlKey: true }); // Ctrl+L = address bar
    dispatchKeydown(window, 'l', { metaKey: true });
    dispatchKeydown(window, 'j', { ctrlKey: true }); // Ctrl+J = downloads
    dispatchKeydown(window, 'n', { ctrlKey: true }); // Ctrl+N = new window
    dispatchKeydown(window, 'm', { metaKey: true }); // Cmd+M = minimize
    dispatchKeydown(window, 'k', { ctrlKey: true }); // Ctrl+K = omnibox
    dispatchKeydown(window, ' ', { ctrlKey: true });
    dispatchKeydown(window, '/', { ctrlKey: true });
    expect(playerStub.playNext).not.toHaveBeenCalled();
    expect(playerStub.playPrev).not.toHaveBeenCalled();
    expect(playerStub.setNowPlayingOpen).not.toHaveBeenCalled();
    expect(playerStub.toggleVocalMute).not.toHaveBeenCalled();
    expect(playerStub.resume).not.toHaveBeenCalled();
    expect(playerStub.pause).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('Shift is NOT part of the modifier guard (uppercase J/K/L/M/N still work)', () => {
    setup(false);
    dispatchKeydown(window, 'L', { shiftKey: true });
    dispatchKeydown(window, 'J', { shiftKey: true });
    expect(playerStub.playNext).toHaveBeenCalled();
    expect(playerStub.playPrev).toHaveBeenCalled();
  });

  it('/ navigates to the Find tab of the merged Get workspace', () => {
    const { router } = setup(false);
    const navigateSpy = vi.spyOn(router, 'navigate');
    dispatchKeydown(window, '/');
    // The merged route directly, not the legacy /acquire alias — the redirect
    // would work, but costs a hop and re-enters the page.
    expect(navigateSpy).toHaveBeenCalledWith(['/get'], { queryParams: { tab: 'find' } });
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
      <div appTvNavGroup axis="horizontal" class="row">
        <button appTvNavItem>one</button>
        <button appTvNavItem>two</button>
      </div>
      <div appTvNavGroup axis="grid" class="grid">
        <button appTvNavItem>g1</button>
        <button appTvNavItem>g2</button>
        <button appTvNavItem>g3</button>
        <button appTvNavItem>g4</button>
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
    const q = (sel: string): HTMLButtonElement[] =>
      Array.from(fixture.nativeElement.querySelectorAll(sel));
    const row = q('.row [appTvNavItem]');
    const grid = q('.grid [appTvNavItem]');
    // 2x2: `inferColumnsPerRow` reads offsetTop, which jsdom always reports 0.
    grid.forEach((el, i) => {
      Object.defineProperty(el, 'offsetTop', {
        value: Math.floor(i / 2) * 100,
        configurable: true,
      });
    });
    const outside = q('button.outside')[0]!;
    return { fixture, row, grid, outside };
  }

  function arrowKeydown(target: HTMLElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  afterEach(() => {
    sub?.unsubscribe();
  });

  it('a real ArrowRight inside a nav group moves D-pad focus and the global seek shortcut defers', () => {
    const { fixture, row } = setupIntegration();
    row[0]!.focus();
    arrowKeydown(row[0]!, 'ArrowRight');
    fixture.detectChanges();

    // (a) the nav group's own D-pad handling still works.
    expect(document.activeElement).toBe(row[1]);
    // (b) the global shortcut correctly deferred to the earlier handler.
    expect(playerStub.seek).not.toHaveBeenCalled();
  });

  it('a real ArrowRight at a horizontal group EDGE is a true no-op — no focus move AND no seek', () => {
    const { fixture, row } = setupIntegration();
    row[1]!.focus(); // last item of the group
    fixture.detectChanges();
    arrowKeydown(row[1]!, 'ArrowRight');
    fixture.detectChanges();

    expect(document.activeElement).toBe(row[1]); // no wrap
    expect(playerStub.seek).not.toHaveBeenCalled(); // and no leak to the seek shortcut
  });

  it('a real ArrowRight inside a grid group navigates and the global seek shortcut defers', () => {
    const { fixture, grid } = setupIntegration();
    grid[0]!.focus();
    arrowKeydown(grid[0]!, 'ArrowRight');
    fixture.detectChanges();

    expect(document.activeElement).toBe(grid[1]);
    expect(playerStub.seek).not.toHaveBeenCalled();
  });

  it('a real ArrowRight at a grid ROW edge is a true no-op — clamped focus AND no seek', () => {
    const { fixture, grid } = setupIntegration();
    grid[1]!.focus(); // last column of row 0 in a 2-column grid
    fixture.detectChanges();
    arrowKeydown(grid[1]!, 'ArrowRight');
    fixture.detectChanges();

    expect(document.activeElement).toBe(grid[1]); // clamped, no wrap into row 1
    expect(playerStub.seek).not.toHaveBeenCalled();
  });

  it('a real ArrowRight outside any nav group still triggers the global seek shortcut (non-TV build)', () => {
    const { outside } = setupIntegration();
    outside.focus();
    arrowKeydown(outside, 'ArrowRight');

    expect(playerStub.seek).toHaveBeenCalledWith(40);
  });

  it('on a TV build, a nav group still owns arrows inside it while outside arrows stay un-prevented', () => {
    vi.mocked(platform.isTvBuild).mockReturnValue(true);
    const { fixture, row, outside } = setupIntegration();

    // Inside a group: the directive still moves D-pad focus itself.
    row[0]!.focus();
    arrowKeydown(row[0]!, 'ArrowRight');
    fixture.detectChanges();
    expect(document.activeElement).toBe(row[1]);

    // Outside any group: no seek AND no preventDefault, so the WebView's
    // spatial navigation is free to move focus (issue #387).
    outside.focus();
    const event = arrowKeydown(outside, 'ArrowRight');
    expect(playerStub.seek).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
