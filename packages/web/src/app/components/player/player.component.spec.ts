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
import type { Track } from '../../services/player.service';

// Prevent IndexedDB usage — preserve-store is only reached when isPreserved() is true,
// which we mock to false. This vi.mock is still required because the module is imported
// at the top level of player.component.ts.
vi.mock('../../lib/preserve-store', () => ({
  getBlob: vi.fn(),
  updateLastAccessed: vi.fn(),
}));

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
      playerService.isPlaying.set(true);
      setVisibility('visible');

      fakeAudio.dispatchEvent(new Event('pause'));

      expect(playerService.isPlaying()).toBe(false);
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
      playerService.isPlaying.set(true);
      setVisibility('visible');

      fakeAudio.dispatchEvent(new Event('pause'));

      expect(playerService.isPlaying()).toBe(false);
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
});
