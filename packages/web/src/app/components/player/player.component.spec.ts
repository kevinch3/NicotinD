import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { vi } from 'vitest';
import { PlayerComponent } from './player.component';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { PreserveService } from '../../services/preserve.service';
import { MediaControlsService } from '../../services/media-controls.service';
import type { Track } from '../../services/player.service';

// Note: preserve-store (IndexedDB) is never reached in these tests because
// the PreserveService mock returns isPreserved() = false, so the component
// always takes the streaming path and never calls db.getBlob / db.updateLastAccessed.

const TRACK: Track = { id: 't1', title: 'Test Track', artist: 'Test Artist' };
const TRACK_2: Track = { id: 't2', title: 'Next Track', artist: 'Test Artist' };

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

describe('PlayerComponent', () => {
  let fixture: ComponentFixture<PlayerComponent>;
  let component: PlayerComponent;
  let playerService: PlayerService;
  // Controlled audio element injected in place of the unresolvable viewChild signal.
  let fakeAudio: HTMLAudioElement;
  let mockPlay: ReturnType<typeof vi.fn>;
  let mockPause: ReturnType<typeof vi.fn>;

  // Shared signal — lets tests control isActiveDevice without re-providing
  const isActiveDevice = signal(true);

  // Save originals so we can restore prototype methods after each test
  const origPlay = HTMLMediaElement.prototype.play;
  const origPause = HTMLMediaElement.prototype.pause;

  beforeEach(async () => {
    mockPlay = vi.fn().mockResolvedValue(undefined);
    mockPause = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HTMLMediaElement.prototype.play = mockPlay as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HTMLMediaElement.prototype.pause = mockPause as any;

    // Stub MediaSession (absent from jsdom)
    if (!('mediaSession' in navigator)) {
      Object.defineProperty(navigator, 'mediaSession', {
        value: {
          metadata: null,
          playbackState: 'none' as MediaSessionPlaybackState,
          setActionHandler: vi.fn(),
          setPositionState: vi.fn(),
        },
        configurable: true,
      });
    }

    // Stub WakeLock (absent from jsdom)
    if (!('wakeLock' in navigator)) {
      Object.defineProperty(navigator, 'wakeLock', {
        value: { request: vi.fn().mockResolvedValue({ released: false, release: vi.fn() }) },
        configurable: true,
      });
    }

    setVisibility('visible');
    isActiveDevice.set(true);

    await TestBed.configureTestingModule({
      imports: [PlayerComponent],
      providers: [
        PlayerService,
        { provide: AuthService, useValue: { token: signal('test-token') } },
        {
          provide: RemotePlaybackService,
          useValue: {
            isActiveDevice,
            remoteEnabled: signal(false),
            remoteIsPlaying: signal(false),
            remotePosition: signal(0),
            remotePositionTs: signal(0),
            remoteDuration: signal(0),
            setRemoteProgress: vi.fn(),
          },
        },
        {
          provide: PlaybackWsService,
          useValue: { sendProgressReport: vi.fn(), sendCommand: vi.fn() },
        },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: PreserveService, useValue: { isPreserved: vi.fn().mockReturnValue(false) } },
        // Mocked so the Capacitor media-session plugin is never imported in jsdom.
        {
          provide: MediaControlsService,
          useValue: {
            setMetadata: vi.fn(),
            setPlaybackState: vi.fn(),
            setPositionState: vi.fn(),
            setActionHandler: vi.fn(),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PlayerComponent);
    component = fixture.componentInstance;
    playerService = TestBed.inject(PlayerService);

    // Angular's signal-based viewChild('audioEl') does not resolve in jsdom.
    // Inject a real audio element before detectChanges() so ngAfterViewInit
    // finds it and registers all audio event listeners on our controlled element.
    fakeAudio = document.createElement('audio');
    Object.defineProperty(component, 'audioEl', {
      value: () => ({ nativeElement: fakeAudio }),
      configurable: true,
      writable: true,
    });

    fixture.detectChanges(); // ngAfterViewInit runs, wires listeners to fakeAudio
  });

  afterEach(() => {
    setVisibility('visible');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HTMLMediaElement.prototype.play = origPlay as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HTMLMediaElement.prototype.pause = origPause as any;
    vi.clearAllMocks();
  });

  // Helper — call the visibilitychange handler registered in ngAfterViewInit
  function fireVisibilityChange(): void {
    const handler = component['visibilityChangeHandler'];
    if (!handler) throw new Error('visibilityChangeHandler not set — did ngAfterViewInit run?');
    handler();
  }

  // ─── PWA screen-lock: pause event handling ─────────────────────────────────

  describe('screen lock — pause event handling', () => {
    it('does not propagate an OS-suspended pause to the store when the screen is locked', () => {
      playerService.isPlaying.set(true);
      setVisibility('hidden');

      fakeAudio.dispatchEvent(new Event('pause'));

      expect(playerService.isPlaying()).toBe(true);
    });

    it('queues a resume so playback restores when the screen unlocks after an OS suspension', () => {
      playerService.isPlaying.set(true);
      setVisibility('hidden');
      fakeAudio.dispatchEvent(new Event('pause')); // OS suspends audio

      setVisibility('visible');
      mockPlay.mockClear();
      fireVisibilityChange();

      expect(mockPlay).toHaveBeenCalled();
    });

    it('propagates pause to the store when the user pauses while the screen is visible', () => {
      vi.useFakeTimers();
      playerService.isPlaying.set(true);
      setVisibility('visible');

      fakeAudio.dispatchEvent(new Event('pause'));
      vi.advanceTimersByTime(300);

      expect(playerService.isPlaying()).toBe(false);
      vi.useRealTimers();
    });

    it('does not queue a resume when audio was already paused by the user before screen lock', () => {
      playerService.isPlaying.set(false); // user already paused

      setVisibility('hidden');
      fakeAudio.dispatchEvent(new Event('pause'));

      setVisibility('visible');
      mockPlay.mockClear();
      fireVisibilityChange();

      expect(mockPlay).not.toHaveBeenCalled();
    });
  });

  // ─── PWA screen-lock: play-rejection handling ──────────────────────────────

  describe('screen lock — play() rejection handling', () => {
    it('does not set autoplayBlocked when play is rejected during screen lock', () => {
      playerService.setAutoplayBlocked(false);
      setVisibility('hidden');

      component['handlePlayRejection']();

      expect(playerService.autoplayBlocked()).toBe(false);
    });

    it('schedules resume when play is rejected during screen lock', () => {
      playerService.isPlaying.set(true);
      setVisibility('hidden');
      component['handlePlayRejection']();

      setVisibility('visible');
      mockPlay.mockClear();
      fireVisibilityChange();

      expect(mockPlay).toHaveBeenCalled();
    });

    it('sets autoplayBlocked when play is rejected while the screen is visible', () => {
      playerService.setAutoplayBlocked(false);
      setVisibility('visible');

      component['handlePlayRejection']();

      expect(playerService.autoplayBlocked()).toBe(true);
    });

    it('does not queue a resume when play is rejected while screen is visible', () => {
      setVisibility('visible');
      component['handlePlayRejection']();

      // A subsequent unlock must NOT trigger play (no pending resume)
      setVisibility('visible');
      mockPlay.mockClear();
      fireVisibilityChange();

      expect(mockPlay).not.toHaveBeenCalled();
    });
  });

  // ─── PWA screen-lock: visibilitychange recovery ────────────────────────────

  describe('screen lock — visibilitychange recovery', () => {
    it('restores playback on unlock after the screen was locked while playing', () => {
      playerService.isPlaying.set(true);

      setVisibility('hidden');
      fireVisibilityChange();

      setVisibility('visible');
      mockPlay.mockClear();
      fireVisibilityChange();

      expect(mockPlay).toHaveBeenCalled();
    });

    it('does not resume on unlock when the player was paused before the screen locked', () => {
      playerService.isPlaying.set(false);

      setVisibility('hidden');
      fireVisibilityChange();

      setVisibility('visible');
      mockPlay.mockClear();
      fireVisibilityChange();

      expect(mockPlay).not.toHaveBeenCalled();
    });

    it('calls player.resume() when isPlaying was cleared by the time the screen unlocks', () => {
      playerService.isPlaying.set(true);

      setVisibility('hidden');
      fireVisibilityChange();

      // Simulate OS clearing the signal (e.g. via the onPause path above)
      playerService.isPlaying.set(false);

      setVisibility('visible');
      fireVisibilityChange();

      expect(playerService.isPlaying()).toBe(true);
    });

    it('clears resume flags so a second visibilitychange to visible does not replay', () => {
      playerService.isPlaying.set(true);

      setVisibility('hidden');
      fireVisibilityChange();

      // First unlock — consumes the flag
      setVisibility('visible');
      fireVisibilityChange();

      // Second unlock (flags cleared) — no replay
      mockPlay.mockClear();
      fireVisibilityChange();

      expect(mockPlay).not.toHaveBeenCalled();
    });

    it('does not resume when this is not the active playback device', () => {
      isActiveDevice.set(false);
      playerService.isPlaying.set(true);

      setVisibility('hidden');
      fireVisibilityChange();

      setVisibility('visible');
      mockPlay.mockClear();
      fireVisibilityChange();

      expect(mockPlay).not.toHaveBeenCalled();
    });
  });

  // ─── Regressions — pre-existing behaviours must remain intact ──────────────

  describe('regressions', () => {
    it('play event on audio element sets isPlaying = true in the store', () => {
      playerService.isPlaying.set(false);

      fakeAudio.dispatchEvent(new Event('play'));

      expect(playerService.isPlaying()).toBe(true);
    });

    it('ended event advances to the next track in the queue', () => {
      playerService.currentTrack.set(TRACK);
      playerService.queue.set([TRACK_2]);

      fakeAudio.dispatchEvent(new Event('ended'));

      expect(playerService.currentTrack()).toEqual(TRACK_2);
    });

    it('pause event while visible and playing sets isPlaying = false', () => {
      vi.useFakeTimers();
      playerService.isPlaying.set(true);
      setVisibility('visible');

      fakeAudio.dispatchEvent(new Event('pause'));
      vi.advanceTimersByTime(300);

      expect(playerService.isPlaying()).toBe(false);
      vi.useRealTimers();
    });

    it('autoplayBlocked is set to true when play is rejected on a visible screen', () => {
      playerService.setAutoplayBlocked(false);
      setVisibility('visible');

      component['handlePlayRejection']();

      expect(playerService.autoplayBlocked()).toBe(true);
    });

    it('loadedmetadata event updates the duration signal', () => {
      Object.defineProperty(fakeAudio, 'duration', { value: 240, configurable: true });

      fakeAudio.dispatchEvent(new Event('loadedmetadata'));

      expect(playerService.duration()).toBe(240);
    });
  });

  // ─── Layout — deterministic control position ───────────────────────────────

  describe('mini-player layout', () => {
    // Two-column mobile layout: track info is the only growing column (flex-1),
    // so it fills the bar and pushes the content-sized controls to the right edge.
    // The device-switcher column must NOT reserve mobile space (no empty third
    // column) — it's content-sized so it's 0-width when the switcher is hidden.
    function columns(): { trackInfo: Element; controls: Element; right: Element } {
      const root = fixture.nativeElement as HTMLElement;
      const trackInfo = root.querySelector('.md\\:w-60');
      const controls = root.querySelector('.flex-col');
      const right = root.querySelector('.justify-end');
      if (!trackInfo || !controls || !right) throw new Error('mini-player columns not found');
      return { trackInfo, controls, right };
    }

    it('grows only the track-info column on mobile (pushes controls right)', () => {
      const { trackInfo, right } = columns();
      // Track info is the single mobile flex-1 column.
      expect(trackInfo.classList.contains('flex-1')).toBe(true);
      expect(trackInfo.classList.contains('md:flex-none')).toBe(true);
      // The right (device-switcher) column must NOT be flex-1 on mobile — that
      // empty third column was the wasted-space bug.
      expect(right.classList.contains('flex-1')).toBe(false);
      expect(right.classList.contains('md:flex-none')).toBe(true);
    });

    it('content-sizes the control cluster on mobile (sits at the right edge)', () => {
      const { controls } = columns();
      expect(controls.classList.contains('flex-none')).toBe(true);
      expect(controls.classList.contains('flex-1')).toBe(false);
      // Desktop reclaims flex-1 to host the inline progress bar.
      expect(controls.classList.contains('md:flex-1')).toBe(true);
    });
  });

  // ─── Expand gesture — tap / swipe-up to open Now Playing ───────────────────

  describe('expand gesture', () => {
    const down = (clientY: number, target: HTMLElement, button = 0) =>
      ({ clientY, button, target }) as unknown as PointerEvent;
    // Move/release through the real document listeners the primitive attaches.
    const move = (clientY: number) =>
      document.dispatchEvent(new MouseEvent('pointermove', { clientY }));
    const release = (clientY: number) =>
      document.dispatchEvent(new MouseEvent('pointerup', { clientY }));

    it('opens Now Playing on a tap (negligible movement)', () => {
      playerService.setNowPlayingOpen(false);
      component.onBarPointerDown(down(100, document.createElement('div')));
      release(104); // delta 4 <= tap tolerance

      expect(playerService.nowPlayingOpen()).toBe(true);
    });

    it('opens Now Playing on a swipe up past the threshold', () => {
      playerService.setNowPlayingOpen(false);
      component.onBarPointerDown(down(200, document.createElement('div')));
      // Commits on move (delta -60 < -40) — touch can fire pointercancel before
      // pointerup, so waiting for release dropped real swipes.
      move(140);
      release(140);

      expect(playerService.nowPlayingOpen()).toBe(true);
    });

    it('does not open on a small downward drag', () => {
      playerService.setNowPlayingOpen(false);
      component.onBarPointerDown(down(100, document.createElement('div')));
      release(130); // delta +30: neither tap nor swipe-up

      expect(playerService.nowPlayingOpen()).toBe(false);
    });

    it('ignores pointer down originating on a control button', () => {
      playerService.setNowPlayingOpen(false);
      component.onBarPointerDown(down(100, document.createElement('button')));
      release(104);

      expect(playerService.nowPlayingOpen()).toBe(false);
    });

    it('ignores pointer down originating on the seek bar', () => {
      playerService.setNowPlayingOpen(false);
      const seek = document.createElement('div');
      seek.setAttribute('data-seek', '');
      component.onBarPointerDown(down(100, seek));
      release(104);

      expect(playerService.nowPlayingOpen()).toBe(false);
    });

    it('regression: interacting with the bar never triggers router navigation', () => {
      const router = TestBed.inject(Router) as unknown as { navigate: ReturnType<typeof vi.fn> };
      playerService.setNowPlayingOpen(false);
      component.onBarPointerDown(down(100, document.createElement('div')));
      release(104);

      expect(router.navigate).not.toHaveBeenCalled();
    });
  });
});
