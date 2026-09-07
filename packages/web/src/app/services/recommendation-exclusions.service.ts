import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { RecommendationsApiService } from './api/recommendations-api.service';
import type { ExcludedSong } from './api/api-types';

/**
 * Per-user "don't recommend this" state, held as a signal so the song menu can
 * label itself ("Don't recommend this" vs "Recommend again") without a round
 * trip. Mirrors LikeService: loaded once per session from the app shell,
 * optimistic on toggle, reverted on error. The server is the authority on the
 * *derived* (skip-based) exclusions too, so `refresh()` is the only way those
 * appear here.
 */
@Injectable({ providedIn: 'root' })
export class RecommendationExclusionsService {
  private api = inject(RecommendationsApiService);

  readonly excluded = signal<ExcludedSong[]>([]);
  readonly loaded = signal(false);

  isExcluded(songId: string): boolean {
    return this.excluded().some((e) => e.songId === songId);
  }

  async refresh(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getExcluded());
      this.excluded.set(res.excluded);
    } catch {
      // Non-fatal — keep the last known list.
    } finally {
      this.loaded.set(true);
    }
  }

  /** Hold a song out of every feed for this listener. */
  async exclude(songId: string): Promise<void> {
    const before = this.excluded();
    this.excluded.set([
      { songId, reason: 'explicit', since: Date.now(), song: null },
      ...before.filter((e) => e.songId !== songId),
    ]);
    try {
      await firstValueFrom(this.api.feedback(songId, 'exclude'));
      void this.refresh();
    } catch {
      this.excluded.set(before);
    }
  }

  /** Let a song back in ("recommend again") — beats a derived exclusion too. */
  async restore(songId: string): Promise<void> {
    const before = this.excluded();
    this.excluded.set(before.filter((e) => e.songId !== songId));
    try {
      await firstValueFrom(this.api.restore(songId));
    } catch {
      this.excluded.set(before);
    }
  }

  reset(): void {
    this.excluded.set([]);
    this.loaded.set(false);
  }
}
