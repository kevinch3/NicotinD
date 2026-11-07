import { Injectable, computed, inject, signal, untracked } from '@angular/core';
import { tap, type Observable } from 'rxjs';
import type { LyricsDto } from '@nicotind/core';
import { parseLrc, findActiveLine, applyLyricsOffset, LYRICS_OFFSET_MAX_MS } from '@nicotind/core';
import { LibraryApiService } from './api/library-api.service';

/** One song's lyrics as this client knows them. */
interface LyricsEntry {
  /** The stored row; null when the library holds none (yet). */
  dto: LyricsDto | null;
  /** The request whose answer this entry is waiting for: a plain read, or a
   *  read that falls back to the sources on a miss. */
  inFlight: 'read' | 'full' | null;
  /** A source *failed* (vs a confident no-match) — offer a retry. */
  error: boolean;
  /** A manual (button-triggered) fetch is in flight. */
  fetching: boolean;
}

const EMPTY: LyricsEntry = {
  dto: null,
  inFlight: null,
  error: false,
  fetching: false,
};

/** How many songs' lyrics stay in memory. The current track and every id an
 *  open Track-info sheet is bound to are never evicted. */
export const LYRICS_CACHE_SIZE = 20;

/**
 * The one owner of lyrics on this client — loaded on demand, parsed once, and
 * shared by every surface that shows or edits them (#1134, #1666).
 *
 * This used to live inside `NowPlayingComponent`, the phone sheet. A TV build
 * never mounts that component (the player is a route there — docs/tv-ux.md),
 * so on a TV nothing could load lyrics at all and the karaoke overlay had no
 * way to exist (#1134). Pulling the state up is what lets the TV player mount
 * the same `NowPlayingKaraokeFullscreenComponent` the phone uses.
 *
 * It is keyed by song id because the Track-info sheet opens for any song row,
 * not only the playing one, and reads and writes through here too: a Re-fetch,
 * Edit or Reset there lands in the same entry the karaoke view renders, with
 * no track change (#1666). The player's view (`lyrics`, `lines`, `plain`,
 * `offsetMs`, `loadedForId`) is the entry of the track the player last asked
 * for (`ensureLoaded`); the sheet uses `ensureEntry`/`lyricsFor`, which never
 * move it. Every request carries a per-id token, so an answer for a request
 * since superseded is dropped, and an answer for another id lands in that id's
 * entry, never on the current track. → docs/web-ui.md "Lyrics have one owner".
 */
@Injectable({ providedIn: 'root' })
export class LyricsService {
  private readonly api = inject(LibraryApiService);

  private readonly entries = signal<ReadonlyMap<string, LyricsEntry>>(new Map());
  /** The track the player view shows: the id the last `ensureLoaded` named. */
  private readonly currentId = signal<string | null>(null);
  /** Ids an open Track-info sheet is bound to, counted (two sheets, one id). */
  private readonly bound = new Map<string, number>();
  /** The latest request per id; an answer carrying an older token is dropped. */
  private readonly tokens = new Map<string, number>();
  private seq = 0;

  private readonly current = computed(() => {
    const id = this.currentId();
    return id ? (this.entries().get(id) ?? null) : null;
  });

  readonly lyrics = computed<LyricsDto | null>(() => this.current()?.dto ?? null);
  /** True only for a first load; a refresh keeps the old words on screen. */
  readonly loading = computed(() => {
    const e = this.current();
    return !!e && e.inFlight !== null && e.dto === null;
  });
  readonly error = computed(() => this.current()?.error ?? false);
  readonly fetching = computed(() => this.current()?.fetching ?? false);
  /** The track whose lyrics `lyrics()` holds. Null on a miss, so a miss is
   *  retried the next time a surface asks for that track. */
  readonly loadedForId = computed(() => (this.current()?.dto ? this.currentId() : null));

  /**
   * Parsed synced LRC lines (empty when the lyrics are plain-only), with both
   * offsets applied: the file's own `[offset:]` tag, folded in by the parser,
   * and the stored human correction. The fetched text itself is never touched —
   * shifting happens here, at render time, which is what makes a sync fix
   * reversible and keeps the source's words intact.
   */
  readonly lines = computed(() =>
    applyLyricsOffset(parseLrc(this.lyrics()?.synced), this.offsetMs()),
  );
  /** Plain text fallback when there are no synced lines. */
  readonly plain = computed(() => this.lyrics()?.plain ?? '');
  /** The stored sync correction; positive shows the lines later. */
  readonly offsetMs = computed(() => this.lyrics()?.offsetMs ?? 0);

  /** Index of the line to highlight at `timeMs` into the track. */
  activeLineAt(timeMs: number): number {
    return findActiveLine(this.lines(), timeMs);
  }

  /**
   * Whether lyrics are loaded **for this track**. Gated on `loadedForId`
   * rather than on `lyrics()` alone: after a track change with every lyrics
   * surface closed the player has not asked for the new track yet, and an
   * ungated check showed a stale positive on the tab-switcher dot.
   */
  hasLyricsFor(trackId: string | null | undefined): boolean {
    if (!trackId || this.loadedForId() !== trackId) return false;
    return !!this.lyrics()?.synced || !!this.lyrics()?.plain;
  }

  /** `id`'s stored lyrics as this client knows them (reactive). */
  lyricsFor(id: string): LyricsDto | null {
    return this.entries().get(id)?.dto ?? null;
  }

  /**
   * The player asks for `id`: it becomes the current track. Loads it unless it
   * is already loaded or loading; a cached entry for a track coming back is
   * shown at once and re-read behind it. Untracked: surfaces call it from an
   * effect, which must not re-run on the writes it causes.
   */
  ensureLoaded(id: string): void {
    untracked(() => this.loadCurrent(id));
  }

  private loadCurrent(id: string): void {
    const wasCurrent = this.currentId() === id;
    this.currentId.set(id);
    const e = this.entries().get(id);
    if (e?.inFlight === 'full' || e?.fetching) return;
    if (e?.dto) {
      if (!wasCurrent && !e.inFlight) this.read(id);
      return;
    }
    this.load(id);
  }

  /**
   * A surface other than the player (the Track-info sheet) wants `id`'s
   * lyrics: read the stored row — never the sources, which cost a request per
   * opened sheet — and keep showing what is known meanwhile. Never moves the
   * current track. Returns the release for the eviction guard.
   */
  ensureEntry(id: string): () => void {
    this.bound.set(id, (this.bound.get(id) ?? 0) + 1);
    untracked(() => {
      if (!this.entries().get(id)?.inFlight) this.read(id);
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.bound.get(id) ?? 1) - 1;
      if (n > 0) this.bound.set(id, n);
      else this.bound.delete(id);
    };
  }

  /** A stored-row read; keeps the entry's words until the answer lands. */
  private read(id: string): void {
    const token = this.begin(id, { inFlight: 'read' });
    this.api.getLyrics(id).subscribe({
      next: (l) => this.settle(id, token, { dto: l, inFlight: null }),
      error: () => this.settle(id, token, { inFlight: null }),
    });
  }

  /** The player's first load: the stored row, else the sources once. */
  private load(id: string): void {
    const token = this.begin(id, { inFlight: 'full', error: false });
    this.api.getLyrics(id).subscribe({
      next: (l) => {
        if (l) {
          this.settle(id, token, { dto: l, inFlight: null });
          return;
        }
        if (!this.isLatest(id, token)) return;
        this.api.fetchLyrics(id).subscribe({
          next: (f) => this.settle(id, token, { dto: f, inFlight: null }),
          // A source failure (502) is distinct from a confident no-match —
          // flag it so the empty state offers a retry instead of "none".
          error: () => this.settle(id, token, { inFlight: null, error: true }),
        });
      },
      error: () => this.settle(id, token, { inFlight: null }),
    });
  }

  /**
   * Nudge the sync offset by `stepMs` (positive = show the lines later).
   *
   * Applied to the signal first and persisted after: the whole reason to nudge
   * is to watch the highlight land on the beat, and a control that waits for a
   * round-trip before moving cannot be judged by ear. A failed write reverts,
   * so the view never keeps a correction the library did not store.
   */
  nudgeOffset(stepMs: number): void {
    this.setOffset(this.offsetMs() + stepMs);
  }

  /** Drop the correction. Exactly restores the source's own timings. */
  resetOffset(): void {
    this.setOffset(0);
  }

  private setOffset(next: number): void {
    const id = this.loadedForId();
    const current = this.lyrics();
    if (!id || !current) return;
    const clamped = Math.max(-LYRICS_OFFSET_MAX_MS, Math.min(LYRICS_OFFSET_MAX_MS, next));
    if (clamped === current.offsetMs) return;
    this.patch(id, { dto: { ...current, offsetMs: clamped } });
    this.api.setLyricsOffset(id, clamped).subscribe({
      // Trust the server's value — it owns the clamp.
      next: (saved) => this.patch(id, { dto: saved }),
      error: () => this.patch(id, { dto: current }),
    });
  }

  /**
   * Manual "Fetch lyrics" from the player's empty state. Forces a re-fetch (so
   * a prior miss/error is retried) and surfaces success/empty/error distinctly.
   */
  fetchManually(id: string | null | undefined): void {
    if (!id) return;
    this.currentId.set(id);
    if (untracked(() => this.entries().get(id)?.fetching)) return;
    this.patch(id, { fetching: true, error: false });
    this.fetchFor(id, true).subscribe({
      next: () => this.patch(id, { fetching: false }),
      error: () => this.patch(id, { fetching: false, error: true }),
    });
  }

  /**
   * Ask the sources for `id` and write the answer into its entry. A forced
   * fetch that finds nothing answers null while the server keeps the stored
   * row (`fetchSongLyrics`), so a null never clears words already held.
   */
  fetchFor(id: string, force: boolean): Observable<LyricsDto | null> {
    const token = this.begin(id, {});
    return this.api
      .fetchLyrics(id, force)
      .pipe(tap((l) => this.settle(id, token, l ? { dto: l, error: false } : {})));
  }

  /**
   * Save an edited body for `id`. The server stores it without timings (an
   * edited text no longer matches the LRC) and clears the offset, and the
   * entry follows what the server answered.
   */
  save(id: string, plain: string): Observable<LyricsDto> {
    const token = this.begin(id, {});
    return this.api
      .saveLyrics(id, plain)
      .pipe(tap((l) => this.settle(id, token, { dto: l, inFlight: null })));
  }

  /** Drop `id`'s stored lyrics. */
  remove(id: string): Observable<{ ok: boolean }> {
    const token = this.begin(id, {});
    return this.api
      .deleteLyrics(id)
      .pipe(tap(() => this.settle(id, token, { dto: null, inFlight: null })));
  }

  /** Start a request for `id`: mint its token and apply the pending state. A
   *  request it supersedes will never settle, so its `inFlight` is cleared. */
  private begin(id: string, changes: Partial<LyricsEntry>): number {
    const token = ++this.seq;
    this.tokens.set(id, token);
    this.patch(id, { inFlight: null, ...changes });
    return token;
  }

  private isLatest(id: string, token: number): boolean {
    return this.tokens.get(id) === token;
  }

  /** Land an answer — only if no later request for `id` has started since. */
  private settle(id: string, token: number, changes: Partial<LyricsEntry>): void {
    if (!this.isLatest(id, token)) return;
    this.patch(id, changes);
  }

  private patch(id: string, changes: Partial<LyricsEntry>): void {
    this.entries.update((prev) => {
      const next = new Map(prev);
      const entry = { ...(prev.get(id) ?? EMPTY), ...changes };
      // Re-insert so iteration order is least-recently-touched first.
      next.delete(id);
      next.set(id, entry);
      this.evict(next);
      return next;
    });
  }

  private evict(map: Map<string, LyricsEntry>): void {
    if (map.size <= LYRICS_CACHE_SIZE) return;
    const keep = this.currentId();
    for (const id of map.keys()) {
      if (map.size <= LYRICS_CACHE_SIZE) return;
      if (id === keep || this.bound.has(id) || map.get(id)?.inFlight) continue;
      map.delete(id);
      this.tokens.delete(id);
    }
  }
}
