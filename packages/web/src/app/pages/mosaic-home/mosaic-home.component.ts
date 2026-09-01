import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { catchError, firstValueFrom, of } from 'rxjs';
import type { LibraryFilter } from '@nicotind/core';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';
import { TranslateService } from '../../services/translate.service';
import { TrackInfoService } from '../../services/track-info.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { HistoryApiService } from '../../services/api/history-api.service';
import { PlaylistsApiService } from '../../services/api/playlists-api.service';
import { ToastService } from '../../services/toast.service';
import { SkeletonComponent } from '../../components/skeleton/skeleton.component';
import { placeholderGradient } from '../../components/cover-art/cover-art.component';
import { createPointerDrag } from '../../lib/pointer-drag';
import { measureBottomChromeInset } from '../../lib/player-chrome';
import { coverSizeBucket, coverUrl } from '../../lib/cover-url';
import { toTrack } from '../../lib/track-utils';
import {
  assignSongsToSlots,
  buildMosaicTiles,
  playWeights,
  tileSize,
  type MosaicTile,
  type PlayWeights,
} from '../../lib/mosaic-tiles';
import { packMosaic, type PackedTile, type Packing } from '../../lib/mosaic-packing';
import { decayVelocity, visiblePlacements } from '../../lib/mosaic-lens';

/** Pointer travel, in px, above which a pointerup is a pan and not a tap. */
const TAP_SLOP_PX = 6;
/** Camera px per pointer px. >1 makes the plane feel light under the finger. */
const PAN_GAIN = 1.2;
/** Hold duration that turns a press into "show me this track's info". */
const LONG_PRESS_MS = 450;

/** The one torus cell that shows the curated home tiles. */
const HOME_CELL = '0,0';
/** Discovery cells kept in memory; beyond this, stale cells are evicted. */
const MAX_CACHED_CELLS = 16;
/** A cell unseen for this many frames is fair game for eviction. */
const CELL_STALE_FRAMES = 60;
/** The hidden accessible list mirrors discovery, capped so it cannot grow forever. */
const DISCOVERED_LIST_CAP = 400;

/** A discovery cell's face while its batch is in flight. */
const LOADING_FACE_HTML = '<div class="mosaic-face skeleton-block"></div>';

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

interface PoolRecord {
  el: HTMLElement;
  transform: string;
  opacity: string;
  stamp: number;
  /** Content key last written into the element; '' when freshly acquired. */
  content: string;
}

/**
 * What a torus cell shows: 'loading' while its batch is in flight, a slot→tile
 * map once it lands, or 'base' — the home copy — when the fetch failed or the
 * library had nothing to give, so a bad network degrades to the old repeating
 * behaviour instead of a hole in the plane.
 */
type CellState = 'loading' | 'base' | Map<number, MosaicTile>;

interface TileContent {
  key: string;
  html: string;
  kind: string;
}

/**
 * The landing: one infinite, pannable mosaic where **every tile starts a radio**.
 *
 * Composed from exactly the sources the classic landing uses (resume, keep the
 * vibe, taste breakers, recently played, curated playlists, vibe presets, top
 * genres) — but collapsed into one surface with one verb, so tapping a cover
 * always means the same thing. The classic landing lives on at /classic.
 *
 * The plane is a packed square patch repeated on a torus, viewed through an
 * orthographic lens (lib/mosaic-lens.ts). The geometry repeats; the content
 * does not: every torus cell except home fills the same slots with a fresh
 * random batch fetched the first time the cell is sighted, so panning keeps
 * surfacing new music instead of looping the same eighty tiles. The maths is
 * pure and unit-tested; this component owns only the DOM pool, the rAF loop,
 * the drag and the per-cell fetches.
 *
 * The loop writes element transforms and never a signal. The app is zoneless
 * (no zone.js dependency), so it costs no change detection and needs no
 * `runOutsideAngular`.
 *
 * Pull-to-refresh disables itself here: the layout gesture is gated on
 * `PullToRefreshService.hasHandler()` and this page registers no handler, so a
 * downward drag pans the mosaic instead of fighting the pull.
 */
@Component({
  selector: 'app-mosaic-home',
  standalone: true,
  imports: [SkeletonComponent],
  templateUrl: './mosaic-home.component.html',
})
export class MosaicHomeComponent implements OnInit {
  private player = inject(PlayerService);
  private api = inject(LibraryApiService);
  private history = inject(HistoryApiService);
  private playlistsApi = inject(PlaylistsApiService);
  private auth = inject(AuthService);
  private server = inject(ServerConfigService);
  private i18n = inject(TranslateService);
  private toast = inject(ToastService);
  private trackInfo = inject(TrackInfoService);

  private stageRef = viewChild<ElementRef<HTMLDivElement>>('stage');

  readonly loading = signal(true);
  readonly tiles = signal<MosaicTile[]>([]);
  readonly starting = signal<string | null>(null);
  readonly chromeInset = signal(0);
  readonly isEmpty = computed(() => !this.loading() && this.tiles().length === 0);
  /** Tiles the discovery cells have surfaced, mirrored into the accessible list. */
  readonly discovered = signal<MosaicTile[]>([]);

  /** Vibe titles are i18n keys; everything else is already a display string. */
  label(tile: MosaicTile): string {
    return tile.kind === 'vibe' ? this.i18n.t(tile.title) : tile.title;
  }

  // --- Camera + loop state (plain fields: written every frame, never rendered) ---
  private packing: Packing | null = null;
  private lensRadius = 600;
  private cx = 0;
  private cy = 0;
  private vx = 0;
  private vy = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private raf = 0;
  private running = false;
  private stamp = 0;
  private live = new Map<string, PoolRecord>();
  private pool: HTMLElement[] = [];
  /** Rendered face markup by content key (`h:<id>` home, `<cell>:<id>` discovery). */
  private html = new Map<string, string>();
  private byId = new Map<number, PackedTile>();
  private reducedMotion = false;

  // --- Discovery cells ---
  private cells = new Map<string, CellState>();
  private cellStamp = new Map<string, number>();
  private weights: PlayWeights = playWeights(null);

  // --- Long press ---
  private pressTimer = 0;
  private suppressTap = false;

  readonly drag = createPointerDrag({
    onStart: (e) => {
      this.dragging = true;
      this.moved = 0;
      this.suppressTap = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.vx = 0;
      this.vy = 0;
      this.stageRef()?.nativeElement.classList.add('cursor-grabbing');
      const tile = this.tileFromEvent(e);
      if (tile) this.schedulePress(tile);
    },
    onMove: (e) => {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.moved += Math.abs(dx) + Math.abs(dy);
      if (this.moved > TAP_SLOP_PX) this.cancelPress();
      this.cx -= dx * PAN_GAIN;
      this.cy -= dy * PAN_GAIN;
      this.vx = -dx * PAN_GAIN;
      this.vy = -dy * PAN_GAIN;
    },
    onEnd: () => {
      this.dragging = false;
      this.cancelPress();
      this.stageRef()?.nativeElement.classList.remove('cursor-grabbing');
    },
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.reducedMotion =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Repack whenever the tile set changes; the stage element is available by
    // then because tiles only arrive after the first render.
    effect(() => {
      this.tiles();
      queueMicrotask(() => this.repack());
    });

    // The loop, and everything that starts or stops it.
    effect((onCleanup) => {
      const stage = this.stageRef()?.nativeElement;
      if (!stage) return;

      const start = (): void => {
        if (this.running) return;
        this.running = true;
        this.raf = requestAnimationFrame(this.frame);
      };
      const stop = (): void => {
        this.running = false;
        cancelAnimationFrame(this.raf);
      };

      // Repack on resize: tile size is derived from the stage's short side, so
      // a rotation or window resize invalidates the whole packing.
      const ro = new ResizeObserver(() => {
        this.chromeInset.set(measureBottomChromeInset());
        this.repack();
      });
      ro.observe(stage);

      // Never animate a stage nobody is looking at.
      const io = new IntersectionObserver(
        (entries) => (entries[0].isIntersecting ? start() : stop()),
        {
          threshold: 0,
        },
      );
      io.observe(stage);

      const onVisibility = (): void => (document.hidden ? stop() : start());
      document.addEventListener('visibilitychange', onVisibility);

      const onClick = (e: MouseEvent): void => this.onStageClick(e);
      stage.addEventListener('click', onClick);

      start();
      onCleanup(() => {
        stop();
        ro.disconnect();
        io.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        stage.removeEventListener('click', onClick);
      });
    });

    destroyRef.onDestroy(() => {
      cancelAnimationFrame(this.raf);
      this.running = false;
      this.cancelPress();
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  /**
   * Load every source. Each lane degrades independently — one failing endpoint
   * must cost its own tiles, not the whole mosaic.
   */
  private async load(): Promise<void> {
    const [recentPlays, tasteBreakers, playlistsRes, genres, stats] = await Promise.all([
      firstValueFrom(this.history.getRecentPlays(20).pipe(catchError(() => of([])))),
      firstValueFrom(this.api.getRandomSongs(24).pipe(catchError(() => of([])))),
      firstValueFrom(
        this.playlistsApi.getPlaylists().pipe(catchError(() => of({ playlists: [] }))),
      ),
      firstValueFrom(this.api.getGenres().pipe(catchError(() => of([])))),
      firstValueFrom(this.history.getStats('all').pipe(catchError(() => of(null)))),
    ]);

    // Keep-the-vibe is seeded by the recent plays, so it can only run second.
    const seedIds = recentPlays.map((p) => p.songId);
    const keepVibe = seedIds.length
      ? await firstValueFrom(this.api.getListRadio(seedIds, 10).pipe(catchError(() => of([]))))
      : [];

    // The discovery cells score their batches with the same personal weights.
    this.weights = playWeights(stats);

    this.tiles.set(
      buildMosaicTiles({
        resume: this.player.currentTrack(),
        keepVibe,
        tasteBreakers,
        recentPlays,
        playlists: playlistsRes.playlists.filter((p) => p.kind === 'curated').slice(0, 10),
        genres: genres.slice(0, 8),
        stats,
      }),
    );
    this.loading.set(false);
  }

  /**
   * Fetch one discovery cell's batch. Sized to the patch so a full cell can
   * fill every slot; a failure or an empty answer falls back to the home copy
   * ('base'), never to a retry loop — the cell retries only after eviction.
   */
  private async loadCell(cell: string): Promise<void> {
    const packing = this.packing;
    if (!packing) return;
    const songs = await firstValueFrom(
      this.api.getRandomSongs(packing.tiles.length).pipe(catchError(() => of([]))),
    );
    if (this.cells.get(cell) !== 'loading') return; // evicted while in flight
    if (!songs.length) {
      this.cells.set(cell, 'base');
      return;
    }
    const slots = assignSongsToSlots(packing.tiles, songs, this.weights);
    this.cells.set(cell, slots);
    this.appendDiscovered(slots);
  }

  /** Mirror a cell's new tiles into the accessible list, deduped and capped. */
  private appendDiscovered(slots: Map<number, MosaicTile>): void {
    const known = new Set<string>();
    for (const t of this.tiles()) known.add(t.key);
    for (const t of this.discovered()) known.add(t.key);
    const fresh = [...slots.values()].filter((t) => !known.has(t.key));
    if (fresh.length) {
      this.discovered.update((d) => [...d, ...fresh].slice(-DISCOVERED_LIST_CAP));
    }
  }

  // -------------------------------------------------------------------------
  // Actions — every one of them starts a radio
  // -------------------------------------------------------------------------

  async start(tile: MosaicTile): Promise<void> {
    if (this.starting()) return;
    this.starting.set(tile.key);
    try {
      switch (tile.action.type) {
        case 'song':
          this.player.startRadio(tile.action.track);
          break;
        case 'playlist':
          await this.startPlaylistRadio(tile.action.playlistId);
          break;
        case 'filter':
          await this.startFilterRadio(tile.action.filter);
          break;
      }
      this.player.nowPlayingOpen.set(true);
    } catch {
      this.toast.show({ message: "Couldn't start radio — try again", kind: 'error' });
    } finally {
      this.starting.set(null);
    }
  }

  private async startFilterRadio(filter: LibraryFilter): Promise<void> {
    const songs = await firstValueFrom(this.api.getFilterRadio(filter, [], 20));
    if (!songs.length) {
      this.toast.show({ message: 'No tracks match that vibe yet', kind: 'info' });
      return;
    }
    this.player.startRadioWithFilter(
      songs.map((s) => toTrack(s)),
      filter,
    );
  }

  private async startPlaylistRadio(playlistId: string): Promise<void> {
    const detail = await firstValueFrom(this.playlistsApi.getPlaylist(playlistId));
    if (!detail.songs.length) {
      this.toast.show({ message: 'That playlist is empty', kind: 'info' });
      return;
    }
    this.player.startRadioWithTracks(detail.songs.map((s) => toTrack(s)));
  }

  /**
   * Delegated tap handling. One listener beats re-binding a handler onto every
   * element as it cycles through the pool — and the pool is the reason a tile's
   * own `onclick` would go stale.
   *
   * The slop test is load-bearing: without it every attempt to pan the mosaic
   * ends in a pointerup on a tile and starts a radio. The suppress flag is the
   * same idea for a long press: the release that follows the hold must not
   * start a radio under the sheet it just opened.
   */
  private onStageClick(e: MouseEvent): void {
    if (this.suppressTap) {
      this.suppressTap = false;
      return;
    }
    if (this.moved > TAP_SLOP_PX) return;
    const tile = this.tileFromEvent(e);
    if (tile) void this.start(tile);
  }

  /** The tile an event landed on, resolved through the cell's content mapping. */
  private tileFromEvent(e: Event): MosaicTile | null {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tile-id]');
    if (!el) return null;
    const packed = this.byId.get(Number(el.dataset['tileId']));
    if (!packed) return null;
    const cell = el.dataset['cell'] ?? HOME_CELL;
    if (cell === HOME_CELL) return packed.tile;
    const state = this.cells.get(cell);
    if (state === 'base') return packed.tile;
    if (state instanceof Map) return state.get(packed.id) ?? null;
    return null; // still loading — a placeholder face is not activatable
  }

  // -------------------------------------------------------------------------
  // Long press → quick info
  // -------------------------------------------------------------------------

  /** Arm the hold-for-info timer; only song-backed tiles carry track info. */
  private schedulePress(tile: MosaicTile): void {
    if (tile.action.type !== 'song') return;
    const track = tile.action.track;
    this.pressTimer = window.setTimeout(() => {
      this.suppressTap = true;
      this.trackInfo.open({
        songId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        coverArt: track.coverArt ?? null,
      });
    }, LONG_PRESS_MS);
  }

  private cancelPress(): void {
    clearTimeout(this.pressTimer);
  }

  // -------------------------------------------------------------------------
  // Packing + render
  // -------------------------------------------------------------------------

  private repack(): void {
    const stage = this.stageRef()?.nativeElement;
    const list = this.tiles();
    if (!stage || list.length === 0) {
      this.packing = null;
      return;
    }
    const stageMin = Math.max(1, Math.min(stage.clientWidth, stage.clientHeight));
    if (stageMin <= 1) return;

    this.packing = packMosaic(list, (t) => tileSize(t.score, stageMin));
    this.lensRadius = stageMin;
    this.cx = this.packing.W / 2;
    this.cy = this.packing.W / 2;

    this.html.clear();
    this.byId.clear();
    for (const p of this.packing.tiles) {
      this.html.set(`h:${p.id}`, this.tileHtml(p, p.tile));
      this.byId.set(p.id, p);
    }
    // Slot ids changed, so every cell's slot mapping is stale with them.
    this.cells.clear();
    this.cellStamp.clear();
    this.discovered.set([]);
    // Every pooled element now holds markup for a stale packing.
    for (const rec of this.live.values()) rec.el.remove();
    this.live.clear();
    this.pool.length = 0;
  }

  private tileHtml(p: PackedTile, t: MosaicTile): string {
    const s = p.size;
    const titleSize = s > 180 ? 17 : s > 130 ? 15 : 13;
    const title = escapeHtml(this.label(t));
    const subtitle = escapeHtml(t.subtitle);

    if (t.kind === 'vibe') {
      return `<div class="mosaic-face bg-gradient-to-br ${t.gradient} text-white">
        <span style="font-size:${Math.round(s * 0.22)}px" aria-hidden="true">${t.emoji ?? ''}</span>
        <div><b style="font-size:${titleSize}px">${title}</b><span>${subtitle}</span></div>
      </div>`;
    }

    if (t.kind === 'genre') {
      return `<div class="mosaic-face bg-theme-surface-2 text-theme-secondary">
        <span class="mosaic-dot"></span>
        <div><b style="font-size:${titleSize}px">${title}</b><span>${subtitle}</span></div>
      </div>`;
    }

    // Song, resume and playlist faces: cover behind a bottom scrim. The
    // placeholder gradient sits underneath, so a missing or slow cover still
    // reads as a deliberate tile rather than a hole.
    const fallback = placeholderGradient(t.subtitle, t.title);
    const cover = t.coverArt
      ? this.server.apiUrl(coverUrl(t.coverArt, coverSizeBucket(s), this.auth.token()))
      : null;
    const bg = cover
      ? `background-image:url('${encodeURI(cover)}'),${fallback};background-size:cover;background-position:center`
      : `background-image:${fallback}`;
    return `<div class="mosaic-face text-white" style="${bg}">
      <div class="mosaic-scrim"><b style="font-size:${titleSize}px">${title}</b><span>${subtitle}</span></div>
    </div>`;
  }

  /**
   * What a slot shows in a given cell. Home shows the packed tile; any other
   * cell shows its own batch (fetched on first sighting), a pulsing
   * placeholder while it loads, or `null` when the batch ran out of songs for
   * this slot — the renderer simply skips those.
   */
  private contentFor(p: PackedTile, cell: string): TileContent | null {
    if (cell !== HOME_CELL) {
      const state = this.cells.get(cell) ?? this.enterCell(cell);
      if (state === 'loading') return { key: 'loading', html: LOADING_FACE_HTML, kind: 'loading' };
      if (state instanceof Map) {
        const tile = state.get(p.id);
        if (!tile) return null;
        const key = `${cell}:${p.id}`;
        let html = this.html.get(key);
        if (html === undefined) {
          html = this.tileHtml(p, tile);
          this.html.set(key, html);
        }
        return { key, html, kind: tile.kind };
      }
      // 'base' falls through to the home copy.
    }
    return { key: `h:${p.id}`, html: this.html.get(`h:${p.id}`) ?? '', kind: p.tile.kind };
  }

  /** First sighting of a cell: reserve it, evict stale ones, start its fetch. */
  private enterCell(cell: string): CellState {
    this.cells.set(cell, 'loading');
    this.evictStaleCells();
    void this.loadCell(cell);
    return 'loading';
  }

  /**
   * Drop the oldest cells nobody has looked at recently, and their cached
   * markup with them. An evicted cell refetches on its next sighting — new
   * content, which for a random batch is no loss at all.
   */
  private evictStaleCells(): void {
    if (this.cells.size <= MAX_CACHED_CELLS) return;
    for (const key of this.cells.keys()) {
      if ((this.cellStamp.get(key) ?? 0) >= this.stamp - CELL_STALE_FRAMES) continue;
      this.cells.delete(key);
      this.cellStamp.delete(key);
      for (const k of this.html.keys()) if (k.startsWith(`${key}:`)) this.html.delete(k);
      if (this.cells.size <= MAX_CACHED_CELLS) return;
    }
  }

  private acquire(key: string, p: PackedTile): PoolRecord {
    let el = this.pool.pop();
    if (!el) {
      el = document.createElement('div');
      el.className = 'mosaic-tile';
      this.stageRef()?.nativeElement.appendChild(el);
    }
    el.style.width = `${p.size}px`;
    el.style.height = `${p.size}px`;
    el.style.display = '';
    el.dataset['tileId'] = String(p.id);
    el.setAttribute('data-testid', 'mosaic-tile');
    const rec: PoolRecord = { el, transform: '', opacity: '', stamp: 0, content: '' };
    this.live.set(key, rec);
    return rec;
  }

  private pop(el: HTMLElement): void {
    if (this.reducedMotion) return;
    const face = el.firstElementChild as HTMLElement | null;
    if (!face) return;
    face.style.animationDelay = `${(Math.random() * 150) | 0}ms`;
    face.classList.add('mosaic-pop');
  }

  private frame = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);

    const stage = this.stageRef()?.nativeElement;
    const packing = this.packing;
    if (!stage || !packing) return;

    if (!this.dragging) {
      this.cx += this.vx;
      this.cy += this.vy;
      // Friction with a hard snap to zero — the mosaic comes to an actual
      // stop instead of creeping sub-pixel forever (there is deliberately no
      // idle drift; a resting mosaic is at rest).
      ({ vx: this.vx, vy: this.vy } = decayVelocity(this.vx, this.vy));
    }

    const view = { w: stage.clientWidth, h: stage.clientHeight };
    const placements = visiblePlacements(
      packing.tiles,
      { x: this.cx, y: this.cy },
      view,
      packing.W,
      this.lensRadius,
    );

    this.stamp++;
    for (const pl of placements) {
      const cell = `${pl.i},${pl.j}`;
      if (cell !== HOME_CELL) this.cellStamp.set(cell, this.stamp);
      const content = this.contentFor(pl.packed, cell);
      if (content === null) continue; // unassigned discovery slot — leave empty

      let rec = this.live.get(pl.key);
      if (!rec) rec = this.acquire(pl.key, pl.packed);
      rec.stamp = this.stamp;
      if (rec.content !== content.key) {
        rec.el.innerHTML = content.html;
        rec.el.dataset['cell'] = cell;
        rec.el.dataset['tileKind'] = content.kind;
        rec.content = content.key;
        this.pop(rec.el);
      }
      const transform = `translate(${pl.left.toFixed(1)}px,${pl.top.toFixed(1)}px) scale(${pl.scale.toFixed(3)})`;
      if (transform !== rec.transform) {
        rec.el.style.transform = transform;
        rec.transform = transform;
      }
      const opacity = pl.opacity.toFixed(2);
      if (opacity !== rec.opacity) {
        rec.el.style.opacity = opacity;
        rec.opacity = opacity;
      }
    }

    // Anything not touched this frame has left the lens — park it for reuse.
    for (const [key, rec] of this.live) {
      if (rec.stamp !== this.stamp) {
        rec.el.style.display = 'none';
        this.pool.push(rec.el);
        this.live.delete(key);
      }
    }
  };
}
