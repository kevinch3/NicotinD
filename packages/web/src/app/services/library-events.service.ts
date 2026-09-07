import { Injectable, Injector, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { ServerConfigService } from './server-config.service';
import { LibraryApiService } from './api/library-api.service';

/** Mirror of the API's `LibraryEvent` union (services/library-events.ts). */
export type LibraryEvent =
  | { type: 'songs.landed'; songIds: string[]; albumIds: string[] }
  | { type: 'songs.deleted'; songIds: string[]; albumIds: string[] }
  | { type: 'album.changed'; albumId: string }
  | { type: 'artist.changed'; artistId: string }
  | { type: 'artwork.changed'; albumId: string; coverArt: string | null; version: number }
  | { type: 'job.changed'; jobId: string };

export interface StampedEvent {
  seq: number;
  at: number;
  event: LibraryEvent;
}

/** How long a hidden tab keeps its stream before letting go (#717 discipline). */
export const HIDDEN_GRACE_MS = 30_000;

/**
 * The client end of `GET /api/library/events`: one server-sent-events stream
 * per visible tab, through which an open page learns that songs landed or were
 * deleted, an album/artist changed, artwork was replaced, or a download job
 * moved — without polling or a reload. See docs/cache-invalidation.md "Live
 * invalidation".
 *
 * Stands down like every poller here: the stream closes `HIDDEN_GRACE_MS`
 * after the tab hides and reopens on return, asking for everything since the
 * last seq it saw. A gap (the server's buffer no longer reaches that seq) or an
 * explicit `resync` drops the cached whole-library reads and bumps `resync` so
 * pages that care can refetch.
 *
 * Deliberately a plain `EventSource`: reconnection and `Last-Event-ID` are
 * built in, and the URL comes from `ServerConfigService.sseUrl` so the token
 * and the service-worker bypass are never hand-built (docs/web-ui.md).
 */
@Injectable({ providedIn: 'root' })
export class LibraryEventsService {
  // Lazy: AuthService reaches TransferService, which injects this service —
  // resolving it at open time keeps the graph acyclic.
  private readonly injector = inject(Injector);
  private readonly server = inject(ServerConfigService);
  private readonly libraryApi = inject(LibraryApiService);

  readonly connected = signal(false);
  /** Album ids that just gained songs; consumers clear what they consumed. */
  readonly landedAlbumIds = signal<ReadonlySet<string>>(new Set());
  readonly deletedSongIds = signal<ReadonlySet<string>>(new Set());
  /** Latest change per album/artist, keyed by id → seq (grows monotonically). */
  readonly changedAlbums = signal<ReadonlyMap<string, number>>(new Map());
  readonly changedArtists = signal<ReadonlyMap<string, number>>(new Map());
  /** Cover version per album, for cache-busting `/api/cover/:id` URLs. */
  readonly artworkVersions = signal<ReadonlyMap<string, number>>(new Map());
  readonly jobsChanged$ = new Subject<string>();
  /** Incremented when the stream could not replay a gap: refetch everything. */
  readonly resync = signal(0);

  private source: EventSource | null = null;
  private lastSeq = 0;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private readonly onVisibility = () => this.applyVisibility();

  start(): void {
    if (this.started) return;
    this.started = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.applyVisibility();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.clearHideTimer();
    this.close();
  }

  /** Forget landed ids a consumer has acted on. */
  consumeLanded(ids: Iterable<string>): void {
    const drop = new Set(ids);
    this.landedAlbumIds.update((s) => new Set([...s].filter((id) => !drop.has(id))));
  }

  private applyVisibility(): void {
    if (document.visibilityState === 'hidden') {
      if (this.source && this.hideTimer === null) {
        this.hideTimer = setTimeout(() => {
          this.hideTimer = null;
          this.close();
        }, HIDDEN_GRACE_MS);
      }
      return;
    }
    this.clearHideTimer();
    if (!this.source) this.open();
  }

  private open(): void {
    // Tolerant of a partial AuthService (host specs stub it): no token, no stream.
    const auth = this.injector.get(AuthService, null) as { token?: () => string | null } | null;
    const token = typeof auth?.token === 'function' ? auth.token() : null;
    if (!token || typeof EventSource === 'undefined') return;
    const since = this.lastSeq > 0 ? `&since=${this.lastSeq}` : '';
    const src = new EventSource(this.server.sseUrl('/api/library/events', token) + since);
    this.source = src;
    src.onopen = () => this.connected.set(true);
    src.onerror = () => this.connected.set(false); // EventSource reconnects on its own
    src.addEventListener('library', (e) => this.onLibraryEvent(e as MessageEvent<string>));
    src.addEventListener('resync', () => this.onResync());
  }

  private close(): void {
    this.source?.close();
    this.source = null;
    this.connected.set(false);
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private onResync(): void {
    this.libraryApi.invalidateLibraryReads();
    this.resync.update((v) => v + 1);
  }

  private onLibraryEvent(e: MessageEvent<string>): void {
    let stamped: StampedEvent;
    try {
      stamped = JSON.parse(e.data) as StampedEvent;
    } catch {
      return;
    }
    // A hole in the sequence means events were lost between two connections.
    if (this.lastSeq > 0 && stamped.seq > this.lastSeq + 1) this.onResync();
    this.lastSeq = Math.max(this.lastSeq, stamped.seq);
    this.apply(stamped.event, stamped.seq);
  }

  /** Pure fan-out from one event to the signals; exported for the spec. */
  apply(ev: LibraryEvent, seq: number): void {
    switch (ev.type) {
      case 'songs.landed':
        this.libraryApi.invalidateLibraryReads();
        this.landedAlbumIds.update((s) => new Set([...s, ...ev.albumIds]));
        this.touch(this.changedAlbums, ev.albumIds, seq);
        break;
      case 'songs.deleted':
        this.libraryApi.invalidateLibraryReads();
        this.deletedSongIds.update((s) => new Set([...s, ...ev.songIds]));
        this.touch(this.changedAlbums, ev.albumIds, seq);
        break;
      case 'album.changed':
        this.libraryApi.invalidateLibraryReads();
        this.touch(this.changedAlbums, [ev.albumId], seq);
        break;
      case 'artist.changed':
        this.libraryApi.invalidateLibraryReads();
        this.touch(this.changedArtists, [ev.artistId], seq);
        break;
      case 'artwork.changed':
        this.artworkVersions.update((m) => new Map(m).set(ev.albumId, ev.version));
        break;
      case 'job.changed':
        this.jobsChanged$.next(ev.jobId);
        break;
    }
  }

  private touch(sig: typeof this.changedAlbums, ids: string[], seq: number): void {
    if (ids.length === 0) return;
    (sig as ReturnType<typeof signal<ReadonlyMap<string, number>>>).update((m) => {
      const next = new Map(m);
      for (const id of ids) next.set(id, seq);
      return next;
    });
  }
}
