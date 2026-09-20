import { Injectable, computed, inject, signal } from '@angular/core';
import type { LyricsDto } from '@nicotind/core';
import { parseLrc, findActiveLine, applyLyricsOffset, LYRICS_OFFSET_MAX_MS } from '@nicotind/core';
import { LibraryApiService } from './api/library-api.service';

/**
 * The lyrics of the track being listened to — loaded on demand, parsed once,
 * and shared by every surface that shows them.
 *
 * This used to live inside `NowPlayingComponent`, the phone sheet. A TV build
 * never mounts that component (the player is a route there — docs/tv-ux.md),
 * so on a TV nothing could load lyrics at all and the karaoke overlay had no
 * way to exist (#1134). Pulling the state up is what lets the TV player mount
 * the same `NowPlayingKaraokeFullscreenComponent` the phone uses — a template
 * fork, not a logic fork, which is the rule the TV surface is built on.
 *
 * Loading is lazy: nothing is fetched until a surface asks for a track
 * (`ensureLoaded`), so a sheet that is never opened never costs a request.
 */
@Injectable({ providedIn: 'root' })
export class LyricsService {
  private readonly api = inject(LibraryApiService);

  readonly lyrics = signal<LyricsDto | null>(null);
  readonly loading = signal(false);
  /** True after a source *failed* (vs a confident no-match) — offer a retry. */
  readonly error = signal(false);
  /** True while a manual (button-triggered) fetch is in flight. */
  readonly fetching = signal(false);
  /** The track whose lyrics `lyrics()` holds. Set only on a successful load,
   *  so a miss is retried the next time a surface asks for that track. */
  readonly loadedForId = signal<string | null>(null);
  private inFlightId: string | null = null;

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
   * rather than on `lyrics()` alone: the state is only reloaded when a surface
   * asks, so after a track change with every lyrics surface closed `lyrics()`
   * still holds the previous track's text, and an ungated check showed a
   * stale positive on the tab-switcher dot.
   */
  hasLyricsFor(trackId: string | null | undefined): boolean {
    if (!trackId || this.loadedForId() !== trackId) return false;
    return !!this.lyrics()?.synced || !!this.lyrics()?.plain;
  }

  /** Load `id`'s lyrics unless they are already loaded or already loading. */
  ensureLoaded(id: string): void {
    if (id === this.loadedForId() || id === this.inFlightId) return;
    this.load(id);
  }

  private load(id: string): void {
    this.inFlightId = id;
    this.lyrics.set(null);
    this.error.set(false);
    this.loading.set(true);
    const settle = (): void => {
      if (this.inFlightId === id) this.inFlightId = null;
      this.loading.set(false);
    };
    this.api.getLyrics(id).subscribe({
      next: (l) => {
        if (l) {
          this.lyrics.set(l);
          this.loadedForId.set(id);
          settle();
          return;
        }
        // Nothing stored: ask the sources once, keeping the id uncached on a
        // miss so a later external fetch (the track-info sheet) is picked up.
        this.api.fetchLyrics(id).subscribe({
          next: (f) => {
            this.lyrics.set(f);
            if (f) this.loadedForId.set(id);
            settle();
          },
          // A source failure (502) is distinct from a confident no-match —
          // flag it so the empty state offers a retry instead of "none".
          error: () => {
            this.error.set(true);
            settle();
          },
        });
      },
      error: settle,
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
    this.lyrics.set({ ...current, offsetMs: clamped });
    this.api.setLyricsOffset(id, clamped).subscribe({
      next: (saved) => {
        // Trust the server's value — it owns the clamp.
        if (this.loadedForId() === id) this.lyrics.set(saved);
      },
      error: () => {
        if (this.loadedForId() === id) this.lyrics.set(current);
      },
    });
  }

  /**
   * Manual "Fetch lyrics" from the empty state. Forces a re-fetch (so a prior
   * miss/error is retried) and surfaces success/empty/error distinctly.
   */
  fetchManually(id: string | null | undefined): void {
    if (!id || this.fetching()) return;
    this.fetching.set(true);
    this.error.set(false);
    this.api.fetchLyrics(id, true).subscribe({
      next: (f) => {
        this.lyrics.set(f);
        if (f) this.loadedForId.set(id);
        this.fetching.set(false);
      },
      error: () => {
        this.error.set(true);
        this.fetching.set(false);
      },
    });
  }
}
