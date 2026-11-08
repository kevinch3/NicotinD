import { Injectable, inject, signal } from '@angular/core';
import type { PreservedCover } from '../lib/preserve-store';
import { OfflineModeService } from './offline-mode.service';

/** Reads the preserved covers; the IndexedDB store in the app, a fake in tests. */
export interface PreservedCoverSource {
  getAllCovers(): Promise<PreservedCover[]>;
}

/**
 * Preserved album covers as object URLs (#1658), so a cover keeps showing when
 * the app is offline. Before this the preserve flow stored a 600px cover per
 * track and nothing ever read it: offline, every cover fell back to the
 * placeholder.
 *
 * `CoverRevisionsService.url` — the one place every cover URL is built since
 * #1666 — asks `urlFor` while `offline()`, so every surface (tiles, rows, the
 * player bar, Now Playing, the lock screen) gets the preserved cover with no
 * per-site change. Online it stays on the network URL: a preserved copy can be
 * older than the live rev, and the cache headers already make that cheap.
 *
 * One 600px cover per album, scaled down by CSS (owner decision, #1658). The
 * map is rebuilt from the store after every preserve / remove (`refresh`);
 * replaced object URLs are revoked.
 */
@Injectable({ providedIn: 'root' })
export class PreservedCoversService {
  private readonly urls = signal<ReadonlyMap<string, string>>(new Map());
  private source: PreservedCoverSource | null = null;

  /** Offline mode (#1751): no network, or the server not answering — a server
   *  that is down serves no covers either, so the preserved copy is the one. */
  readonly offline = inject(OfflineModeService).isOffline;

  /** Bind the store (PreserveService does, at construction) and load it. */
  attach(source: PreservedCoverSource): Promise<void> {
    this.source = source;
    return this.refresh();
  }

  /** Rebuild the map from the store; revokes the URLs it replaces. */
  async refresh(): Promise<void> {
    if (!this.source) return;
    let covers: PreservedCover[];
    try {
      covers = await this.source.getAllCovers();
    } catch {
      return; // No IndexedDB (private mode, SSR): stay on network URLs.
    }
    const next = new Map<string, string>();
    for (const c of covers) next.set(c.key, URL.createObjectURL(c.cover));
    const prev = this.urls();
    this.urls.set(next);
    for (const url of prev.values()) URL.revokeObjectURL(url);
  }

  /** The preserved cover for a cover key (`coverKeyOf`), or undefined. Reactive. */
  urlFor(key: string): string | undefined {
    return this.urls().get(key);
  }
}
