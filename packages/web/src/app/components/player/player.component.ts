import {
  Component,
  inject,
  signal,
  computed,
  effect,
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

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

@Component({
  selector: 'app-player',
  imports: [CoverArtComponent, DeviceSwitcherComponent],
  template: `
    <audio #audioEl></audio>
    <div [class]="'fixed bottom-0 left-0 right-0 bg-theme-surface border-t border-theme z-50 transition-transform duration-300 ease-out ' +
      (player.currentTrack() ? 'translate-y-0' : 'translate-y-full')">

      <!-- Autoplay blocked banner -->
      @if (player.autoplayBlocked()) {
        <div
          class="absolute inset-0 bg-theme-surface/95 flex items-center justify-center z-10 cursor-pointer"
          (click)="unblockAutoplay()"
        >
          <div class="flex items-center gap-3 px-4">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-amber-400 flex-shrink-0">
              <circle cx="12" cy="12" r="10" />
              <polygon points="10,8 16,12 10,16" fill="currentColor" />
            </svg>
            <span class="text-sm text-theme-secondary">Tap here to start playback</span>
          </div>
        </div>
      }

      <!-- Clickable area to open Now Playing -->
      <div
        class="flex items-center px-3 md:px-4 gap-2 md:gap-4 h-16 cursor-pointer"
        (click)="openNowPlaying($event)"
      >
        <!-- Track info -->
        <div class="flex items-center gap-3 min-w-0 flex-shrink md:w-60 md:flex-shrink-0">
          @if (player.currentTrack(); as track) {
            <app-cover-art
              [src]="track.coverArt ? '/api/cover/' + track.coverArt + '?size=80&token=' + auth.token() : undefined"
              [artist]="track.artist"
              [album]="track.album ?? ''"
              [size]="40"
              rounded="rounded"
            />
          }
          <div class="min-w-0">
            <p class="text-sm font-medium text-theme-primary truncate">{{ player.currentTrack()?.title }}</p>
            <p
              class="text-xs text-theme-secondary truncate cursor-pointer hover:underline hover:text-theme-primary transition"
              (click)="navigateToArtist($event)"
            >
              {{ player.currentTrack()?.artist }}
            </p>
          </div>
          <!-- TODO: PreserveButton goes here (Phase 5) -->
        </div>

        <!-- Controls -->
        <div class="flex-1 flex flex-col items-center gap-1">
          <div class="flex items-center gap-2 md:gap-3">
            <!-- Shuffle - desktop only -->
            <button
              (click)="player.toggleShuffle()"
              [class]="'hidden md:flex w-7 h-7 items-center justify-center rounded-full transition ' +
                (player.shuffle() ? 'text-emerald-400' : 'text-theme-muted hover:text-theme-secondary')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 3h5v5" />
                <path d="M4 20 21 3" />
                <path d="M21 16v5h-5" />
                <path d="M15 15l6 6" />
                <path d="M4 4l5 5" />
              </svg>
            </button>

            <!-- Previous -->
            <button
              (click)="handlePrev()"
              class="w-7 h-7 flex items-center justify-center text-theme-secondary hover:text-theme-primary transition"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="5" width="3" height="14" />
                <polygon points="21,5 9,12 21,19" />
              </svg>
            </button>

            <!-- Play/Pause -->
            <button
              (click)="handlePlayPause()"
              class="w-8 h-8 rounded-full bg-zinc-100 text-zinc-900 flex items-center justify-center hover:bg-zinc-200 transition"
            >
              @if (showPlaying()) {
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
                </svg>
              } @else {
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5,3 19,12 5,21" />
                </svg>
              }
            </button>

            <!-- Next -->
            <button
              (click)="handleNext()"
              class="w-7 h-7 flex items-center justify-center text-theme-secondary hover:text-theme-primary transition"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="3,5 15,12 3,19" />
                <rect x="18" y="5" width="3" height="14" />
              </svg>
            </button>

            <!-- Repeat - desktop only -->
            <button
              (click)="player.cycleRepeat()"
              [class]="'hidden md:flex w-7 h-7 items-center justify-center rounded-full transition relative ' +
                (player.repeat() !== 'off' ? 'text-emerald-400' : 'text-theme-muted hover:text-theme-secondary')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 2l4 4-4 4" />
                <path d="M3 11v-1a4 4 0 014-4h14" />
                <path d="M7 22l-4-4 4-4" />
                <path d="M21 13v1a4 4 0 01-4 4H3" />
              </svg>
              @if (player.repeat() === 'one') {
                <span class="absolute -top-1 -right-1 text-[9px] font-bold text-emerald-400">1</span>
              }
            </button>
          </div>

          <!-- Progress bar (desktop) -->
          <div class="hidden md:flex items-center gap-2 w-full max-w-md">
            <span class="text-xs text-theme-muted w-10 text-right">{{ formatTime(safeProgress()) }}</span>
            <div class="flex-1 h-1 bg-theme-surface-2 rounded-full cursor-pointer" (click)="handleSeek($event)">
              <div
                class="h-full bg-theme-secondary rounded-full transition-all"
                [style.width.%]="progressPercent()"
              ></div>
            </div>
            <span class="text-xs text-theme-muted w-10">{{ formatTime(safeDuration()) }}</span>
          </div>
        </div>

        <!-- Right side: device switcher -->
        <div class="flex items-center justify-end flex-shrink-0">
          <app-device-switcher />
        </div>
      </div>

      <!-- Mobile progress bar -->
      <div class="md:hidden h-0.5 bg-theme-surface-2">
        <div
          class="h-full bg-theme-secondary transition-all"
          [style.width.%]="progressPercent()"
        ></div>
      </div>
    </div>
  `,
})
export class PlayerComponent implements AfterViewInit, OnDestroy {
  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  private remote = inject(RemotePlaybackService);
  private ws = inject(PlaybackWsService);
  private router = inject(Router);
  private zone = inject(NgZone);

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
    // Effect 1: Load track
    effect(() => {
      const track = this.player.currentTrack();
      const token = this.auth.token();
      const isActive = this.isActiveDevice();
      const audio = this.audioEl()?.nativeElement;
      if (!audio) return;

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
        audio.src = `/api/stream/${track.id}?token=${token}`;
        audio.play().catch((err) => {
          if (err.name === 'NotAllowedError') this.player.setAutoplayBlocked(true);
        });
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
    if (track) {
      this.router.navigate(['/'], { queryParams: { q: track.artist } });
    }
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
