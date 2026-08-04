import { Component, inject, signal, computed, effect, viewChild, DestroyRef } from '@angular/core';
import { Router } from '@angular/router';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { NowPlayingHeaderComponent } from './now-playing-header/now-playing-header.component';
import { NowPlayingCoverArtComponent } from './now-playing-cover-art/now-playing-cover-art.component';
import { NowPlayingTransportComponent } from './now-playing-transport/now-playing-transport.component';
import { NowPlayingPanelTabsComponent } from './now-playing-panel-tabs/now-playing-panel-tabs.component';
import { NowPlayingQueuePanelComponent } from './now-playing-queue-panel/now-playing-queue-panel.component';
import { NowPlayingLyricsPanelComponent } from './now-playing-lyrics-panel/now-playing-lyrics-panel.component';
import { NowPlayingKaraokeFullscreenComponent } from './now-playing-karaoke-fullscreen/now-playing-karaoke-fullscreen.component';
import { TrackContextMenuComponent } from '../track-context-menu/track-context-menu.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TrackInfoService } from '../../services/track-info.service';
import { resolveArtistTarget } from '../../lib/route-utils';
import { LibraryApiService } from '../../services/api/library-api.service';
import { parseLrc, findActiveLine } from '../../lib/lrc-parser';
import type { LyricsDto } from '@nicotind/core';
import { firstValueFrom } from 'rxjs';
import { createPointerDrag } from '../../lib/pointer-drag';
import { ScrollLockService } from '../../services/scroll-lock.service';
import { ServerConfigService } from '../../services/server-config.service';
import { isTvUi } from '../../lib/platform';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import {
  computePaletteFromPixels,
  scrollToActiveLine,
  DEFAULT_PALETTE,
  type CoverPalette,
} from '../../lib/cover-colors';
import { resolveLyricsScrollContainer } from '../../lib/lyrics-scroll-container';

@Component({
  selector: 'app-now-playing',
  imports: [
    NowPlayingHeaderComponent,
    NowPlayingCoverArtComponent,
    NowPlayingTransportComponent,
    NowPlayingPanelTabsComponent,
    NowPlayingQueuePanelComponent,
    NowPlayingLyricsPanelComponent,
    NowPlayingKaraokeFullscreenComponent,
    TrackContextMenuComponent,
    TranslatePipe,
    TvNavGroupDirective,
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
  private destroyRef = inject(DestroyRef);
  readonly trackInfo = inject(TrackInfoService);

  // Context menu state
  readonly contextMenu = signal<{ x: number; y: number } | null>(null);

  // Lyrics view state. Lyrics load lazily on first open and reload when the
  // track changes while the panel is open. `lyricsOpen`'s own declaration
  // lives further down (seeded from `activePanel`, see the comment there) —
  // field initialization order matters in JS/TS class bodies, and
  // `activePanel` must already be assigned before `lyricsOpen`'s initializer
  // runs.
  readonly lyrics = signal<LyricsDto | null>(null);
  readonly lyricsLoading = signal(false);
  /** True after a source *failed* (vs a confident no-match) — offer a retry. */
  readonly lyricsError = signal(false);
  /** True while a manual (button-triggered) fetch is in flight. */
  readonly fetchingLyrics = signal(false);
  private lyricsLoadedForId = signal<string | null>(null);
  /** Parsed synced LRC lines (empty when the lyrics are plain-only). */
  readonly lyricLines = computed(() => parseLrc(this.lyrics()?.synced));
  /** Index of the line to highlight for the current playback position. */
  readonly activeLine = computed(() =>
    findActiveLine(this.lyricLines(), this.displayTime() * 1000),
  );
  /** Plain text fallback when there are no synced lines. */
  readonly plainLyrics = computed(() => this.lyrics()?.plain ?? '');
  /** Whether the current track has lyrics loaded (drives the tab-switcher dot).
   *  Gated on `lyricsLoadedForId` matching the current track — `lyrics()` is
   *  only cleared/reloaded when the lyrics panel is open (see the effects
   *  below), so without this gate switching tracks with the panel closed
   *  left `lyrics()` holding the PREVIOUS track's data and the dot showed a
   *  stale positive. This only reflects data that has actually been loaded
   *  for the current track — it does not proactively prefetch, so the dot
   *  stays off until the Lyrics tab has been opened at least once for this
   *  track (see docs/web-ui.md). */
  readonly hasLyrics = computed(() => {
    const track = this.player.currentTrack();
    if (!track || this.lyricsLoadedForId() !== track.id) return false;
    return !!this.lyrics()?.synced || !!this.lyrics()?.plain;
  });

  /** Current line's text for the fullscreen auto-follow (2-line) view. */
  readonly currentLineText = computed(() => this.lyricLines()[this.activeLine()]?.text ?? '');
  /** Next line's text, or null when the current line is the last one. */
  readonly nextLineText = computed(() => {
    const next = this.lyricLines()[this.activeLine() + 1];
    return next ? next.text : null;
  });

  // Fullscreen lyrics has two views: a 2-line auto-follow view (default, fits a
  // narrow TV/monitor without wrapping) and a manual-browse view (the full
  // scrolling list) entered by scrolling/swiping; tapping a line there seeks
  // and returns to auto-follow. `false` = auto-follow.
  readonly karaokeBrowsing = signal(false);
  private static readonly BROWSE_IDLE_MS = 4000;
  private browseIdleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Alternates on every activeLine change so the CSS keyframe animation
   *  restarts (changing the class name is what forces a replay). */
  readonly karaokeLineAnimClass = signal<'karaoke-line-anim-a' | 'karaoke-line-anim-b'>(
    'karaoke-line-anim-a',
  );

  // Fullscreen karaoke overlay (the in-place lyrics panel is always open when
  // lyricsOpen is true; this flag expands it to a gradient-covered immersive view).
  readonly karaokeFullscreen = signal(false);
  /** Dominant colors extracted from the current track's cover art. */
  readonly coverColors = signal<CoverPalette>(DEFAULT_PALETTE);
  /** The in-place lyrics panel child — its own `lyricsScrollRef` (an internal
   *  `#lyricsScroll` template ref) is re-exposed here so the shell's
   *  auto-scroll effect below can reach across the component boundary; this
   *  is the one place in the now-playing decomposition where a child's
   *  internal DOM ref must be reachable from the shell. */
  readonly lyricsPanel = viewChild(NowPlayingLyricsPanelComponent);
  /** Fullscreen karaoke overlay child — its `overlayRef` (an internal
   *  `#karaokeOverlay` template ref) is re-exposed here so it can be focused
   *  on entry (ArrowUp/ArrowDown work immediately for keyboard/TV-remote
   *  users with no prior click), mirroring `lyricsPanel()` above. */
  readonly karaokeFullscreenPanel = viewChild(NowPlayingKaraokeFullscreenComponent);
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

  // Manual queue resize: dragging the handle up shrinks the cover art and gives
  // the Now-Playing queue more room (the queue is flex-1, so shrinking the cover
  // grows it). `queueExtraHeightPx` is how many px the cover has shrunk from its
  // max; persisted per-device so the chosen size survives reload.
  private static readonly COVER_MAX_PX = 320; // matches Tailwind max-w-80 (20rem)
  private static readonly COVER_MIN_PX = 120;
  private static readonly QUEUE_EXTRA_MAX_PX =
    NowPlayingComponent.COVER_MAX_PX - NowPlayingComponent.COVER_MIN_PX;
  private static readonly QUEUE_EXTRA_STORAGE_KEY = 'nicotind:np-queue-extra';
  readonly queueExtraHeightPx = signal(this.readStoredQueueExtra());

  // Active panel (queue vs lyrics) persisted per-device.
  private static readonly ACTIVE_PANEL_STORAGE_KEY = 'nicotind:np-active-panel';
  readonly activePanel = signal<'queue' | 'lyrics'>(this.readStoredActivePanel());
  // Seeded from the restored `activePanel` (must be declared after it — see
  // the comment near `lyrics` above) so a page load that restores onto the
  // Lyrics tab has `lyricsOpen` already true: the lyrics-loading/color-
  // extraction/auto-scroll effects below all gate on `lyricsOpen()`, and
  // without this seed a restored Lyrics tab rendered an incorrect "no
  // lyrics" empty state until the user re-clicked the tab.
  readonly lyricsOpen = signal(this.activePanel() === 'lyrics');

  /** Cover art max-width (px), shrinking as the queue is dragged taller. */
  readonly coverMaxPx = computed(
    () => NowPlayingComponent.COVER_MAX_PX - this.queueExtraHeightPx(),
  );

  /** TV player treatment (10-foot layout): blurred-cover backdrop, bottom
   *  transport bar, Next-up chip instead of the stacked queue/lyrics panels.
   *  Reads the root class (not the build env) so e2e can exercise it. */
  readonly isTv = isTvUi();

  /** The blurred sheet backdrop on TV — same cover endpoint the art uses;
   *  null (no backdrop) when the track has no cover. */
  readonly tvBackdropUrl = computed(() => {
    const track = this.player.currentTrack();
    if (!this.isTv || !track?.coverArt) return null;
    return this.server.apiUrl(`/api/cover/${track.coverArt}?size=600&token=${this.auth.token()}`);
  });

  /** Head of the queue, shown in the TV Next-up chip. */
  readonly nextUp = computed(() => this.player.queue()[0] ?? null);
  private queueResizeStartExtra = 0;
  private readonly queueResizeDrag = createPointerDrag({
    onStart: () => {
      this.queueResizeStartExtra = this.queueExtraHeightPx();
    },
    // Drag up (clientY decreases) → grow the queue / shrink the cover.
    onMove: (event, start) => {
      const delta = start.clientY - event.clientY;
      this.queueExtraHeightPx.set(this.clampQueueExtra(this.queueResizeStartExtra + delta));
    },
    onEnd: () => this.persistQueueExtra(this.queueExtraHeightPx()),
  });
  readonly resizingQueue = this.queueResizeDrag.dragging;

  onQueueResizeStart(event: PointerEvent): void {
    this.queueResizeDrag.start(event);
  }

  private clampQueueExtra(px: number): number {
    return Math.min(NowPlayingComponent.QUEUE_EXTRA_MAX_PX, Math.max(0, Math.round(px)));
  }

  private readStoredQueueExtra(): number {
    try {
      const raw = localStorage.getItem(NowPlayingComponent.QUEUE_EXTRA_STORAGE_KEY);
      return raw ? this.clampQueueExtra(Number(raw)) : 0;
    } catch {
      return 0;
    }
  }

  private persistQueueExtra(px: number): void {
    try {
      localStorage.setItem(NowPlayingComponent.QUEUE_EXTRA_STORAGE_KEY, String(px));
    } catch {
      /* storage unavailable — the size just won't persist */
    }
  }

  private readStoredActivePanel(): 'queue' | 'lyrics' {
    try {
      const raw = localStorage.getItem(NowPlayingComponent.ACTIVE_PANEL_STORAGE_KEY);
      return raw === 'lyrics' ? 'lyrics' : 'queue';
    } catch {
      return 'queue';
    }
  }

  setActivePanel(panel: 'queue' | 'lyrics'): void {
    this.activePanel.set(panel);
    this.lyricsOpen.set(panel === 'lyrics');
    try {
      localStorage.setItem(NowPlayingComponent.ACTIVE_PANEL_STORAGE_KEY, panel);
    } catch {
      /* storage unavailable — the choice just won't persist */
    }
  }

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
      if (!this.lyricsOpen()) return;
      const id = this.player.currentTrack()?.id ?? null;
      if (!id || id === this.lyricsLoadedForId()) return;
      this.loadLyrics(id);
    });

    // Extract cover colors when lyrics are open (needed for the fullscreen gradient).
    effect(() => {
      const track = this.player.currentTrack();
      if (!track?.coverArt) return;
      if (!this.lyricsOpen()) return;
      if (this.colorExtractedForId === track.id) return;
      this.colorExtractedForId = track.id;
      const token = this.auth.token();
      const url = this.server.apiUrl(`/api/cover/${track.coverArt}?size=80&token=${token}`);
      this.extractColorsFromImage(url);
    });

    // Auto-scroll lyrics to the active line — `resolveLyricsScrollContainer`
    // (a pure function, unit-tested standalone) picks whichever surface is
    // actually visible: the in-place lyrics panel, or the karaoke-fullscreen
    // overlay's browse-mode list (its own ref is only populated while
    // `browsing()` is true, so this is a no-op — early return below — during
    // the fullscreen auto-follow 2-line view, which has no scrollable list).
    effect(() => {
      const active = this.activeLine();
      if (!this.lyricsOpen() || active < 0) return;
      const container = resolveLyricsScrollContainer(this.karaokeFullscreen(), {
        lyricsPanelEl: this.lyricsPanel()?.lyricsScrollRef()?.nativeElement ?? null,
        karaokeEl: this.karaokeFullscreenPanel()?.lyricsScrollRef()?.nativeElement ?? null,
      });
      if (!container) return;
      scrollToActiveLine(container, active);
    });

    // Replay the fullscreen auto-follow line-change animation on every advance.
    effect(() => {
      this.activeLine();
      this.karaokeLineAnimClass.update((c) =>
        c === 'karaoke-line-anim-a' ? 'karaoke-line-anim-b' : 'karaoke-line-anim-a',
      );
    });

    // Ensure the browse-idle timeout can never fire/leak past destruction.
    this.destroyRef.onDestroy(() => this.clearBrowseIdleTimer());
  }

  toggleKaraokeFullscreen(): void {
    const entering = !this.karaokeFullscreen();
    this.karaokeFullscreen.set(entering);
    this.clearBrowseIdleTimer();
    this.karaokeBrowsing.set(false);
    if (entering) {
      // Ensure lyrics stay loaded
      if (!this.lyricsOpen()) this.lyricsOpen.set(true);
      // Re-extract colors if needed
      const track = this.player.currentTrack();
      if (track?.coverArt && this.colorExtractedForId !== track.id) {
        this.colorExtractedForId = track.id;
        const token = this.auth.token();
        const url = this.server.apiUrl(`/api/cover/${track.coverArt}?size=80&token=${token}`);
        this.extractColorsFromImage(url);
      }
      setTimeout(() => this.karaokeFullscreenPanel()?.overlayRef()?.nativeElement.focus(), 0);
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
    this.lyrics.set(null);
    this.lyricsError.set(false);
    this.lyricsLoading.set(true);
    this.api.getLyrics(id).subscribe({
      next: (l) => {
        if (l) {
          this.lyrics.set(l);
          this.lyricsLoadedForId.set(id);
          this.lyricsLoading.set(false);
        } else {
          this.api.fetchLyrics(id).subscribe({
            next: (f) => {
              this.lyrics.set(f);
              // Only cache the id on success so a later external fetch (e.g.
              // from the track-info sheet) is picked up on the next effect run.
              if (f) this.lyricsLoadedForId.set(id);
              this.lyricsLoading.set(false);
            },
            // A source failure (502) is distinct from a confident no-match —
            // flag it so the empty state offers a retry instead of "none".
            error: () => {
              this.lyricsError.set(true);
              this.lyricsLoading.set(false);
            },
          });
        }
      },
      error: () => this.lyricsLoading.set(false),
    });
  }

  /**
   * Manual "Fetch lyrics" from the empty state. Forces a re-fetch (so a prior
   * miss/error is retried) and surfaces success/empty/error distinctly.
   */
  fetchLyricsManually(): void {
    const id = this.player.currentTrack()?.id;
    if (!id || this.fetchingLyrics()) return;
    this.fetchingLyrics.set(true);
    this.lyricsError.set(false);
    this.api.fetchLyrics(id, true).subscribe({
      next: (f) => {
        this.lyrics.set(f);
        if (f) this.lyricsLoadedForId.set(id);
        this.fetchingLyrics.set(false);
      },
      error: () => {
        this.lyricsError.set(true);
        this.fetchingLyrics.set(false);
      },
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

  /** Wheel/touch gesture on the fullscreen lyrics body enters browse mode. */
  onKaraokeInteraction(): void {
    this.karaokeBrowsing.set(true);
    this.resetBrowseIdleTimer();
  }

  /** Tapping a line in browse mode seeks there and returns to auto-follow. */
  seekToLine(index: number): void {
    const line = this.lyricLines()[index];
    if (!line) return;
    this.clearBrowseIdleTimer();
    this.onSeek(line.timeMs / 1000);
    this.karaokeBrowsing.set(false);
  }

  private resetBrowseIdleTimer(): void {
    this.clearBrowseIdleTimer();
    this.browseIdleTimer = setTimeout(() => {
      this.karaokeBrowsing.set(false);
    }, NowPlayingComponent.BROWSE_IDLE_MS);
  }

  private clearBrowseIdleTimer(): void {
    if (this.browseIdleTimer !== null) {
      clearTimeout(this.browseIdleTimer);
      this.browseIdleTimer = null;
    }
  }

  /** Explicit toggle for the visible browse button and keyboard entry — flips
   *  between the 2-line auto-follow view and the full browse list. */
  toggleKaraokeBrowsing(): void {
    if (this.karaokeBrowsing()) {
      this.clearBrowseIdleTimer();
      this.karaokeBrowsing.set(false);
    } else {
      this.onKaraokeInteraction();
    }
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
    this.contextMenu.set({ x: event.clientX, y: event.clientY });
  }

  onOpenTrackInfo(songId: string): void {
    this.contextMenu.set(null);
    const t = this.player.currentTrack();
    this.trackInfo.open({
      songId,
      title: t?.title,
      artist: t?.artist,
      album: t?.album,
      coverArt: t?.coverArt ?? null,
    });
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
}
