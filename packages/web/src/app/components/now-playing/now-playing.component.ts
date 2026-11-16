import {
  Component,
  inject,
  signal,
  computed,
  effect,
  viewChild,
  DestroyRef,
  ElementRef,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { PlayerService, type Track } from '../../services/player.service';
import { songCover } from '../../lib/cover-url';
import { CoverRevisionsService } from '../../services/cover-revisions.service';
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
import { offlineFind, resolveArtistTarget } from '../../lib/route-utils';
import { OfflineModeService } from '../../services/offline-mode.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { WaveformData } from '@nicotind/core';
import { firstValueFrom } from 'rxjs';
import { createPointerDrag } from '../../lib/pointer-drag';
import {
  createHorizontalSwipe,
  createVerticalSwipe,
  scrollableAncestorTop,
  shouldCommit,
} from '../../lib/vertical-swipe';
import {
  clampLift,
  effectiveSnap,
  panelLayout,
  persistPanelState,
  resolvePullMode,
  restorePanelState,
  settle,
  snapLift,
  transition,
  type PanelEvent,
  type PanelGeometry,
  type PanelSnap,
  type PanelState,
} from '../../lib/player-panel';
import { canStartSheetSkip, gestureOrigin, skipDirection } from '../../lib/swipe-to-skip';
import { haptic } from '../../lib/haptics';
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
import { ConfirmService } from '../../services/confirm.service';
import { TranslateService } from '../../services/translate.service';
import type { LyricsTryState } from './lyrics-options-sheet/lyrics-options-sheet.component';
import { LyricsTimingEditorComponent } from './lyrics-timing-editor/lyrics-timing-editor.component';
import { rowsFromLyrics, type TimingRow } from '../../lib/lyrics-timing-draft';
import { KaraokeBrowseMode } from '../../lib/karaoke-browse';
import { resolveLyricsScrollContainer } from '../../lib/lyrics-scroll-container';
import { OverflowRevealDirective } from '../../directives/overflow-reveal.directive';
import { HapticDirective } from '../../directives/haptic.directive';
import { NgComponentOutlet } from '@angular/common';
import { PLAYER_PANEL_TABS } from './player-panel-tabs';

/** The `lg:` side-panel layout, where a vertical panel resize has nothing to do. */
function isDesktopSheet(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(min-width: 1024px)').matches;
}

@Component({
  selector: 'app-now-playing',
  imports: [
    OverflowRevealDirective,
    HapticDirective,
    NgComponentOutlet,
    NowPlayingHeaderComponent,
    NowPlayingCoverArtComponent,
    NowPlayingTransportComponent,
    NowPlayingPanelTabsComponent,
    NowPlayingQueuePanelComponent,
    NowPlayingLyricsPanelComponent,
    LyricsTimingEditorComponent,
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
  private readonly offlineMode = inject(OfflineModeService);
  private api = inject(LibraryApiService);
  private scrollLock = inject(ScrollLockService);
  private server = inject(ServerConfigService);
  private readonly coverRevisions = inject(CoverRevisionsService);
  private destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
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
  private readonly confirm = inject(ConfirmService);
  private readonly i18n = inject(TranslateService);
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
  /** "Try another source" for the options sheet (#1674); curators only, like Sync. */
  readonly lyricsTry = computed<LyricsTryState | null>(() =>
    this.auth.canCurate()
      ? {
          walk: this.lyrics()?.walk ?? null,
          busy: this.lyricsSvc.trying() || this.undoingLyrics(),
          result: this.lyricsSvc.tryResult(),
          canUndo: !!this.lyrics()?.canUndo,
        }
      : null,
  );
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

  // Karaoke is the Lyrics tab at `full` (#1680, D5): no flag of its own, so it
  // cannot disagree with the panel state that is persisted and restored.
  readonly karaokeFullscreen = computed(
    () => this.panelState().tab === 'lyrics' && this.panelSnap() === 'full',
  );
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
  /** `<track id>@<cover rev>` the palette was taken from: a replaced cover re-extracts (#1666). */
  private colorExtractedFor: string | null = null;

  readonly isActiveDevice = this.remote.isActiveDevice;
  /** See PlayerComponent.drivesLocalPlayer. */
  readonly drivesLocalPlayer = computed(
    () => this.isActiveDevice() || !this.remote.sessionControllable(),
  );

  readonly displayTime = computed(() => {
    if (this.isActiveDevice()) return this.player.currentTime();
    return this.remote.remoteClock();
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
  // tabs, panel). Who owns a pull — the panel, the sheet's dismiss, or the
  // browser — is decided once at slop by `resolvePullMode` (#1679, the mode
  // table in docs/player-panel.md §2.4). A panel pull from `rest` that keeps
  // going down continues into the dismiss; one from `full` stops at `rest`.
  readonly dragOffsetPx = signal(0);
  private static readonly DISMISS_THRESHOLD_PX = 120;
  private readonly bodyMode = signal<'idle' | 'panel' | 'dismiss'>('idle');
  /** The snap and geometry a panel pull started from, and its live `lift`. */
  private pull: { start: PanelSnap; baseLift: number; geometry: PanelGeometry } | null = null;
  readonly panelDragLift = signal<number | null>(null);
  private readonly bodySwipe = createVerticalSwipe({
    resolve: ({ target, dy }) => {
      const zone = target instanceof Element ? target.closest('[data-np-zone="panel"]') : null;
      const mode = resolvePullMode({
        origin: zone ? 'panel' : 'stage',
        direction: dy < 0 ? 'up' : 'down',
        snap: this.panelSnap(),
        nestedScrollTop: zone ? scrollableAncestorTop(target, zone) : 0,
        lg: this.lg(),
      });
      if (mode === 'release') return 'release';
      if (mode === 'panel') {
        const geometry = this.measurePanelGeometry();
        // No layout (a hidden sheet): nothing to move the panel through.
        if (geometry.fullLiftPx <= 0) return 'release';
        const start = this.panelSnap();
        this.pull = { start, baseLift: snapLift(start, geometry), geometry };
        this.panelFullLiftPx.set(geometry.fullLiftPx);
      }
      this.bodyMode.set(mode);
      return 'own';
    },
    onMove: (dy) => {
      if (this.bodyMode() === 'panel' && this.pull) {
        const lift = clampLift(this.pull.start, this.pull.baseLift - dy, this.pull.geometry);
        this.panelDragLift.set(Math.max(0, lift));
        this.dragOffsetPx.set(lift < 0 ? -lift : 0);
        return;
      }
      this.dragOffsetPx.set(Math.max(0, dy));
    },
    onEnd: ({ velocity, owned, cancelled }) => {
      if (owned) this.markGestureEnded();
      const mode = this.bodyMode();
      this.bodyMode.set('idle');
      // An OS interruption settles by distance only: it never flings (§2.4).
      const v = cancelled ? 0 : velocity;
      if (mode === 'panel' && this.pull) {
        const pull = this.pull;
        const lift = (this.panelDragLift() ?? 0) - this.dragOffsetPx();
        this.pull = null;
        this.panelDragLift.set(null);
        this.dragOffsetPx.set(0);
        // `settle` measures velocity upward; the swipe's is downward.
        const result = settle(pull.start, lift, -v, pull.geometry);
        if (result.kind === 'dismiss') {
          haptic('commit');
          this.player.setNowPlayingOpen(false);
        } else {
          this.setPanelState({ ...this.panelState(), snap: result.snap });
        }
        return;
      }
      if (mode !== 'dismiss') return;
      const offset = this.dragOffsetPx();
      this.dragOffsetPx.set(0);
      if (shouldCommit(offset, v, { thresholdPx: NowPlayingComponent.DISMISS_THRESHOLD_PX })) {
        haptic('commit');
        this.player.setNowPlayingOpen(false);
      }
    },
    onRelease: () => {
      this.bodyMode.set('idle');
      this.pull = null;
      this.panelDragLift.set(null);
      // In karaoke, a swipe the panel did not own (up, or sideways) is a
      // reach for the lyrics: browse them (§3).
      if (this.karaokeFullscreen()) this.browse.interact();
    },
  });
  readonly dragging = this.bodySwipe.dragging;
  readonly resizingQueue = computed(() => this.bodyMode() === 'panel');

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

  // Swipe the sheet sideways to skip (#1297), the cover following the finger: started from the same pointerdown
  // as the body gesture, so the two resolve by dominance at slop and the first
  // to own the pointer makes the other release — never both.
  readonly coverSwipeOffsetPx = signal(0);
  private readonly coverSwipe = createHorizontalSwipe({
    resolve: () => 'own',
    onMove: (dx) => this.coverSwipeOffsetPx.set(dx),
    onEnd: ({ dx, velocity, owned }) => {
      this.coverSwipeOffsetPx.set(0);
      if (!owned) return;
      this.markGestureEnded();
      const direction = skipDirection(dx, velocity);
      if (!direction) return;
      haptic('commit');
      if (direction === 'next') this.handleNext();
      else this.handlePrev();
    },
    onRelease: () => this.coverSwipeOffsetPx.set(0),
  });
  readonly coverSwiping = this.coverSwipe.dragging;

  // A drag that starts on a neighbour sliver (#1652) is a drag of the cover:
  // gestureOrigin lets it past BODY_NO_SWIPE, and the click the browser still
  // fires on the sliver at the end of that drag is swallowed here, or one
  // gesture would skip twice (or skip and dismiss).
  private static readonly SLIVER_CLICK_AFTER_DRAG_MS = 500;
  private gestureEndedAt = Number.NEGATIVE_INFINITY;
  private markGestureEnded(): void {
    this.gestureEndedAt = Date.now();
  }
  onSliverSkip(direction: 'next' | 'prev'): void {
    if (Date.now() - this.gestureEndedAt < NowPlayingComponent.SLIVER_CLICK_AFTER_DRAG_MS) return;
    if (direction === 'next') this.handleNext();
    else this.handlePrev();
  }

  onBodyPointerDown(event: PointerEvent): void {
    // A fresh press is a fresh tap: a drag's click window never outlives it.
    this.gestureEndedAt = Number.NEGATIVE_INFINITY;
    // Beside the side column a down-pull would close the whole sheet from
    // karaoke; there it keeps its ✕ and Back, as before #1680.
    if (this.karaokeFullscreen() && this.lg()) return;
    const target = event.target;
    const origin = gestureOrigin(target);
    if (origin instanceof Element && origin.closest(NowPlayingComponent.BODY_NO_SWIPE)) return;
    // Anywhere on the sheet but its scrolling panel, not just the artwork: the
    // cover is 60vw wide, and a swipe that started beside it did nothing.
    if (canStartSheetSkip(target)) this.coverSwipe.start(event);
    this.bodySwipe.start(event);
  }

  // The panel machine's state (#1679, docs/player-panel.md): which tab, and
  // whether it rests under the transport or covers the sheet at `full`.
  // Persisted as one key; the two pre-#1679 keys migrate on first read.
  private static readonly COVER_MAX_PX = 320; // matches Tailwind max-w-80 (20rem)
  /** The registered tabs (#1681): the strip, the `lg` rule and the full chrome read them. */
  readonly panelTabs = inject(PLAYER_PANEL_TABS);
  readonly panelState = signal<PanelState>(
    restorePanelState(
      NowPlayingComponent.storage(),
      this.panelTabs.map((t) => t.id),
    ),
  );
  readonly activePanel = computed(() => this.panelState().tab);
  readonly activeTab = computed(
    () => this.panelTabs.find((t) => t.id === this.panelState().tab) ?? this.panelTabs[0],
  );
  /** D6: a full panel whose tab asks for it keeps play/pause and next above it. */
  readonly showCompactTransport = computed(
    () => this.panelFull() && this.activeTab()?.full.chrome === 'compact-transport',
  );
  // DERIVED from the panel state, not a second writable signal (issue #446):
  // karaoke used to open lyrics by writing a flag of its own, and the panel
  // that got persisted disagreed with the one on screen.
  readonly lyricsOpen = computed(() => this.activePanel() === 'lyrics');

  /** The side-column layout (`lg`), read live so a resize re-renders. */
  readonly lg = signal(isDesktopSheet());
  /** The snap this width shows: the side column has no `full` yet (§5). */
  readonly panelSnap = computed(() =>
    effectiveSnap(this.panelState(), {
      lg: this.lg(),
      // Karaoke covers the sheet at every width; a full queue beside the side
      // column buys nothing (§5).
      fullAtLg: !!this.activeTab()?.full.atLg,
    }),
  );
  /** `lift` at `full`, measured from the live layout when the panel moves. */
  readonly panelFullLiftPx = signal(0);
  /** The `lift` on screen: the finger's while a pull is owned, else the snap's. */
  readonly panelLiftPx = computed(() => {
    const drag = this.panelDragLift();
    if (drag !== null) return drag;
    return this.panelSnap() === 'full' ? this.panelFullLiftPx() : 0;
  });
  /** The frame slides over a stage that never reflows, so no cover-shrink
   *  phase: the whole `lift` is translation (`coverMaxPx: 0`). */
  readonly panelTopPx = computed(() => {
    const up = panelLayout(this.panelLiftPx(), {
      fullLiftPx: this.panelFullLiftPx(),
      coverMaxPx: 0,
    }).panelTranslatePx;
    return up === 0 ? 0 : -up;
  });
  readonly panelFull = computed(() => this.panelSnap() === 'full');
  /** Karaoke rides the pull down from `full` like the panel frame does. */
  readonly karaokeOffsetPx = computed(() => {
    const drag = this.panelDragLift();
    return drag === null ? 0 : Math.max(0, this.panelFullLiftPx() - drag);
  });
  /** The covered stage leaves the tab order at a settled `full` (§7). */
  readonly stageInert = computed(() => this.panelFull() && this.panelDragLift() === null);
  /** Cover art max-width (px). The panel covers the cover rather than shrinking it. */
  readonly coverMaxPx = computed(() => NowPlayingComponent.COVER_MAX_PX);

  /**
   * The live geometry a panel move needs. The frame's flow box never moves
   * (the frame is a layer above it), so its top is the panel's rest top at any
   * snap. Public so a spec can stand in for a layout jsdom does not have.
   */
  measurePanelGeometry(): PanelGeometry {
    const zone = this.host.nativeElement.querySelector<HTMLElement>('[data-np-zone="panel"]');
    const restTop = zone?.getBoundingClientRect().top ?? 0;
    return { fullLiftPx: Math.max(0, restTop - this.safeAreaTopPx()), coverMaxPx: 0 };
  }

  private safeAreaTopPx(): number {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;top:0;visibility:hidden;height:env(safe-area-inset-top, 0px)';
    document.body.appendChild(probe);
    const px = probe.getBoundingClientRect().height;
    probe.remove();
    return px;
  }

  private static storage():
    Storage | { getItem: () => null; setItem: () => void; removeItem: () => void } {
    try {
      return localStorage;
    } catch {
      return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    }
  }

  private setPanelState(next: PanelState): void {
    const prev = this.panelState();
    if (next.snap === 'full' && prev.snap !== 'full') {
      this.panelFullLiftPx.set(this.measurePanelGeometry().fullLiftPx);
    }
    const wasKaraoke = this.karaokeFullscreen();
    this.panelState.set(next);
    persistPanelState(NowPlayingComponent.storage(), next);
    // Here, not in an effect: an effect never sees an enter and exit in one tick.
    if (this.karaokeFullscreen() !== wasKaraoke) this.onKaraokeChanged(!wasKaraoke);
  }

  /** Karaoke starts in auto-follow; entering focuses it so the arrows work at once. */
  private onKaraokeChanged(entered: boolean): void {
    this.browse.leave();
    if (!entered) return;
    const track = this.player.currentTrack();
    if (track) this.extractColorsOnce(track);
    setTimeout(() => this.karaokeFullscreenPanel()?.overlayRef()?.nativeElement.focus(), 0);
  }

  /** A discrete panel event (tab tap, notch, keys, Back), through the machine. */
  panelEvent(event: PanelEvent): boolean {
    // A tab with no `full` beside the side column: its active tab is a no-op.
    const noFullHere = this.lg() && !this.activeTab()?.full.atLg;
    if (noFullHere && event.type !== 'tap-tab' && event.type !== 'back') return false;
    if (noFullHere && event.type === 'tap-tab' && event.tab === this.panelState().tab) return false;
    const { state, consumed } = transition(this.panelState(), event);
    if (consumed) this.setPanelState(state);
    return consumed;
  }

  onTabSelected(tab: string): void {
    this.panelEvent({ type: 'tap-tab', tab });
  }

  /** The notch toggles `rest` ↔ `full`; the click a drag leaves behind does not. */
  onNotchClick(): void {
    if (Date.now() - this.gestureEndedAt < NowPlayingComponent.SLIVER_CLICK_AFTER_DRAG_MS) return;
    this.panelEvent({ type: 'notch-activate' });
  }

  onNotchKeydown(event: KeyboardEvent): void {
    const map: Record<string, PanelEvent | undefined> = {
      Enter: { type: 'notch-activate' },
      ' ': { type: 'notch-activate' },
      ArrowUp: { type: 'key-up' },
      ArrowDown: { type: 'key-down' },
    };
    const panelEvent = map[event.key];
    if (!panelEvent) return;
    event.preventDefault();
    this.panelEvent(panelEvent);
  }

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
    if (!this.isTv || !track || !this.player.nowPlayingOpen()) return null;
    return this.coverSrc(track, 600) ?? null;
  });

  /** Head of the queue, shown in the TV Next-up chip. */
  readonly nextUp = computed(() => this.player.queue()[0] ?? null);

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

  /** Switch the panel's tab, keeping its snap (karaoke, Q / Y). */
  setActivePanel(panel: string): void {
    this.setPanelState({ ...this.panelState(), tab: panel });
  }

  private readonly backButton = inject(BackButtonService);

  constructor() {
    // Hardware Back (issue #394): exit karaoke first, then close the sheet.
    // Persistent + state-checked so transient overlays (menus, track info)
    // pushed while open always sit above it on the stack.
    const unregisterBack = this.backButton.stack.push(() => {
      // A `full` panel (karaoke included) comes down to `rest` before the sheet closes.
      if (this.player.nowPlayingOpen() && this.panelEvent({ type: 'back' })) return true;
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
      if (!track) return;
      if (!this.lyricsOpen()) return;
      this.extractColorsOnce(track);
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

    // `lg` and the `full` geometry follow the window.
    const onResize = (): void => {
      this.lg.set(isDesktopSheet());
      if (this.panelFull()) this.panelFullLiftPx.set(this.measurePanelGeometry().fullLiftPx);
    };
    window.addEventListener('resize', onResize);
    this.destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
    // A sheet that opens onto a restored `full` measures once it is laid out.
    effect(() => {
      if (!this.player.nowPlayingOpen() || !this.panelFull()) return;
      untracked(() =>
        requestAnimationFrame(() =>
          this.panelFullLiftPx.set(this.measurePanelGeometry().fullLiftPx),
        ),
      );
    });
  }

  /** The lyrics panel's expand button and karaoke's ✕: Lyrics at `full` ↔ `rest`. */
  toggleKaraokeFullscreen(): void {
    if (this.karaokeFullscreen()) {
      this.setPanelState({ ...this.panelState(), snap: 'rest' });
      return;
    }
    this.setPanelState({ tab: 'lyrics', snap: 'full' });
  }

  /** A track's cover, resolved, at its album's live cover rev (#1666). */
  private coverSrc(track: Track, size: number): string | undefined {
    const url = this.coverRevisions.url(songCover(track), size, this.auth.mediaToken());
    return url ? this.server.apiUrl(url) : undefined;
  }

  /** Extract the palette once per (track, cover rev): a cover replaced while
   *  the track plays re-extracts, a re-render of the same one does not. */
  private extractColorsOnce(track: Track): void {
    const ref = songCover(track);
    if (!ref) return;
    const key = `${track.id}@${this.coverRevisions.effective(ref)}`;
    if (this.colorExtractedFor === key) return;
    this.colorExtractedFor = key;
    const url = this.coverSrc(track, 80);
    if (url) this.extractColorsFromImage(url);
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

  /** The timing editor (#1675): an overlay over the sheet, curators only. */
  readonly timingEditorOpen = signal(false);
  readonly timingSaving = signal(false);
  /** The draft's starting rows, taken once when the editor opens. */
  readonly timingRows = signal<TimingRow[]>([]);
  private timingSongId: string | null = null;
  /** The element's clock on this device; the remote clock when casting. */
  readonly timingClock = (): number =>
    (this.isActiveDevice() ? this.player.elementTime() : this.displayTime()) * 1000;

  openTimingEditor(): void {
    const id = this.player.currentTrack()?.id;
    if (!id || !this.auth.canCurate()) return;
    this.timingSongId = id;
    this.timingRows.set(rowsFromLyrics(this.lyrics()));
    this.timingEditorOpen.set(true);
  }

  closeTimingEditor(): void {
    this.timingEditorOpen.set(false);
  }

  /** Saves against the song the editor opened on, even if playback moved on. */
  saveTiming(body: { plain: string; synced: string }): void {
    const id = this.timingSongId;
    if (!id || this.timingSaving()) return;
    this.timingSaving.set(true);
    this.lyricsSvc.save(id, body.plain, body.synced).subscribe({
      next: () => {
        this.timingSaving.set(false);
        this.timingEditorOpen.set(false);
      },
      error: () => this.timingSaving.set(false),
    });
  }

  /** "Undo last change" (#1960): put back the one previous version. */
  readonly undoingLyrics = signal(false);
  undoLyricsChange(): void {
    const id = this.player.currentTrack()?.id;
    if (!id || this.undoingLyrics()) return;
    this.undoingLyrics.set(true);
    const done = () => this.undoingLyrics.set(false);
    this.lyricsSvc.undo(id).subscribe({ next: done, error: done });
  }

  tryAnotherLyricsSource(): void {
    const id = this.player.currentTrack()?.id;
    if (!id) return;
    this.lyricsSvc.tryAnother(id, () =>
      this.confirm.ask(this.i18n.t('trackInfo.lyricsRefetchReplacesEdit'), {
        confirmLabel: this.i18n.t('trackInfo.lyricsRefetchReplacesEditConfirm'),
        cancelLabel: this.i18n.t('trackInfo.lyricsRefetchKeepEdit'),
      }),
    );
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
    // Offline the artist page needs the server: the saved songs by name (#1751).
    if (this.offlineMode.isOffline())
      return void this.router.navigate(...offlineFind(track.artist));
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
      coverRev: t?.coverRev,
      albumId: t?.albumId ?? null,
    });
  }
}
