import {
  Component,
  inject,
  signal,
  computed,
  effect,
} from '@angular/core';
import { Router } from '@angular/router';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { DeviceSwitcherComponent } from '../device-switcher/device-switcher.component';
import { resolveArtistRoute } from '../player/player.component';

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

@Component({
  selector: 'app-now-playing',
  imports: [DeviceSwitcherComponent],
  templateUrl: './now-playing.component.html',
  })
export class NowPlayingComponent {
  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  private remote = inject(RemotePlaybackService);
  private ws = inject(PlaybackWsService);
  private router = inject(Router);

  // Context menu state stub
  private contextMenu = signal<{ x: number; y: number } | null>(null);

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

  constructor() {
    // Remote playback interpolation (rAF loop)
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
    if (this.isActiveDevice()) {
      this.player.playPrev();
    } else {
      this.ws.sendCommand('PREV');
    }
  }

  handleSeek(event: MouseEvent): void {
    const safeDur = this.safeDuration();
    if (!safeDur) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (!rect.width) return;
    const pct = (event.clientX - rect.left) / rect.width;
    const newTime = Math.max(0, Math.min(1, pct)) * safeDur;

    if (this.isActiveDevice()) {
      this.player.seek(newTime);
    } else {
      this.ws.sendCommand('SEEK', { position: newTime });
      this.remote.setRemoteProgress(newTime, safeDur);
    }
  }

  jumpToTrack(index: number): void {
    const queue = this.player.queue();
    const track = queue[index];
    if (track) this.player.play(track);
  }

  navigateToArtist(): void {
    const track = this.player.currentTrack();
    if (!track) return;
    this.player.setNowPlayingOpen(false);
    this.router.navigate(resolveArtistRoute(track.artistId));
  }

  onTitleContextMenu(event: MouseEvent): void {
    event.preventDefault();
    // TODO: Wire up TrackContextMenu (Phase 5)
    this.contextMenu.set({ x: event.clientX, y: event.clientY });
  }

  unblockAutoplay(): void {
    const audio = document.querySelector('audio');
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
