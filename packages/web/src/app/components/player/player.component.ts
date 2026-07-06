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
    return Number.isFinite(t) && t >= 0 ? Math.min(t, d || t) : 0;
  });

  readonly showPlaying = computed(() => {
    return this.isActiveDevice() ? this.player.isPlaying() : this.remote.remoteIsPlaying();
  });

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
              audio.src = this.server.apiUrl(`/api/stream/${track.id}?token=${token}`);
            }
            audio.play().catch((err) => {
              if (err.name === 'NotAllowedError') this.handlePlayRejection();
            });
          })();
        } else {
          audio.src = this.server.apiUrl(`/api/stream/${track.id}?token=${token}`);
          audio.play().catch((err) => {
            if (err.name === 'NotAllowedError') this.handlePlayRejection();
          });
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

    const onTime = () => {
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
                standby.src = this.server.apiUrl(
                  `/api/stream/${nextTrack.id}?token=${this.auth.token()}`,
                );
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
      const value = audio.duration;
      if (Number.isFinite(value) && value > 0) {
        this.player.setDuration(value);
        if (this.player.restoredTime !== null) {
          audio.currentTime = this.player.restoredTime;
          this.player.restoredTime = null;
        }
      }
    };

    const onEnded = () => {
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
                } else {
                  audio.src = this.server.apiUrl(`/api/stream/${nextTrack.id}?token=${token}`);
                }
                playNext();
              });
            } else {
              audio.src = this.server.apiUrl(`/api/stream/${nextTrack.id}?token=${token}`);
              playNext();
            }
          }
        }
        this.player.playNext();
      }
    };

    const onPlay = () => {
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

    const onWaiting = () => this.player.setBuffering(true);
    const onSeeking = () => this.player.setBuffering(true);
    // stalled also fires on harmless network hiccups while plenty is buffered —
    // only treat it as buffering when playback genuinely can't proceed.
    const onStalled = () => {
      if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) this.player.setBuffering(true);
    };
    const onPlaying = () => this.player.setBuffering(false);
    const onCanPlay = () => this.player.setBuffering(false);
    const onError = () => this.player.setBuffering(false);
    const onProgress = () => {
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
      () => audio.removeEventListener('stalled', onStalled),
      () => audio.removeEventListener('playing', onPlaying),
      () => audio.removeEventListener('canplay', onCanPlay),
      () => audio.removeEventListener('error', onError),
      () => audio.removeEventListener('progress', onProgress),
    ];
  }

  ngOnDestroy(): void {
    this.audioListenerCleanups.forEach((fn) => fn());
    if (this.backgroundPauseTimer !== null) clearTimeout(this.backgroundPauseTimer);
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
