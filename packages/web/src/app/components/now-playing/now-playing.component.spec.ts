import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError, Subject } from 'rxjs';
import type { Observable } from 'rxjs';
import type { LyricsDto, WaveformData } from '@nicotind/core';
import { provideRouter } from '@angular/router';
import { NowPlayingComponent } from './now-playing.component';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';

function makePlayerStub() {
  return {
    currentTrack: signal<{ id: string; title: string; artist: string; artistId?: string } | null>(
      null,
    ),
    nowPlayingOpen: signal(true),
    nowPlayingLiftPx: signal(0),
    isPlaying: signal(false),
    shuffle: signal(false),
    repeat: signal('off'),
    radio: signal(false),
    radioFilter: signal(null),
    radioAnchor: signal(null),
    toggleRadio: () => {},
    queue: signal<
      { id: string; title: string; artist: string; coverArt?: string | null; album?: string }[]
    >([]),
    history: signal([]),
    context: signal(null),
    currentTime: signal(0),
    duration: signal(0),
    buffering: signal(false),
    bufferingVisible: signal(false),
    bufferedRanges: signal([]),
    setNowPlayingOpen: () => {},
    seek: vi.fn(),
    vocalsMuted: () => false,
  };
}

function makeRemoteStub() {
  return {
    isActiveDevice: signal(true),
    playingElsewhere: signal(false),
    sessionControllable: signal(true),
    activeDevice: signal(null),
    remoteIsPlaying: signal(false),
    remoteDuration: signal(0),
    remotePosition: signal(0),
    remotePositionTs: signal(Date.now()),
    devices: signal([]),
    activeDeviceId: signal(null),
    switcherOpen: signal(false),
    setSwitcherOpen: () => {},
    switchToDevice: () => {},
    setRemoteProgress: () => {},
  };
}

function makeLibraryStub() {
  return {
    // Typed to the real return so a test can mockReturnValue a populated DTO;
    // a bare `of(null)` infers Observable<null> and rejects every other shape.
    getLyrics: vi.fn<(id: string) => Observable<LyricsDto | null>>(() => of(null)),
    fetchLyrics: vi.fn<(id: string, force?: boolean) => Observable<LyricsDto | null>>(() =>
      of(null),
    ),
    setLyricsOffset: vi.fn<(id: string, offsetMs: number) => Observable<LyricsDto>>(() =>
      throwError(() => ({ status: 400 })),
    ),
    // 404 by default: "no waveform" is the common state and must leave the
    // sheet rendering exactly as before (#643).
    getPeaks: vi.fn<(id: string) => Observable<WaveformData>>(() =>
      throwError(() => ({ status: 404 })),
    ),
  };
}

function setup() {
  const playerStub = makePlayerStub();
  const remoteStub = makeRemoteStub();
  const libraryStub = makeLibraryStub();

  TestBed.configureTestingModule({
    imports: [NowPlayingComponent],
    providers: [
      provideRouter([]),
      { provide: PlayerService, useValue: playerStub },
      { provide: AuthService, useValue: { token: signal('tok'), canCurate: () => true } },
      { provide: LibraryApiService, useValue: libraryStub },
      { provide: RemotePlaybackService, useValue: remoteStub },
      {
        provide: PlaybackWsService,
        useValue: {
          getDeviceId: () => 'dev-1',
          getDeviceName: () => 'Test',
          sendCommand: () => {},
        },
      },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(NowPlayingComponent);
  fixture.detectChanges();
  return { fixture, playerStub, remoteStub, libraryStub };
}

describe('NowPlayingComponent', () => {
  // The component restores per-device UI state (active panel, queue height)
  // from localStorage at construction, and several tests here persist it —
  // entering karaoke fullscreen now records the panel choice (issue #446).
  // Without a reset, that leaks into every later test's fresh component.
  beforeEach(() => localStorage.clear());

  describe('device switcher', () => {
    it('renders app-device-switcher whenever a track is loaded (no opt-in gate)', () => {
      const { fixture, playerStub } = setup();

      playerStub.currentTrack.set({ id: '1', title: 'Song', artist: 'Artist' });
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('app-device-switcher')).not.toBeNull();
    });

    it('does not render app-device-switcher when no track is loaded', () => {
      const { fixture } = setup();
      // currentTrack is null by default

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('app-device-switcher')).toBeNull();
    });
  });

  describe('lyrics manual fetch (empty state)', () => {
    it('force-fetches and populates lyrics on success', () => {
      const { fixture, playerStub, libraryStub } = setup();
      const component = fixture.componentInstance;
      playerStub.currentTrack.set({ id: 's1', title: 'Song', artist: 'Artist' });
      libraryStub.fetchLyrics.mockReturnValue(
        of({
          plain: 'la la',
          synced: null,
          source: 'lrclib',
          customized: false,
          updatedAt: 0,
          offsetMs: 0,
        }),
      );

      component.fetchLyricsManually();

      expect(libraryStub.fetchLyrics).toHaveBeenCalledWith('s1', true);
      expect(component.lyrics()?.plain).toBe('la la');
      expect(component.fetchingLyrics()).toBe(false);
      expect(component.lyricsError()).toBe(false);
    });

    it('flags an error (for a retry) when the source fails', () => {
      const { fixture, playerStub, libraryStub } = setup();
      const component = fixture.componentInstance;
      playerStub.currentTrack.set({ id: 's1', title: 'Song', artist: 'Artist' });
      libraryStub.fetchLyrics.mockReturnValue(throwError(() => new Error('502')));

      component.fetchLyricsManually();

      expect(component.lyricsError()).toBe(true);
      expect(component.fetchingLyrics()).toBe(false);
      expect(component.lyrics()).toBeNull();
    });

    it('ignores a second click while a fetch is in flight', () => {
      const { fixture, playerStub, libraryStub } = setup();
      const component = fixture.componentInstance;
      playerStub.currentTrack.set({ id: 's1', title: 'Song', artist: 'Artist' });
      // A never-completing observable keeps fetchingLyrics true.
      libraryStub.fetchLyrics.mockReturnValue(new Subject());

      component.fetchLyricsManually();
      component.fetchLyricsManually();

      expect(libraryStub.fetchLyrics).toHaveBeenCalledTimes(1);
      expect(component.fetchingLyrics()).toBe(true);
    });
  });

  describe('waveform fetch waits for the audio (#1328)', () => {
    it('does not request peaks while the track is still buffering', () => {
      const { fixture, playerStub, libraryStub } = setup();
      playerStub.buffering.set(true);
      playerStub.currentTrack.set({ id: 'w1', title: 'Song', artist: 'Artist' });
      fixture.detectChanges();
      expect(libraryStub.getPeaks).not.toHaveBeenCalled();

      playerStub.buffering.set(false);
      fixture.detectChanges();
      expect(libraryStub.getPeaks.mock.calls).toEqual([['w1']]);
    });

    it('fetches only the track a skip burst lands on', () => {
      const { fixture, playerStub, libraryStub } = setup();
      playerStub.buffering.set(true);
      for (const id of ['b1', 'b2', 'b3']) {
        playerStub.currentTrack.set({ id, title: id, artist: 'Artist' });
        fixture.detectChanges();
      }
      playerStub.buffering.set(false);
      fixture.detectChanges();
      expect(libraryStub.getPeaks.mock.calls).toEqual([['b3']]);
    });
  });

  describe('hasLyrics (tab-switcher dot)', () => {
    it('does not show a stale positive after switching tracks with lyrics loaded for the previous one', () => {
      const { fixture, playerStub, libraryStub } = setup();
      const component = fixture.componentInstance;

      // Load lyrics for track A (simulates having visited the Lyrics tab).
      playerStub.currentTrack.set({ id: 'a', title: 'Song A', artist: 'Artist' });
      libraryStub.fetchLyrics.mockReturnValue(
        of({
          plain: 'la la',
          synced: null,
          source: 'lrclib',
          customized: false,
          updatedAt: 0,
          offsetMs: 0,
        }),
      );
      component.fetchLyricsManually();
      expect(component.hasLyrics()).toBe(true);

      // Switch to track B without reopening the lyrics panel — `lyrics()`
      // still holds track A's data (nothing clears it on track change).
      playerStub.currentTrack.set({ id: 'b', title: 'Song B', artist: 'Artist' });

      expect(component.hasLyrics()).toBe(false);
    });

    it('is false with no current track', () => {
      const { fixture } = setup();
      expect(fixture.componentInstance.hasLyrics()).toBe(false);
    });
  });

  describe('karaoke fullscreen 2-line mode', () => {
    function withSyncedLyrics(playerStub: ReturnType<typeof makePlayerStub>) {
      playerStub.currentTrack.set({ id: 's1', title: 'Song', artist: 'Artist' });
    }

    it('starts in auto-follow mode (not browsing) when fullscreen opens', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;

      component.toggleKaraokeFullscreen();

      expect(component.karaokeBrowsing()).toBe(false);
    });

    it('currentLineText/nextLineText read from lyricLines at activeLine', () => {
      const { fixture, playerStub, libraryStub } = setup();
      const component = fixture.componentInstance;
      withSyncedLyrics(playerStub);
      libraryStub.getLyrics.mockReturnValue(
        of({
          plain: null,
          synced: '[00:00.00]first line\n[00:10.00]second line\n[00:20.00]third line',
          source: 'lrclib',
          customized: false,
          updatedAt: 0,
          offsetMs: 0,
        }),
      );
      component.setActivePanel('lyrics');
      fixture.detectChanges();
      playerStub.currentTime.set(10); // activeLine -> index 1 ("second line")

      expect(component.currentLineText()).toBe('second line');
      expect(component.nextLineText()).toBe('third line');
    });

    it('nextLineText is null on the last line', () => {
      const { fixture, playerStub, libraryStub } = setup();
      const component = fixture.componentInstance;
      withSyncedLyrics(playerStub);
      libraryStub.getLyrics.mockReturnValue(
        of({
          plain: null,
          synced: '[00:00.00]only line',
          source: 'lrclib',
          customized: false,
          updatedAt: 0,
          offsetMs: 0,
        }),
      );
      component.setActivePanel('lyrics');
      fixture.detectChanges();
      playerStub.currentTime.set(0);

      expect(component.currentLineText()).toBe('only line');
      expect(component.nextLineText()).toBeNull();
    });

    it('onKaraokeInteraction enters browsing mode', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      component.toggleKaraokeFullscreen();

      component.onKaraokeInteraction();

      expect(component.karaokeBrowsing()).toBe(true);
    });

    it('onKaraokeInteraction auto-returns to auto-follow after the idle timeout', () => {
      vi.useFakeTimers();
      try {
        const { fixture } = setup();
        const component = fixture.componentInstance;
        component.toggleKaraokeFullscreen();

        component.onKaraokeInteraction();
        expect(component.karaokeBrowsing()).toBe(true);

        vi.advanceTimersByTime(4000);
        expect(component.karaokeBrowsing()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('seekToLine seeks to the line timestamp and exits browsing mode', () => {
      const { fixture, playerStub, libraryStub } = setup();
      const component = fixture.componentInstance;
      withSyncedLyrics(playerStub);
      libraryStub.getLyrics.mockReturnValue(
        of({
          plain: null,
          synced: '[00:00.00]first line\n[00:12.50]second line',
          source: 'lrclib',
          customized: false,
          updatedAt: 0,
          offsetMs: 0,
        }),
      );
      component.setActivePanel('lyrics');
      fixture.detectChanges();
      component.toggleKaraokeFullscreen();
      component.onKaraokeInteraction();
      expect(component.karaokeBrowsing()).toBe(true);

      component.seekToLine(1);

      expect(playerStub.seek).toHaveBeenCalledWith(12.5);
      expect(component.karaokeBrowsing()).toBe(false);
    });

    it('seekToLine does nothing for an out-of-range index', () => {
      const { fixture, playerStub } = setup();
      const component = fixture.componentInstance;
      withSyncedLyrics(playerStub);

      component.seekToLine(99);

      expect(playerStub.seek).not.toHaveBeenCalled();
    });

    it('exiting fullscreen resets browsing back to auto-follow', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      component.toggleKaraokeFullscreen();
      component.onKaraokeInteraction();
      expect(component.karaokeBrowsing()).toBe(true);

      component.toggleKaraokeFullscreen(); // exits fullscreen

      expect(component.karaokeBrowsing()).toBe(false);
    });

    // "renders only current+next lines in auto-follow mode" and "shows the
    // full list in browse mode and seeks on line click" moved to
    // now-playing-karaoke-fullscreen.component.spec.ts as of the Task 10
    // shell decomposition: the JIT vitest harness doesn't propagate a
    // template `[input]="…"` binding across a *nested* component boundary
    // (see src/testing/signal-input.ts's documented limitation — the same
    // gap extends to a nested child's rendered content, not just its signal
    // value), so once the karaoke overlay became a child component instead
    // of inline shell markup, its *content* can only be asserted from its
    // own spec (driven directly with `setInputValue`), not through the shell.
    // The shell-level "tabbed queue/lyrics panel wiring" describe below
    // still asserts the shell's own responsibility: that the right child
    // *component* is present/absent.

    // The auto-scroll effect's container *selection* (in-place lyrics panel
    // vs. karaoke-fullscreen browse list) is a pure `resolveLyricsScrollContainer`
    // (lib/lyrics-scroll-container.ts, unit-tested standalone) so the branching
    // logic is covered without going through Angular `viewChild()` at all —
    // this JIT vitest harness doesn't resolve *any* `viewChild()` query
    // (confirmed with a minimal inline-template repro unrelated to now-playing:
    // a bare `<div #ref>` component's own `viewChild<ElementRef>('ref')` stays
    // `undefined` after `detectChanges()`), so a test exercising the real refs
    // end-to-end through this shell can only ever pass in a real browser/e2e.

    it('alternates the line animation class each time activeLine changes', () => {
      const { fixture, playerStub, libraryStub } = setup();
      const component = fixture.componentInstance;
      withSyncedLyrics(playerStub);
      libraryStub.getLyrics.mockReturnValue(
        of({
          plain: null,
          synced: '[00:00.00]a\n[00:05.00]b\n[00:10.00]c',
          source: 'lrclib',
          customized: false,
          updatedAt: 0,
          offsetMs: 0,
        }),
      );
      component.setActivePanel('lyrics');
      fixture.detectChanges();

      const first = component.karaokeLineAnimClass();
      playerStub.currentTime.set(5); // activeLine index 0 -> 1
      fixture.detectChanges();
      const second = component.karaokeLineAnimClass();
      playerStub.currentTime.set(10); // activeLine index 1 -> 2
      fixture.detectChanges();
      const third = component.karaokeLineAnimClass();

      expect(second).not.toBe(first);
      expect(third).not.toBe(second);
    });

    it('toggleKaraokeBrowsing enters browsing mode from auto-follow', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      component.toggleKaraokeFullscreen();
      expect(component.karaokeBrowsing()).toBe(false);

      component.toggleKaraokeBrowsing();

      expect(component.karaokeBrowsing()).toBe(true);
    });

    it('toggleKaraokeBrowsing exits browsing mode back to auto-follow', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      component.toggleKaraokeFullscreen();
      component.onKaraokeInteraction();
      expect(component.karaokeBrowsing()).toBe(true);

      component.toggleKaraokeBrowsing();

      expect(component.karaokeBrowsing()).toBe(false);
    });

    it('renders a visible browse-toggle button in the fullscreen header', () => {
      const { fixture, playerStub } = setup();
      const component = fixture.componentInstance;
      playerStub.currentTrack.set({ id: 's1', title: 'Song', artist: 'Artist' });
      component.toggleKaraokeFullscreen();
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector('[data-testid="karaoke-browse-toggle"]');
      expect(btn).not.toBeNull();
    });

    // "ArrowDown/ArrowUp on the overlay enters browsing mode" moved to
    // now-playing-karaoke-fullscreen.component.spec.ts for the same reason
    // as above — the keydown listener now lives on the extracted child's own
    // template, and its `(interaction)` output crossing back to this shell
    // can't be exercised via a real DOM event dispatch in this harness
    // (confirmed by a minimal repro: an `output()`-based child event bound
    // in a *parent* template via `(event)="…"` never reaches the parent
    // handler here, while `componentInstance.someOutput.subscribe(...)`
    // does — the same class of gap `setInputValue` works around for inputs).
    // `onKaraokeInteraction enters browsing mode` above still covers the
    // shell's own reaction to that call directly.
  });

  describe('active panel (queue vs lyrics)', () => {
    beforeEach(() => localStorage.clear());

    it('persists the active panel choice across construction', () => {
      localStorage.setItem('nicotind:np-active-panel', 'lyrics');
      const fixture = TestBed.createComponent(NowPlayingComponent);
      expect(fixture.componentInstance.activePanel()).toBe('lyrics');
    });

    it('seeds lyricsOpen from a restored lyrics activePanel (issue: lyrics tab restored with lyricsOpen still false)', () => {
      localStorage.setItem('nicotind:np-active-panel', 'lyrics');
      const fixture = TestBed.createComponent(NowPlayingComponent);
      expect(fixture.componentInstance.activePanel()).toBe('lyrics');
      expect(fixture.componentInstance.lyricsOpen()).toBe(true);
    });

    it('leaves lyricsOpen false when the restored activePanel is queue', () => {
      const fixture = TestBed.createComponent(NowPlayingComponent);
      expect(fixture.componentInstance.activePanel()).toBe('queue');
      expect(fixture.componentInstance.lyricsOpen()).toBe(false);
    });

    it('lyricsOpen is derived, so it cannot disagree with the persisted panel', () => {
      // Two independently-writable booleans for one panel is what drifted:
      // entering karaoke fullscreen used to open lyrics by writing lyricsOpen
      // directly, leaving activePanel (the value that gets persisted and
      // restored) saying 'queue' while lyrics were on screen.
      const fixture = TestBed.createComponent(NowPlayingComponent);
      const c = fixture.componentInstance;

      c.toggleKaraokeFullscreen();

      expect(c.lyricsOpen()).toBe(true);
      expect(c.activePanel()).toBe('lyrics');
      expect(localStorage.getItem('nicotind:np-active-panel')).toBe('lyrics');
    });

    it('leaving the lyrics panel exits karaoke fullscreen', () => {
      const fixture = TestBed.createComponent(NowPlayingComponent);
      const c = fixture.componentInstance;

      c.setActivePanel('lyrics');
      c.toggleKaraokeFullscreen();
      expect(c.karaokeFullscreen()).toBe(true);

      // Otherwise the overlay outlives the panel behind it.
      c.setActivePanel('queue');
      expect(c.karaokeFullscreen()).toBe(false);
      expect(c.lyricsOpen()).toBe(false);
    });

    it('setActivePanel updates the signal and persists it', () => {
      const fixture = TestBed.createComponent(NowPlayingComponent);
      fixture.componentInstance.setActivePanel('lyrics');
      expect(fixture.componentInstance.activePanel()).toBe('lyrics');
      expect(localStorage.getItem('nicotind:np-active-panel')).toBe('lyrics');
    });
  });

  describe('queue resize (drag handle)', () => {
    const pointer = (type: string, clientY: number, button = 0) =>
      new MouseEvent(type, { clientY, button }) as unknown as PointerEvent;

    beforeEach(() => localStorage.clear());

    it('grows the queue (shrinks the cover) when dragged up, and clamps', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      expect(component.queueExtraHeightPx()).toBe(0);
      expect(component.coverMaxPx()).toBe(320);

      component.onQueueResizeStart(pointer('pointerdown', 300));
      document.dispatchEvent(pointer('pointermove', 200)); // up 100px
      expect(component.queueExtraHeightPx()).toBe(100);
      expect(component.coverMaxPx()).toBe(220);

      // 300px up is now within range: the floor is 0, not 120 (#993), so the
      // cover keeps shrinking instead of stopping with most of the reclaimed
      // space handed back.
      document.dispatchEvent(pointer('pointermove', 0)); // up 300px from start
      expect(component.queueExtraHeightPx()).toBe(300);
      expect(component.coverMaxPx()).toBe(20);

      document.dispatchEvent(pointer('pointerup', 0));
    });

    it('collapses the cover all the way to zero, and no further', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;

      component.onQueueResizeStart(pointer('pointerdown', 500));
      // Far past the full 320px range.
      document.dispatchEvent(pointer('pointermove', -400));
      expect(component.coverMaxPx()).toBe(0);
      expect(component.queueExtraHeightPx()).toBe(320);

      document.dispatchEvent(pointer('pointerup', -400));
    });

    it('clamps a downward drag back to zero', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      component.onQueueResizeStart(pointer('pointerdown', 100));
      document.dispatchEvent(pointer('pointermove', 260)); // down 160
      expect(component.queueExtraHeightPx()).toBe(0);
      document.dispatchEvent(pointer('pointerup', 260));
    });

    it('persists the chosen size across a fresh mount (per-device)', () => {
      const first = setup();
      first.fixture.componentInstance.onQueueResizeStart(pointer('pointerdown', 300));
      document.dispatchEvent(pointer('pointermove', 220)); // up 80
      document.dispatchEvent(pointer('pointerup', 220));
      expect(first.fixture.componentInstance.queueExtraHeightPx()).toBe(80);

      // A new component instance reads the persisted value on construction.
      TestBed.resetTestingModule();
      const second = setup();
      expect(second.fixture.componentInstance.queueExtraHeightPx()).toBe(80);
    });
  });

  describe('hoisted resize handle (shell-owned)', () => {
    // The handle used to live inside the queue panel, below the Queue/Lyrics tab
    // bar — so it vanished whenever the Lyrics tab was active and read as "lost".
    // It is now owned by the shell, above the tabs, working for both panels.
    // Bubbling, like a real pointerdown: the notch is served by the sheet
    // root's gesture, not a handler of its own.
    const pointer = (type: string, clientY: number, button = 0) =>
      new MouseEvent(type, { clientY, button, bubbles: true }) as unknown as PointerEvent;

    function setupWithTrack() {
      const ctx = setup();
      ctx.playerStub.currentTrack.set({ id: '1', title: 'Song', artist: 'Artist' });
      ctx.fixture.detectChanges();
      return ctx;
    }

    beforeEach(() => localStorage.clear());

    it('renders the handle in the shell, outside the queue panel and before the tabs', () => {
      const { fixture } = setupWithTrack();
      const el: HTMLElement = fixture.nativeElement;
      const handle = el.querySelector('[data-testid="now-playing-queue-resize"]')!;
      expect(handle).not.toBeNull();
      expect(handle.closest('app-now-playing-queue-panel')).toBeNull();
      const tabs = el.querySelector('app-now-playing-panel-tabs')!;
      expect(handle.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('stays available on the Lyrics tab', () => {
      const { fixture } = setupWithTrack();
      fixture.componentInstance.setActivePanel('lyrics');
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="now-playing-queue-resize"]'),
      ).not.toBeNull();
    });

    it('drives the queue resize drag from the template wiring', () => {
      const { fixture } = setupWithTrack();
      const handle: HTMLElement = fixture.nativeElement.querySelector(
        '[data-testid="now-playing-queue-resize"]',
      )!;
      handle.dispatchEvent(pointer('pointerdown', 300));
      document.dispatchEvent(pointer('pointermove', 200)); // up 100px
      expect(fixture.componentInstance.queueExtraHeightPx()).toBe(100);
      document.dispatchEvent(pointer('pointerup', 200));
    });

    it('is absent while karaoke fullscreen is active', () => {
      const { fixture } = setupWithTrack();
      fixture.componentInstance.toggleKaraokeFullscreen();
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="now-playing-queue-resize"]'),
      ).toBeNull();
    });
  });

  describe('notch / safe-area clearance', () => {
    // The now-playing sheet is fixed inset-0 over a viewport-fit=cover page, so
    // on notched iPhones the grab pill + close chevron sit right under the
    // hardware cutout. The header must pad its top by env(safe-area-inset-top)
    // so the dismiss affordance stays visible/tappable; otherwise the user
    // can't close the sheet (regression: iPhone 13 Pro PWA).
    it('pads the drag-handle header with env(safe-area-inset-top)', () => {
      const { fixture, playerStub } = setup();
      playerStub.currentTrack.set({ id: '1', title: 'Song', artist: 'Artist' });
      fixture.detectChanges();

      // The drag-handle header is the touch-none element that pads its top
      // with env(safe-area-inset-top) to drop below the iPhone hardware notch.
      const candidate = Array.from(
        fixture.nativeElement.querySelectorAll('[class*="safe-area-inset-top"]'),
      ).find((el) => (el as HTMLElement).classList.contains('touch-none'));

      expect(candidate).toBeTruthy();
      expect((candidate as HTMLElement).className).toContain('safe-area-inset-top');
    });
  });

  describe('queue D-pad navigation', () => {
    // Each row is now its own nested `axis="horizontal"` group of
    // [jump, remove] (issue #356 — Remove is D-pad reachable via ArrowRight),
    // so `[appTvNavItem]` under the outer rows group now matches 2 elements
    // per row, not 1. `.jump`/`.remove`-style structure isn't in the DOM
    // (there's no such class); use `[data-testid="queue-remove"]` and "the
    // other button in the row" to distinguish them.
    function queueRows(fixture: { nativeElement: HTMLElement }) {
      const outerGroup = fixture.nativeElement.querySelector(
        '[data-testid="now-playing-queue"] [appTvNavGroup]',
      )!;
      const rowGroups: HTMLElement[] = Array.from(outerGroup.querySelectorAll('[appTvNavGroup]'));
      return rowGroups.map((row) => ({
        jump: row.querySelector('[appTvNavItem]:not([data-testid="queue-remove"])') as HTMLElement,
        remove: row.querySelector('[data-testid="queue-remove"]') as HTMLElement,
      }));
    }

    it('renders the queue list as a rows group of nested [jump, remove] row groups', () => {
      const { fixture, playerStub } = setup();
      playerStub.currentTrack.set({ id: 'now', title: 'Now Playing', artist: 'A' });
      playerStub.queue.set([
        { id: 't1', title: 'One', artist: 'A' },
        { id: 't2', title: 'Two', artist: 'A' },
      ]);
      fixture.detectChanges();

      const rows = queueRows(fixture);
      expect(rows.length).toBe(2);
      expect(rows[0]!.jump).toBeTruthy();
      expect(rows[0]!.remove).toBeTruthy();
    });

    // Phase 1/2's flagship consumer, re-asserted behaviorally after items
    // moved from an @ContentChildren query to DI self-registration: this group
    // has no component boundary, so its behaviour must be unchanged. Now
    // exercises the nested two-axis model (issue #356) instead of a flat list.
    it("ArrowDown moves focus to the next row's jump button", () => {
      const { fixture, playerStub } = setup();
      playerStub.currentTrack.set({ id: 'now', title: 'Now Playing', artist: 'A' });
      playerStub.queue.set([
        { id: 't1', title: 'One', artist: 'A' },
        { id: 't2', title: 'Two', artist: 'A' },
      ]);
      fixture.detectChanges();

      const rows = queueRows(fixture);
      // Since the sheet gained a ROOT nav group (issue #389) the single Tab
      // stop belongs to its first entry (the header close button), so every
      // queue item starts at -1; focusing a row re-syncs the whole chain.
      expect(rows[0]!.jump.getAttribute('tabindex')).toBe('-1');
      expect(rows[1]!.jump.getAttribute('tabindex')).toBe('-1');
      rows[0]!.jump.focus();
      rows[0]!.jump.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
      fixture.detectChanges();
      expect(document.activeElement).toBe(rows[1]!.jump);
      expect(rows[1]!.jump.getAttribute('tabindex')).toBe('0');
    });

    it("ArrowRight from the jump button reaches the row's Remove button (issue #356)", () => {
      const { fixture, playerStub } = setup();
      playerStub.currentTrack.set({ id: 'now', title: 'Now Playing', artist: 'A' });
      playerStub.queue.set([{ id: 't1', title: 'One', artist: 'A' }]);
      fixture.detectChanges();

      const rows = queueRows(fixture);
      rows[0]!.jump.focus();
      rows[0]!.jump.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
      fixture.detectChanges();
      expect(document.activeElement).toBe(rows[0]!.remove);
    });
  });

  describe('tabbed queue/lyrics panel wiring', () => {
    beforeEach(() => localStorage.clear());

    // The tab buttons themselves route through `app-now-playing-panel-tabs`'s
    // `(panelSelected)` output — its own spec covers that a click emits the
    // right value (`now-playing-panel-tabs.component.spec.ts`, direct
    // `.subscribe()`, since the JIT vitest harness doesn't propagate a
    // template `(event)="…"` binding across a *nested* component boundary;
    // see src/testing/signal-input.ts's documented input-side version of the
    // same gap). These shell-level tests drive `setActivePanel` directly
    // (exactly what that output binding calls) to assert the shell's own
    // responsibility: swapping which child renders.
    it('shows the queue panel by default and switches to lyrics on tab select', () => {
      const { fixture, playerStub } = setup();
      playerStub.currentTrack.set({ id: '1', title: 'Song', artist: 'Artist' });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-now-playing-queue-panel')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-now-playing-lyrics-panel')).toBeNull();

      fixture.componentInstance.setActivePanel('lyrics');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-now-playing-lyrics-panel')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-now-playing-queue-panel')).toBeNull();
    });

    it('shows the karaoke fullscreen component instead of the lyrics panel when karaokeFullscreen is set', () => {
      const { fixture, playerStub } = setup();
      playerStub.currentTrack.set({ id: '1', title: 'Song', artist: 'Artist' });
      fixture.detectChanges();
      fixture.componentInstance.setActivePanel('lyrics');
      fixture.componentInstance.karaokeFullscreen.set(true);
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('app-now-playing-karaoke-fullscreen'),
      ).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-now-playing-lyrics-panel')).toBeNull();
    });

    it('returns to the queue view when the Queue tab is selected after Lyrics', () => {
      const { fixture, playerStub } = setup();
      playerStub.currentTrack.set({ id: '1', title: 'Song', artist: 'Artist' });
      fixture.detectChanges();

      fixture.componentInstance.setActivePanel('lyrics');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-now-playing-lyrics-panel')).toBeTruthy();

      fixture.componentInstance.setActivePanel('queue');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-now-playing-queue-panel')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-now-playing-lyrics-panel')).toBeNull();
    });
  });

  describe('sheet body gesture (mode table)', () => {
    // Stamped so the flick velocity is deterministic (jsdom stamps events at
    // creation; two in one tick would read as a flick).
    const pointer = (
      type: string,
      clientY: number,
      opts: { t?: number; target?: Element; clientX?: number; button?: number } = {},
    ) => {
      const e = new MouseEvent(type, {
        clientY,
        clientX: opts.clientX ?? 0,
        button: opts.button ?? 0,
      }) as unknown as PointerEvent;
      Object.defineProperty(e, 'timeStamp', { value: opts.t ?? 0 });
      if (opts.target) Object.defineProperty(e, 'target', { value: opts.target });
      return e;
    };
    const move = (y: number, t = 500) => document.dispatchEvent(pointer('pointermove', y, { t }));
    const up = (y: number, t = 1000) => document.dispatchEvent(pointer('pointerup', y, { t }));

    /** A panel zone with a scroller inside, as the tabs+panel wrapper renders. */
    function panelZone(scrollTop: number) {
      const zone = document.createElement('div');
      zone.setAttribute('data-np-zone', 'panel');
      const scroller = document.createElement('div');
      scroller.style.overflowY = 'auto';
      Object.defineProperty(scroller, 'scrollTop', { value: scrollTop, configurable: true });
      const row = document.createElement('div');
      zone.appendChild(scroller);
      scroller.appendChild(row);
      document.body.appendChild(zone);
      return { zone, row };
    }

    afterEach(() => {
      document.querySelectorAll('[data-np-zone]').forEach((n) => n.remove());
      delete (window as { matchMedia?: unknown }).matchMedia;
    });

    it('stage + down: follows the finger and closes past the threshold', () => {
      const { fixture, playerStub } = setup();
      const component = fixture.componentInstance;
      const setOpen = vi.spyOn(playerStub, 'setNowPlayingOpen');

      component.onBodyPointerDown(pointer('pointerdown', 100));
      expect(component.dragging()).toBe(true);
      move(280); // delta 180 > 120 threshold
      expect(component.dragOffsetPx()).toBe(180);
      expect(component.resizingQueue()).toBe(false);

      up(280);
      expect(setOpen).toHaveBeenCalledWith(false);
      expect(component.dragOffsetPx()).toBe(0);
      expect(component.dragging()).toBe(false);
    });

    it('snaps back without closing for a short, slow drag', () => {
      const { fixture, playerStub } = setup();
      const component = fixture.componentInstance;
      const setOpen = vi.spyOn(playerStub, 'setNowPlayingOpen');

      component.onBodyPointerDown(pointer('pointerdown', 100));
      move(150);
      up(150);

      expect(setOpen).not.toHaveBeenCalled();
      expect(component.dragOffsetPx()).toBe(0);
    });

    it('a short but fast flick down closes', () => {
      const { fixture, playerStub } = setup();
      const component = fixture.componentInstance;
      const setOpen = vi.spyOn(playerStub, 'setNowPlayingOpen');

      component.onBodyPointerDown(pointer('pointerdown', 100));
      move(140, 20); // 40px in 20ms = 2 px/ms
      up(140, 20);

      expect(setOpen).toHaveBeenCalledWith(false);
    });

    it('closes on pointercancel past the threshold (touch may never deliver pointerup)', () => {
      const { fixture, playerStub } = setup();
      const component = fixture.componentInstance;
      const setOpen = vi.spyOn(playerStub, 'setNowPlayingOpen');

      component.onBodyPointerDown(pointer('pointerdown', 100));
      move(280);
      document.dispatchEvent(pointer('pointercancel', 280, { t: 1000 }));

      expect(setOpen).toHaveBeenCalledWith(false);
      expect(component.dragOffsetPx()).toBe(0);
    });

    it('stage + up: grows the panel (shrinks the cover) from anywhere, not just the notch', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;

      component.onBodyPointerDown(pointer('pointerdown', 400));
      move(300); // up 100
      expect(component.queueExtraHeightPx()).toBe(100);
      expect(component.resizingQueue()).toBe(true);
      expect(component.dragOffsetPx()).toBe(0);
      up(300);
      expect(localStorage.getItem('nicotind:np-queue-extra')).toBe('100');
      expect(component.resizingQueue()).toBe(false);
    });

    it('stage + down with the panel grown: collapses it, then continues into a dismiss', () => {
      const { fixture, playerStub } = setup();
      const component = fixture.componentInstance;
      const setOpen = vi.spyOn(playerStub, 'setNowPlayingOpen');
      component.queueExtraHeightPx.set(100);

      component.onBodyPointerDown(pointer('pointerdown', 100));
      move(160); // down 60: still collapsing
      expect(component.queueExtraHeightPx()).toBe(40);
      expect(component.dragOffsetPx()).toBe(0);

      move(250); // down 150: 100 spent on the collapse, 50 into the dismiss
      expect(component.queueExtraHeightPx()).toBe(0);
      expect(component.dragOffsetPx()).toBe(50);
      expect(component.resizingQueue()).toBe(false);

      up(250); // 50 < threshold, slow: springs back, collapse persisted
      expect(setOpen).not.toHaveBeenCalled();
      expect(component.dragOffsetPx()).toBe(0);
      expect(localStorage.getItem('nicotind:np-queue-extra')).toBe('0');
    });

    it('panel + down with the list scrolled: released to native scrolling', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      const { row } = panelZone(40);

      component.onBodyPointerDown(pointer('pointerdown', 100, { target: row }));
      move(200);
      expect(component.dragging()).toBe(false);
      expect(component.dragOffsetPx()).toBe(0);
      expect(component.queueExtraHeightPx()).toBe(0);
    });

    it('panel + down at the top with the panel grown: collapses it', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      component.queueExtraHeightPx.set(120);
      const { row } = panelZone(0);

      component.onBodyPointerDown(pointer('pointerdown', 100, { target: row }));
      move(150);
      expect(component.queueExtraHeightPx()).toBe(70);
      expect(component.dragOffsetPx()).toBe(0);
      up(150);
    });

    it('panel + down at the top with the panel at rest: dismisses the sheet', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      const { row } = panelZone(0);

      component.onBodyPointerDown(pointer('pointerdown', 100, { target: row }));
      move(150);
      expect(component.dragOffsetPx()).toBe(50);
      up(150);
    });

    it('panel + up: grows the panel even from inside the scroller', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      const { row } = panelZone(40);

      component.onBodyPointerDown(pointer('pointerdown', 300, { target: row }));
      move(250);
      expect(component.queueExtraHeightPx()).toBe(50);
      up(250);
    });

    it('panel + up when fully grown: released so the list scrolls', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      component.queueExtraHeightPx.set(320);
      const { row } = panelZone(0);

      component.onBodyPointerDown(pointer('pointerdown', 300, { target: row }));
      move(250);
      expect(component.dragging()).toBe(false);
      expect(component.queueExtraHeightPx()).toBe(320);
    });

    it('at lg (side-panel layout) an up-swipe is released and a down-swipe dismisses', () => {
      (window as { matchMedia?: unknown }).matchMedia = (q: string) => ({
        matches: q.includes('1024px'),
      });
      const { fixture } = setup();
      const component = fixture.componentInstance;

      component.onBodyPointerDown(pointer('pointerdown', 300));
      move(200);
      expect(component.dragging()).toBe(false);
      expect(component.queueExtraHeightPx()).toBe(0);

      component.onBodyPointerDown(pointer('pointerdown', 100));
      move(200);
      expect(component.dragOffsetPx()).toBe(100);
      up(200);
    });

    it.each([
      ['a button', () => document.createElement('button')],
      ['a link', () => document.createElement('a')],
      [
        'the seek bar',
        () => {
          const el = document.createElement('div');
          el.setAttribute('data-seek', '');
          return el;
        },
      ],
      [
        'a menu panel',
        () => {
          const menu = document.createElement('app-menu-panel');
          const inner = document.createElement('div');
          menu.appendChild(inner);
          return inner;
        },
      ],
      [
        'a draggable queue row',
        () => {
          const row = document.createElement('li');
          row.setAttribute('draggable', 'true');
          const inner = document.createElement('span');
          row.appendChild(inner);
          return inner;
        },
      ],
    ])('never starts from %s', (_label, make) => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      component.onBodyPointerDown(pointer('pointerdown', 100, { target: make() }));
      expect(component.dragging()).toBe(false);
    });

    it('never starts while karaoke fullscreen owns the screen', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      component.karaokeFullscreen.set(true);
      component.onBodyPointerDown(pointer('pointerdown', 100));
      expect(component.dragging()).toBe(false);
    });

    it('ignores non-primary buttons', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      component.onBodyPointerDown(pointer('pointerdown', 100, { button: 2 }));
      expect(component.dragging()).toBe(false);
    });

    it('the resize notch routes into the same gesture', () => {
      const { fixture, playerStub } = setup();
      playerStub.currentTrack.set({ id: '1', title: 'Song', artist: 'Artist' });
      fixture.detectChanges();
      const spy = vi.spyOn(fixture.componentInstance, 'onBodyPointerDown');
      const el: HTMLElement = fixture.nativeElement;
      el.querySelector('[data-testid="now-playing-queue-resize"]')!.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('closed-sheet lift (live-follow open from the mini bar)', () => {
    function root(fixture: { nativeElement: HTMLElement }) {
      return fixture.nativeElement.querySelector<HTMLElement>('.fixed.inset-0')!;
    }

    it('rides PlayerService.nowPlayingLiftPx while closed, with transitions off', () => {
      const { fixture, playerStub } = setup();
      playerStub.currentTrack.set({ id: '1', title: 'Song', artist: 'Artist' });
      playerStub.nowPlayingOpen.set(false);
      playerStub.nowPlayingLiftPx.set(80);
      fixture.detectChanges();

      const el = root(fixture);
      expect(el.style.transform).toBe('translateY(calc(100% - 80px))');
      expect(el.classList.contains('transition-none')).toBe(true);
    });

    it('parks the sheet normally once the lift drops to zero', () => {
      const { fixture, playerStub } = setup();
      playerStub.currentTrack.set({ id: '1', title: 'Song', artist: 'Artist' });
      playerStub.nowPlayingOpen.set(false);
      playerStub.nowPlayingLiftPx.set(0);
      fixture.detectChanges();

      const el = root(fixture);
      expect(el.style.transform).toBe('');
      expect(el.classList.contains('translate-y-full')).toBe(true);
      expect(el.classList.contains('transition-none')).toBe(false);
    });
  });

  describe('desktop side-panel splitter', () => {
    const pointer = (type: string, clientX: number, button = 0) =>
      new MouseEvent(type, { clientX, button }) as unknown as PointerEvent;
    const key = (k: string) => new KeyboardEvent('keydown', { key: k, cancelable: true });

    beforeEach(() => {
      localStorage.clear();
      Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    });

    it('defaults to 380px and grows when the border is dragged left', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      expect(component.sidePanelWidthPx()).toBe(380);

      component.onSideResizeStart(pointer('pointerdown', 1000));
      document.dispatchEvent(pointer('pointermove', 900));
      expect(component.sidePanelWidthPx()).toBe(480);
      document.dispatchEvent(pointer('pointerup', 900));
      expect(localStorage.getItem('nicotind:np-side-width')).toBe('480');
    });

    it('clamps to [300, 640]', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;

      component.onSideResizeStart(pointer('pointerdown', 1000));
      document.dispatchEvent(pointer('pointermove', 1200));
      expect(component.sidePanelWidthPx()).toBe(300);
      document.dispatchEvent(pointer('pointermove', 0));
      expect(component.sidePanelWidthPx()).toBe(640);
      document.dispatchEvent(pointer('pointerup', 0));
    });

    it('never takes more than half the viewport', () => {
      Object.defineProperty(window, 'innerWidth', { value: 1100, configurable: true });
      const { fixture } = setup();
      const component = fixture.componentInstance;

      component.onSideResizeStart(pointer('pointerdown', 1000));
      document.dispatchEvent(pointer('pointermove', 0));
      expect(component.sidePanelWidthPx()).toBe(550);
      document.dispatchEvent(pointer('pointerup', 0));
    });

    it('restores the persisted width on a fresh mount', () => {
      localStorage.setItem('nicotind:np-side-width', '450');
      const { fixture } = setup();
      expect(fixture.componentInstance.sidePanelWidthPx()).toBe(450);
    });

    it('steps with the keyboard: arrows ±16, Home/End to the bounds', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;

      component.onSideResizeKeydown(key('ArrowLeft'));
      expect(component.sidePanelWidthPx()).toBe(396);
      component.onSideResizeKeydown(key('ArrowRight'));
      expect(component.sidePanelWidthPx()).toBe(380);
      component.onSideResizeKeydown(key('End'));
      expect(component.sidePanelWidthPx()).toBe(640);
      component.onSideResizeKeydown(key('Home'));
      expect(component.sidePanelWidthPx()).toBe(300);
      expect(localStorage.getItem('nicotind:np-side-width')).toBe('300');
    });

    it('resets to the default', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;
      component.sidePanelWidthPx.set(500);
      component.resetSidePanelWidth();
      expect(component.sidePanelWidthPx()).toBe(380);
      expect(localStorage.getItem('nicotind:np-side-width')).toBe('380');
    });

    it('renders an accessible separator and feeds the width to the side column as a CSS var', () => {
      const { fixture, playerStub } = setup();
      playerStub.currentTrack.set({ id: '1', title: 'Song', artist: 'Artist' });
      fixture.componentInstance.sidePanelWidthPx.set(420);
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      const sep = el.querySelector<HTMLElement>('[data-testid="now-playing-side-resize"]')!;
      expect(sep).not.toBeNull();
      expect(sep.getAttribute('role')).toBe('separator');
      expect(sep.getAttribute('aria-orientation')).toBe('vertical');
      expect(sep.getAttribute('aria-valuenow')).toBe('420');
      expect(sep.getAttribute('tabindex')).toBe('0');
      const side = sep.nextElementSibling as HTMLElement;
      expect(side.style.getPropertyValue('--np-side-w')).toBe('420px');
    });
  });
});

describe('NowPlayingComponent — TV backdrop bleed (issue #439)', () => {
  /**
   * The sheet is never unmounted, only translated below the viewport. Its
   * blurred-cover `::before` uses `inset: -6%`, which on a 540px TV viewport
   * reaches 32px back inside the screen; `blur(56px)` then smeared the cover's
   * colours ~90px up, so every route had a wash behind the mini-player.
   *
   * `isTv` is read once at construction from the root class, so the class must
   * be stamped before `setup()` creates the component.
   */
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.documentElement.classList.add('tv-build');
  });
  afterEach(() => document.documentElement.classList.remove('tv-build'));

  const TRACK = { id: '1', title: 'Song', artist: 'Artist', coverArt: 'cov-1' };

  it('withholds the backdrop while the sheet is closed', () => {
    const { fixture, playerStub } = setup();
    playerStub.currentTrack.set(TRACK);
    playerStub.nowPlayingOpen.set(false);
    fixture.detectChanges();

    expect(fixture.componentInstance.tvBackdropUrl()).toBeNull();
  });

  it('paints the backdrop once the sheet is open', () => {
    const { fixture, playerStub } = setup();
    playerStub.currentTrack.set(TRACK);
    playerStub.nowPlayingOpen.set(true);
    fixture.detectChanges();

    expect(fixture.componentInstance.tvBackdropUrl()).toContain('/api/cover/cov-1');
  });

  it('reacts to the sheet closing, not just its initial state', () => {
    const { fixture, playerStub } = setup();
    playerStub.currentTrack.set(TRACK);
    playerStub.nowPlayingOpen.set(true);
    fixture.detectChanges();
    expect(fixture.componentInstance.tvBackdropUrl()).not.toBeNull();

    playerStub.nowPlayingOpen.set(false);
    fixture.detectChanges();
    expect(fixture.componentInstance.tvBackdropUrl()).toBeNull();
  });

  describe('entity links inside the sheet', () => {
    it('closeForNavigation collapses the sheet and leaves routing to the link itself', () => {
      const { fixture, playerStub } = setup();
      const setOpen = vi.spyOn(playerStub, 'setNowPlayingOpen');
      fixture.componentInstance.closeForNavigation();
      expect(setOpen).toHaveBeenCalledWith(false);
    });
  });
});
