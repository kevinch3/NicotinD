import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface WatchlistItem {
  id: number;
  foreign_album_id: string | null;
  artist_mbid: string | null;
  artist_name: string;
  album_title: string;
  lidarr_album_id: number | null;
  state: 'watching' | 'acquired' | 'failed';
  last_checked_at: number | null;
  last_error: string | null;
  created_at: number;
}

export interface AddWatchInput {
  foreignAlbumId?: string;
  artistMbid?: string;
  artistName: string;
  albumTitle: string;
}

@Injectable({ providedIn: 'root' })
export class WatchlistService {
  private http = inject(HttpClient);

  readonly items = signal<WatchlistItem[]>([]);

  // Release-group ids currently watched — lets album cards render a filled star.
  private readonly watchedIds = computed(
    () =>
      new Set(
        this.items()
          .map((i) => i.foreign_album_id)
          .filter((x): x is string => !!x),
      ),
  );

  isWatched(foreignAlbumId: string | undefined | null): boolean {
    return !!foreignAlbumId && this.watchedIds().has(foreignAlbumId);
  }

  async refresh(): Promise<void> {
    try {
      const res = await firstValueFrom(this.http.get<{ items: WatchlistItem[] }>('/api/watchlist'));
      this.items.set(res.items);
    } catch {
      // Non-fatal (e.g. Lidarr unconfigured → route not mounted). Leave list empty.
    }
  }

  async add(input: AddWatchInput): Promise<void> {
    const res = await firstValueFrom(
      this.http.post<{ item: WatchlistItem }>('/api/watchlist', input),
    );
    // Optimistic local update so the star flips immediately.
    this.items.update((list) => {
      const without = list.filter((i) => i.id !== res.item.id);
      return [res.item, ...without];
    });
  }

  async remove(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/watchlist/${id}`));
    this.items.update((list) => list.filter((i) => i.id !== id));
  }

  /** Toggle watching for a catalog album (add if not watched, remove if it is). */
  async toggle(album: {
    foreignAlbumId: string;
    artistMbid: string;
    artistName: string;
    title: string;
  }): Promise<void> {
    const existing = this.items().find((i) => i.foreign_album_id === album.foreignAlbumId);
    if (existing) {
      await this.remove(existing.id);
    } else {
      await this.add({
        foreignAlbumId: album.foreignAlbumId,
        artistMbid: album.artistMbid,
        artistName: album.artistName,
        albumTitle: album.title,
      });
    }
  }
}
