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
import { buildMosaicTiles, tileSize, type MosaicTile } from '../../lib/mosaic-tiles';
import { packMosaic, type PackedTile, type Packing } from '../../lib/mosaic-packing';
import { visiblePlacements } from '../../lib/mosaic-lens';

/** Pointer travel, in px, above which a pointerup is a pan and not a tap. */
const TAP_SLOP_PX = 6;
/** Camera px per pointer px. >1 makes the plane feel light under the finger. */
const PAN_GAIN = 1.2;
/** Per-frame velocity decay after release. */
const FRICTION = 0.94;
/** Frames at rest before the idle drift starts. */
const IDLE_FRAMES = 60;
/** Velocity² below which the camera counts as stopped. */
const REST_EPSILON = 0.0025;

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
 * orthographic lens (lib/mosaic-lens.ts). The maths is pure and unit-tested;
 * this component owns only the DOM pool, the rAF loop and the drag.
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

  private stageRef = viewChild<ElementRef<HTMLDivElement>>('stage');

  readonly loading = signal(true);
  readonly tiles = signal<MosaicTile[]>([]);
  readonly starting = signal<string | null>(null);
  readonly chromeInset = signal(0);
  readonly isEmpty = computed(() => !this.loading() && this.tiles().length === 0);

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
  private idle = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private raf = 0;
  private running = false;
  private stamp = 0;
  private live = new Map<string, PoolRecord>();
  private pool: HTMLElement[] = [];
  private html = new Map<number, string>();
  private byId = new Map<number, PackedTile>();
  private reducedMotion = false;

  readonly drag = createPointerDrag({
    onStart: (e) => {
      this.dragging = true;
      this.idle = 0;
      this.moved = 0;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.vx = 0;
      this.vy = 0;
      this.stageRef()?.nativeElement.classList.add('cursor-grabbing');
    },
    onMove: (e) => {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.moved += Math.abs(dx) + Math.abs(dy);
      this.cx -= dx * PAN_GAIN;
      this.cy -= dy * PAN_GAIN;
      this.vx = -dx * PAN_GAIN;
      this.vy = -dy * PAN_GAIN;
    },
    onEnd: () => {
      this.dragging = false;
      this.idle = 0;
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
   * ends in a pointerup on a tile and starts a radio.
   */
  private onStageClick(e: MouseEvent): void {
    if (this.moved > TAP_SLOP_PX) return;
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tile-id]');
    const id = el?.dataset['tileId'];
    if (id === undefined) return;
    const packed = this.byId.get(Number(id));
    if (packed) void this.start(packed.tile);
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
      this.html.set(p.id, this.tileHtml(p));
      this.byId.set(p.id, p);
    }
    // Every pooled element now holds markup for a stale packing.
    for (const rec of this.live.values()) rec.el.remove();
    this.live.clear();
    this.pool.length = 0;
  }

  private tileHtml(p: PackedTile): string {
    const t = p.tile;
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
    el.dataset['tileKind'] = p.tile.kind;
    el.setAttribute('data-testid', 'mosaic-tile');
    el.innerHTML = this.html.get(p.id) ?? '';
    if (!this.reducedMotion) {
      const face = el.firstElementChild as HTMLElement | null;
      if (face) {
        face.style.animationDelay = `${(Math.random() * 150) | 0}ms`;
        face.classList.add('mosaic-pop');
      }
    }
    const rec: PoolRecord = { el, transform: '', opacity: '', stamp: 0 };
    this.live.set(key, rec);
    return rec;
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
      this.vx *= FRICTION;
      this.vy *= FRICTION;
      this.idle++;
      const resting = this.vx * this.vx + this.vy * this.vy < REST_EPSILON;
      if (!this.reducedMotion && this.idle > IDLE_FRAMES && resting) {
        this.vx = 0.3;
        this.vy = 0.1;
      }
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
      let rec = this.live.get(pl.key);
      if (!rec) rec = this.acquire(pl.key, pl.packed);
      rec.stamp = this.stamp;
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
