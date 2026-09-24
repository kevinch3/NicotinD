import { TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import type { Subscription } from 'rxjs';
import { KeyboardShortcutsService } from './keyboard-shortcuts.service';
import { PlayerService } from './player.service';
import { LikeService } from './like.service';
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
    currentTrack: ReturnType<typeof signal<{ id: string } | null>>;
    isPlaying: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    playPrev: ReturnType<typeof vi.fn>;
    playNext: ReturnType<typeof vi.fn>;
    toggleVocalMute: ReturnType<typeof vi.fn>;
    nowPlayingOpen: ReturnType<typeof signal<boolean>>;
    setNowPlayingOpen: ReturnType<typeof vi.fn>;
    showNowPlayingPanel: ReturnType<typeof vi.fn>;
    startRadio: ReturnType<typeof vi.fn>;
    currentTime: ReturnType<typeof signal<number>>;
    seek: ReturnType<typeof vi.fn>;
  };
  let likeStub: { toggle: ReturnType<typeof vi.fn> };
  let sub: Subscription;

  @Component({ standalone: true, template: '' })
  class Blank {}

  function setup(initialIsPlaying: boolean) {
    playerStub = {
      currentTrack: signal<{ id: string } | null>({ id: 'song-1' }),
      isPlaying: vi.fn(() => initialIsPlaying),
      pause: vi.fn(),
      resume: vi.fn(),
      playPrev: vi.fn(),
      playNext: vi.fn(),
      toggleVocalMute: vi.fn(),
      nowPlayingOpen: signal(false),
      setNowPlayingOpen: vi.fn(),
      showNowPlayingPanel: vi.fn(),
      startRadio: vi.fn(),
      currentTime: signal(0),
      seek: vi.fn(),
    };
    likeStub = { toggle: vi.fn(() => Promise.resolve()) };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'player', component: Blank },
          { path: 'library', component: Blank },
        ]),
        KeyboardShortcutsService,
        { provide: PlayerService, useValue: playerStub },
        { provide: LikeService, useValue: likeStub },
      ],
    });
    const service = TestBed.inject(KeyboardShortcutsService);
    const router = TestBed.inject(Router);
    sub = service.initialize();
    return { service, router };
  }

  function focused<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    document.body.appendChild(el);
    el.focus();
    return el;
  }

  afterEach(() => {
    sub?.unsubscribe();
    document.body.innerHTML = '';
  });

  it('Space resumes playback when paused and nothing is focused', () => {
    setup(false);
    const event = dispatchKeydown(window, ' ');
    expect(playerStub.resume).toHaveBeenCalled();
    expect(playerStub.pause).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('Space pauses playback when playing', () => {
    setup(true);
    dispatchKeydown(window, ' ');
    expect(playerStub.pause).toHaveBeenCalled();
  });

  it('K also toggles play/pause, even on a focused button', () => {
    setup(false);
    const button = focused('button');
    dispatchKeydown(button, 'k');
    expect(playerStub.resume).toHaveBeenCalled();
  });

  it('Space is left to a focused button or role="switch" (its own activation wins)', () => {
    setup(false);
    const button = focused('button');
    const onButton = dispatchKeydown(button, ' ');
    const toggle = focused('button');
    toggle.setAttribute('role', 'switch');
    dispatchKeydown(toggle, ' ');
    expect(playerStub.resume).not.toHaveBeenCalled();
    expect(onButton.defaultPrevented).toBe(false);
  });

  it('nothing fires from an input, textarea, select or contenteditable', () => {
    setup(false);
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.appendChild(editable);
    const targets: HTMLElement[] = [
      focused('input'),
      focused('textarea'),
      focused('select'),
      editable,
    ];
    for (const target of targets) {
      for (const key of [' ', 'k', 'l', 'r', 'n', 'q', 'm', '/', '?', 'ArrowLeft', 'ArrowRight']) {
        const event = dispatchKeydown(target, key);
        expect(event.defaultPrevented, `${target.tagName} ${key}`).toBe(false);
      }
    }
    expect(playerStub.resume).not.toHaveBeenCalled();
    expect(playerStub.seek).not.toHaveBeenCalled();
    expect(likeStub.toggle).not.toHaveBeenCalled();
    expect(playerStub.startRadio).not.toHaveBeenCalled();
  });

  it('ArrowRight seeks forward 5 s from the current position', () => {
    setup(false);
    playerStub.currentTime.set(30);
    dispatchKeydown(window, 'ArrowRight');
    expect(playerStub.seek).toHaveBeenCalledWith(35);
  });

  it('ArrowLeft seeks back 5 s, clamped to 0', () => {
    setup(false);
    playerStub.currentTime.set(3);
    dispatchKeydown(window, 'ArrowLeft');
    expect(playerStub.seek).toHaveBeenCalledWith(0);
  });

  it('Shift+ArrowLeft / Shift+ArrowRight change track instead of seeking', () => {
    setup(false);
    dispatchKeydown(window, 'ArrowLeft', { shiftKey: true });
    dispatchKeydown(window, 'ArrowRight', { shiftKey: true });
    expect(playerStub.playPrev).toHaveBeenCalled();
    expect(playerStub.playNext).toHaveBeenCalled();
    expect(playerStub.seek).not.toHaveBeenCalled();
  });

  it('L likes the current track, and does nothing with no track loaded', () => {
    setup(false);
    dispatchKeydown(window, 'l');
    expect(likeStub.toggle).toHaveBeenCalledWith('song-1');
    playerStub.currentTrack.set(null);
    dispatchKeydown(window, 'l');
    expect(likeStub.toggle).toHaveBeenCalledTimes(1);
  });

  it("R starts a radio from the current track through the song menu's path", () => {
    setup(false);
    dispatchKeydown(window, 'r');
    expect(playerStub.startRadio).toHaveBeenCalledWith({ id: 'song-1' });
  });

  it('N toggles Now Playing', () => {
    setup(false);
    dispatchKeydown(window, 'n');
    expect(playerStub.setNowPlayingOpen).toHaveBeenLastCalledWith(true);
    playerStub.nowPlayingOpen.set(true);
    dispatchKeydown(window, 'n');
    expect(playerStub.setNowPlayingOpen).toHaveBeenLastCalledWith(false);
  });

  it('Q / Y open the sheet on the queue / lyrics tab', () => {
    setup(false);
    dispatchKeydown(window, 'q');
    expect(playerStub.showNowPlayingPanel).toHaveBeenLastCalledWith('queue');
    dispatchKeydown(window, 'y');
    expect(playerStub.showNowPlayingPanel).toHaveBeenLastCalledWith('lyrics');
  });

  it('M toggles vocal mute', () => {
    setup(false);
    dispatchKeydown(window, 'm');
    expect(playerStub.toggleVocalMute).toHaveBeenCalled();
  });

  it('? toggles the help sheet', () => {
    const { service } = setup(false);
    dispatchKeydown(window, '?', { shiftKey: true });
    expect(service.helpOpen()).toBe(true);
    dispatchKeydown(window, '?', { shiftKey: true });
    expect(service.helpOpen()).toBe(false);
  });

  it("/ focuses the page's own visible search box", () => {
    const { router } = setup(false);
    const navigateSpy = vi.spyOn(router, 'navigate');
    const main = document.createElement('main');
    const input = document.createElement('input');
    input.type = 'search';
    // jsdom has no layout; a rendered input reports at least one client rect.
    input.getClientRects = () => [{}] as unknown as DOMRectList;
    main.appendChild(input);
    document.body.appendChild(main);
    dispatchKeydown(window, '/');
    expect(document.activeElement).toBe(input);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("/ goes to the library's find box when the page has no search", () => {
    const { router } = setup(false);
    const navigateSpy = vi.spyOn(router, 'navigate');
    dispatchKeydown(window, '/');
    expect(navigateSpy).toHaveBeenCalledWith(['/library']);
  });

  it('Alt/Meta+Arrow (browser Back/Forward) neither seeks nor preventDefaults', () => {
    setup(false);
    playerStub.currentTime.set(30);
    const back = dispatchKeydown(window, 'ArrowLeft', { altKey: true });
    const forward = dispatchKeydown(window, 'ArrowRight', { metaKey: true });
    expect(playerStub.seek).not.toHaveBeenCalled();
    expect(back.defaultPrevented).toBe(false);
    expect(forward.defaultPrevented).toBe(false);
  });

  it('Ctrl/Meta + a letter (reserved browser shortcuts) does not fire the player action', () => {
    const { router } = setup(false);
    const navigateSpy = vi.spyOn(router, 'navigate');
    dispatchKeydown(window, 'l', { ctrlKey: true }); // Ctrl+L = address bar
    dispatchKeydown(window, 'r', { ctrlKey: true }); // Ctrl+R = reload
    dispatchKeydown(window, 'n', { ctrlKey: true }); // Ctrl+N = new window
    dispatchKeydown(window, 'm', { metaKey: true }); // Cmd+M = minimize
    dispatchKeydown(window, 'k', { ctrlKey: true }); // Ctrl+K = omnibox
    dispatchKeydown(window, ' ', { ctrlKey: true });
    dispatchKeydown(window, '/', { ctrlKey: true });
    expect(likeStub.toggle).not.toHaveBeenCalled();
    expect(playerStub.startRadio).not.toHaveBeenCalled();
    expect(playerStub.setNowPlayingOpen).not.toHaveBeenCalled();
    expect(playerStub.toggleVocalMute).not.toHaveBeenCalled();
    expect(playerStub.resume).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('does not seek when the keydown was already handled (defaultPrevented) by a D-pad nav group', () => {
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

  it('on a TV build, off the player route, every key is left to the D-pad', () => {
    vi.mocked(platform.isTvBuild).mockReturnValue(true);
    setup(false);
    playerStub.currentTime.set(30);
    for (const key of [' ', 'k', 'l', 'r', 'n', '/', 'ArrowLeft', 'ArrowRight']) {
      // The un-prevented event IS the fix: preventDefault() is what cancelled
      // the WebView's D-pad focus move (issue #387).
      expect(dispatchKeydown(window, key).defaultPrevented, key).toBe(false);
    }
    expect(playerStub.seek).not.toHaveBeenCalled();
    expect(playerStub.resume).not.toHaveBeenCalled();
  });

  it('on a TV build, the /player route seeks 10 s with ◀ ▶ (#438)', async () => {
    vi.mocked(platform.isTvBuild).mockReturnValue(true);
    const { router } = setup(false);
    await router.navigateByUrl('/player');
    playerStub.currentTime.set(30);
    dispatchKeydown(window, 'ArrowRight');
    expect(playerStub.seek).toHaveBeenLastCalledWith(40);
    dispatchKeydown(window, 'ArrowLeft');
    expect(playerStub.seek).toHaveBeenLastCalledWith(20);
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
        { provide: LikeService, useValue: { toggle: vi.fn() } },
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

    expect(playerStub.seek).toHaveBeenCalledWith(35);
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
