import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import { applySchema } from '../db.js';
import { WatchlistService } from './watchlist.service.js';
import type { CatalogService } from './catalog-search.service.js';
import type { AlbumHunterService } from './album-hunter.service.js';

// The poller must respect the acquisition-plugin toggle: when disabled, a sweep
// does nothing (it never touches a watching row). When enabled it proceeds (and
// here harmlessly resolves to null because the row lacks ids), touching the row.
function makeService(db: Database, isAcquisitionEnabled: () => boolean) {
  return new WatchlistService({
    db,
    catalog: {} as unknown as CatalogService,
    hunter: {} as unknown as AlbumHunterService,
    lidarr: {} as unknown as Lidarr,
    slskdRef: { current: null },
    isAcquisitionEnabled,
  });
}

function lastChecked(db: Database): number | null {
  return (
    db.query<{ last_checked_at: number | null }, []>('SELECT last_checked_at FROM watchlist LIMIT 1').get()
      ?.last_checked_at ?? null
  );
}

describe('WatchlistService acquisition gating', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO watchlist (artist_name, album_title, state, created_at) VALUES ('A', 'B', 'watching', ?)`,
      [Date.now()],
    );
  });

  it('skips the sweep entirely when acquisition is disabled', async () => {
    await makeService(db, () => false).sweep();
    expect(lastChecked(db)).toBeNull();
  });

  it('runs the sweep when acquisition is enabled', async () => {
    await makeService(db, () => true).sweep();
    expect(lastChecked(db)).not.toBeNull();
  });
});
