import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../db.js';
import {
  artistImageCoverage,
  countArtistsNeedingPortrait,
  fillArtistImages,
  selectArtistsNeedingPortrait,
} from './artist-image-fill.js';
import { parseLimit } from '../scripts/backfill-artist-images.js';

let db: Database;
let coverCacheDir: string;

function seedArtist(id: string, name: string, opts: { override?: boolean; albums?: number } = {}) {
  db.run(
    `INSERT INTO library_artists (id, name, album_count, manual_override, hidden, synced_at)
     VALUES (?, ?, ?, ?, 0, 1)`,
    [id, name, opts.albums ?? 1, opts.override ? 1 : 0],
  );
}

function seedPortrait(id: string) {
  db.run(
    `INSERT INTO library_artwork (id, kind, cover_url, updated_at)
     VALUES (?, 'artist', 'http://x/p.jpg', 1)`,
    [id],
  );
}

/** A Spotify-shaped provider: the chain uses it when Lidarr is absent. */
function spotify(map: Record<string, string | null>) {
  return mock(async (name: string) => map[name] ?? null);
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  coverCacheDir = mkdtempSync(join(tmpdir(), 'artist-img-'));
});

describe('selectArtistsNeedingPortrait / countArtistsNeedingPortrait (#250)', () => {
  it('counts only visible artists with no portrait and no curator override', () => {
    seedArtist('a', 'Needs One');
    seedArtist('b', 'Has One');
    seedPortrait('b');
    seedArtist('c', 'Curator Set', { override: true });
    db.run(`UPDATE library_artists SET hidden = 1 WHERE id = 'a2'`); // no-op, guards the clause
    seedArtist('d', 'Hidden');
    db.run(`UPDATE library_artists SET hidden = 1 WHERE id = 'd'`);

    expect(countArtistsNeedingPortrait(db)).toBe(1);
    expect(selectArtistsNeedingPortrait(db, 10).map((a) => a.name)).toEqual(['Needs One']);
  });

  it('orders most-prolific first so headline names get faces soonest', () => {
    seedArtist('a', 'Small', { albums: 1 });
    seedArtist('b', 'Big', { albums: 40 });
    seedArtist('c', 'Medium', { albums: 9 });
    expect(selectArtistsNeedingPortrait(db, 10).map((a) => a.name)).toEqual([
      'Big',
      'Medium',
      'Small',
    ]);
  });
});

describe('fillArtistImages (#250)', () => {
  it('resolves a portrait and stores it as library_artwork', async () => {
    seedArtist('a', 'Real Artist');
    const lookup = spotify({ 'Real Artist': 'https://cdn/portrait.jpg' });

    const res = await fillArtistImages(
      db,
      { lidarr: null, spotifyLookup: lookup, coverCacheDir },
      selectArtistsNeedingPortrait(db, 10),
    );

    expect(res.applied).toBe(1);
    expect(res.labels[0]).toContain('Real Artist');
    expect(
      db.query(`SELECT cover_url FROM library_artwork WHERE id = 'a' AND kind = 'artist'`).get(),
    ).toEqual({ cover_url: 'https://cdn/portrait.jpg' });
  });

  it('reports an unresolvable artist rather than counting it as applied', async () => {
    seedArtist('a', 'Obscure');
    const res = await fillArtistImages(
      db,
      { lidarr: null, spotifyLookup: spotify({}), coverCacheDir },
      selectArtistsNeedingPortrait(db, 10),
    );
    expect(res.applied).toBe(0);
    expect(res.unresolved).toEqual(['Obscure']);
  });

  /**
   * "Various Artists" has no portrait to find; asking burns a provider
   * round-trip per batch and would pollute the miss list every run.
   */
  it('skips placeholder/VA names without querying a provider', async () => {
    seedArtist('va', 'Various Artists');
    const lookup = spotify({ 'Various Artists': 'https://cdn/should-not-be-used.jpg' });

    const res = await fillArtistImages(
      db,
      { lidarr: null, spotifyLookup: lookup, coverCacheDir },
      selectArtistsNeedingPortrait(db, 10),
    );

    expect(res.applied).toBe(0);
    expect(res.unresolved).toEqual([]); // not a miss — never asked
    expect(lookup).not.toHaveBeenCalled();
  });

  /**
   * A Lidarr blip must never fail the batch: a portrait backfill is the last
   * thing that should take down a processing window.
   */
  it('falls through to the remaining providers when Lidarr throws', async () => {
    seedArtist('a', 'Resilient');
    const lidarr = {
      artist: {
        list: mock(async () => {
          throw new Error('ECONNREFUSED');
        }),
      },
    };

    const res = await fillArtistImages(
      db,
      {
        lidarr: lidarr as never,
        spotifyLookup: spotify({ Resilient: 'https://cdn/ok.jpg' }),
        coverCacheDir,
      },
      selectArtistsNeedingPortrait(db, 10),
    );

    expect(res.applied).toBe(1);
  });

  it('is a no-op on an empty target list (no provider setup at all)', async () => {
    const lookup = spotify({});
    const res = await fillArtistImages(
      db,
      { lidarr: null, spotifyLookup: lookup, coverCacheDir },
      [],
    );
    expect(res).toEqual({ applied: 0, labels: [], unresolved: [] });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('backfill-artist-images --limit', () => {
  it('defaults to the pending count and accepts an explicit limit', () => {
    expect(parseLimit([], 42)).toBe(42);
    expect(parseLimit(['--limit', '5'], 42)).toBe(5);
  });

  it('throws on a non-numeric or non-positive limit rather than silently doing everything', () => {
    expect(() => parseLimit(['--limit', 'lots'], 42)).toThrow(/positive number/);
    expect(() => parseLimit(['--limit', '0'], 42)).toThrow();
    expect(() => parseLimit(['--limit'], 42)).toThrow();
  });
});

afterEach(() => rmSync(coverCacheDir, { recursive: true, force: true }));

/**
 * Issue #250 gap 3. The number an admin reads must be the number a fill would
 * act on, so `missing` reuses NEEDS_PORTRAIT_SQL rather than restating it.
 */
describe('artistImageCoverage', () => {
  function seedHidden(id: string, name: string) {
    db.run(
      `INSERT INTO library_artists (id, name, album_count, manual_override, hidden, synced_at)
       VALUES (?, ?, 1, 0, 1, 1)`,
      [id, name],
    );
  }

  it('is all-zero on an empty library', () => {
    expect(artistImageCoverage(db)).toEqual({
      visible: 0,
      withPortrait: 0,
      missing: 0,
      manualOverride: 0,
    });
  });

  it('counts a resolved portrait as covered', () => {
    seedArtist('a1', 'With');
    seedPortrait('a1');
    seedArtist('a2', 'Without');

    expect(artistImageCoverage(db)).toEqual({
      visible: 2,
      withPortrait: 1,
      missing: 1,
      manualOverride: 0,
    });
  });

  // A curator upload lives in <dataDir>/artist-overrides with NO library_artwork
  // row, so a subtraction-based count would report it as missing.
  it('counts a curator upload as covered even with no artwork row', () => {
    seedArtist('a1', 'Uploaded', { override: true });

    expect(artistImageCoverage(db)).toEqual({
      visible: 1,
      withPortrait: 1,
      missing: 0,
      manualOverride: 1,
    });
  });

  it('excludes hidden artists from every bucket', () => {
    seedArtist('a1', 'Visible');
    seedHidden('h1', 'Split Compound');

    const c = artistImageCoverage(db);
    expect(c.visible).toBe(1);
    expect(c.missing).toBe(1);
  });

  // The invariant the Admin row renders as "N of M".
  it('partitions visible exactly: withPortrait + missing === visible', () => {
    seedArtist('a1', 'Resolved');
    seedPortrait('a1');
    seedArtist('a2', 'Uploaded', { override: true });
    seedArtist('a3', 'Bare');
    seedArtist('a4', 'AlsoBare');
    seedHidden('h1', 'Hidden');

    const c = artistImageCoverage(db);
    expect(c.withPortrait + c.missing).toBe(c.visible);
    expect(c).toEqual({ visible: 4, withPortrait: 2, missing: 2, manualOverride: 1 });
  });

  it('agrees with countArtistsNeedingPortrait, the number a fill acts on', () => {
    seedArtist('a1', 'One');
    seedArtist('a2', 'Two', { override: true });
    seedArtist('a3', 'Three');
    seedPortrait('a3');
    seedArtist('a4', 'Four');

    expect(artistImageCoverage(db).missing).toBe(countArtistsNeedingPortrait(db));
  });
});
