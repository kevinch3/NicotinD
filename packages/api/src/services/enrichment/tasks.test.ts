import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import { ENRICHMENT_TASKS, getTask, type EnrichmentContext } from './tasks.js';
import { MAX_ANALYSIS_ATTEMPTS } from './analysis-failures.js';

let db: Database;

function seedSong(
  id: string,
  opts: {
    artist?: string;
    title?: string;
    bpm?: number | null;
    genre?: string | null;
    key?: string | null;
    energy?: number | null;
  } = {},
): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at, bpm, genre, key, energy)
     VALUES (?, 'alb', ?, ?, 'art', 0, ?, 10, 320, 'opus', 'audio/opus', '2024-01-01', 1, ?, ?, ?, ?)`,
    [
      id,
      opts.title ?? `T-${id}`,
      opts.artist ?? 'Artist',
      `${opts.artist ?? 'Artist'}/Album/${id}.opus`,
      opts.bpm ?? null,
      opts.genre ?? null,
      opts.key ?? null,
      opts.energy ?? null,
    ],
  );
}

function ctx(overrides: Partial<EnrichmentContext> = {}): EnrichmentContext {
  return {
    musicDir: '/music',
    coverCacheDir: '/data/cover-cache',
    lidarr: {} as never,
    concurrency: 2,
    ffmpegAvailable: () => true,
    readTags: async () => ({}),
    writeTags: async () => true,
    analyzeBpm: async () => 120,
    analyzeKey: async () => 'C major',
    analyzeLoudness: async () => ({ loudness: -9.5, energy: 0.7 }),
    analyzeAudioFeatures: async () => ({
      features: {
        danceability: 0.6,
        valence: 0.4,
        acousticness: 0.2,
        instrumental: 0.9,
        mood: 'relaxed',
      },
      embedding: { model: 'discogs-effnet-bs64-1', dim: 4, values: [1, 2, 3, 4] },
      modelVersions: { embedding: 'discogs-effnet-bs64-1' },
    }),
    audioFeaturesAvailable: () => true,
    lookupGenre: async () => 'Rock',
    lookupArtistImageSpotify: async () => null,
    fileExists: () => true,
    ...overrides,
  };
}

function seedArtist(
  id: string,
  opts: { name?: string; albumCount?: number; hidden?: number; manualOverride?: number } = {},
): void {
  db.run(
    'INSERT INTO library_artists (id, name, album_count, hidden, manual_override, synced_at) VALUES (?, ?, ?, ?, ?, 1)',
    [id, opts.name ?? `Artist ${id}`, opts.albumCount ?? 1, opts.hidden ?? 0, opts.manualOverride ?? 0],
  );
}

/** A Lidarr stub whose monitored list carries one poster per named artist. */
function lidarrWithPosters(posters: Record<string, string>): EnrichmentContext['lidarr'] {
  return {
    artist: {
      list: async () =>
        Object.entries(posters).map(([artistName, url], i) => ({
          id: i + 1,
          artistName,
          images: [{ coverType: 'poster', url }],
        })),
      lookup: async () => [],
    },
  } as unknown as EnrichmentContext['lidarr'];
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
    // A quiet null (no onError) is not a hard failure — nothing to report.
    expect(res.failed).toBe(0);
    expect(res.errorSample).toBeNull();
  });

  it('counts decode failures and keeps the first error as a sample', async () => {
    seedSong('a');
    seedSong('b');
    const res = await bpm.run(
      db,
      ctx({
        analyzeBpm: async (_abs, onError) => {
          onError?.(new Error('ffmpeg PCM decode exited with code 183: Invalid data'));
          return null;
        },
      }),
      25,
    );
    expect(res.applied).toBe(0);
    expect(res.failed).toBe(2);
    expect(res.errorSample).toContain('code 183');
  });
});

describe('corrupt-file exclusion', () => {
  const bpm = getTask('bpm')!;
  const alwaysFails = () =>
    ctx({
      analyzeBpm: async (_abs, onError) => {
        onError?.(new Error('ffmpeg PCM decode exited with code 183: Invalid data'));
        return null;
      },
    });

  it('drops a repeatedly-failing file out of the pending set after the cap', async () => {
    seedSong('a');
    expect(bpm.countPending(db)).toBe(1);
    // Each run attempts + fails the file once; after the cap it is excluded.
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i++) {
      await bpm.run(db, alwaysFails(), 25);
    }
    expect(bpm.countPending(db)).toBe(0);
    // A further run doesn't even attempt it (nothing selected → no failures).
    const res = await bpm.run(db, alwaysFails(), 25);
    expect(res.failed).toBe(0);
  });

  it('clears the failure record when the file later succeeds', async () => {
    seedSong('a');
    await bpm.run(db, alwaysFails(), 25); // one failure recorded
    // A subsequent good run enriches it and wipes the ledger row.
    const res = await bpm.run(db, ctx({ analyzeBpm: async () => 120 }), 25);
    expect(res.applied).toBe(1);
    const remaining = db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM library_song_analysis_failures')
      .get()!.n;
    expect(remaining).toBe(0);
  });

  it('re-includes a file after it is re-downloaded (size change)', async () => {
    seedSong('a');
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i++) {
      await bpm.run(db, alwaysFails(), 25);
    }
    expect(bpm.countPending(db)).toBe(0);
    // seedSong inserts size 10; simulate a re-download by changing it.
    db.run("UPDATE library_songs SET size = 9999 WHERE id = 'a'");
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

describe('key task', () => {
  const key = getTask('key')!;

  it('is unavailable without ffmpeg', () => {
    expect(key.available(ctx({ ffmpegAvailable: () => false }))).toBe('ffmpeg not found on PATH');
    expect(key.available(ctx())).toBe(true);
  });

  it('counts only songs with NULL/empty key', () => {
    seedSong('a');
    seedSong('b', { key: 'A minor' });
    seedSong('c');
    expect(key.countPending(db)).toBe(2);
  });

  it('analyzes pending songs and writes the analyzed key to the tag', async () => {
    seedSong('a');
    let wrote = 0;
    const c = ctx({
      analyzeKey: async () => 'G major',
      writeTags: async () => ((wrote += 1), true),
    });
    const res = await key.run(db, c, 25);
    expect(res.applied).toBe(1);
    expect(wrote).toBe(1);
    const row = db
      .query<{ key: string }, [string]>('SELECT key FROM library_songs WHERE id = ?')
      .get('a');
    expect(row?.key).toBe('G major');
  });

  it('prefers an existing tag key and does not re-analyze', async () => {
    seedSong('a');
    let analyzed = 0;
    const c = ctx({
      readTags: async () => ({ key: 'F# minor' }),
      analyzeKey: async () => ((analyzed += 1), 'C major'),
    });
    const res = await key.run(db, c, 25);
    expect(res.applied).toBe(1);
    expect(analyzed).toBe(0);
    const row = db
      .query<{ key: string }, [string]>('SELECT key FROM library_songs WHERE id = ?')
      .get('a');
    expect(row?.key).toBe('F# minor');
  });
});

describe('artist-image task', () => {
  const artistImage = getTask('artist-image')!;

  it('is available with Lidarr or Spotify, unavailable with neither', () => {
    expect(artistImage.available(ctx())).toBe(true);
    expect(artistImage.available(ctx({ lidarr: null }))).toBe(true); // Spotify present
    expect(
      artistImage.available(ctx({ lidarr: null, lookupArtistImageSpotify: null })),
    ).toBe('Lidarr/Spotify not configured');
  });

  it('counts artists missing an artist artwork row (excludes hidden/manual/has-artwork)', () => {
    seedArtist('a'); // pending
    seedArtist('b', { hidden: 1 }); // excluded: hidden
    seedArtist('c', { manualOverride: 1 }); // excluded: manual
    seedArtist('d'); // excluded: already has artwork
    db.run(
      `INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES ('d', 'artist', 'https://x/p.jpg', 1)`,
    );
    expect(artistImage.countPending(db)).toBe(1);
  });

  it('writes a Lidarr poster for a matching artist and skips placeholder/VA names', async () => {
    seedArtist('art-real', { name: 'Radiohead', albumCount: 5 });
    seedArtist('art-va', { name: 'Various Artists', albumCount: 9 });
    const c = ctx({
      lidarr: lidarrWithPosters({ Radiohead: 'https://x/radiohead.jpg' }),
      lookupArtistImageSpotify: async () => null,
    });
    const res = await artistImage.run(db, c, 25);
    expect(res.applied).toBe(1);
    const real = db
      .query<{ cover_url: string }, [string]>(
        `SELECT cover_url FROM library_artwork WHERE id = ? AND kind = 'artist'`,
      )
      .get('art-real');
    expect(real?.cover_url).toBe('https://x/radiohead.jpg');
    // VA placeholder is never written even with a high album_count.
    expect(
      db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM library_artwork WHERE id = ? AND kind = 'artist'`,
        )
        .get('art-va')?.n,
    ).toBe(0);
  });

  it('falls back to Spotify when Lidarr has no poster, labelling the source', async () => {
    seedArtist('art-1', { name: 'Obscure Band' });
    const c = ctx({
      lidarr: lidarrWithPosters({}),
      lookupArtistImageSpotify: async () => 'https://x/spotify.jpg',
    });
    const res = await artistImage.run(db, c, 25);
    expect(res.applied).toBe(1);
    expect(res.labels[0]).toContain('spotify');
    expect(
      db
        .query<{ cover_url: string }, [string]>(
          `SELECT cover_url FROM library_artwork WHERE id = ? AND kind = 'artist'`,
        )
        .get('art-1')?.cover_url,
    ).toBe('https://x/spotify.jpg');
  });

  it('does not overwrite a manually-set (manual_override) artist', async () => {
    seedArtist('art-1', { name: 'Radiohead', manualOverride: 1 });
    const c = ctx({ lidarr: lidarrWithPosters({ Radiohead: 'https://x/p.jpg' }) });
    const res = await artistImage.run(db, c, 25);
    expect(res.applied).toBe(0);
  });
});

describe('energy task', () => {
  const energy = getTask('energy')!;

  it('is unavailable without ffmpeg', () => {
    expect(energy.available(ctx({ ffmpegAvailable: () => false }))).toBe(
      'ffmpeg not found on PATH',
    );
    expect(energy.available(ctx())).toBe(true);
  });

  it('counts only songs with NULL energy', () => {
    seedSong('a');
    seedSong('b', { energy: 0.5 });
    expect(energy.countPending(db)).toBe(1);
  });

  it('analyzes pending songs, writing energy + loudness to DB and tag', async () => {
    seedSong('a');
    let wroteTags: unknown = null;
    const c = ctx({
      analyzeLoudness: async () => ({ loudness: -8.2, energy: 0.81 }),
      writeTags: async (_abs, tags) => {
        wroteTags = tags;
        return true;
      },
    });
    const res = await energy.run(db, c, 25);
    expect(res.applied).toBe(1);
    const row = db
      .query<{ energy: number; loudness: number }, [string]>(
        'SELECT energy, loudness FROM library_songs WHERE id = ?',
      )
      .get('a');
    expect(row?.energy).toBeCloseTo(0.81);
    expect(row?.loudness).toBeCloseTo(-8.2);
    expect(wroteTags).toEqual({ energy: 0.81, loudness: -8.2 });
  });

  it('prefers an existing ENERGY tag and does NOT rewrite the tag', async () => {
    seedSong('a');
    let analyzed = 0;
    let wrote = 0;
    const c = ctx({
      readTags: async () => ({ energy: 0.33, loudness: -14.0 }),
      analyzeLoudness: async () => ((analyzed += 1), { loudness: -6, energy: 0.99 }),
      writeTags: async () => ((wrote += 1), true),
    });
    const res = await energy.run(db, c, 25);
    expect(res.applied).toBe(1);
    expect(analyzed).toBe(0);
    expect(wrote).toBe(0);
    const row = db
      .query<{ energy: number; loudness: number }, [string]>(
        'SELECT energy, loudness FROM library_songs WHERE id = ?',
      )
      .get('a');
    expect(row?.energy).toBeCloseTo(0.33);
    expect(row?.loudness).toBeCloseTo(-14.0);
  });

  it('does not apply when analysis returns null (stays pending)', async () => {
    seedSong('a');
    const res = await energy.run(db, ctx({ analyzeLoudness: async () => null }), 25);
    expect(res.applied).toBe(0);
    expect(energy.countPending(db)).toBe(1);
  });
});

describe('audio-features task', () => {
  const features = getTask('audio-features')!;

  it('is unavailable without a configured sidecar, or when unreachable', () => {
    expect(features.available(ctx({ analyzeAudioFeatures: null }))).toBe(
      'analysis sidecar not configured',
    );
    expect(features.available(ctx({ audioFeaturesAvailable: () => false }))).toBe(
      'analysis sidecar unreachable',
    );
    expect(features.available(ctx())).toBe(true);
  });

  it('counts only songs with NULL danceability', () => {
    seedSong('a');
    db.run("UPDATE library_songs SET danceability = 0.5 WHERE id = 'a'");
    seedSong('b');
    expect(features.countPending(db)).toBe(1);
  });

  it('analyzes pending songs: feature columns + embedding row + tag write', async () => {
    seedSong('a');
    let wroteTags: unknown = null;
    const c = ctx({
      writeTags: async (_abs, tags) => {
        wroteTags = tags;
        return true;
      },
    });
    const res = await features.run(db, c, 25);
    expect(res.applied).toBe(1);
    const row = db
      .query<
        { danceability: number; valence: number; mood: string },
        [string]
      >('SELECT danceability, valence, mood FROM library_songs WHERE id = ?')
      .get('a');
    expect(row?.danceability).toBeCloseTo(0.6);
    expect(row?.valence).toBeCloseTo(0.4);
    expect(row?.mood).toBe('relaxed');
    const emb = db
      .query<
        { model: string; dim: number; vec: Uint8Array },
        [string]
      >('SELECT model, dim, vec FROM library_embeddings WHERE song_id = ?')
      .get('a');
    expect(emb?.model).toBe('discogs-effnet-bs64-1');
    expect(emb?.dim).toBe(4);
    expect(Array.from(new Float32Array(emb!.vec.buffer.slice(0)))).toEqual([1, 2, 3, 4]);
    expect(wroteTags).toEqual({
      danceability: 0.6,
      valence: 0.4,
      acousticness: 0.2,
      instrumental: 0.9,
      mood: 'relaxed',
    });
  });

  it('adopts fully-tagged files without calling the sidecar', async () => {
    seedSong('a');
    let sidecarCalls = 0;
    const c = ctx({
      readTags: async () => ({
        danceability: 0.7,
        valence: 0.2,
        acousticness: 0.9,
        instrumental: 0.1,
        mood: 'sad',
      }),
      analyzeAudioFeatures: async () => {
        sidecarCalls++;
        return null;
      },
    });
    const res = await features.run(db, c, 25);
    expect(res.applied).toBe(1);
    expect(sidecarCalls).toBe(0);
    const row = db
      .query<{ mood: string; danceability: number }, [string]>(
        'SELECT mood, danceability FROM library_songs WHERE id = ?',
      )
      .get('a');
    expect(row?.mood).toBe('sad');
    expect(row?.danceability).toBeCloseTo(0.7);
    // No embedding without a sidecar analysis.
    expect(
      db.query('SELECT COUNT(*) AS c FROM library_embeddings').get() as { c: number },
    ).toEqual({ c: 0 });
  });

  it('partially-tagged files still go to the sidecar', async () => {
    seedSong('a');
    let sidecarCalls = 0;
    const c = ctx({
      readTags: async () => ({ danceability: 0.7 }), // missing the rest
      analyzeAudioFeatures: async () => {
        sidecarCalls++;
        return {
          features: {
            danceability: 0.5,
            valence: 0.5,
            acousticness: 0.5,
            instrumental: 0.5,
            mood: 'happy',
          },
          embedding: { model: 'm', dim: 1, values: [0] },
          modelVersions: {},
        };
      },
    });
    await features.run(db, c, 25);
    expect(sidecarCalls).toBe(1);
  });

  it('stops the batch when the sidecar goes down mid-run (songs stay pending)', async () => {
    for (let i = 0; i < 4; i++) seedSong(`s${i}`);
    let calls = 0;
    const c = ctx({
      concurrency: 1,
      analyzeAudioFeatures: async () => {
        calls++;
        return null; // every call fails…
      },
      audioFeaturesAvailable: () => false, // …and health says it's gone
    });
    const res = await features.run(db, c, 25);
    expect(res.applied).toBe(0);
    expect(calls).toBe(1); // aborted after the first failure, not 4 attempts
    expect(features.countPending(db)).toBe(4);
    // A sidecar *outage* is not counted against individual files.
    expect(res.failed).toBe(0);
  });

  it('counts per-file failures when the sidecar is up but rejects a file (404)', async () => {
    seedSong('a');
    seedSong('b');
    const c = ctx({
      concurrency: 1,
      analyzeAudioFeatures: async () => null, // sidecar rejects each file…
      audioFeaturesAvailable: () => true, // …but is otherwise healthy
    });
    const res = await features.run(db, c, 25);
    expect(res.applied).toBe(0);
    expect(res.failed).toBe(2);
    expect(res.errorSample).toContain('sidecar');
  });
});

describe('registry', () => {
  it('exposes bpm, genre, key, energy, audio-features and artist-image tasks', () => {
    expect(ENRICHMENT_TASKS.map((t) => t.id).sort()).toEqual([
      'artist-image',
      'audio-features',
      'bpm',
      'energy',
      'genre',
      'key',
    ]);
  });
});
