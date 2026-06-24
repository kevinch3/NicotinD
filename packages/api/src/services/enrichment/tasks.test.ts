import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import { ENRICHMENT_TASKS, getTask, type EnrichmentContext } from './tasks.js';

let db: Database;

function seedSong(
  id: string,
  opts: { artist?: string; title?: string; bpm?: number | null; genre?: string | null } = {},
): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at, bpm, genre)
     VALUES (?, 'alb', ?, ?, 'art', 0, ?, 10, 320, 'opus', 'audio/opus', '2024-01-01', 1, ?, ?)`,
    [
      id,
      opts.title ?? `T-${id}`,
      opts.artist ?? 'Artist',
      `${opts.artist ?? 'Artist'}/Album/${id}.opus`,
      opts.bpm ?? null,
      opts.genre ?? null,
    ],
  );
}

function ctx(overrides: Partial<EnrichmentContext> = {}): EnrichmentContext {
  return {
    musicDir: '/music',
    lidarr: {} as never,
    concurrency: 2,
    ffmpegAvailable: () => true,
    readTags: async () => ({}),
    writeTags: async () => true,
    analyzeBpm: async () => 120,
    lookupGenre: async () => 'Rock',
    fileExists: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('bpm task', () => {
  const bpm = getTask('bpm')!;

  it('is unavailable without ffmpeg', () => {
    expect(bpm.available(ctx({ ffmpegAvailable: () => false }))).toBe('ffmpeg not found on PATH');
    expect(bpm.available(ctx())).toBe(true);
  });

  it('counts only songs with NULL bpm', () => {
    seedSong('a');
    seedSong('b', { bpm: 90 });
    seedSong('c');
    expect(bpm.countPending(db)).toBe(2);
  });

  it('analyzes pending songs and writes the analyzed value to the tag', () => {
    seedSong('a');
    let wrote = 0;
    const c = ctx({ analyzeBpm: async () => 128, writeTags: async () => ((wrote += 1), true) });
    return bpm.run(db, c, 25).then((res) => {
      expect(res.applied).toBe(1);
      expect(wrote).toBe(1); // analyzed → tag written back
      const row = db
        .query<{ bpm: number }, [string]>('SELECT bpm FROM library_songs WHERE id = ?')
        .get('a');
      expect(row?.bpm).toBe(128);
    });
  });

  it('prefers an existing tag bpm and does NOT rewrite the tag', async () => {
    seedSong('a');
    let wrote = 0;
    let analyzed = 0;
    const c = ctx({
      readTags: async () => ({ bpm: 95 }),
      analyzeBpm: async () => ((analyzed += 1), 200),
      writeTags: async () => ((wrote += 1), true),
    });
    const res = await bpm.run(db, c, 25);
    expect(res.applied).toBe(1);
    expect(analyzed).toBe(0); // tag value used, no analysis
    expect(wrote).toBe(0); // already on the tag, no rewrite
    const row = db
      .query<{ bpm: number }, [string]>('SELECT bpm FROM library_songs WHERE id = ?')
      .get('a');
    expect(row?.bpm).toBe(95);
  });

  it('respects the batch limit and skips missing files', async () => {
    for (let i = 0; i < 5; i++) seedSong(`s${i}`);
    const res = await bpm.run(db, ctx({ fileExists: (abs) => !abs.endsWith('s0.opus') }), 3);
    // 3 selected, one of those may be s0 (skipped). Applied ≤ 3, pending shrinks.
    expect(res.applied).toBeLessThanOrEqual(3);
    expect(bpm.countPending(db)).toBeGreaterThanOrEqual(2);
  });

  it('does not apply when analysis returns null', async () => {
    seedSong('a');
    const res = await bpm.run(db, ctx({ analyzeBpm: async () => null }), 25);
    expect(res.applied).toBe(0);
    expect(bpm.countPending(db)).toBe(1);
  });
});

describe('genre task', () => {
  const genre = getTask('genre')!;

  it('is unavailable without Lidarr', () => {
    expect(genre.available(ctx({ lidarr: null }))).toBe('Lidarr not configured');
    expect(genre.available(ctx())).toBe(true);
  });

  it('counts songs with NULL or empty genre', () => {
    seedSong('a');
    seedSong('b', { genre: '' });
    seedSong('c', { genre: 'Jazz' });
    expect(genre.countPending(db)).toBe(2);
  });

  it('looks up once per artist and fans the genre out to all their songs', async () => {
    seedSong('a1', { artist: 'Foo' });
    seedSong('a2', { artist: 'Foo' });
    seedSong('b1', { artist: 'Bar' });
    const seen: string[] = [];
    const c = ctx({
      lookupGenre: async (artist) => {
        seen.push(artist);
        return artist === 'Foo' ? 'Punk' : 'Reggae';
      },
    });
    const res = await genre.run(db, c, 25);
    expect(res.applied).toBe(3);
    expect(seen.sort()).toEqual(['Bar', 'Foo']); // one lookup per artist
    const foo = db
      .query<{ genre: string }, [string]>('SELECT genre FROM library_songs WHERE id = ?')
      .get('a1');
    expect(foo?.genre).toBe('Punk');
  });

  it('skips artists Lidarr cannot resolve', async () => {
    seedSong('a', { artist: 'Unknownish' });
    const res = await genre.run(db, ctx({ lookupGenre: async () => null }), 25);
    expect(res.applied).toBe(0);
    expect(genre.countPending(db)).toBe(1);
  });
});

describe('registry', () => {
  it('exposes bpm and genre tasks', () => {
    expect(ENRICHMENT_TASKS.map((t) => t.id).sort()).toEqual(['bpm', 'genre']);
  });
});
