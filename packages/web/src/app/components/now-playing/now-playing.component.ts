import { Component, inject, signal, computed, effect, ElementRef, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { DeviceSwitcherComponent } from '../device-switcher/device-switcher.component';
import { TrackContextMenuComponent } from '../track-context-menu/track-context-menu.component';
import { TrackInfoSheetComponent } from '../track-info-sheet/track-info-sheet.component';
import { resolveArtistTarget } from '../../lib/route-utils';
import { LibraryApiService } from '../../services/api/library-api.service';
import { parseLrc, findActiveLine } from '../../lib/lrc-parser';
import type { LyricsDto } from '@nicotind/core';
import { firstValueFrom } from 'rxjs';
import { createPointerDrag } from '../../lib/pointer-drag';
import { ScrollLockService } from '../../services/scroll-lock.service';
import { SeekBarComponent } from '../seek-bar/seek-bar.component';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { ArtistLinksComponent } from '../artist-links/artist-links.component';
import { ServerConfigService } from '../../services/server-config.service';
import {
  computePaletteFromPixels,
  scrollToActiveLine,
  DEFAULT_PALETTE,
  type CoverPalette,
} from '../../lib/cover-colors';

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

@Component({
  selector: 'app-now-playing',
  imports: [
    DeviceSwitcherComponent,
    TrackContextMenuComponent,
    TrackInfoSheetComponent,
    SeekBarComponent,
    CoverArtComponent,
    ArtistLinksComponent,
  ],
  templateUrl: './now-playing.component.html',
})
export class NowPlayingComponent {
  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  readonly remote = inject(RemotePlaybackService);
  private ws = inject(PlaybackWsService);
  private router = inject(Router);
  private api = inject(LibraryApiService);
  private scrollLock = inject(ScrollLockService);
  private server = inject(ServerConfigService);

  // Context menu state
  readonly contextMenu = signal<{ x: number; y: number } | null>(null);

  // Track info sheet state
  readonly trackInfoSongId = signal<string | null>(null);

  // Lyrics view state. Lyrics load lazily on first open and reload when the
  // track changes while the panel is open.
  readonly lyricsOpen = signal(false);
  readonly lyrics = signal<LyricsDto | null>(null);
  readonly lyricsLoading = signal(false);
  private lyricsLoadedForId = signal<string | null>(null);
  /** Parsed synced LRC lines (empty when the lyrics are plain-only). */
  readonly lyricLines = computed(() => parseLrc(this.lyrics()?.synced));
  /** Index of the line to highlight for the current playback position. */
  readonly activeLine = computed(() => findActiveLine(this.lyricLines(), this.displayTime() * 1000));
  /** Plain text fallback when there are no synced lines. */
  readonly plainLyrics = computed(() => this.lyrics()?.plain ?? '');

  // Fullscreen karaoke mode
  readonly karaokeMode = signal(false);
  /** Dominant colors extracted from the current track's cover art. */
  readonly coverColors = signal<CoverPalette>(DEFAULT_PALETTE);
  /** Reference to the karaoke lyrics scroll container for auto-scroll. */
  readonly karaokeLyricsRef = viewChild<ElementRef<HTMLElement>>('karaokeLyrics');
  private colorExtractedForId: string | null = null;

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

  readonly showPlaying = computed(() => {
    return this.isActiveDevice() ? this.player.isPlaying() : this.remote.remoteIsPlaying();
  });

  readonly showBuffering = computed(() => this.isActiveDevice() && this.player.bufferingVisible());

  // Live-follow dismiss gesture: the sheet tracks the finger downward and
  // snaps closed past DISMISS_THRESHOLD_PX, otherwise springs back open.
  readonly dragOffsetPx = signal(0);
  private static readonly DISMISS_THRESHOLD_PX = 120;
  private readonly sheetDrag = createPointerDrag({
    // Downward only — dragging up past the open position is a no-op.
    onMove: (event, start) => this.dragOffsetPx.set(Math.max(0, event.clientY - start.clientY)),
    onEnd: () => {
      if (this.dragOffsetPx() > NowPlayingComponent.DISMISS_THRESHOLD_PX) {
        this.player.setNowPlayingOpen(false);
      }
      this.dragOffsetPx.set(0);
    },
  });
  readonly dragging = this.sheetDrag.dragging;

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

    // Lock the document while the full-screen sheet is actually on screen (open
    // AND a track exists — clear() drops the track without touching the open
    // flag, and the template gates on currentTrack). Prevents the backgrounded
    // page from scrolling/overscrolling behind the sheet. onCleanup releases the
    // lock when it closes or the component is destroyed.
    effect((onCleanup) => {
      if (this.player.nowPlayingOpen() && this.player.currentTrack() !== null) {
        this.scrollLock.lock();
        onCleanup(() => this.scrollLock.unlock());
      }
    });

    // Lazily (re)load lyrics whenever the panel is open and the track changes.
    effect(() => {
      if (!this.lyricsOpen() && !this.karaokeMode()) return;
      const id = this.player.currentTrack()?.id ?? null;
      if (!id || id === this.lyricsLoadedForId()) return;
      this.loadLyrics(id);
    });

    // Extract cover colors when karaoke mode is active and the track changes.
    effect(() => {
      const track = this.player.currentTrack();
      if (!track?.coverArt) return;
      // Only extract if karaoke mode is on or lyrics panel is open
      if (!this.karaokeMode() && !this.lyricsOpen()) return;
      if (this.colorExtractedForId === track.id) return;
      this.colorExtractedForId = track.id;
      const token = this.auth.token();
      const url = this.server.apiUrl(`/api/cover/${track.coverArt}?size=80&token=${token}`);
      this.extractColorsFromImage(url);
    });

    // Auto-scroll karaoke lyrics to the active line.
    effect(() => {
      const active = this.activeLine();
      if (!this.karaokeMode() || active < 0) return;
      const container = this.karaokeLyricsRef()?.nativeElement;
      if (!container) return;
      scrollToActiveLine(container, active);
    });
  }

  toggleLyrics(): void {
    this.lyricsOpen.update((v) => !v);
  }

  toggleKaraokeMode(): void {
    const entering = !this.karaokeMode();
    this.karaokeMode.set(entering);
    if (entering) {
      // Ensure lyrics are loaded and open
      if (!this.lyricsOpen()) this.lyricsOpen.set(true);
      // Re-extract colors if needed
      const track = this.player.currentTrack();
      if (track?.coverArt && this.colorExtractedForId !== track.id) {
        this.colorExtractedForId = track.id;
        const token = this.auth.token();
        const url = this.server.apiUrl(`/api/cover/${track.coverArt}?size=80&token=${token}`);
        this.extractColorsFromImage(url);
      }
    }
  }

  /**
   * Load a cover image into a tiny offscreen canvas and derive a karaoke
   * gradient from its pixels. This is just the DOM shell — the pixel→palette
   * math lives in the pure, unit-tested computePaletteFromPixels().
   */
  private extractColorsFromImage(src: string): void {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const size = 40; // downscale for fast sampling
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        this.coverColors.set(computePaletteFromPixels(data));
      } catch {
        // CORS or canvas error — use defaults
        this.coverColors.set(DEFAULT_PALETTE);
      }
    };
    img.onerror = () => {
      this.coverColors.set(DEFAULT_PALETTE);
    };
    img.src = src;
  }

  private loadLyrics(id: string): void {
    this.lyricsLoadedForId.set(id);
    this.lyrics.set(null);
    this.lyricsLoading.set(true);
    this.api.getLyrics(id).subscribe({
      next: (l) => {
        // Auto-fetch on first view when nothing is stored yet.
        if (l) {
          this.lyrics.set(l);
          this.lyricsLoading.set(false);
        } else {
          this.api.fetchLyrics(id).subscribe({
            next: (f) => {
              this.lyrics.set(f);
              this.lyricsLoading.set(false);
            },
            error: () => this.lyricsLoading.set(false),
          });
        }
      },
      error: () => this.lyricsLoading.set(false),
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

  // Seek commit from app-seek-bar (native range — reliable click/drag/touch/
  // keyboard across browsers; see SeekBarComponent). Fires once on release.
  onSeek(time: number): void {
    if (this.isActiveDevice()) {
      this.player.seek(time);
    } else {
      this.ws.sendCommand('SEEK', { position: time });
      this.remote.setRemoteProgress(time, this.safeDuration());
    }
  }

  jumpToTrack(index: number): void {
    const queue = this.player.queue();
    const track = queue[index];
    if (track) this.player.play(track);
  }

  onSheetDragStart(event: PointerEvent): void {
    this.sheetDrag.start(event);
  }

  async navigateToArtist(): Promise<void> {
    const track = this.player.currentTrack();
    if (!track) return;
    this.player.setNowPlayingOpen(false);
    // A track played from a network result has no artistId — resolve by name so
    // the link still lands on the real artist page when they exist locally.
    const target = await resolveArtistTarget(track, (name) =>
      firstValueFrom(this.api.resolveArtistIdByName(name)),
    );
    void this.router.navigate(target);
  }

  onTitleContextMenu(event: MouseEvent): void {
    event.preventDefault();
    this.contextMenu.set({ x: event.clientX, y: event.clientY });
  }

  onOpenTrackInfo(songId: string): void {
    this.contextMenu.set(null);
    this.trackInfoSongId.set(songId);
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
