import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LibraryApiService } from './api/library-api.service';
import { PlaylistService } from './playlist.service';

/**
 * Per-user "like" state (issue #225). A like is a personal gesture, so it can't
 * reuse the global scanner-derived `starred` column — the backend stores it as
 * membership in the user's auto-maintained "Liked Songs" playlist. This service
 * holds the liked-id set as a signal so every heart (track row, track-info,
 * player) reads `isLiked()` reactively; `toggle()` is optimistic and reverts on
 * error, and refreshes the playlist list so the Liked Songs count stays in sync.
 */
@Injectable({ providedIn: 'root' })
export class LikeService {
  private api = inject(LibraryApiService);
  private playlists = inject(PlaylistService);

  private readonly liked = signal<Set<string>>(new Set());
  readonly loaded = signal(false);

  isLiked(id: string): boolean {
    return this.liked().has(id);
  }

  /** Load the liked-id set once per session (called from the app shell). */
  async refresh(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getLikedIds());
      this.liked.set(new Set(res.ids));
    } catch {
      // Non-fatal — leave the set as-is (hearts stay in their last state).
    } finally {
      this.loaded.set(true);
    }
  }

  /** Optimistically flip the heart, then persist; revert the signal on failure. */
  async toggle(songId: string): Promise<void> {
    const wasLiked = this.isLiked(songId);
    this.setLocal(songId, !wasLiked);
    try {
      await firstValueFrom(wasLiked ? this.api.unlikeSong(songId) : this.api.likeSong(songId));
      // Keep the Liked Songs playlist's count/existence fresh on the playlists page.
      void this.playlists.refresh();
    } catch {
      this.setLocal(songId, wasLiked);
    }
  }

  private setLocal(id: string, liked: boolean): void {
    this.liked.update((set) => {
      const next = new Set(set);
      if (liked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  reset(): void {
    this.liked.set(new Set());
    this.loaded.set(false);
  }
}
