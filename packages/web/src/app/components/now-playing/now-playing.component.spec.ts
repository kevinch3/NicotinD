import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError, Subject } from 'rxjs';
import type { Observable } from 'rxjs';
import type { LyricsDto, WaveformData } from '@nicotind/core';
import { provideRouter } from '@angular/router';
import { NowPlayingComponent } from './now-playing.component';
import { PlayerService } from '../../services/player.service';
import { VocalSeparationService } from '../../services/vocal-separation.service';
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
    isPlaying: signal(false),
    shuffle: signal(false),
    repeat: signal('off'),
    radio: signal(false),
    toggleRadio: () => {},
    queue: signal<
      { id: string; title: string; artist: string; coverArt?: string | null; album?: string }[]
    >([]),
    history: signal([]),
    context: signal(null),
    currentTime: signal(0),
    duration: signal(0),
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
    remoteEnabled: signal(false),
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
      {
        provide: VocalSeparationService,
        useValue: {
          vocalMode: () => 'off',
          etaSec: () => null,
          queuePosition: () => null,
          setKaraokeOpen: () => {},
        },
      },
      { provide: AuthService, useValue: { token: signal('tok') } },
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
    it('renders app-device-switcher when a track is loaded and remote is enabled', () => {
      const { fixture, playerStub, remoteStub } = setup();

      remoteStub.remoteEnabled.set(true);
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
        of({ plain: 'la la', synced: null, source: 'lrclib', customized: false, updatedAt: 0 }),
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

  describe('hasLyrics (tab-switcher dot)', () => {
    it('does not show a stale positive after switching tracks with lyrics loaded for the previous one', () => {
      const { fixture, playerStub, libraryStub } = setup();
      const component = fixture.componentInstance;

      // Load lyrics for track A (simulates having visited the Lyrics tab).
      playerStub.currentTrack.set({ id: 'a', title: 'Song A', artist: 'Artist' });
      libraryStub.fetchLyrics.mockReturnValue(
        of({ plain: 'la la', synced: null, source: 'lrclib', customized: false, updatedAt: 0 }),
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

      // Drag far past the max — clamps to COVER_MAX - COVER_MIN (200).
      document.dispatchEvent(pointer('pointermove', 0)); // up 300px from start
      expect(component.queueExtraHeightPx()).toBe(200);
      expect(component.coverMaxPx()).toBe(120);

      document.dispatchEvent(pointer('pointerup', 0));
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
    const pointer = (type: string, clientY: number, button = 0) =>
      new MouseEvent(type, { clientY, button }) as unknown as PointerEvent;

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

  describe('drag-to-dismiss (live-follow)', () => {
    // jsdom has no PointerEvent constructor; MouseEvent carries clientY + button
    // and dispatches under any type string, driving the real document listeners.
    const pointer = (type: string, clientY: number, button = 0) =>
      new MouseEvent(type, { clientY, button }) as unknown as PointerEvent;

    it('follows the finger downward and closes the sheet past the threshold', () => {
      const { fixture, playerStub } = setup();
      const component = fixture.componentInstance;
      const setOpen = vi.spyOn(playerStub, 'setNowPlayingOpen');

      component.onSheetDragStart(pointer('pointerdown', 100));
      expect(component.dragging()).toBe(true);

      document.dispatchEvent(pointer('pointermove', 280)); // delta 180 > 120 threshold
      expect(component.dragOffsetPx()).toBe(180);

      document.dispatchEvent(pointer('pointerup', 280));
      expect(setOpen).toHaveBeenCalledWith(false);
      expect(component.dragOffsetPx()).toBe(0);
      expect(component.dragging()).toBe(false);
    });

    it('snaps back without closing for a short drag', () => {
      const { fixture, playerStub } = setup();
      const component = fixture.componentInstance;
      const setOpen = vi.spyOn(playerStub, 'setNowPlayingOpen');

      component.onSheetDragStart(pointer('pointerdown', 100));
      document.dispatchEvent(pointer('pointermove', 150)); // delta 50 < 120 threshold
      document.dispatchEvent(pointer('pointerup', 150));

      expect(setOpen).not.toHaveBeenCalled();
      expect(component.dragOffsetPx()).toBe(0);
      expect(component.dragging()).toBe(false);
    });

    it('clamps an upward drag to zero (downward-only)', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;

      component.onSheetDragStart(pointer('pointerdown', 200));
      document.dispatchEvent(pointer('pointermove', 50)); // delta -150
      expect(component.dragOffsetPx()).toBe(0);
    });

    it('ignores non-primary buttons and stops tracking after release', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;

      component.onSheetDragStart(pointer('pointerdown', 100, 2)); // right-click
      expect(component.dragging()).toBe(false);

      component.onSheetDragStart(pointer('pointerdown', 100));
      document.dispatchEvent(pointer('pointerup', 100));
      // Listeners detached: a post-release move must not move the sheet.
      document.dispatchEvent(pointer('pointermove', 300));
      expect(component.dragOffsetPx()).toBe(0);
      expect(component.dragging()).toBe(false);
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
});
