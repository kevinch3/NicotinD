import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { upsertArtistOrigin } from './artist-origins.js';
import {
  candidatesFor,
  refreshAutoPlaylists,
  maybeRefreshAutoPlaylists,
  getAutoPlaylistCadence,
  setAutoPlaylistCadence,
  getAutoPlaylistStatus,
  runAutoPlaylistsNow,
} from './auto-playlists.service.js';
import { RECIPES, weekSeedFor } from './playlist-recipe.js';

const db = new Database(':memory:');
applySchema(db);

function insertSong(id: string, over: Partial<Record<string, unknown>> = {}): void {
  const s = {
    album_id: 'al',
    title: id,
    artist: `Artist-${id}`,
    artist_id: `art-${id}`,
    duration: 200,
    year: 2015,
    genre: 'Electronic',
    path: `/m/${id}.flac`,
    bpm: 130,
    key: 'C major',
    hidden: 0,
    ...over,
  };
  db.run(
    `INSERT INTO library_songs
       (id, album_id, title, artist, artist_id, duration, year, genre, path, bpm, key, hidden, landed_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    [
      id,
      s.album_id as string,
      s.title as string,
      s.artist as string,
      s.artist_id as string,
      s.duration as number,
      s.year as number,
      s.genre as string,
      s.path as string,
      s.bpm as number,
      s.key as string,
      s.hidden as number,
    ],
  );
}

function seed(): void {
  db.run('DELETE FROM playlists');
  db.run('DELETE FROM playlist_songs');
  db.run('DELETE FROM library_songs');
  db.run('DELETE FROM library_sync_state');
  db.run('DELETE FROM users');
  db.run(
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('admin', 'admin', 'x', 'admin', '2020-01-01')",
  );
  // A spread of workout-range + electronic tracks across many artists.
  for (let i = 0; i < 30; i++) insertSong(`s${i}`, { bpm: 128 + (i % 10) });
}

describe('candidatesFor (origin countries)', () => {
  it('restricts a countries recipe to credited-artist origins via the shared filter SQL', () => {
    seed();
    upsertArtistOrigin(db, { artistId: 'art-s0', country: 'AR', source: 'musicbrainz' });
    upsertArtistOrigin(db, { artistId: 'art-s1', country: 'DE', source: 'musicbrainz' });
    const rows = candidatesFor(db, {
      slug: 'test-ar',
      name: 'Test AR',
      description: '',
      palette: { from: '#000000', to: '#ffffff' },
      where: '1=1',
      countries: ['AR'],
      targetSize: 10,
      maxPerArtist: 2,
    });
    expect(rows.map((r) => r.id)).toEqual(['s0']);
  });

  it('a recipe without countries is unchanged', () => {
    seed();
    const rows = candidatesFor(db, {
      slug: 'test-all',
      name: 'Test All',
      description: '',
      palette: { from: '#000000', to: '#ffffff' },
      where: '1=1',
      targetSize: 10,
      maxPerArtist: 2,
    });
    expect(rows).toHaveLength(30);
  });
});

describe('refreshAutoPlaylists', () => {
  beforeEach(seed);

  it('dry run computes counts without writing playlists', () => {
    const results = refreshAutoPlaylists(db, Date.now(), { apply: false });
    expect(results).toHaveLength(RECIPES.length);
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) n FROM playlists').get();
    expect(count?.n).toBe(0);
  });

  it('materializes curated playlists idempotently (no dupes on re-run)', () => {
    const now = Date.now();
    const results = refreshAutoPlaylists(db, now, { apply: true });
    const after1 = db
      .query<{ n: number }, []>("SELECT COUNT(*) n FROM playlists WHERE kind='curated'")
      .get();
    const songs1 = db.query<{ n: number }, []>('SELECT COUNT(*) n FROM playlist_songs').get();

    refreshAutoPlaylists(db, now, { apply: true });
    const after2 = db
      .query<{ n: number }, []>("SELECT COUNT(*) n FROM playlists WHERE kind='curated'")
      .get();
    const songs2 = db.query<{ n: number }, []>('SELECT COUNT(*) n FROM playlist_songs').get();

    expect(after2?.n).toBe(after1?.n);
    expect(songs2?.n).toBe(songs1?.n);
    // Only recipes with candidates materialize; zero-candidate shelves (e.g.
    // the perceptual-feature ones before any enrichment) are not created.
    const nonEmpty = results.filter((r) => r.count > 0).length;
    expect(after1?.n).toBe(nonEmpty);
    expect(nonEmpty).toBeGreaterThan(0);
    expect(nonEmpty).toBeLessThan(RECIPES.length);
  });

  it('creates a feature shelf once enrichment fills the columns', () => {
    // Analyzed library: high valence + danceability satisfies 'feel-good'.
    for (let i = 0; i < 10; i++) {
      db.run(
        'UPDATE library_songs SET valence = 0.8, danceability = 0.7, energy = 0.6 WHERE id = ?',
        [`s${i}`],
      );
    }
    const results = refreshAutoPlaylists(db, Date.now(), { apply: true });
    const feelGood = results.find((r) => r.slug === 'feel-good');
    expect(feelGood?.count).toBeGreaterThan(0);
    const row = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) n FROM playlists WHERE kind='curated' AND name='Feel Good'",
      )
      .get();
    expect(row?.n).toBe(1);
  });

  it('drops a track that left the library on refresh', () => {
    const now = Date.now();
    refreshAutoPlaylists(db, now, { apply: true });
    const before = db.query<{ n: number }, []>('SELECT COUNT(*) n FROM playlist_songs').get();
    db.run('DELETE FROM library_songs'); // library emptied
    refreshAutoPlaylists(db, now, { apply: true });
    const after = db.query<{ n: number }, []>('SELECT COUNT(*) n FROM playlist_songs').get();
    expect(after?.n).toBe(0);
    expect(before!.n).toBeGreaterThan(0);
  });
});

describe('maybeRefreshAutoPlaylists (cadence guard)', () => {
  beforeEach(seed);

  it('defaults to weekly: refreshes once per ISO week then no-ops until next week', () => {
    // Align to the start of an ISO-week bucket so the offsets stay within/next week.
    const weekMs = 7 * 86_400_000;
    const now = weekSeedFor(Date.UTC(2026, 5, 1)) * weekMs + 3_600_000; // 1h into a bucket
    expect(getAutoPlaylistCadence(db)).toBe('weekly'); // default
    expect(maybeRefreshAutoPlaylists(db, now)).toBe(true);
    // Same week → guarded no-op.
    expect(maybeRefreshAutoPlaylists(db, now + 3 * 86_400_000)).toBe(false);
    // Next week → refreshes again.
    expect(maybeRefreshAutoPlaylists(db, now + weekMs)).toBe(true);
    const marker = db
      .query<{ value: string }, []>(
        "SELECT value FROM library_sync_state WHERE key='auto_playlists_period'",
      )
      .get();
    expect(marker?.value).toBe(`weekly:${weekSeedFor(now + weekMs)}`);
  });

  it('daily cadence refreshes once per calendar day', () => {
    setAutoPlaylistCadence(db, 'daily');
    const day = 86_400_000;
    const now = 20_000 * day + 3_600_000; // 1h into a day bucket
    expect(maybeRefreshAutoPlaylists(db, now)).toBe(true);
    expect(maybeRefreshAutoPlaylists(db, now + 3_600_000)).toBe(false); // same day
    expect(maybeRefreshAutoPlaylists(db, now + day)).toBe(true); // next day
  });

  it('off cadence never refreshes', () => {
    setAutoPlaylistCadence(db, 'off');
    expect(maybeRefreshAutoPlaylists(db, Date.now())).toBe(false);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) n FROM playlists').get()?.n).toBe(0);
  });

  it('changing cadence re-triggers on the next tick', () => {
    setAutoPlaylistCadence(db, 'weekly');
    const now = Date.now();
    expect(maybeRefreshAutoPlaylists(db, now)).toBe(true);
    expect(maybeRefreshAutoPlaylists(db, now)).toBe(false); // guarded
    setAutoPlaylistCadence(db, 'daily'); // different period key → runs again
    expect(maybeRefreshAutoPlaylists(db, now)).toBe(true);
  });

  it('rejects an unknown cadence value', () => {
    expect(setAutoPlaylistCadence(db, 'hourly')).toBe(false);
    expect(getAutoPlaylistCadence(db)).toBe('weekly'); // unchanged
  });

  it('no-ops when there is no admin owner', () => {
    db.run('DELETE FROM users');
    expect(maybeRefreshAutoPlaylists(db, Date.now())).toBe(false);
  });
});

describe('runAutoPlaylistsNow (manual trigger) + status', () => {
  beforeEach(seed);

  it('forces a refresh regardless of the guard and records the timestamp', () => {
    const now = 1_900_000_000_000;
    const results = runAutoPlaylistsNow(db, now);
    expect(results.length).toBe(RECIPES.length);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) n FROM playlists WHERE kind='curated'").get()?.n,
    ).toBeGreaterThan(0);
    const status = getAutoPlaylistStatus(db);
    expect(status.cadence).toBe('weekly');
    expect(status.lastRefreshedAt).toBe(now);
    // Manual run counts as this period → the scheduled tick stays a no-op.
    expect(maybeRefreshAutoPlaylists(db, now)).toBe(false);
  });

  it('works even when the schedule is off (records a manual marker)', () => {
    setAutoPlaylistCadence(db, 'off');
    const now = 1_900_000_100_000;
    runAutoPlaylistsNow(db, now);
    expect(getAutoPlaylistStatus(db).lastRefreshedAt).toBe(now);
  });
});
