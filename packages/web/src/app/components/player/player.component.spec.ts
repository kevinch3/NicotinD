import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { vi } from 'vitest';
import {
  PlayerComponent,
  browserDurationIsAcceptable,
  MAX_RECOVERY_ATTEMPTS,
  MEDIA_ERROR_RETRY_MS,
  STREAM_STALL_TIMEOUT_MS,
  LOAD_SETTLE_MS,
  PENDING_SEEK_TIMEOUT_MS,
} from './player.component';
import { SEEK_AVAILABILITY_EPSILON_SEC } from '../../lib/seek-availability';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { LikeService } from '../../services/like.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { PreserveService } from '../../services/preserve.service';
import { MediaControlsService } from '../../services/media-controls.service';
import { NetworkStatusService } from '../../services/network-status.service';
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
  let mockLoad: ReturnType<typeof vi.fn>;
  let likes: { isLiked: ReturnType<typeof vi.fn>; toggle: ReturnType<typeof vi.fn> };
  let preserveMock: { isPreserved: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };

  // Shared signals — let tests control device/network state without re-providing
  const isActiveDevice = signal(true);
  const netOnline = signal(true);

  // Save originals so we can restore prototype methods after each test
  const origPlay = HTMLMediaElement.prototype.play;
  const origPause = HTMLMediaElement.prototype.pause;
  const origLoad = HTMLMediaElement.prototype.load;

  beforeEach(async () => {
    mockPlay = vi.fn().mockResolvedValue(undefined);
    mockPause = vi.fn();
    mockLoad = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HTMLMediaElement.prototype.play = mockPlay as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HTMLMediaElement.prototype.pause = mockPause as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HTMLMediaElement.prototype.load = mockLoad as any;

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
    netOnline.set(true);
    likes = { isLiked: vi.fn().mockReturnValue(false), toggle: vi.fn() };
    preserveMock = {
      isPreserved: vi.fn().mockReturnValue(false),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    await TestBed.configureTestingModule({
      imports: [PlayerComponent],
      providers: [
        PlayerService,
        { provide: AuthService, useValue: { token: signal('test-token') } },
        { provide: LikeService, useValue: likes },
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
        { provide: PreserveService, useValue: preserveMock },
        // `reconnects` is read by ListeningQueueService's drain effect, which
        // instantiates through the component's ListeningTrackerService chain.
        {
          provide: NetworkStatusService,
          useValue: {
            online: netOnline,
            reconnects: signal(0),
            whenReady: () => Promise.resolve(),
          },
        },
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HTMLMediaElement.prototype.load = origLoad as any;
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
    it('schedules resume when play is rejected during screen lock', () => {
      playerService.isPlaying.set(true);
      setVisibility('hidden');
      component['handlePlayRejection']();

      setVisibility('visible');
      mockPlay.mockClear();
      fireVisibilityChange();

      expect(mockPlay).toHaveBeenCalled();
    });

    // No dedicated "tap to resume" banner — a rejected play while the screen
    // is visible just falls back to paused (the normal Play button is a
    // fresh gesture and will succeed).
    it('falls back to paused when play is rejected while the screen is visible', () => {
      playerService.isPlaying.set(true);
      setVisibility('visible');

      component['handlePlayRejection']();

      expect(playerService.isPlaying()).toBe(false);
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

    // Effect 1 must not call audio.play() on its own — only Effect 5 (which
    // drives isPlaying sync) gets to start playback. Otherwise restoring a
    // track on page load would autoplay (and get silently rejected by the
    // browser), even before the user has pressed anything. The seek position
    // is still restored by onDuration; the audio just stays paused.
    it('loading a track while isPlaying=false sets audio.src but does not call audio.play()', () => {
      playerService.isPlaying.set(false);
      mockPlay.mockClear();
      fakeAudio.src = '';

      playerService.currentTrack.set(TRACK);
      fixture.detectChanges();

      expect(fakeAudio.src).not.toBe('');
      expect(mockPlay).not.toHaveBeenCalled();
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

  // ─── Like button — quick interaction on the mini-player itself ────────────

  describe('like button', () => {
    it('renders the heart for the current track and toggles it via LikeService', () => {
      playerService.currentTrack.set(TRACK);
      fixture.detectChanges();

      const heart: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="player-like"]',
      );
      expect(heart).toBeTruthy();
      expect(heart.getAttribute('aria-pressed')).toBe('false');

      heart.click();
      expect(likes.toggle).toHaveBeenCalledWith(TRACK.id);
    });

    it('reflects the liked state via aria-pressed', () => {
      playerService.currentTrack.set(TRACK);
      likes.isLiked.mockReturnValue(true);
      fixture.detectChanges();

      const heart: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="player-like"]',
      );
      expect(heart.getAttribute('aria-pressed')).toBe('true');
    });

    it('renders nothing when no track is loaded', () => {
      playerService.currentTrack.set(null);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="player-like"]')).toBeNull();
    });

    it('does not hijack the swipe-to-open gesture (onBarPointerDown bails on a button target)', () => {
      playerService.currentTrack.set(TRACK);
      fixture.detectChanges();
      const dragStartSpy = vi.spyOn(component['barDrag'], 'start');

      const heart: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="player-like"]',
      );
      heart.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

      expect(dragStartSpy).not.toHaveBeenCalled();
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

    // Issue #432 — a D-pad emits key events, never pointer events, so the
    // pointer-only grab notch was unreachable on Android TV. The transport
    // buttons beside it were focusable (appTvNavItem), which is why the bar
    // looked half-alive.
    describe('D-pad / keyboard (issue #432)', () => {
      const grab = (): HTMLElement => {
        const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
          '[data-testid="player-grab"]',
        );
        if (!el) throw new Error('grab notch not found');
        return el;
      };

      it('exposes the grab notch as a focusable, labelled button', () => {
        const el = grab();
        expect(el.getAttribute('tabindex')).toBe('0');
        expect(el.getAttribute('role')).toBe('button');
        expect(el.getAttribute('aria-label')).toBeTruthy();
      });

      it('opens Now Playing on click (what a D-pad select fires in a WebView)', () => {
        playerService.setNowPlayingOpen(false);
        grab().click();
        expect(playerService.nowPlayingOpen()).toBe(true);
      });

      it('opens Now Playing on Enter', () => {
        playerService.setNowPlayingOpen(false);
        grab().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        fixture.detectChanges();
        expect(playerService.nowPlayingOpen()).toBe(true);
      });

      it('opens Now Playing on Space', () => {
        playerService.setNowPlayingOpen(false);
        grab().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        fixture.detectChanges();
        expect(playerService.nowPlayingOpen()).toBe(true);
      });
    });

    it('regression: interacting with the bar never triggers router navigation', () => {
      const router = TestBed.inject(Router) as unknown as { navigate: ReturnType<typeof vi.fn> };
      playerService.setNowPlayingOpen(false);
      component.onBarPointerDown(down(100, document.createElement('div')));
      release(104);

      expect(router.navigate).not.toHaveBeenCalled();
    });
  });

  // ─── Dead-stream recovery (playback stops with nothing to restart it) ──────

  describe('dead-stream recovery', () => {
    // A stream that dies mid-playback used to be terminal: `error` only cleared
    // the spinner, and a stall raised nothing at all, so the store kept saying
    // "playing" over silence until the user pressed play again.
    const knownTrack: Track = {
      id: 't1',
      title: 'Test Track',
      artist: 'Test Artist',
      duration: 240,
    };

    function loadAndPlay(atSecond = 42): void {
      playerService.currentTrack.set(knownTrack);
      fixture.detectChanges();
      playerService.isPlaying.set(true);
      Object.defineProperty(fakeAudio, 'currentTime', { value: atSecond, configurable: true });
      mockPlay.mockClear();
    }

    it('reloads the stream and resumes where the listener was when the element errors', () => {
      vi.useFakeTimers();
      loadAndPlay(42);

      fakeAudio.dispatchEvent(new Event('error'));
      // The retry is announced immediately (spinner), then runs after the backoff.
      expect(playerService.buffering()).toBe(true);
      expect(mockPlay).not.toHaveBeenCalled();

      vi.advanceTimersByTime(MEDIA_ERROR_RETRY_MS + 10);

      expect(mockPlay).toHaveBeenCalled();
      expect(fakeAudio.src).toContain('/api/stream/t1');
      // Resumes at the interruption, not at 0 — onDuration replays this.
      expect(playerService.restoredTime).toBe(42);
      vi.useRealTimers();
    });

    it('does not resurrect a stream the user paused', () => {
      vi.useFakeTimers();
      loadAndPlay(42);
      playerService.isPlaying.set(false);
      mockPlay.mockClear();

      fakeAudio.dispatchEvent(new Event('error'));
      vi.advanceTimersByTime(MEDIA_ERROR_RETRY_MS + 10);

      expect(mockPlay).not.toHaveBeenCalled();
      expect(playerService.restoredTime).toBeNull();
      vi.useRealTimers();
    });

    it('stops claiming to play once the retry budget is spent', () => {
      vi.useFakeTimers();
      loadAndPlay(42);

      for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
        fakeAudio.dispatchEvent(new Event('error'));
        vi.advanceTimersByTime(MEDIA_ERROR_RETRY_MS + 10);
      }
      expect(playerService.isPlaying()).toBe(true); // still trying

      // One failure past the allowance: the resource is genuinely unreachable,
      // so the UI must say paused rather than lie about playing.
      fakeAudio.dispatchEvent(new Event('error'));

      expect(playerService.isPlaying()).toBe(false);
      expect(playerService.buffering()).toBe(false);
      vi.useRealTimers();
    });

    it('recovers a stall that never raises an error', () => {
      vi.useFakeTimers();
      loadAndPlay(10);

      // The silent failure: the element parks on `waiting` and never asks for
      // another byte.
      fakeAudio.dispatchEvent(new Event('waiting'));
      vi.advanceTimersByTime(STREAM_STALL_TIMEOUT_MS + 10);
      vi.advanceTimersByTime(MEDIA_ERROR_RETRY_MS + 10);

      expect(mockPlay).toHaveBeenCalled();
      // `restoredTime` is written by the reload and nothing else here, so it
      // is the assertion that the *recovery* ran rather than the play/pause
      // sync effect flushing under the fake clock.
      expect(playerService.restoredTime).toBe(10);
      vi.useRealTimers();
    });

    it('leaves a slow-but-alive load alone', () => {
      vi.useFakeTimers();
      loadAndPlay(10);

      fakeAudio.dispatchEvent(new Event('waiting'));
      // Bytes land: the clock advances before the watchdog window is out.
      Object.defineProperty(fakeAudio, 'currentTime', { value: 12, configurable: true });
      fakeAudio.dispatchEvent(new Event('timeupdate'));
      vi.advanceTimersByTime(STREAM_STALL_TIMEOUT_MS + MEDIA_ERROR_RETRY_MS + 20);

      // No reload: the watchdog was disarmed by the progress it was watching for.
      expect(playerService.restoredTime).toBeNull();
      vi.useRealTimers();
    });

    it('waits for the network rather than dropping the track when the stream dies offline', () => {
      vi.useFakeTimers();
      loadAndPlay(42);
      netOnline.set(false);

      fakeAudio.dispatchEvent(new Event('error'));
      vi.advanceTimersByTime(MEDIA_ERROR_RETRY_MS + 10);

      // A tunnel is not a reason to lose the track: the intent (and the
      // spinner) are held, and no retry is spent against a dead radio.
      expect(playerService.currentTrack()).toEqual(knownTrack);
      expect(playerService.buffering()).toBe(true);
      expect(playerService.restoredTime).toBeNull();

      netOnline.set(true);
      fixture.detectChanges(); // the reconnect effect runs
      vi.advanceTimersByTime(MEDIA_ERROR_RETRY_MS + 10);

      expect(playerService.restoredTime).toBe(42);
      vi.useRealTimers();
    });

    it('ignores the error raised by parking the element (offline stop)', () => {
      vi.useFakeTimers();
      loadAndPlay(42);
      // Offline + not preserved: the load path parks the element deliberately.
      netOnline.set(false);
      playerService.play(TRACK_2);
      fixture.detectChanges();
      mockPlay.mockClear();

      // Assigning `src = ''` raises `error` in a real browser. Recovering from
      // it would re-point the element at audio the app just decided to stop.
      fakeAudio.dispatchEvent(new Event('error'));
      vi.advanceTimersByTime(MEDIA_ERROR_RETRY_MS + 10);

      expect(mockPlay).not.toHaveBeenCalled();
      expect(playerService.restoredTime).toBeNull();
      vi.useRealTimers();
    });
  });

  // ─── Buffering feedback (HDD-aware loaders) ────────────────────────────────

  describe('buffering feedback', () => {
    it('waiting event sets buffering', () => {
      fakeAudio.dispatchEvent(new Event('waiting'));
      expect(playerService.buffering()).toBe(true);
    });

    it('seeking event sets buffering', () => {
      fakeAudio.dispatchEvent(new Event('seeking'));
      expect(playerService.buffering()).toBe(true);
    });

    it('playing event clears buffering', () => {
      playerService.setBuffering(true);
      fakeAudio.dispatchEvent(new Event('playing'));
      expect(playerService.buffering()).toBe(false);
    });

    it('canplay clears buffering', () => {
      playerService.setBuffering(true);
      fakeAudio.dispatchEvent(new Event('canplay'));
      expect(playerService.buffering()).toBe(false);
    });

    // canplay does NOT re-fire when seeking lands in an already-buffered region
    // (readyState never dips), so while paused only seeked can clear the flag.
    it('seeked into a buffered region clears buffering even while paused', () => {
      playerService.setBuffering(true);
      Object.defineProperty(fakeAudio, 'readyState', { value: 4, configurable: true });
      fakeAudio.dispatchEvent(new Event('seeked'));
      expect(playerService.buffering()).toBe(false);
    });

    it('seeked into an unbuffered region keeps buffering until data arrives', () => {
      playerService.setBuffering(true);
      Object.defineProperty(fakeAudio, 'readyState', { value: 2, configurable: true });
      fakeAudio.dispatchEvent(new Event('seeked'));
      expect(playerService.buffering()).toBe(true);
    });

    it('error clears buffering so the spinner cannot spin forever', () => {
      playerService.setBuffering(true);
      fakeAudio.dispatchEvent(new Event('error'));
      expect(playerService.buffering()).toBe(false);
    });

    it('stalled sets buffering only when playback genuinely lacks data', () => {
      Object.defineProperty(fakeAudio, 'readyState', { value: 4, configurable: true });
      fakeAudio.dispatchEvent(new Event('stalled'));
      expect(playerService.buffering()).toBe(false);

      Object.defineProperty(fakeAudio, 'readyState', { value: 2, configurable: true });
      fakeAudio.dispatchEvent(new Event('stalled'));
      expect(playerService.buffering()).toBe(true);
    });

    it('loading a new track sets buffering and clears stale buffered ranges', () => {
      playerService.setBufferedRanges([{ start: 0, end: 10 }]);
      playerService.currentTrack.set(TRACK);
      fixture.detectChanges();
      expect(playerService.buffering()).toBe(true);
      expect(playerService.bufferedRanges()).toEqual([]);
    });

    it('clears buffering when this device stops being the active one', () => {
      playerService.setBuffering(true);
      isActiveDevice.set(false);
      fixture.detectChanges();
      expect(playerService.buffering()).toBe(false);
    });

    it('progress event snapshots audio.buffered into the service', () => {
      Object.defineProperty(fakeAudio, 'buffered', {
        value: { length: 2, start: (i: number) => [0, 60][i], end: (i: number) => [30, 90][i] },
        configurable: true,
      });
      fakeAudio.dispatchEvent(new Event('progress'));
      expect(playerService.bufferedRanges()).toEqual([
        { start: 0, end: 30 },
        { start: 60, end: 90 },
      ]);
    });

    it('handlePlayRejection clears buffering (falls back to the paused state)', () => {
      playerService.setBuffering(true);
      setVisibility('visible');
      component['handlePlayRejection']();
      expect(playerService.buffering()).toBe(false);
    });

    it('ended-with-queue advance flags buffering for the incoming track', () => {
      playerService.currentTrack.set(TRACK);
      playerService.queue.set([TRACK_2]);
      playerService.setBuffering(false);

      fakeAudio.dispatchEvent(new Event('ended'));

      expect(playerService.buffering()).toBe(true);
    });

    // The actual spinner/attribute rendering now lives inside
    // app-player-transport-mini (see player-transport-mini.component.spec.ts
    // "shows the buffering spinner when buffering is true") — this harness's
    // plain-vitest JIT setup doesn't register signal inputs on a nested
    // imported component (see testing/signal-input.ts), so a parent-level
    // detectChanges() can't verify the [buffering] binding actually lands on
    // the child. What's left worth asserting at this layer is that the
    // shell's own showBuffering() computed — the value handed to the
    // binding — resolves correctly.
    it('showBuffering() reflects bufferingVisible while this device is active', () => {
      playerService.bufferingVisible.set(true);
      expect(component.showBuffering()).toBe(true);

      playerService.bufferingVisible.set(false);
      expect(component.showBuffering()).toBe(false);
    });
  });

  // ─── Vocal mute toggle (karaoke) ──────────────────────────────────────────

  describe('vocal mute toggle', () => {
    beforeEach(() => {
      playerService.restoredTime = null;
    });

    it('stashes restoredTime before src change and plays when wasPlaying', () => {
      // Load a track first (Effect 1) without any vocal mute.
      playerService.currentTrack.set(TRACK);
      playerService.isPlaying.set(true);
      fixture.detectChanges();
      mockPlay.mockClear();
      mockPause.mockClear();

      Object.defineProperty(fakeAudio, 'currentTime', {
        value: 30,
        writable: true,
        configurable: true,
      });
      fakeAudio.removeAttribute('src');

      playerService.toggleVocalMute();
      fixture.detectChanges();

      // Effect 6b must stash the position on player.restoredTime so the
      // existing onDuration handler restores it once the new media loads.
      expect(playerService.restoredTime).toBe(30);
      // The new src includes the vocals=off flag.
      expect(fakeAudio.src).toContain('/api/stream/t1');
      expect(fakeAudio.src).toContain('vocals=off');
      // Was playing, so audio.play() is called immediately.
      expect(mockPlay).toHaveBeenCalled();
      // No explicit pause — onDuration handles the restore.
      expect(mockPause).not.toHaveBeenCalled();
    });

    it('does not stash restoredTime when currentTime is near the start', () => {
      playerService.currentTrack.set(TRACK);
      playerService.isPlaying.set(true);
      fixture.detectChanges();
      mockPlay.mockClear();

      Object.defineProperty(fakeAudio, 'currentTime', {
        value: 0.5,
        writable: true,
        configurable: true,
      });
      fakeAudio.removeAttribute('src');

      playerService.toggleVocalMute();
      fixture.detectChanges();

      // Within the first second, no point stashing — no restoredTime set.
      expect(playerService.restoredTime).toBeNull();
      expect(mockPlay).toHaveBeenCalled();
    });

    it('does not play when paused', () => {
      playerService.currentTrack.set(TRACK);
      playerService.isPlaying.set(false);
      fixture.detectChanges();
      mockPlay.mockClear();

      Object.defineProperty(fakeAudio, 'currentTime', {
        value: 45,
        writable: true,
        configurable: true,
      });
      fakeAudio.removeAttribute('src');

      playerService.toggleVocalMute();
      fixture.detectChanges();

      // Position should still be stashed.
      expect(playerService.restoredTime).toBe(45);
      // But play() must NOT be called since we were paused.
      expect(mockPlay).not.toHaveBeenCalled();
    });

    it('restores position and drops the flag when toggling back off', () => {
      playerService.currentTrack.set(TRACK);
      playerService.isPlaying.set(true);
      fixture.detectChanges();

      // First toggle: vocals off.
      Object.defineProperty(fakeAudio, 'currentTime', {
        value: 30,
        writable: true,
        configurable: true,
      });
      playerService.toggleVocalMute();
      fixture.detectChanges();
      expect(fakeAudio.src).toContain('vocals=off');
      // Simulate onDuration consuming the stash so the next toggle starts clean.
      playerService.restoredTime = null;

      // Second toggle back on: position must be stashed again and the flag gone.
      Object.defineProperty(fakeAudio, 'currentTime', {
        value: 62,
        writable: true,
        configurable: true,
      });
      playerService.toggleVocalMute();
      fixture.detectChanges();

      expect(playerService.restoredTime).toBe(62);
      expect(fakeAudio.src).toContain('/api/stream/t1');
      expect(fakeAudio.src).not.toContain('vocals=off');
    });
  });

  // ─── False-ended recovery (premature track-end bug) ────────────────────────

  describe('premature ended (false positive) recovery', () => {
    // A track with a known duration is the input to all the scenarios here.
    const knownTrack: Track = {
      id: 't1',
      title: 'Test Track',
      artist: 'Test Artist',
      duration: 240,
    };

    beforeEach(() => {
      playerService.currentTrack.set(knownTrack);
      fixture.detectChanges();
    });

    it('keeps the API-known duration when the browser reports a too-short native duration (relative gate)', () => {
      // The bug: browser reports 1.8s for a 240s track → 1.8 / 240 = 0.0075,
      // far below the 0.7 threshold. The player must keep 240 so the seek bar
      // and ended-guard have a sane reference.
      Object.defineProperty(fakeAudio, 'duration', { value: 1.8, configurable: true });
      fakeAudio.dispatchEvent(new Event('loadedmetadata'));
      expect(playerService.duration()).toBe(240);
    });

    it('keeps the API-known duration when the browser reports a moderately-short duration (absolute gate)', () => {
      // 200s for a 240s source — passes the relative check (200/240 = 0.83),
      // but fails the absolute check (|200-240| = 40 > 5). Must reject.
      Object.defineProperty(fakeAudio, 'duration', { value: 200, configurable: true });
      fakeAudio.dispatchEvent(new Event('loadedmetadata'));
      expect(playerService.duration()).toBe(240);
    });

    it('adopts a browser duration within tolerance of the API-known one', () => {
      // 239s for 240s — passes both gates. The minor codec framing drift
      // is exactly what the tolerance window exists for.
      Object.defineProperty(fakeAudio, 'duration', { value: 239, configurable: true });
      fakeAudio.dispatchEvent(new Event('loadedmetadata'));
      expect(playerService.duration()).toBe(239);
    });

    it('does not advance the queue when ended fires at currentTime=1.8s for a 240s track', () => {
      // The reported user symptom. Set up the audio as the bug would: tiny
      // duration, currentTime parked at "end", then dispatch ended.
      Object.defineProperty(fakeAudio, 'duration', { value: 1.8, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', { value: 1.8, configurable: true });
      playerService.queue.set([TRACK_2]);
      playerService.isPlaying.set(true);

      fakeAudio.dispatchEvent(new Event('ended'));

      // The queue must NOT advance — we triggered recovery instead.
      expect(playerService.currentTrack()).toEqual(knownTrack);
      expect(playerService.queue()).toEqual([TRACK_2]);
      expect(playerService.recoveryState()).toBe('awaiting-duration');
      expect(playerService.buffering()).toBe(true);
    });

    it('recovers and resumes playback when a sane durationchange arrives after the false ended', () => {
      // First: the false ended event
      Object.defineProperty(fakeAudio, 'duration', { value: 1.8, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', { value: 1.8, configurable: true });
      playerService.isPlaying.set(true);
      mockPlay.mockClear();
      fakeAudio.dispatchEvent(new Event('ended'));
      expect(playerService.recoveryState()).toBe('awaiting-duration');

      // Then: the browser reports a real duration as more bytes arrive
      Object.defineProperty(fakeAudio, 'duration', { value: 240, configurable: true });
      fakeAudio.dispatchEvent(new Event('durationchange'));

      expect(playerService.recoveryState()).toBe('normal');
      expect(playerService.buffering()).toBe(false);
      expect(playerService.duration()).toBe(240);
      // The user's intent (isPlaying=true) is honored — audio resumes.
      expect(mockPlay).toHaveBeenCalled();
    });

    it('falls back to reload + play when no sane duration arrives within 5s', () => {
      vi.useFakeTimers();
      // False ended setup; we deliberately do NOT dispatch a real durationchange.
      Object.defineProperty(fakeAudio, 'duration', { value: 1.8, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', {
        value: 1.8,
        writable: true,
        configurable: true,
      });
      playerService.isPlaying.set(true);
      mockPlay.mockClear();
      mockLoad.mockClear();
      fakeAudio.dispatchEvent(new Event('ended'));
      expect(playerService.recoveryState()).toBe('awaiting-duration');

      // 5 s safety-valve timer fires — recovery gives up waiting.
      vi.advanceTimersByTime(5000);

      expect(playerService.recoveryState()).toBe('normal');
      expect(playerService.buffering()).toBe(false);
      // The fallback RELOADS the source rather than seeking to 0: a bare seek
      // replays the truncated resource straight out of the browser's media
      // cache (no new bytes requested), which is exactly what fed the
      // "plays 3-4 s → ends → repeats" loop. load() forces a refetch.
      expect(mockLoad).toHaveBeenCalled();
      expect(mockPlay).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('advances the queue after MAX_RECOVERY_ATTEMPTS false-ended cycles instead of looping forever', () => {
      vi.useFakeTimers();
      // A genuinely short/corrupt resource: every recovery ends the same way,
      // so without the bound this cycle repeats every 5 s and the queue is
      // never reached (the unterminating-recovery bug).
      Object.defineProperty(fakeAudio, 'duration', { value: 1.8, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', {
        value: 1.8,
        writable: true,
        configurable: true,
      });
      playerService.queue.set([TRACK_2]);
      playerService.isPlaying.set(true);

      for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
        fakeAudio.dispatchEvent(new Event('ended'));
        expect(playerService.recoveryState()).toBe('awaiting-duration');
        // The 5 s valve gives up, reloads and replays — for a genuinely short
        // resource the refetch delivers the same bytes and feeds the next
        // false `ended`.
        vi.advanceTimersByTime(5000);
        expect(playerService.recoveryState()).toBe('normal');
        // Still on the same track: each cycle refused to advance.
        expect(playerService.currentTrack()).toEqual(knownTrack);
      }

      // Allowance spent — this ended must fall through to the normal advance.
      fakeAudio.dispatchEvent(new Event('ended'));

      expect(playerService.currentTrack()).toEqual(TRACK_2);
      expect(playerService.queue()).toEqual([]);
      vi.useRealTimers();
    });

    it('gives a newly loaded track a fresh recovery allowance', () => {
      vi.useFakeTimers();
      Object.defineProperty(fakeAudio, 'duration', { value: 1.8, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', {
        value: 1.8,
        writable: true,
        configurable: true,
      });
      playerService.isPlaying.set(true);

      // Burn the whole allowance on the current track.
      for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
        fakeAudio.dispatchEvent(new Event('ended'));
        vi.advanceTimersByTime(5000);
      }

      // A different track loads — the counter resets, so the guard protects it
      // again rather than letting the previous track's failures skip it.
      playerService.currentTrack.set(TRACK_2);
      fixture.detectChanges();
      playerService.queue.set([knownTrack]);

      fakeAudio.dispatchEvent(new Event('ended'));

      expect(playerService.recoveryState()).toBe('awaiting-duration');
      expect(playerService.queue()).toEqual([knownTrack]);
      vi.useRealTimers();
    });

    it('does not enter recovery for a legitimate ended near the real duration', () => {
      // currentTime is at the full duration — the track really did finish. The
      // false-ended guard must not flag this.
      Object.defineProperty(fakeAudio, 'duration', { value: 240, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', { value: 240, configurable: true });
      playerService.queue.set([TRACK_2]);

      fakeAudio.dispatchEvent(new Event('ended'));

      // Normal queue advance
      expect(playerService.currentTrack()).toEqual(TRACK_2);
      expect(playerService.recoveryState()).toBe('normal');
    });

    it('stale ended events from a prior load are ignored (load generation guard)', () => {
      // The element-swap path in onEnded re-binds listeners on the NEW
      // element with a fresh boundGen. A stale `ended` from the OLD element
      // (now paused with src cleared) cannot fire on the new element because
      // the old listeners were removed in the swap. This test asserts the
      // simpler invariant: dispatching `ended` after recoveryState has been
      // reset to 'normal' is treated as a legitimate end and advances the
      // queue. (The full "stale event survives a src change" case is
      // covered by the element-swap test in the regressions block above.)
      Object.defineProperty(fakeAudio, 'duration', { value: 240, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', { value: 240, configurable: true });
      playerService.queue.set([TRACK_2]);
      // Recovery must NOT trip when currentTime is at the full duration.
      fakeAudio.dispatchEvent(new Event('ended'));
      expect(playerService.recoveryState()).toBe('normal');
      expect(playerService.currentTrack()).toEqual(TRACK_2);
    });
  });

  // ─── Seeking past the loaded region ───────────────────────────────────────

  describe('seek past the loaded region', () => {
    const longTrack: Track = { id: 't1', title: 'Test Track', artist: 'A', duration: 240 };

    /** Stub what the element can currently seek into. */
    function setSeekable(...pairs: [number, number][]): void {
      Object.defineProperty(fakeAudio, 'seekable', {
        value: {
          length: pairs.length,
          start: (i: number) => pairs[i][0],
          end: (i: number) => pairs[i][1],
        },
        configurable: true,
      });
    }

    /** currentTime has to be writable for the applier's assignment to stick. */
    function setCurrentTime(value: number): void {
      Object.defineProperty(fakeAudio, 'currentTime', {
        value,
        writable: true,
        configurable: true,
      });
    }

    beforeEach(() => {
      playerService.currentTrack.set(longTrack);
      fixture.detectChanges();
      setCurrentTime(10);
      playerService.setCurrentTime(10);
    });

    it('applies a seek that lands inside the loaded region immediately', () => {
      setSeekable([0, 240]);

      component.onSeek(90);
      fixture.detectChanges();

      expect(fakeAudio.currentTime).toBe(90);
      expect(playerService.pendingSeek()).toBeNull();
    });

    // The reported bug. Assigning currentTime past what the browser holds does
    // not fail — it clamps to the end and fires `ended`, which the rest of the
    // player reads as "track finished".
    it('does not move the element when the target is past everything loaded', () => {
      setSeekable([0, 40]);

      component.onSeek(180);
      fixture.detectChanges();

      expect(fakeAudio.currentTime).toBe(10);
      expect(playerService.pendingSeek()).toEqual({ trackId: 't1', time: 180 });
      expect(playerService.buffering()).toBe(true);
    });

    it('shows the target on the seek bar while the intent is held', () => {
      setSeekable([0, 40]);

      component.onSeek(180);
      fixture.detectChanges();

      // Not 10 — the user asked to be at 3:00, so the bar reads 3:00.
      expect(component.displayTime()).toBe(180);
    });

    it('applies the held seek as soon as the loaded region reaches it', () => {
      setSeekable([0, 40]);
      component.onSeek(180);
      fixture.detectChanges();
      expect(playerService.pendingSeek()).not.toBeNull();

      // More bytes arrive and the region now covers the target.
      setSeekable([0, 200]);
      fakeAudio.dispatchEvent(new Event('progress'));

      expect(fakeAudio.currentTime).toBe(180);
      expect(playerService.pendingSeek()).toBeNull();
    });

    it('applies the held seek when a real duration lands', () => {
      setSeekable([0, 40]);
      component.onSeek(180);
      fixture.detectChanges();

      setSeekable([0, 240]);
      Object.defineProperty(fakeAudio, 'duration', { value: 240, configurable: true });
      fakeAudio.dispatchEvent(new Event('durationchange'));

      expect(fakeAudio.currentTime).toBe(180);
      expect(playerService.pendingSeek()).toBeNull();
    });

    // Defense in depth for a resource whose `seekable` over-promised: the
    // element clamps to its end and fires `ended`, and the old code advanced
    // the queue / restarted the track at 0 from there.
    it('does not advance the queue when a clamped seek provokes ended', () => {
      setSeekable([0, 40]);
      component.onSeek(180);
      fixture.detectChanges();

      playerService.queue.set([TRACK_2]);
      playerService.isPlaying.set(true);
      Object.defineProperty(fakeAudio, 'duration', { value: 40, configurable: true });
      setCurrentTime(40);

      fakeAudio.dispatchEvent(new Event('ended'));

      expect(playerService.currentTrack()).toEqual(longTrack);
      expect(playerService.queue()).toEqual([TRACK_2]);
      expect(playerService.recoveryState()).toBe('awaiting-duration');
    });

    it('resumes at the seek target — not 0 — after the recovery valve reloads', () => {
      vi.useFakeTimers();
      setSeekable([0, 40]);
      component.onSeek(180);
      fixture.detectChanges();

      playerService.isPlaying.set(true);
      Object.defineProperty(fakeAudio, 'duration', { value: 40, configurable: true });
      setCurrentTime(40);
      fakeAudio.dispatchEvent(new Event('ended'));

      mockLoad.mockClear();
      vi.advanceTimersByTime(5000);

      expect(mockLoad).toHaveBeenCalled();
      // onDuration replays restoredTime once a sane duration lands, so the
      // listener comes back to where they asked to be.
      expect(playerService.restoredTime).toBe(180);
      vi.useRealTimers();
    });

    // Without a pending seek the valve still preserves the listener's place —
    // it used to throw away everything before the fault on every fire.
    it('resumes at the played position after a recovery with no pending seek', () => {
      vi.useFakeTimers();
      playerService.isPlaying.set(true);
      Object.defineProperty(fakeAudio, 'duration', { value: 90, configurable: true });
      setCurrentTime(90);

      fakeAudio.dispatchEvent(new Event('ended'));
      vi.advanceTimersByTime(5000);

      expect(playerService.restoredTime).toBe(90);
      vi.useRealTimers();
    });

    it('lands at the reachable edge when the target never becomes available', () => {
      vi.useFakeTimers();
      setSeekable([0, 40]);
      component.onSeek(180);
      fixture.detectChanges();

      vi.advanceTimersByTime(PENDING_SEEK_TIMEOUT_MS);

      // As far forward as the element can actually go, rather than a spinner
      // that never resolves.
      expect(fakeAudio.currentTime).toBe(40 - SEEK_AVAILABILITY_EPSILON_SEC);
      expect(playerService.pendingSeek()).toBeNull();
      expect(playerService.buffering()).toBe(false);
      vi.useRealTimers();
    });

    it('voids a held seek when the user skips to another track', () => {
      setSeekable([0, 40]);
      component.onSeek(180);
      fixture.detectChanges();
      expect(playerService.pendingSeek()).not.toBeNull();

      playerService.currentTrack.set(TRACK_2);
      fixture.detectChanges();

      expect(playerService.pendingSeek()).toBeNull();
      // And the target must not land on the incoming track.
      setSeekable([0, 240]);
      fakeAudio.dispatchEvent(new Event('progress'));
      expect(fakeAudio.currentTime).not.toBe(180);
    });

    it('survives a token refresh — a re-run that is not a track change', () => {
      setSeekable([0, 40]);
      component.onSeek(180);
      fixture.detectChanges();

      TestBed.inject(AuthService).token.set('refreshed-token');
      fixture.detectChanges();

      expect(playerService.pendingSeek()).toEqual({ trackId: 't1', time: 180 });
    });

    it('clamps a media-session seekto past the known duration', () => {
      setSeekable([0, 240]);

      playerService.seek(9999);
      fixture.detectChanges();

      expect(fakeAudio.currentTime).toBe(240);
      expect(playerService.pendingSeek()).toBeNull();
    });

    // A fully-seekable resource cannot clamp, so a deliberate drag to the last
    // second is a seek to the end — not a target to sit on a spinner for.
    it('applies a seek to the very end when the whole track is seekable', () => {
      setSeekable([0, 240]);

      component.onSeek(240);
      fixture.detectChanges();

      expect(fakeAudio.currentTime).toBe(240);
      expect(playerService.pendingSeek()).toBeNull();
    });

    it('forwards a seek to the remote device instead of holding an intent', () => {
      isActiveDevice.set(false);
      fixture.detectChanges();
      const ws = TestBed.inject(PlaybackWsService);

      component.onSeek(90);

      expect(ws.sendCommand).toHaveBeenCalledWith('SEEK', { position: 90 });
      expect(playerService.pendingSeek()).toBeNull();
    });
  });

  // ─── Rapid skips (burst collapsing) ───────────────────────────────────────

  describe('rapid track changes', () => {
    const tracks: Track[] = [1, 2, 3, 4, 5, 6].map((n) => ({
      id: `b${n}`,
      title: `Burst ${n}`,
      artist: 'A',
      duration: 200,
    }));

    /** Every src the element was actually pointed at. */
    function loadedIds(): string[] {
      return mockSrcSets
        .filter((s) => s.includes('/api/stream/'))
        .map((s) => s.split('/api/stream/')[1].split('?')[0]);
    }

    let mockSrcSets: string[];
    let srcDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
      mockSrcSets = [];
      srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      Object.defineProperty(fakeAudio, 'src', {
        get: () => mockSrcSets[mockSrcSets.length - 1] ?? '',
        set: (v: string) => mockSrcSets.push(v),
        configurable: true,
      });
    });

    afterEach(() => {
      if (srcDescriptor) Object.defineProperty(HTMLMediaElement.prototype, 'src', srcDescriptor);
    });

    it('loads a single track change immediately (no added latency)', () => {
      vi.useFakeTimers();
      playerService.currentTrack.set(tracks[0]);
      fixture.detectChanges();

      expect(loadedIds()).toEqual(['b1']);
      vi.useRealTimers();
    });

    // The felt bug: five presses used to start and abort five stream requests,
    // each of which can spin an HDD and start server-side transcode work.
    it('collapses a burst of five changes into the leading load plus one', () => {
      vi.useFakeTimers();
      playerService.currentTrack.set(tracks[0]);
      fixture.detectChanges();
      expect(loadedIds()).toEqual(['b1']);

      for (const track of tracks.slice(1)) {
        vi.advanceTimersByTime(30);
        playerService.currentTrack.set(track);
        fixture.detectChanges();
      }
      // Nothing new fetched while the burst is still in flight.
      expect(loadedIds()).toEqual(['b1']);

      vi.advanceTimersByTime(LOAD_SETTLE_MS);

      // Exactly one more load, and it is where the user actually landed.
      expect(loadedIds()).toEqual(['b1', 'b6']);
      vi.useRealTimers();
    });

    it('acknowledges every press instantly even while the load is deferred', () => {
      vi.useFakeTimers();
      playerService.currentTrack.set(tracks[0]);
      fixture.detectChanges();

      vi.advanceTimersByTime(30);
      playerService.currentTrack.set(tracks[1]);
      fixture.detectChanges();

      // Title/artwork/seek-bar state is current even though no bytes have moved.
      expect(playerService.currentTrack()).toEqual(tracks[1]);
      expect(playerService.duration()).toBe(200);
      expect(playerService.buffering()).toBe(true);
      expect(loadedIds()).toEqual(['b1']);
      vi.useRealTimers();
    });

    // Effect 5 syncs play/pause off `isPlaying`. During a deferred load the
    // element still holds the *outgoing* resource, so an unguarded play() there
    // audibly resumes the track the user just skipped away from.
    it('does not resume the outgoing track while a load is deferred', () => {
      vi.useFakeTimers();
      playerService.currentTrack.set(tracks[0]);
      playerService.isPlaying.set(true);
      fixture.detectChanges();

      playerService.isPlaying.set(false);
      fixture.detectChanges();

      vi.advanceTimersByTime(30);
      mockPlay.mockClear();
      // Paused, then a skip inside the settle window: isPlaying flips back on
      // while the element is still pointed at the previous track.
      playerService.currentTrack.set(tracks[1]);
      playerService.isPlaying.set(true);
      fixture.detectChanges();

      expect(mockPlay).not.toHaveBeenCalled();

      // The deferred commit owns the play, once the new source is in place.
      vi.advanceTimersByTime(LOAD_SETTLE_MS);
      expect(loadedIds()).toEqual(['b1', 'b2']);
      expect(mockPlay).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('loads again immediately once the burst has settled', () => {
      vi.useFakeTimers();
      playerService.currentTrack.set(tracks[0]);
      fixture.detectChanges();

      vi.advanceTimersByTime(LOAD_SETTLE_MS + 10);
      playerService.currentTrack.set(tracks[1]);
      fixture.detectChanges();

      expect(loadedIds()).toEqual(['b1', 'b2']);
      vi.useRealTimers();
    });

    // Generation guard: it used to be bumped only on the cross-element swap,
    // so an in-place src replacement left the superseded load's handlers live.
    // The handler has to be invoked directly — dispatching on the element
    // would reach the *new* listeners and prove nothing.
    it('makes the handlers of a load a skip replaced inert', () => {
      vi.useFakeTimers();
      const bound: { type: string; fn: EventListener }[] = [];
      const origAdd = fakeAudio.addEventListener.bind(fakeAudio);
      fakeAudio.addEventListener = ((type: string, fn: EventListener, opts?: unknown) => {
        bound.push({ type, fn });
        origAdd(type, fn, opts as never);
      }) as typeof fakeAudio.addEventListener;

      playerService.currentTrack.set(tracks[0]);
      fixture.detectChanges();
      Object.defineProperty(fakeAudio, 'duration', { value: 200, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', { value: 200, configurable: true });

      // The `ended` handler belonging to the load now in progress.
      const staleEnded = [...bound].reverse().find((b) => b.type === 'ended')!.fn;

      vi.advanceTimersByTime(LOAD_SETTLE_MS + 10);
      playerService.currentTrack.set(tracks[1]);
      playerService.queue.set([tracks[2]]);
      fixture.detectChanges();

      // A late `ended` from the resource the skip replaced must not advance.
      staleEnded(new Event('ended'));

      expect(playerService.currentTrack()).toEqual(tracks[1]);
      expect(playerService.queue()).toEqual([tracks[2]]);
      vi.useRealTimers();
    });
  });

  // ─── Pure duration-gate helper (the 70% AND 5 s contract) ───────────────────

  describe('browserDurationIsAcceptable', () => {
    it('accepts a duration within 5 s of the known value', () => {
      // 70% AND 5 s — both must pass to accept.
      expect(browserDurationIsAcceptable(240, 240)).toBe(true);
      expect(browserDurationIsAcceptable(240, 239)).toBe(true);
      expect(browserDurationIsAcceptable(240, 236)).toBe(true); // exactly 4 s off
    });

    it('rejects a duration that fails the relative gate (70% of known)', () => {
      // 1.8 s for 240 s → 0.75% of known → reject.
      expect(browserDurationIsAcceptable(240, 1.8)).toBe(false);
      // 100 s for 240 s → 42% of known → reject.
      expect(browserDurationIsAcceptable(240, 100)).toBe(false);
      // Just under 70% → reject.
      expect(browserDurationIsAcceptable(240, 167)).toBe(false);
    });

    it('rejects a duration that fails the absolute gate (5 s of known)', () => {
      // 200 s for 240 s → relative passes (83%), but |200-240| = 40 > 5 → reject.
      expect(browserDurationIsAcceptable(240, 200)).toBe(false);
    });

    it('rejects non-finite or non-positive native values', () => {
      expect(browserDurationIsAcceptable(240, 0)).toBe(false);
      expect(browserDurationIsAcceptable(240, -1)).toBe(false);
      expect(browserDurationIsAcceptable(240, Number.NaN)).toBe(false);
      expect(browserDurationIsAcceptable(240, Number.POSITIVE_INFINITY)).toBe(false);
    });

    it('falls back to an absolute floor when the known duration is missing (issue #234)', () => {
      // No reference value (freshly-scanned track with duration:0, or an
      // untagged acquisition) — there's no API duration to compare against,
      // but a sub-floor native duration is still almost certainly a
      // truncated/corrupt server response, not a legitimately tiny track.
      // Trusting it blindly (the old behavior) is exactly how issue #234's
      // "plays 1-2s then advances" bug slipped past every other mitigation.
      expect(browserDurationIsAcceptable(0, 1.8)).toBe(false);
      expect(browserDurationIsAcceptable(Number.NaN, 1.8)).toBe(false);
    });

    it('accepts a native duration at/above the absolute floor when known duration is missing', () => {
      expect(browserDurationIsAcceptable(0, 5)).toBe(true);
      expect(browserDurationIsAcceptable(0, 240)).toBe(true);
    });
  });

  describe('false-ended recovery without an API-known duration (issue #234)', () => {
    // The library scanner writes duration:0 when a file's tags carry no
    // parseable duration; the API then ships track.duration as 0/undefined.
    // Every existing false-ended defense keys off that value, so without an
    // absolute-floor fallback a corrupt/truncated transcode for one of these
    // tracks plays 1-2s, fires `ended`, and silently advances the queue.
    const unknownDurationTrack: Track = {
      id: 't1',
      title: 'Untagged Track',
      artist: 'Test Artist',
      // duration intentionally omitted
    };

    beforeEach(() => {
      playerService.currentTrack.set(unknownDurationTrack);
      fixture.detectChanges();
    });

    it('does not advance the queue when ended fires at 1.8s and the API duration is unknown', () => {
      Object.defineProperty(fakeAudio, 'duration', { value: 1.8, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', { value: 1.8, configurable: true });
      playerService.queue.set([TRACK_2]);
      playerService.isPlaying.set(true);

      fakeAudio.dispatchEvent(new Event('ended'));

      expect(playerService.currentTrack()).toEqual(unknownDurationTrack);
      expect(playerService.queue()).toEqual([TRACK_2]);
      expect(playerService.recoveryState()).toBe('awaiting-duration');
      expect(playerService.buffering()).toBe(true);
    });

    it('recovers once a real duration arrives, even with no API reference', () => {
      Object.defineProperty(fakeAudio, 'duration', { value: 1.8, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', { value: 1.8, configurable: true });
      playerService.isPlaying.set(true);
      mockPlay.mockClear();
      fakeAudio.dispatchEvent(new Event('ended'));
      expect(playerService.recoveryState()).toBe('awaiting-duration');

      Object.defineProperty(fakeAudio, 'duration', { value: 240, configurable: true });
      fakeAudio.dispatchEvent(new Event('durationchange'));

      expect(playerService.recoveryState()).toBe('normal');
      expect(playerService.duration()).toBe(240);
      expect(mockPlay).toHaveBeenCalled();
    });

    it('does not enter recovery for a legitimately short track ending at/above the floor', () => {
      // A real 4s track with no scanned duration must still play through
      // normally — the floor must not misfire on genuinely tiny tracks.
      Object.defineProperty(fakeAudio, 'duration', { value: 4, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', { value: 4, configurable: true });
      playerService.queue.set([TRACK_2]);

      fakeAudio.dispatchEvent(new Event('ended'));

      expect(playerService.currentTrack()).toEqual(TRACK_2);
      expect(playerService.recoveryState()).toBe('normal');
    });
  });

  // ─── Truncated preserved blob: self-heal by falling back to the stream ──────

  describe('false ended while sourced from a preserved blob (truncated store)', () => {
    // The "plays 3-4 s then stalls/advances, feels cached" report: a partial
    // fetch slipped into IndexedDB, so every play sources the same short blob.
    // Waiting/retrying that source can never help — the player must drop the
    // poisoned entry and re-point at the network stream.
    const knownTrack: Track = {
      id: 't1',
      title: 'Test Track',
      artist: 'Test Artist',
      duration: 240,
    };

    beforeEach(() => {
      playerService.currentTrack.set(knownTrack);
      fixture.detectChanges();
      // The element is playing an object URL of the stored (truncated) blob.
      Object.defineProperty(fakeAudio, 'currentSrc', {
        value: 'blob:http://localhost/poisoned',
        configurable: true,
      });
      Object.defineProperty(fakeAudio, 'duration', { value: 3.5, configurable: true });
      Object.defineProperty(fakeAudio, 'currentTime', { value: 3.5, configurable: true });
      // Only the current track is preserved — a queue advance to TRACK_2 must
      // take the stream path (the real preserve-store would touch IndexedDB,
      // which jsdom does not provide).
      preserveMock.isPreserved.mockImplementation((id: string) => id === 't1');
    });

    it('drops the poisoned preservation and re-streams instead of blind recovery', () => {
      playerService.queue.set([TRACK_2]);
      playerService.isPlaying.set(true);
      mockPlay.mockClear();

      fakeAudio.dispatchEvent(new Event('ended'));

      // Healed in place: same track, queue untouched, no recovery wait state.
      expect(playerService.currentTrack()).toEqual(knownTrack);
      expect(playerService.queue()).toEqual([TRACK_2]);
      expect(playerService.recoveryState()).toBe('normal');
      // The bad blob is deleted so future plays (and other devices' sync of
      // this store) don't replay it, and the element now points at the stream.
      expect(preserveMock.remove).toHaveBeenCalledWith('t1');
      expect(fakeAudio.src).toContain('/api/stream/t1');
      expect(mockPlay).toHaveBeenCalled();
    });

    it('falls back to bounded blind recovery when offline (the blob is the only source)', () => {
      netOnline.set(false);
      playerService.queue.set([TRACK_2]);
      playerService.isPlaying.set(true);

      fakeAudio.dispatchEvent(new Event('ended'));

      expect(preserveMock.remove).not.toHaveBeenCalled();
      expect(playerService.recoveryState()).toBe('awaiting-duration');
      expect(playerService.queue()).toEqual([TRACK_2]);
    });

    it('advances normally once the recovery allowance is spent on a genuinely short blob', () => {
      vi.useFakeTimers();
      playerService.queue.set([TRACK_2]);
      playerService.isPlaying.set(true);

      // Each cycle: the heal swaps to the stream — make the element look
      // blob-sourced again to model the pathological case where every source
      // keeps ending short, and verify the shared allowance still terminates.
      for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
        fakeAudio.dispatchEvent(new Event('ended'));
        vi.advanceTimersByTime(5000);
        expect(playerService.currentTrack()).toEqual(knownTrack);
      }

      fakeAudio.dispatchEvent(new Event('ended'));

      expect(playerService.currentTrack()).toEqual(TRACK_2);
      vi.useRealTimers();
    });

    it('does not touch the preservation for a non-blob (stream) false ended', () => {
      Object.defineProperty(fakeAudio, 'currentSrc', {
        value: 'http://localhost/api/stream/t1',
        configurable: true,
      });
      playerService.isPlaying.set(true);

      fakeAudio.dispatchEvent(new Event('ended'));

      expect(preserveMock.remove).not.toHaveBeenCalled();
      expect(playerService.recoveryState()).toBe('awaiting-duration');
    });
  });
});
