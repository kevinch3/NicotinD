import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError, Subject } from 'rxjs';
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
    isPlaying: signal(false),
    shuffle: signal(false),
    repeat: signal('off'),
    radio: signal(false),
    toggleRadio: () => {},
    queue: signal([]),
    history: signal([]),
    context: signal(null),
    currentTime: signal(0),
    duration: signal(0),
    autoplayBlocked: signal(false),
    bufferingVisible: signal(false),
    bufferedRanges: signal([]),
    setNowPlayingOpen: () => {},
    seek: () => {},
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
    getLyrics: vi.fn(() => of(null)),
    fetchLyrics: vi.fn(() => of(null)),
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
        of({ plain: 'la la', synced: null, source: 'lrclib', customized: false }),
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
