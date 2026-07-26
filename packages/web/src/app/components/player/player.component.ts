import {
  Component,
  inject,
  signal,
  computed,
  effect,
  untracked,
  viewChild,
  ElementRef,
  OnDestroy,
  AfterViewInit,
  NgZone,
} from '@angular/core';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { ArtistLinksComponent } from '../artist-links/artist-links.component';
import { DeviceSwitcherComponent } from '../device-switcher/device-switcher.component';
import { PreserveService } from '../../services/preserve.service';
import { ServerConfigService } from '../../services/server-config.service';
import { MediaControlsService } from '../../services/media-controls.service';
import { NetworkStatusService } from '../../services/network-status.service';
import { ToastService } from '../../services/toast.service';
import { buildMediaMetadata } from '../../lib/media-metadata';
import * as db from '../../lib/preserve-store';
import { createPointerDrag } from '../../lib/pointer-drag';
import { miniPlayerSlideClass } from '../../lib/player-chrome';
import { SeekBarComponent } from '../seek-bar/seek-bar.component';

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Absolute floor (seconds) used by both {@link browserDurationIsAcceptable}
 * and {@link PlayerComponent.isFalseEnded} when there is no API-known
 * `track.duration` to compare against (the library scanner writes
 * `duration: 0` when a file's tags carry no parseable duration — see
 * `library-scanner.ts` — and the API ships that through as 0/undefined).
 * Real tracks are essentially never this short, so a sub-floor native
 * duration is treated as a truncated/corrupt server response rather than a
 * legitimately tiny track (issue #234).
 */
export const FALSE_ENDED_ABSOLUTE_FLOOR_SEC = 3;

/**
 * Frontend duration gate. The API-known `track.duration` (from the library
 * scan / source-file tag metadata) is the reference of truth — a browser
 * reporting a much-smaller `audio.duration` for the same resource usually
 * means the container is still being parsed (VBR / chunked streaming) or the
 * response is genuinely short (a corrupt server cache, the reported bug).
 *
 * Reject the browser's value unless BOTH checks pass:
 *   - `native >= 0.7 × known` (catches a 1.8 s browser parse of a 240 s file)
 *   - `|native − known| <= 5 s` (catches a 200 s browser parse of a 240 s file
 *     — relative check passes, absolute catches it)
 *
 * When the known value is missing (`<= 0`), there's no reference to compare
 * against, but blindly trusting the browser (the old behavior) let a
 * corrupt/truncated response for an unscanned-duration track slip past this
 * gate entirely — issue #234. Fall back to the absolute floor instead.
 */
export function browserDurationIsAcceptable(
  knownSec: number,
  nativeSec: number,
): boolean {
  if (!Number.isFinite(nativeSec) || nativeSec <= 0) return false;
  if (!Number.isFinite(knownSec) || knownSec <= 0) {
    return nativeSec >= FALSE_ENDED_ABSOLUTE_FLOOR_SEC;
  }
  const relativeOk = nativeSec >= knownSec * 0.7;
  const absoluteOk = Math.abs(nativeSec - knownSec) <= 5;
  return relativeOk && absoluteOk;
}

@Component({
  selector: 'app-player',
  imports: [CoverArtComponent, DeviceSwitcherComponent, SeekBarComponent, ArtistLinksComponent],
  templateUrl: './player.component.html',
})
export class PlayerComponent implements AfterViewInit, OnDestroy {
  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  readonly remote = inject(RemotePlaybackService);
  private ws = inject(PlaybackWsService);
  private zone = inject(NgZone);
  private preserve = inject(PreserveService);
  private server = inject(ServerConfigService);
  private mediaControls = inject(MediaControlsService);
  private network = inject(NetworkStatusService);
  private toast = inject(ToastService);

  private audioElA = viewChild<ElementRef<HTMLAudioElement>>('audioElA');
  private audioElB = viewChild<ElementRef<HTMLAudioElement>>('audioElB');
  // Which element is currently active; flipping this makes all Effects switch to the other element.
  private primaryIsA = signal(true);
  private readonly audioEl = computed(() =>
    this.primaryIsA() ? this.audioElA() : this.audioElB(),
  );
  private get standbyNativeEl(): HTMLAudioElement | null {
    return (this.primaryIsA() ? this.audioElB() : this.audioElA())?.nativeElement ?? null;
  }

  private pausingByStore = false;
  private backgroundPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private progressReportInterval: ReturnType<typeof setInterval> | null = null;
  private rafId: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private visibilityChangeHandler: (() => void) | null = null;
  private wasPlayingBeforeHidden = false;
  private resumePendingAfterVisible = false;
  // Set by onEnded when it pre-loads the next track synchronously; tells Effect 1 to skip.
  private lastManualSrc: string | null = null;
  // Object URL created by onEnded for a preserved track; needs manual revocation.
  private lastManualObjectUrl: string | null = null;
  // Track id that has been pre-buffered into the standby element.
  private preloadedTrackId: string | null = null;
  // Tracks the last vocal mute state to detect toggle changes (Effect 6b).
  private lastVocalsMuted: boolean | null = null;
  // Load generation: bumped only on the element swap (onEnded standby swap).
  // Every event handler closure captures the generation at bind time and
  // ignores events from a prior element's listener scope. (The browser
  // already discards queued events when `audio.src` is reassigned on the
  // same element, so we don't bump for in-place src changes — only for
  // cross-element handoffs where the old listeners were removed.)
  private loadGeneration = 0;

  // Playback progress interpolation
  private interpolatedTime = signal(0);

  readonly isActiveDevice = this.remote.isActiveDevice;

  readonly slideClass = computed(() => miniPlayerSlideClass(this.player.currentTrack() !== null));

  readonly displayTime = computed(() => {
    if (this.isActiveDevice()) return this.player.currentTime();
    return this.interpolatedTime();
  });

  readonly displayDuration = computed(() => {
    if (this.isActiveDevice()) return this.player.duration();
    return this.remote.remoteDuration() || this.player.duration();
  });

  readonly safeDuration = computed(() => {
    const d = this.displayDuration();
    return Number.isFinite(d) && d > 0 ? d : 0;
  });

  readonly safeProgress = computed(() => {
    const t = this.displayTime();
    const d = this.safeDuration();
    // When the duration is unknown/0 (mid-load, or false-ended recovery before
    // a real duration lands), don't fall back to `t` — that paints a 100% seek
    // bar from the first sample. Hold at 0 and let the real duration push the
    // bar to the right position once it arrives.
    if (!Number.isFinite(t) || t < 0) return 0;
    if (!Number.isFinite(d) || d <= 0) return 0;
    return Math.min(t, d);
  });

  readonly showPlaying = computed(() => {
    return this.isActiveDevice() ? this.player.isPlaying() : this.remote.remoteIsPlaying();
  });

  readonly showBuffering = computed(() => this.isActiveDevice() && this.player.bufferingVisible());

  // Event listener teardown references
  private audioListenerCleanups: (() => void)[] = [];

  constructor() {
    // Effect 1: Load track (checks IndexedDB first for offline-preserved tracks)
    effect((onCleanup) => {
      // Revoke any object URL we created in onEnded for a preserved track.
      const pendingObjectUrl = this.lastManualObjectUrl;
      this.lastManualObjectUrl = null;
      onCleanup(() => {
        if (pendingObjectUrl) URL.revokeObjectURL(pendingObjectUrl);
      });

      const track = this.player.currentTrack();
      const token = this.auth.token();
      const isActive = this.isActiveDevice();
      const audio = this.audioEl()?.nativeElement;
      if (!audio) return;

      // onEnded pre-loaded this track synchronously to keep the Android audio session alive.
      if (track && this.lastManualSrc === track.id) {
        this.lastManualSrc = null;
        return;
      }

      let objectUrl: string | null = null;
      onCleanup(() => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      });

      if (!isActive) {
        this.pausingByStore = true;
        audio.pause();
        this.pausingByStore = false;
        audio.src = '';
        this.player.setBuffering(false);
        this.player.setBufferedRanges([]);
        return;
      }

      if (track) {
        this.player.setCurrentTime(0);
        this.player.setDuration(track.duration ?? 0);
        // New load beginning — flag it before any bytes move so track rows and
        // play buttons can acknowledge instantly (HDD loads take seconds).
        this.player.setBuffering(true);
        this.player.setBufferedRanges([]);

        if (untracked(() => this.preserve.isPreserved(track.id))) {
          // Load from IndexedDB — no network request
          (async () => {
            const blob = await db.getBlob(track.id);
            if (blob) {
              objectUrl = URL.createObjectURL(blob.audio);
              audio.src = objectUrl;
              db.updateLastAccessed(track.id);
            } else {
              // Metadata exists but blob missing — fall back to stream
              audio.src = this.server.streamUrl(track.id, token);
            }
            // Don't autoplay on a fresh track load: the user must have pressed
            // play (or have autoplay_on_load + restored session — which routes
            // through Effect 5 via isPlaying). Otherwise just loading the
            // metadata is enough — the seek position is restored by onDuration.
            if (untracked(() => this.player.isPlaying())) {
              audio.play().catch((err) => {
                if (err.name === 'NotAllowedError') this.handlePlayRejection();
              });
            }
          })();
        } else if (untracked(() => !this.network.online())) {
          // Offline and this track isn't downloaded — don't point <audio> at an
          // unreachable stream. Left unguarded, the element stalls on a spinner
          // that never resolves (`onError` only clears buffering). Bail cleanly.
          audio.src = '';
          this.player.setBuffering(false);
          this.player.setBufferedRanges([]);
          this.toast.show({ message: `"${track.title}" isn't available offline`, kind: 'error' });
        } else {
          audio.src = this.server.streamUrl(track.id, token);
          // See the preserve branch above for why play() is gated here.
          if (untracked(() => this.player.isPlaying())) {
            audio.play().catch((err) => {
              if (err.name === 'NotAllowedError') this.handlePlayRejection();
            });
          }
        }
      } else {
        this.pausingByStore = true;
        audio.pause();
        this.pausingByStore = false;
        audio.src = '';
        this.player.setCurrentTime(0);
        this.player.setDuration(0);
        this.player.setBuffering(false);
        this.player.setBufferedRanges([]);
      }
    });

    // Effect 2: Media Session metadata (OS lock-screen / notification). Routed
    // through MediaControlsService so it works in the native WebView (which lacks
    // the Web Media Session API) as well as the browser.
    effect(() => {
      const track = this.player.currentTrack();
      const token = this.auth.token();

      if (!track) {
        this.mediaControls.setMetadata({ title: '', artist: '', album: '', artwork: [] });
        this.mediaControls.setPlaybackState('none');
        return;
      }

      this.mediaControls.setMetadata(
        buildMediaMetadata(track, (coverArt, size) =>
          this.server.apiUrl(`/api/cover/${coverArt}?size=${size}&token=${token}`),
        ),
      );
    });

    // Effect 3: Media Session playback state
    effect(() => {
      const playing = this.player.isPlaying();
      this.mediaControls.setPlaybackState(playing ? 'playing' : 'paused');
    });

    // Effect 4: Media Session action handlers
    // Handlers are always registered (never nulled) so OS controls work throughout the last
    // track and across lock-screen sessions. All callbacks run inside zone.run() because
    // lock-screen/notification-shade dispatches fire outside Angular's zone.
    effect(() => {
      // Read signals so effect re-runs when these change (keeps handlers fresh).
      this.player.queue();
      this.player.history();
      this.player.repeat();

      this.mediaControls.setActionHandler('play', () => this.zone.run(() => this.player.resume()));
      this.mediaControls.setActionHandler('pause', () => this.zone.run(() => this.player.pause()));
      this.mediaControls.setActionHandler('nexttrack', () =>
        this.zone.run(() => this.player.playNext()),
      );
      this.mediaControls.setActionHandler('previoustrack', () =>
        this.zone.run(() => {
          const audio = this.audioEl()?.nativeElement;
          if (audio && audio.currentTime > 3) {
            audio.currentTime = 0;
          } else {
            this.player.playPrev();
          }
        }),
      );
      this.mediaControls.setActionHandler('seekto', (seekTime) => {
        if (seekTime != null) this.zone.run(() => this.player.seek(seekTime));
      });
      this.mediaControls.setActionHandler('seekforward', () =>
        this.zone.run(() => this.player.seek(this.player.currentTime() + 10)),
      );
      this.mediaControls.setActionHandler('seekbackward', () =>
        this.zone.run(() => this.player.seek(Math.max(0, this.player.currentTime() - 10))),
      );
    });

    // Effect 5: Play/pause sync
    effect(() => {
      const playing = this.player.isPlaying();
      const isActive = this.isActiveDevice();
      const audio = this.audioEl()?.nativeElement;
      if (!audio) return;

      if (!isActive) {
        this.pausingByStore = true;
        audio.pause();
        this.pausingByStore = false;
        this.releaseWakeLock();
        return;
      }
      if (playing) {
        audio.play().catch((err) => {
          if (err.name === 'NotAllowedError') this.handlePlayRejection();
        });
        void this.acquireWakeLock();
      } else {
        this.pausingByStore = true;
        audio.pause();
        this.pausingByStore = false;
        this.releaseWakeLock();
      }
    });

    // Effect 6: Seek from store
    effect(() => {
      const seekTo = this.player.seekTo();
      const audio = this.audioEl()?.nativeElement;
      if (!audio || seekTo === null) return;
      audio.currentTime = seekTo;
      this.player.clearSeek();
    });

    // Effect 6b: Vocal mute toggle — reloads the stream with/without the
    // ?vocals=off param. The toggle requires a fresh audio src because the
    // server-side filter produces a different file. Position is preserved via
    // player.restoredTime, which the existing onDuration handler (above)
    // applies once loadedmetadata fires on the new audio. This re-uses the
    // same restore mechanism as the page-reload path (PlayerService.restoreState).
    // why backend (not a client Web Audio graph): routing the <audio> element
    // through a MediaElementAudioSourceNode silenced playback entirely on
    // Android, so vocal removal must stay server-side. Do not reintroduce a
    // client-side vocal filter.
    effect(() => {
      const vocalsMuted = this.player.vocalsMuted();
      const track = this.player.currentTrack();
      const audio = this.audioEl()?.nativeElement;
      if (!track || !audio) return;

      // Skip the initial run (track load is handled by Effect 1).
      if (this.lastVocalsMuted === null) {
        this.lastVocalsMuted = vocalsMuted;
        return;
      }
      if (vocalsMuted === this.lastVocalsMuted) return;
      this.lastVocalsMuted = vocalsMuted;

      // Stash the current position so onDuration restores it once the new
      // media's loadedmetadata fires (browser resets currentTime to 0 when
      // audio.src changes).
      if (audio.currentTime > 1) this.player.restoredTime = audio.currentTime;
      const wasPlaying = this.player.isPlaying();
      const token = this.auth.token();
      audio.src = this.server.streamUrl(track.id, token, { vocalsOff: vocalsMuted });
      if (wasPlaying) {
        audio.play().catch((err) => {
          if (err.name === 'NotAllowedError') this.handlePlayRejection();
        });
      }
    });

    // Effect 7: Progress reporting interval
    effect((onCleanup) => {
      const isActive = this.isActiveDevice();
      const playing = this.player.isPlaying();

      if (!isActive || !playing) return;
      const audio = this.audioEl()?.nativeElement;
      if (!audio) return;

      const report = () => {
        if (audio.duration > 0 && Number.isFinite(audio.currentTime)) {
          this.ws.sendProgressReport(audio.currentTime, audio.duration);
          // Keep the OS notification scrubber in sync (and enable seekto).
          this.mediaControls.setPositionState(audio.duration, audio.currentTime);
        }
      };

      report();
      const interval = setInterval(report, 2000);
      onCleanup(() => clearInterval(interval));
    });

    // Effect 8: Remote playback interpolation (rAF loop)
    effect((onCleanup) => {
      const isActive = this.isActiveDevice();

      if (isActive) {
        this.interpolatedTime.set(this.player.currentTime());
        return;
      }

      const remPlaying = this.remote.remoteIsPlaying();
      const remPos = this.remote.remotePosition();
      const remPosTs = this.remote.remotePositionTs();
      const remDur = this.remote.remoteDuration();

      if (!remPlaying) {
        this.interpolatedTime.set(remPos);
        return;
      }

      let rafId: number;
      const tick = () => {
        const elapsed = (Date.now() - remPosTs) / 1000;
        const maxTime = remDur || Infinity;
        this.interpolatedTime.set(Math.min(remPos + elapsed, maxTime));
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
      onCleanup(() => cancelAnimationFrame(rafId));
    });
  }

  private handlePlayRejection(): void {
    this.player.setBuffering(false);
    if (document.visibilityState === 'hidden') {
      // Browser revoked autoplay while screen is locked — resume when app returns.
      this.resumePendingAfterVisible = true;
    } else {
      this.player.setAutoplayBlocked(true);
    }
  }

  /**
   * Stop playback cleanly when the current/next track can't be sourced offline
   * (not downloaded, or its blob is missing). Avoids the silent, infinite
   * buffering spinner that a doomed network `<audio>` load would produce.
   */
  private stopForOffline(audio: HTMLAudioElement, title: string): void {
    this.pausingByStore = true;
    audio.pause();
    this.pausingByStore = false;
    audio.src = '';
    this.player.setBuffering(false);
    this.player.setBufferedRanges([]);
    this.toast.show({ message: `"${title}" isn't available offline`, kind: 'error' });
  }

  private async acquireWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) return;
    if (this.wakeLock && !this.wakeLock.released) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === 'NotSupportedError' || err.name === 'NotAllowedError')
      )
        return;
      throw err;
    }
  }

  private releaseWakeLock(): void {
    this.wakeLock?.release();
    this.wakeLock = null;
  }

  ngAfterViewInit(): void {
    const audio = this.audioEl()?.nativeElement;
    if (!audio) return;
    this.bindAudioListeners(audio);

    this.visibilityChangeHandler = () => {
      if (document.visibilityState === 'hidden') {
        this.wasPlayingBeforeHidden = this.player.isPlaying() && this.isActiveDevice();
      } else if (document.visibilityState === 'visible') {
        void this.acquireWakeLock();
        if (
          (this.wasPlayingBeforeHidden || this.resumePendingAfterVisible) &&
          this.isActiveDevice()
        ) {
          this.wasPlayingBeforeHidden = false;
          this.resumePendingAfterVisible = false;
          const audioEl = this.audioEl()?.nativeElement;
          if (audioEl) {
            if (!this.player.isPlaying()) this.player.resume();
            if (audioEl.paused) {
              audioEl.play().catch(() => this.player.setAutoplayBlocked(true));
            }
          }
        }
      }
    };
    document.addEventListener('visibilitychange', this.visibilityChangeHandler);
  }

  private bindAudioListeners(audio: HTMLAudioElement): void {
    // Remove previous listeners before re-binding (called again on every element swap).
    this.audioListenerCleanups.forEach((fn) => fn());
    if (this.backgroundPauseTimer !== null) {
      clearTimeout(this.backgroundPauseTimer);
      this.backgroundPauseTimer = null;
    }

    // Capture the load generation at bind time. Every handler below closes
    // over this number and bails if `loadGeneration` has moved on (the standby
    // element was swapped in, a vocal-mute toggle reloaded src, etc). Without
    // this, a stale `ended` from the pre-swap load could advance the queue
    // right after the user manually picks the next track.
    const boundGen = this.loadGeneration;

    const onTime = () => {
      if (boundGen !== this.loadGeneration) return;
      const value = audio.currentTime;
      if (Number.isFinite(value) && value >= 0) {
        this.player.setCurrentTime(value);
        if ('mediaSession' in navigator && audio.duration > 0 && Number.isFinite(audio.duration)) {
          try {
            navigator.mediaSession.setPositionState({
              duration: audio.duration,
              playbackRate: 1,
              position: value,
            });
          } catch {
            // Older WebKit may throw
          }
        }
      }
      // Pre-buffer next track when 30 s remain so the element swap at onEnded is instant.
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const remaining = audio.duration - value;
        if (remaining > 0 && remaining < 30) {
          const nextTrack = untracked(() => this.player.queue()[0]);
          if (nextTrack && nextTrack.id !== this.preloadedTrackId) {
            const isPreserved = untracked(() => this.preserve.isPreserved(nextTrack.id));
            if (!isPreserved) {
              const standby = this.standbyNativeEl;
              if (standby) {
                this.preloadedTrackId = nextTrack.id;
                standby.src = this.server.streamUrl(nextTrack.id, this.auth.token());
                standby.preload = 'auto';
                // load() without play() — just buffer the initial bytes
                standby.load();
              }
            }
          }
        }
      }
    };

    const onDuration = () => {
      if (boundGen !== this.loadGeneration) return;
      const value = audio.duration;
      if (!Number.isFinite(value) || value <= 0) return;
      // Duration gate: refuse to adopt a browser-reported duration that's far
      // off the API-known one. Keeping the API value prevents the seek bar
      // from showing 100% on a partial-parse / corrupt-cache response, and
      // keeps the false-ended recovery path in a position to detect the
      // mismatched state (browser.currentTime reaches the bad short duration
      // → ended fires → we recover rather than advance the queue).
      const known = untracked(() => this.player.currentTrack()?.duration ?? 0);
      if (!browserDurationIsAcceptable(known, value)) {
        return;
      }
      this.player.setDuration(value);
      if (this.player.recoveryState() === 'awaiting-duration') {
        // A sane duration finally arrived — exit recovery and resume from
        // where the audio element is currently parked (1-2 s into the bogus
        // short read; the browser keeps playing from there once play() is
        // called again).
        this.player.recoveryState.set('normal');
        this.recoveryTimeout = null;
        this.player.setBuffering(false);
        if (this.player.isPlaying()) {
          audio.play().catch((err) => {
            if (err.name === 'NotAllowedError') this.handlePlayRejection();
          });
        }
      }
      if (this.player.restoredTime !== null) {
        audio.currentTime = this.player.restoredTime;
        this.player.restoredTime = null;
      }
    };

    const onEnded = () => {
      if (boundGen !== this.loadGeneration) return;
      // False-ended guard: the browser fired `ended` but the audio timeline
      // nowhere near the API-known duration. Most commonly a VBR/lossy
      // container that reported a partial duration over the Range response,
      // or a corrupt server cache file (the bug this branch was written for).
      // Do NOT advance the queue — pause, flag recovery, wait for a real
      // duration.
      if (this.isFalseEnded(audio)) {
        this.startRecovery(audio, boundGen);
        return;
      }
      const repeat = this.player.repeat();
      const token = this.auth.token();

      if (repeat === 'one') {
        audio.currentTime = 0;
        audio.play().catch((err) => {
          if (err.name === 'NotAllowedError') this.handlePlayRejection();
        });
      } else {
        const nextTrack = this.player.queue()[0];
        if (nextTrack) {
          this.lastManualSrc = nextTrack.id;
          const standby = this.standbyNativeEl;
          const isPreloaded = standby !== null && this.preloadedTrackId === nextTrack.id;

          if (isPreloaded && standby) {
            // Standby element has the next track already buffered — swap instantly.
            // Clean up the element that just finished.
            const pendingUrl = this.lastManualObjectUrl;
            this.lastManualObjectUrl = null;
            audio.pause();
            audio.src = '';
            if (pendingUrl) URL.revokeObjectURL(pendingUrl);

            // Flip which element Effects reference.
            this.primaryIsA.update((v) => !v);
            this.preloadedTrackId = null;
            // New load on a new element — bump the generation so any stale
            // event still queued on the now-cleared old element can't make
            // it through (the new listeners capture the bumped value).
            this.loadGeneration += 1;

            // Re-bind all audio listeners to the now-active element.
            this.bindAudioListeners(standby);

            // Usually clears within ms (the standby is buffered) — the 250ms visibility
            // delay means no spinner unless the swap actually stalls.
            this.player.setBuffering(true);
            this.player.setBufferedRanges([]);

            // Start playback — the element is already buffered so this is near-instant.
            standby.play().catch((err) => {
              if (document.visibilityState === 'hidden') {
                this.resumePendingAfterVisible = true;
              } else if (err.name === 'NotAllowedError') {
                this.handlePlayRejection();
              }
            });
          } else {
            // No preload available (preserved track, first track, or preload missed) — existing path.
            const isPreserved = untracked(() => this.preserve.isPreserved(nextTrack.id));

            const playNext = () => {
              this.player.setBuffering(true);
              this.player.setBufferedRanges([]);
              audio.play().catch((err) => {
                if (document.visibilityState === 'hidden') {
                  this.resumePendingAfterVisible = true;
                } else if (err.name === 'NotAllowedError') {
                  this.handlePlayRejection();
                }
              });
            };

            if (isPreserved) {
              db.getBlob(nextTrack.id).then((blob) => {
                if (blob) {
                  const url = URL.createObjectURL(blob.audio);
                  this.lastManualObjectUrl = url;
                  audio.src = url;
                  playNext();
                } else if (untracked(() => !this.network.online())) {
                  // Metadata preserved but blob missing, and offline — don't
                  // stall on an unreachable stream.
                  this.stopForOffline(audio, nextTrack.title);
                } else {
                  audio.src = this.server.streamUrl(nextTrack.id, token);
                  playNext();
                }
              });
            } else if (untracked(() => !this.network.online())) {
              // Offline and the next track isn't downloaded — stop instead of
              // pointing <audio> at a stream that will only spin forever.
              this.stopForOffline(audio, nextTrack.title);
            } else {
              audio.src = this.server.streamUrl(nextTrack.id, token);
              playNext();
            }
          }
        }
        this.player.playNext();
      }
    };

    const onPlay = () => {
      if (boundGen !== this.loadGeneration) return;
      // Cancel any deferred pause — audio resumed before the timer fired.
      if (this.backgroundPauseTimer !== null) {
        clearTimeout(this.backgroundPauseTimer);
        this.backgroundPauseTimer = null;
      }
      this.player.setAutoplayBlocked(false);
      if (!this.player.isPlaying()) {
        this.player.resume();
      }
    };
    const onPause = () => {
      if (boundGen !== this.loadGeneration) return;
      if (this.pausingByStore) return;
      if (document.visibilityState === 'hidden') {
        this.resumePendingAfterVisible = this.player.isPlaying();
        return;
      }
      // Android race: audio.pause can fire before visibilitychange(hidden) when the
      // OS yanks audio focus. Defer committing the pause so visibilitychange arrives first.
      this.backgroundPauseTimer = setTimeout(() => {
        this.backgroundPauseTimer = null;
        if (document.visibilityState === 'hidden') {
          this.resumePendingAfterVisible = this.player.isPlaying();
        } else if (this.player.isPlaying()) {
          this.player.pause();
        }
      }, 250);
    };

    const onWaiting = () => {
      if (boundGen !== this.loadGeneration) return;
      this.player.setBuffering(true);
    };
    const onSeeking = () => {
      if (boundGen !== this.loadGeneration) return;
      this.player.setBuffering(true);
    };
    // Seeking into an already-buffered region fires no playing/canplay while
    // paused (readyState never dips), so seeked must clear the flag itself —
    // but only when data is really there; unbuffered targets keep the spinner
    // up until waiting/canplay resolve it.
    const onSeeked = () => {
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) this.player.setBuffering(false);
    };
    // stalled also fires on harmless network hiccups while plenty is buffered —
    // only treat it as buffering when playback genuinely can't proceed.
    const onStalled = () => {
      if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) this.player.setBuffering(true);
    };
    const onPlaying = () => {
      if (boundGen !== this.loadGeneration) return;
      this.player.setBuffering(false);
    };
    const onCanPlay = () => {
      if (boundGen !== this.loadGeneration) return;
      this.player.setBuffering(false);
      // `canplay` is a coarser signal than `durationchange` but it's the
      // earliest event that proves the browser has enough bytes to play —
      // exit recovery if the current duration is sane.
      const d = audio.duration;
      const known = untracked(() => this.player.currentTrack()?.duration ?? 0);
      if (
        this.player.recoveryState() === 'awaiting-duration' &&
        Number.isFinite(d) && d > 0 &&
        browserDurationIsAcceptable(known, d)
      ) {
        this.player.recoveryState.set('normal');
        this.recoveryTimeout = null;
        this.player.setBuffering(false);
        if (this.player.isPlaying()) {
          audio.play().catch((err) => {
            if (err.name === 'NotAllowedError') this.handlePlayRejection();
          });
        }
      }
    };
    const onError = () => {
      if (boundGen !== this.loadGeneration) return;
      this.player.setBuffering(false);
    };
    const onProgress = () => {
      if (boundGen !== this.loadGeneration) return;
      const ranges: { start: number; end: number }[] = [];
      for (let i = 0; i < audio.buffered.length; i++) {
        ranges.push({ start: audio.buffered.start(i), end: audio.buffered.end(i) });
      }
      this.player.setBufferedRanges(ranges);
    };

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onDuration);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('seeking', onSeeking);
    audio.addEventListener('seeked', onSeeked);
    audio.addEventListener('stalled', onStalled);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('error', onError);
    audio.addEventListener('progress', onProgress);

    this.audioListenerCleanups = [
      () => audio.removeEventListener('timeupdate', onTime),
      () => audio.removeEventListener('loadedmetadata', onDuration),
      () => audio.removeEventListener('durationchange', onDuration),
      () => audio.removeEventListener('ended', onEnded),
      () => audio.removeEventListener('play', onPlay),
      () => audio.removeEventListener('pause', onPause),
      () => audio.removeEventListener('waiting', onWaiting),
      () => audio.removeEventListener('seeking', onSeeking),
      () => audio.removeEventListener('seeked', onSeeked),
      () => audio.removeEventListener('stalled', onStalled),
      () => audio.removeEventListener('playing', onPlaying),
      () => audio.removeEventListener('canplay', onCanPlay),
      () => audio.removeEventListener('error', onError),
      () => audio.removeEventListener('progress', onProgress),
    ];
  }

  /**
   * Heuristic for a false `ended` event: the browser believes playback reached
   * the end of the resource, but the timeline is suspiciously short relative
   * to the API-known track duration. Either the browser mis-parsed a VBR /
   * lossy container over a Range response, or the server handed us a
   * corrupt/transcoded-too-short file.
   */
  private isFalseEnded(audio: HTMLAudioElement): boolean {
    const t = audio.currentTime;
    const d = audio.duration;
    if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return false;
    const known = untracked(() => this.player.currentTrack()?.duration ?? 0);
    if (known > 0) {
      if (t < known * 0.7) return true;
      if (Math.abs(d - known) > 5 && d < known * 0.9) return true;
      return false;
    }
    // No API-known duration to compare against (issue #234 — a scan that
    // couldn't read tag duration, or an untagged acquisition). Fall back to
    // the absolute floor rather than skipping the check entirely.
    return t < FALSE_ENDED_ABSOLUTE_FLOOR_SEC && d < FALSE_ENDED_ABSOLUTE_FLOOR_SEC;
  }

  /** The timer handle for the false-ended recovery fallback (5 s). */
  private recoveryTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Begin the false-ended recovery flow: pause the audio element, surface
   * the buffering indicator, and wait for a real `durationchange` (or
   * `canplay` with a sane duration) so we can resume from the correct
   * position. If nothing arrives within 5 s, the server response is
   * probably genuinely short/corrupt — give up waiting and seek to 0 +
   * play so the user isn't stuck.
   */
  private startRecovery(audio: HTMLAudioElement, boundGen: number): void {
    if (this.player.recoveryState() === 'awaiting-duration') return; // already recovering
    this.player.recoveryState.set('awaiting-duration');
    this.player.setBuffering(true);
    if (this.recoveryTimeout !== null) clearTimeout(this.recoveryTimeout);
    this.recoveryTimeout = setTimeout(() => {
      if (boundGen !== this.loadGeneration) return;
      this.recoveryTimeout = null;
      this.player.recoveryState.set('normal');
      this.player.setBuffering(false);
      audio.currentTime = 0;
      if (this.player.isPlaying()) {
        audio.play().catch((err) => {
          if (err.name === 'NotAllowedError') this.handlePlayRejection();
        });
      }
    }, 5000);
  }

  ngOnDestroy(): void {
    this.audioListenerCleanups.forEach((fn) => fn());
    if (this.backgroundPauseTimer !== null) clearTimeout(this.backgroundPauseTimer);
    if (this.recoveryTimeout !== null) {
      clearTimeout(this.recoveryTimeout);
      this.recoveryTimeout = null;
    }
    if (this.progressReportInterval) clearInterval(this.progressReportInterval);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.releaseWakeLock();
    if (this.visibilityChangeHandler) {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
    }
  }

  handlePlayPause(): void {
    if (this.isActiveDevice()) {
      if (this.player.isPlaying()) this.player.pause();
      else this.player.resume();
    } else {
      this.ws.sendCommand(this.remote.remoteIsPlaying() ? 'PAUSE' : 'PLAY');
    }
  }

  handleNext(): void {
    if (this.isActiveDevice()) this.player.playNext();
    else this.ws.sendCommand('NEXT');
  }

  handlePrev(): void {
    const audio = this.audioEl()?.nativeElement;
    if (this.isActiveDevice()) {
      if (audio && audio.currentTime > 3) {
        audio.currentTime = 0;
      } else {
        this.player.playPrev();
      }
    } else {
      this.ws.sendCommand('PREV');
    }
  }

  // Seek commit from app-seek-bar (native range — see SeekBarComponent for why
  // a range input replaced the old div + pointer-math that kept regressing on
  // Firefox). Fires once on release: scrub locally for the active device, or
  // forward a SEEK command to the remote device.
  onSeek(time: number): void {
    const audio = this.audioEl()?.nativeElement;
    if (this.isActiveDevice() && audio) {
      audio.currentTime = time;
    } else {
      this.ws.sendCommand('SEEK', { position: time });
      this.remote.setRemoteProgress(time, this.safeDuration());
    }
  }

  // Open is tap/swipe-up driven, not live-follow: the 64px mini bar is too short
  // to meaningfully follow a finger, and the Now Playing sheet lives in a separate
  // component. Live-follow is reserved for the dismiss drag (now-playing.component).
  private static readonly OPEN_THRESHOLD_PX = 40;
  private static readonly TAP_TOLERANCE_PX = 10;

  // The bar itself does not move during the gesture; we only track start→end
  // displacement to distinguish a tap / swipe-up (open Now Playing) from a scroll.
  private readonly barDrag = createPointerDrag({
    onMove: (event, start) => {
      // Commit the open the moment an upward swipe crosses the threshold rather
      // than waiting for pointerup: on touch the browser can reclaim a vertical
      // pan and fire pointercancel before pointerup, so the old end-only check
      // dropped real swipes. Idempotent — set(true) is a no-op once open.
      if (start.clientY - event.clientY > PlayerComponent.OPEN_THRESHOLD_PX) {
        this.player.setNowPlayingOpen(true);
      }
    },
    onEnd: (event, start) => {
      const deltaY = event.clientY - start.clientY;
      if (Math.abs(deltaY) <= PlayerComponent.TAP_TOLERANCE_PX) {
        this.player.setNowPlayingOpen(true);
      }
    },
  });

  onBarPointerDown(event: PointerEvent): void {
    // Don't hijack control buttons or the desktop seek bar.
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('[data-seek]')) return;
    this.barDrag.start(event);
  }

  unblockAutoplay(): void {
    const audio = this.audioEl()?.nativeElement;
    if (audio) {
      audio
        .play()
        .then(() => this.player.setAutoplayBlocked(false))
        .catch(() => {});
    }
  }

  formatTime(s: number): string {
    return formatTime(s);
  }
}
