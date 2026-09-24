import {
  Component,
  inject,
  signal,
  computed,
  effect,
  viewChild,
  DestroyRef,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { NowPlayingHeaderComponent } from './now-playing-header/now-playing-header.component';
import { PlayingElsewhereComponent } from '../playing-elsewhere/playing-elsewhere.component';
import { NowPlayingCoverArtComponent } from './now-playing-cover-art/now-playing-cover-art.component';
import { NowPlayingTransportComponent } from './now-playing-transport/now-playing-transport.component';
import { NowPlayingPanelTabsComponent } from './now-playing-panel-tabs/now-playing-panel-tabs.component';
import { NowPlayingQueuePanelComponent } from './now-playing-queue-panel/now-playing-queue-panel.component';
import { NowPlayingLyricsPanelComponent } from './now-playing-lyrics-panel/now-playing-lyrics-panel.component';
import { NowPlayingKaraokeFullscreenComponent } from './now-playing-karaoke-fullscreen/now-playing-karaoke-fullscreen.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TrackInfoService } from '../../services/track-info.service';
import { resolveArtistTarget } from '../../lib/route-utils';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { WaveformData } from '@nicotind/core';
import { firstValueFrom } from 'rxjs';
import { createPointerDrag } from '../../lib/pointer-drag';
import { createVerticalSwipe, scrollableAncestorTop, shouldCommit } from '../../lib/vertical-swipe';
import { ScrollLockService } from '../../services/scroll-lock.service';
import { ServerConfigService } from '../../services/server-config.service';
import { isTvUi } from '../../lib/platform';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { NowPlayingTvQueueComponent } from './now-playing-tv-queue/now-playing-tv-queue.component';
import { BackButtonService } from '../../services/native/back-button.service';
import {
  loadCoverPalette,
  scrollToActiveLine,
  DEFAULT_PALETTE,
  type CoverPalette,
} from '../../lib/cover-colors';
import { LyricsService } from '../../services/lyrics.service';
import { KaraokeBrowseMode } from '../../lib/karaoke-browse';
import { resolveLyricsScrollContainer } from '../../lib/lyrics-scroll-container';

/** The `lg:` side-panel layout, where a vertical panel resize has nothing to do. */
function isDesktopSheet(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(min-width: 1024px)').matches;
}

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
    TranslatePipe,
    TvNavGroupDirective,
    TvNavItemDirective,
    NowPlayingTvQueueComponent,
    PlayingElsewhereComponent,
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
  /** Karaoke ML separation (issue #603): overlay-open trigger + the mute's serve state. */

  /** TV queue overlay opened from the Next-up chip (issue #399). */
  readonly tvQueueOpen = signal(false);

  onTvQueueJump(index: number): void {
    this.player.jumpToQueueIndex(index);
    this.closeTvQueue();
  }

  onTvQueueRemove(index: number): void {
    this.player.removeFromQueue(index);
    // Removing the last row leaves nothing to act on (the chip itself is
    // about to disappear too) — close rather than strand focus.
    if (this.player.queue().length === 0) this.closeTvQueue();
  }

  closeTvQueue(): void {
    this.tvQueueOpen.set(false);
    // Focus-restore to the chip (the MenuPanel discipline): host query, not
    // viewChild — signal view queries do not populate in the JIT harness.
    document.querySelector<HTMLElement>('[data-testid="now-playing-next-up"]')?.focus();
  }

  // Lyrics view state. Lyrics load lazily on first open and reload when the
  // track changes while the panel is open. `lyricsOpen`'s own declaration
  // lives further down (seeded from `activePanel`, see the comment there) —
  // field initialization order matters in JS/TS class bodies, and
  // `activePanel` must already be assigned before `lyricsOpen`'s initializer
  // runs.
  // The lyrics themselves live in `LyricsService` (#1134): the TV player shows
  // the same karaoke overlay and never mounts this sheet, so the state could
  // not stay here. These are the service's own signals under the names the
  // template, the child bindings and the specs have always used.
  private readonly lyricsSvc = inject(LyricsService);
  readonly lyrics = this.lyricsSvc.lyrics;
  /** Precomputed waveform artifact for the current track (issue #643); null
   *  until fetched or when the server has none (404 → plain seek bar). */
  readonly waveform = signal<WaveformData | null>(null);
  private readonly waveformLoadedForId = signal<string | null>(null);
  readonly lyricsLoading = this.lyricsSvc.loading;
  readonly lyricsError = this.lyricsSvc.error;
  readonly fetchingLyrics = this.lyricsSvc.fetching;
  /** Parsed synced LRC lines (empty when the lyrics are plain-only). */
  readonly lyricLines = this.lyricsSvc.lines;
  /** Index of the line to highlight for the current playback position — the
   *  sheet's *display* time, which follows a remote session when the audio is
   *  elsewhere. */
  readonly activeLine = computed(() => this.lyricsSvc.activeLineAt(this.displayTime() * 1000));
  /** Plain text fallback when there are no synced lines. */
  readonly plainLyrics = this.lyricsSvc.plain;
  /** Stored sync correction, shown next to the nudge control. */
  readonly lyricsOffsetMs = this.lyricsSvc.offsetMs;
  /** The offset is shared library state, so it follows the same gate as every
   *  other lyrics write. Non-curators see no control rather than a dead one. */
  readonly canSyncLyrics = computed(() => this.auth.canCurate());
  /** Whether the current track has lyrics loaded (drives the tab-switcher dot).
   *  Gated on the service's `loadedForId` — the state is only reloaded while
   *  a lyrics surface is open, so after a track change with the panel closed
   *  it still holds the previous track's text, and an ungated check showed a
   *  stale positive. Stays off until the Lyrics tab has been opened at least
   *  once for this track (see docs/web-ui.md). */
  readonly hasLyrics = computed(() => this.lyricsSvc.hasLyricsFor(this.player.currentTrack()?.id));

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
  // and returns to auto-follow. The rule — and its idle timeout — is
  // `KaraokeBrowseMode`, shared with the TV overlay. `false` = auto-follow.
  private readonly browse = new KaraokeBrowseMode();
  readonly karaokeBrowsing = this.browse.browsing;

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
  /** See PlayerComponent.drivesLocalPlayer. */
  readonly drivesLocalPlayer = computed(
    () => this.isActiveDevice() || !this.remote.sessionControllable(),
  );

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

  // One body gesture for the whole sheet (header, cover, transport, notch,
  // tabs, panel). Which of the two things a vertical pull can do — resize the
  // panel or dismiss the sheet — is decided once, at the first move past slop,
  // from the origin zone and the current state (the mode table in
  // docs/web-ui.md "Player expand/collapse gesture"). Collapsing the panel all
  // the way flips into a dismiss mid-gesture, so one pull reads as "shrink,
  // then close" instead of stopping dead at the panel's rest height.
  readonly dragOffsetPx = signal(0);
  private static readonly DISMISS_THRESHOLD_PX = 120;
  private readonly bodyMode = signal<'idle' | 'resize' | 'dismiss'>('idle');
  private resizeStartExtra = 0;
  /** dy at which a collapse ran out of panel and the pull became a dismiss. */
  private dismissBaseDy = 0;
  private readonly bodySwipe = createVerticalSwipe({
    resolve: ({ target, dy }) => {
      const mode = this.resolveBodyMode(target, dy);
      if (mode === 'release') return 'release';
      this.bodyMode.set(mode);
      this.resizeStartExtra = this.queueExtraHeightPx();
      this.dismissBaseDy = 0;
      return 'own';
    },
    onMove: (dy) => {
      if (this.bodyMode() === 'resize') {
        const extra = this.resizeStartExtra - dy;
        if (extra >= 0 || dy < 0) {
          this.queueExtraHeightPx.set(this.clampQueueExtra(extra));
          return;
        }
        // Continuation: the panel is at rest and the finger keeps going down.
        this.queueExtraHeightPx.set(0);
        this.persistQueueExtra(0);
        this.dismissBaseDy = this.resizeStartExtra;
        this.bodyMode.set('dismiss');
      }
      this.dragOffsetPx.set(Math.max(0, dy - this.dismissBaseDy));
    },
    onEnd: ({ velocity }) => {
      const mode = this.bodyMode();
      this.bodyMode.set('idle');
      if (mode === 'resize') {
        this.persistQueueExtra(this.queueExtraHeightPx());
        return;
      }
      if (mode !== 'dismiss') return;
      const offset = this.dragOffsetPx();
      this.dragOffsetPx.set(0);
      if (
        shouldCommit(offset, velocity, { thresholdPx: NowPlayingComponent.DISMISS_THRESHOLD_PX })
      ) {
        this.player.setNowPlayingOpen(false);
      }
    },
    onRelease: () => this.bodyMode.set('idle'),
  });
  readonly dragging = this.bodySwipe.dragging;
  readonly resizingQueue = computed(() => this.bodyMode() === 'resize');

  /** The sheet's transform: a closed sheet rides the mini bar's lift up, an
   *  open one follows the dismiss drag down. */
  readonly sheetTransform = computed(() => {
    const lift = this.player.nowPlayingLiftPx();
    if (!this.player.nowPlayingOpen() && lift > 0) return `translateY(calc(100% - ${lift}px))`;
    const offset = this.dragOffsetPx();
    return offset > 0 ? `translateY(${offset}px)` : null;
  });
  readonly sheetInstant = computed(() => this.dragging() || this.player.nowPlayingLiftPx() > 0);

  // Controls and nested drags keep their own pointer: a tap on them must not
  // become a sheet gesture, the seek/waveform scrubs are horizontal drags, and
  // a queue row owns its swipe-remove and long-press reorder (#1295).
  private static readonly BODY_NO_SWIPE =
    'button, a, input, select, textarea, [data-seek], .seek-range, app-now-playing-waveform, app-menu-panel, [draggable="true"], [data-np-no-swipe]';

  onBodyPointerDown(event: PointerEvent): void {
    if (this.karaokeFullscreen()) return;
    const target = event.target;
    if (target instanceof Element && target.closest(NowPlayingComponent.BODY_NO_SWIPE)) return;
    this.bodySwipe.start(event);
  }

  private resolveBodyMode(
    target: EventTarget | null,
    dy: number,
  ): 'resize' | 'dismiss' | 'release' {
    const extra = this.queueExtraHeightPx();
    const zone = target instanceof Element ? target.closest('[data-np-zone="panel"]') : null;
    if (dy < 0) {
      // Up grows the panel; at lg the panel is a side column with nothing to grow.
      return !isDesktopSheet() && extra < NowPlayingComponent.QUEUE_EXTRA_MAX_PX
        ? 'resize'
        : 'release';
    }
    if (zone && scrollableAncestorTop(target, zone) > 0) return 'release';
    return extra > 0 && !isDesktopSheet() ? 'resize' : 'dismiss';
  }

  // Manual queue resize: dragging the handle up shrinks the cover art and gives
  // the Now-Playing queue more room (the queue is flex-1, so shrinking the cover
  // grows it). `queueExtraHeightPx` is how many px the cover has shrunk from its
  // max; persisted per-device so the chosen size survives reload.
  private static readonly COVER_MAX_PX = 320; // matches Tailwind max-w-80 (20rem)
  // Zero, not 120 (#993). A floor of 120px handed most of the reclaimed space
  // straight back on a short phone, which is the device the drag exists for —
  // and it made the gesture feel broken rather than bounded, because the handle
  // kept moving after the cover had stopped shrinking. The wrapper's padding
  // collapses with it (`now-playing-cover-art`), or 32px of empty box would
  // survive the cover it was padding.
  private static readonly COVER_MIN_PX = 0;
  private static readonly QUEUE_EXTRA_MAX_PX =
    NowPlayingComponent.COVER_MAX_PX - NowPlayingComponent.COVER_MIN_PX;
  private static readonly QUEUE_EXTRA_STORAGE_KEY = 'nicotind:np-queue-extra';
  readonly queueExtraHeightPx = signal(this.readStoredQueueExtra());

  // Active panel (queue vs lyrics) persisted per-device.
  private static readonly ACTIVE_PANEL_STORAGE_KEY = 'nicotind:np-active-panel';
  readonly activePanel = signal<'queue' | 'lyrics'>(this.readStoredActivePanel());
  // DERIVED from `activePanel`, not a second writable signal (issue #446).
  // The queue and lyrics areas are one panel showing one thing, and two
  // independently-writable booleans drifted: `toggleKaraokeFullscreen` opened
  // lyrics by writing this flag directly, so the panel choice that got
  // persisted disagreed with what was on screen and the next launch restored
  // the wrong one. As a computed there is exactly one writer (`setActivePanel`)
  // and the two can no longer disagree.
  //
  // Still correct for the restore path it was seeded for: a page load onto the
  // Lyrics tab has `lyricsOpen` true immediately, which the lyrics-loading /
  // colour-extraction / auto-scroll effects below all gate on.
  readonly lyricsOpen = computed(() => this.activePanel() === 'lyrics');

  /** Cover art max-width (px), shrinking as the queue is dragged taller. */
  readonly coverMaxPx = computed(
    () => NowPlayingComponent.COVER_MAX_PX - this.queueExtraHeightPx(),
  );

  /** TV player treatment (10-foot layout): blurred-cover backdrop, bottom
   *  transport bar, Next-up chip instead of the stacked queue/lyrics panels.
   *  Reads the root class (not the build env) so e2e can exercise it. */
  readonly isTv = isTvUi();

  /**
   * The blurred sheet backdrop on TV — same cover endpoint the art uses;
   * null (no backdrop) when the track has no cover.
   *
   * Also null while the sheet is **closed**. The sheet is never unmounted, only
   * translated below the viewport, and its `::before` uses `inset: -6%` to hide
   * the blur's unsampled edge — which on a 540px TV viewport reaches 32px back
   * INSIDE the screen. With `blur(56px)` on top, the cover's colours smeared
   * roughly 90px up the page, painting a soft wash across the bottom of every
   * route (the mini-player looked like it had a gradient behind it). Withholding
   * the URL is the fix rather than `overflow: hidden` on the sheet: the sheet
   * carries a transform, so it is the containing block for the fixed-position
   * TV queue overlay, and clipping it would clip that too.
   */
  readonly tvBackdropUrl = computed(() => {
    const track = this.player.currentTrack();
    if (!this.isTv || !track?.coverArt || !this.player.nowPlayingOpen()) return null;
    return this.server.apiUrl(
      `/api/cover/${track.coverArt}?size=600&token=${this.auth.mediaToken()}`,
    );
  });

  /** Head of the queue, shown in the TV Next-up chip. */
  readonly nextUp = computed(() => this.player.queue()[0] ?? null);
  onQueueResizeStart(event: PointerEvent): void {
    this.onBodyPointerDown(event);
  }

  // Desktop (lg) side panel width — the border between the columns is a
  // splitter. Rides a CSS var (`--np-side-w`) for the same reason the cover cap
  // does: an inline width would beat the responsive cascade below lg.
  static readonly SIDE_DEFAULT_PX = 380;
  static readonly SIDE_MIN_PX = 300;
  static readonly SIDE_MAX_PX = 640;
  private static readonly SIDE_KEY_STEP_PX = 16;
  private static readonly SIDE_WIDTH_STORAGE_KEY = 'nicotind:np-side-width';
  readonly sidePanelWidthPx = signal(this.readStoredSideWidth());
  // Templates cannot read statics.
  readonly sideMinPx = NowPlayingComponent.SIDE_MIN_PX;
  readonly sideMaxPx = NowPlayingComponent.SIDE_MAX_PX;
  private sideResizeStartWidth = NowPlayingComponent.SIDE_DEFAULT_PX;
  private readonly sideResizeDrag = createPointerDrag({
    onStart: () => {
      this.sideResizeStartWidth = this.sidePanelWidthPx();
    },
    // The panel is on the right: dragging the border left (clientX decreases) grows it.
    onMove: (event, start) => {
      const delta = start.clientX - event.clientX;
      this.sidePanelWidthPx.set(this.clampSideWidth(this.sideResizeStartWidth + delta));
    },
    onEnd: () => this.persistSideWidth(this.sidePanelWidthPx()),
  });
  readonly resizingSide = this.sideResizeDrag.dragging;

  onSideResizeStart(event: PointerEvent): void {
    this.sideResizeDrag.start(event);
  }

  onSideResizeKeydown(event: KeyboardEvent): void {
    const step = NowPlayingComponent.SIDE_KEY_STEP_PX;
    const next: Record<string, number | undefined> = {
      ArrowLeft: this.sidePanelWidthPx() + step,
      ArrowRight: this.sidePanelWidthPx() - step,
      Home: NowPlayingComponent.SIDE_MIN_PX,
      End: NowPlayingComponent.SIDE_MAX_PX,
    };
    const width = next[event.key];
    if (width === undefined) return;
    event.preventDefault();
    this.setSideWidth(width);
  }

  resetSidePanelWidth(): void {
    this.setSideWidth(NowPlayingComponent.SIDE_DEFAULT_PX);
  }

  private setSideWidth(px: number): void {
    this.sidePanelWidthPx.set(this.clampSideWidth(px));
    this.persistSideWidth(this.sidePanelWidthPx());
  }

  private clampSideWidth(px: number): number {
    const max = Math.min(NowPlayingComponent.SIDE_MAX_PX, Math.floor(window.innerWidth / 2));
    return Math.min(max, Math.max(NowPlayingComponent.SIDE_MIN_PX, Math.round(px)));
  }

  private readStoredSideWidth(): number {
    try {
      const raw = localStorage.getItem(NowPlayingComponent.SIDE_WIDTH_STORAGE_KEY);
      return raw ? this.clampSideWidth(Number(raw)) : NowPlayingComponent.SIDE_DEFAULT_PX;
    } catch {
      return NowPlayingComponent.SIDE_DEFAULT_PX;
    }
  }

  private persistSideWidth(px: number): void {
    try {
      localStorage.setItem(NowPlayingComponent.SIDE_WIDTH_STORAGE_KEY, String(px));
    } catch {
      /* storage unavailable — the width just won't persist */
    }
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
    // Leaving lyrics must also leave karaoke fullscreen, or the overlay
    // outlives the panel behind it and there is no way back to the queue.
    if (panel !== 'lyrics') this.karaokeFullscreen.set(false);
    try {
      localStorage.setItem(NowPlayingComponent.ACTIVE_PANEL_STORAGE_KEY, panel);
    } catch {
      /* storage unavailable — the choice just won't persist */
    }
  }

  private readonly backButton = inject(BackButtonService);

  constructor() {
    // Hardware Back (issue #394): exit karaoke first, then close the sheet.
    // Persistent + state-checked so transient overlays (menus, track info)
    // pushed while open always sit above it on the stack.
    const unregisterBack = this.backButton.stack.push(() => {
      if (this.karaokeFullscreen()) {
        this.karaokeFullscreen.set(false);
        return true;
      }
      if (this.player.nowPlayingOpen()) {
        this.player.setNowPlayingOpen(false);
        return true;
      }
      return false;
    });
    this.destroyRef.onDestroy(unregisterBack);

    // Q / Y (#1296): the shortcut asks for a panel; the panel state is ours.
    effect(() => {
      const panel = this.player.nowPlayingPanelRequest();
      if (!panel) return;
      untracked(() => {
        this.setActivePanel(panel);
        this.player.nowPlayingPanelRequest.set(null);
      });
    });

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

    // Fetch the waveform artifact whenever the sheet is open and the track
    // changes — lazily, like lyrics: a closed sheet never costs a decode. And
    // only once the track's audio is flowing: a cold peaks request is a full
    // server-side decode that competes with the stream for the disk exactly at
    // time-to-first-audio, and a skip burst would start one per track (#1328).
    effect(() => {
      if (!this.player.nowPlayingOpen()) return;
      if (this.player.buffering()) return;
      const id = this.player.currentTrack()?.id ?? null;
      if (!id || id === this.waveformLoadedForId()) return;
      this.loadWaveform(id);
    });

    // Lazily (re)load lyrics whenever the panel is open and the track changes.
    effect(() => {
      if (!this.lyricsOpen()) return;
      const id = this.player.currentTrack()?.id ?? null;
      if (id) this.lyricsSvc.ensureLoaded(id);
    });

    // Extract cover colors when lyrics are open (needed for the fullscreen gradient).
    effect(() => {
      const track = this.player.currentTrack();
      if (!track?.coverArt) return;
      if (!this.lyricsOpen()) return;
      if (this.colorExtractedForId === track.id) return;
      this.colorExtractedForId = track.id;
      const token = this.auth.mediaToken();
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
    this.destroyRef.onDestroy(() => this.browse.destroy());
  }

  toggleKaraokeFullscreen(): void {
    const entering = !this.karaokeFullscreen();
    this.karaokeFullscreen.set(entering);
    this.browse.leave();
    if (entering) {
      // Ensure lyrics stay loaded — through setActivePanel so the persisted
      // choice matches what is actually on screen (issue #446).
      if (!this.lyricsOpen()) this.setActivePanel('lyrics');
      // Re-extract colors if needed
      const track = this.player.currentTrack();
      if (track?.coverArt && this.colorExtractedForId !== track.id) {
        this.colorExtractedForId = track.id;
        const token = this.auth.mediaToken();
        const url = this.server.apiUrl(`/api/cover/${track.coverArt}?size=80&token=${token}`);
        this.extractColorsFromImage(url);
      }
      setTimeout(() => this.karaokeFullscreenPanel()?.overlayRef()?.nativeElement.focus(), 0);
    }
  }

  /** The Image/<canvas> shell lives with the palette maths it feeds
   *  (`loadCoverPalette`), shared with the TV overlay (#1134). */
  private extractColorsFromImage(src: string): void {
    void loadCoverPalette(src).then((palette) => this.coverColors.set(palette));
  }

  private loadWaveform(id: string): void {
    this.waveform.set(null);
    this.waveformLoadedForId.set(id);
    this.api.getPeaks(id).subscribe({
      // Guard against a late response for a track we've already moved past.
      next: (w) => {
        if (this.player.currentTrack()?.id === id) this.waveform.set(w);
      },
      // 404 (no waveform) or any failure: the seek bar alone is the fallback.
      error: () => undefined,
    });
  }

  /**
   * Manual "Fetch lyrics" from the empty state. Forces a re-fetch (so a prior
   * miss/error is retried) and surfaces success/empty/error distinctly.
   */
  fetchLyricsManually(): void {
    this.lyricsSvc.fetchManually(this.player.currentTrack()?.id);
  }

  nudgeLyricsOffset(stepMs: number): void {
    this.lyricsSvc.nudgeOffset(stepMs);
  }

  resetLyricsOffset(): void {
    this.lyricsSvc.resetOffset();
  }

  handlePlayPause(): void {
    if (this.drivesLocalPlayer()) {
      if (this.player.isPlaying()) this.player.pause();
      else this.player.resume();
    } else {
      this.ws.sendCommand(this.remote.remoteIsPlaying() ? 'PAUSE' : 'PLAY');
    }
  }

  handleNext(): void {
    if (this.drivesLocalPlayer()) this.player.playNext();
    else this.ws.sendCommand('NEXT');
  }

  handlePrev(): void {
    if (this.drivesLocalPlayer()) {
      this.player.playPrev();
    } else {
      this.ws.sendCommand('PREV');
    }
  }

  // Seek commit from app-seek-bar (native range — reliable click/drag/touch/
  // keyboard across browsers; see SeekBarComponent). Fires once on release.
  onSeek(time: number): void {
    if (this.drivesLocalPlayer()) {
      this.player.seek(time);
    } else {
      this.ws.sendCommand('SEEK', { position: time });
      this.remote.setRemoteProgress(time, this.safeDuration());
    }
  }

  /** Wheel/touch gesture on the fullscreen lyrics body enters browse mode. */
  onKaraokeInteraction(): void {
    this.browse.interact();
  }

  /** Tapping a line in browse mode seeks there and returns to auto-follow. */
  seekToLine(index: number): void {
    const line = this.lyricLines()[index];
    if (!line) return;
    this.onSeek(line.timeMs / 1000);
    this.browse.leave();
  }

  /** Explicit toggle for the visible browse button and keyboard entry — flips
   *  between the 2-line auto-follow view and the full browse list. */
  toggleKaraokeBrowsing(): void {
    this.browse.toggle();
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

  /** An entity link (album, queue-row artist/album) navigates itself via
   *  routerLink; the sheet only has to get out of the way. */
  closeForNavigation(): void {
    this.player.setNowPlayingOpen(false);
  }

  onOpenTrackInfo(songId: string): void {
    const t = this.player.currentTrack();
    this.trackInfo.open({
      songId,
      title: t?.title,
      artist: t?.artist,
      album: t?.album,
      coverArt: t?.coverArt ?? null,
    });
  }
}
