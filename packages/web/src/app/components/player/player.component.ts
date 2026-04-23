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
import { Router } from '@angular/router';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { DeviceSwitcherComponent } from '../device-switcher/device-switcher.component';
import { PreserveService } from '../../services/preserve.service';
import * as db from '../../lib/preserve-store';

/** Returns the router commands to navigate to an artist page, or to /library as fallback. */
export function resolveArtistRoute(artistId: string | undefined): string[] {
  return artistId ? ['/library/artists', artistId] : ['/library'];
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

@Component({
  selector: 'app-player',
  imports: [CoverArtComponent, DeviceSwitcherComponent],
  templateUrl: './player.component.html',
  })
export class PlayerComponent implements AfterViewInit, OnDestroy {
  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  private remote = inject(RemotePlaybackService);
  private ws = inject(PlaybackWsService);
  private router = inject(Router);
  private zone = inject(NgZone);
  private preserve = inject(PreserveService);

  private audioEl = viewChild<ElementRef<HTMLAudioElement>>('audioEl');

  private pausingByStore = false;
  private progressReportInterval: ReturnType<typeof setInterval> | null = null;
  private rafId: number | null = null;

  // Playback progress interpolation
  private interpolatedTime = signal(0);

  readonly isActiveDevice = this.remote.isActiveDevice;

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

  readonly progressPercent = computed(() => {
    const d = this.safeDuration();
    return d > 0 ? Math.max(0, Math.min(100, (this.safeProgress() / d) * 100)) : 0;
  });

  readonly showPlaying = computed(() => {
    return this.isActiveDevice() ? this.player.isPlaying() : this.remote.remoteIsPlaying();
  });

  // Event listener teardown references
  private audioListenerCleanups: (() => void)[] = [];

  constructor() {
    // Effect 1: Load track (checks IndexedDB first for offline-preserved tracks)
    effect((onCleanup) => {
      const track = this.player.currentTrack();
      const token = this.auth.token();
      const isActive = this.isActiveDevice();
      const audio = this.audioEl()?.nativeElement;
      if (!audio) return;

      let objectUrl: string | null = null;
      onCleanup(() => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      });

      if (!isActive) {
        this.pausingByStore = true;
        audio.pause();
        this.pausingByStore = false;
        audio.src = '';
        return;
      }

      if (track) {
        this.player.setCurrentTime(0);
        this.player.setDuration(track.duration ?? 0);

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
              audio.src = `/api/stream/${track.id}?token=${token}`;
            }
            audio.play().catch((err) => {
              if (err.name === 'NotAllowedError') this.player.setAutoplayBlocked(true);
            });
          })();
        } else {
          audio.src = `/api/stream/${track.id}?token=${token}`;
          audio.play().catch((err) => {
            if (err.name === 'NotAllowedError') this.player.setAutoplayBlocked(true);
          });
        }
      } else {
        this.pausingByStore = true;
        audio.pause();
        this.pausingByStore = false;
        audio.src = '';
        this.player.setCurrentTime(0);
        this.player.setDuration(0);
      }
    });

    // Effect 2: Media Session metadata
    effect(() => {
      const track = this.player.currentTrack();
      const token = this.auth.token();
      if (!('mediaSession' in navigator)) return;

      if (!track) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
        return;
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album ?? '',
        artwork: track.coverArt
          ? [
              { src: `/api/cover/${track.coverArt}?size=96&token=${token}`, sizes: '96x96', type: 'image/jpeg' },
              { src: `/api/cover/${track.coverArt}?size=256&token=${token}`, sizes: '256x256', type: 'image/jpeg' },
              { src: `/api/cover/${track.coverArt}?size=512&token=${token}`, sizes: '512x512', type: 'image/jpeg' },
            ]
          : [],
      });
    });

    // Effect 3: Media Session playback state
    effect(() => {
      const playing = this.player.isPlaying();
      if (!('mediaSession' in navigator)) return;
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    });

    // Effect 4: Media Session action handlers
    effect(() => {
      const queue = this.player.queue();
      const history = this.player.history();
      const repeat = this.player.repeat();
      if (!('mediaSession' in navigator)) return;

      const canGoNext = queue.length > 0 || repeat === 'all' || repeat === 'one';
      const canGoPrev = history.length > 0;

      navigator.mediaSession.setActionHandler('play', () => this.player.resume());
      navigator.mediaSession.setActionHandler('pause', () => this.player.pause());
      navigator.mediaSession.setActionHandler(
        'nexttrack',
        canGoNext ? () => this.player.playNext() : null,
      );
      navigator.mediaSession.setActionHandler(
        'previoustrack',
        canGoPrev
          ? () => {
              const audio = this.audioEl()?.nativeElement;
              if (audio && audio.currentTime > 3) {
                audio.currentTime = 0;
              } else {
                this.player.playPrev();
              }
            }
          : null,
      );
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) this.player.seek(details.seekTime);
      });
      navigator.mediaSession.setActionHandler('seekforward', () => {
        this.player.seek(this.player.currentTime() + 10);
      });
      navigator.mediaSession.setActionHandler('seekbackward', () => {
        this.player.seek(Math.max(0, this.player.currentTime() - 10));
      });
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
        return;
      }
      if (playing) {
        audio.play().catch((err) => {
          if (err.name === 'NotAllowedError') this.player.setAutoplayBlocked(true);
        });
      } else {
        this.pausingByStore = true;
        audio.pause();
        this.pausingByStore = false;
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

  ngAfterViewInit(): void {
    const audio = this.audioEl()?.nativeElement;
    if (!audio) return;

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
    };
    const onDuration = () => {
      const value = audio.duration;
      if (Number.isFinite(value) && value > 0) this.player.setDuration(value);
    };
    const onEnded = () => this.player.playNext();
    const onPlay = () => {
      this.player.setAutoplayBlocked(false);
      if (!this.player.isPlaying()) {
        this.player.resume();
      }
    };
    const onPause = () => {
      if (this.pausingByStore) return;
      if (this.player.isPlaying()) {
        this.player.pause();
      }
    };

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onDuration);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    this.audioListenerCleanups = [
      () => audio.removeEventListener('timeupdate', onTime),
      () => audio.removeEventListener('loadedmetadata', onDuration),
      () => audio.removeEventListener('durationchange', onDuration),
      () => audio.removeEventListener('ended', onEnded),
      () => audio.removeEventListener('play', onPlay),
      () => audio.removeEventListener('pause', onPause),
    ];
  }

  ngOnDestroy(): void {
    this.audioListenerCleanups.forEach((fn) => fn());
    if (this.progressReportInterval) clearInterval(this.progressReportInterval);
    if (this.rafId) cancelAnimationFrame(this.rafId);
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

  handleSeek(event: MouseEvent): void {
    const audio = this.audioEl()?.nativeElement;
    const safeDur = this.safeDuration();
    if (!safeDur) return;

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (!rect.width) return;
    const pct = (event.clientX - rect.left) / rect.width;
    const newTime = Math.max(0, Math.min(1, pct)) * safeDur;

    if (this.isActiveDevice() && audio) {
      audio.currentTime = newTime;
    } else {
      this.ws.sendCommand('SEEK', { position: newTime });
      this.remote.setRemoteProgress(newTime, safeDur);
    }
  }

  openNowPlaying(event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('button')) return;
    this.player.setNowPlayingOpen(true);
  }

  navigateToArtist(event: MouseEvent): void {
    event.stopPropagation();
    const track = this.player.currentTrack();
    if (!track) return;
    this.router.navigate(resolveArtistRoute(track.artistId));
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
