import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../db.js';
import { completeArtist, dueCompletionSteps, type ArtistCompleteDeps } from './artist-complete.js';
import { upsertArtistMeta } from './artist-meta-store.js';
import { upsertMbid } from './mbid-store.js';
import { getArtistOrigin, upsertArtistOrigin } from './artist-origins.js';
import { recordPortraitAttempts } from './artist-image-fill.js';

let db: Database;
let coverCacheDir: string;
const artist = { id: 'ar1', name: 'Johnny Hammond' };

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  coverCacheDir = mkdtempSync(join(tmpdir(), 'artist-complete-'));
  db.run(
    `INSERT INTO library_artists (id, name, album_count, manual_override, hidden, synced_at)
     VALUES ('ar1', 'Johnny Hammond', 3, 0, 0, 1)`,
  );
});
afterEach(() => rmSync(coverCacheDir, { recursive: true, force: true }));

/** The bio step as the route wires it: resolves + stores the MBID, then the bio. */
function bioStep(bio: string | null) {
  return mock(async (a: { id: string; name: string }) => {
    upsertMbid(db, {
      scope: 'artist',
      key: 'johnny hammond',
      mbid: 'mb-jh',
      source: 'lidarr',
      confidence: 0.8,
    });
    upsertArtistMeta(db, { artistId: a.id, bio, urls: [], source: 'discogs' });
    return { kind: 'ok' as const };
  });
}

function deps(over: Partial<ArtistCompleteDeps> = {}): ArtistCompleteDeps {
  return {
    fetchInfo: bioStep('Organist.'),
    origin: { lidarr: null, lookupArtistOrigin: mock(async () => ({ ok: true, country: 'US' })) },
    portrait: {
      lidarr: null,
      spotifyLookup: mock(async () => 'http://img/jh.jpg'),
      discogsLookup: null,
      coverCacheDir,
    },
    ...over,
  };
}

describe('dueCompletionSteps', () => {
  it('a bare artist is due all three', () => {
    expect([...dueCompletionSteps(db, 'ar1')].sort()).toEqual(['bio', 'origin', 'portrait']);
  });

  it('nothing is due once each has an answer or a recent attempt', () => {
    upsertArtistMeta(db, { artistId: 'ar1', bio: null, urls: [], source: 'discogs' });
    upsertArtistOrigin(db, { artistId: 'ar1', country: 'US', source: 'musicbrainz' });
    recordPortraitAttempts(db, ['ar1'], Date.now());
    expect(dueCompletionSteps(db, 'ar1').size).toBe(0);
  });

  it("a curator's 'no country' is final, not due", () => {
    upsertArtistOrigin(db, { artistId: 'ar1', country: null, source: 'user' });
    expect(dueCompletionSteps(db, 'ar1').has('origin')).toBe(false);
  });
});

describe('completeArtist (#1855)', () => {
  it('fills bio, then the origin from the MBID the bio stored, and the portrait', async () => {
    const d = deps();
    const res = await completeArtist(db, d, artist);
    expect(res.filled.sort()).toEqual(['bio', 'origin', 'portrait']);
    expect(d.origin!.lookupArtistOrigin).toHaveBeenCalledWith('mb-jh');
    expect(getArtistOrigin(db, 'ar1')?.country).toBe('US');
  });

  it('concurrent calls for one artist share a single run', async () => {
    const d = deps();
    const [a, b] = await Promise.all([
      completeArtist(db, d, artist),
      completeArtist(db, d, artist),
    ]);
    expect(a).toBe(b);
    expect(d.fetchInfo).toHaveBeenCalledTimes(1);
  });

  it('asks no source when nothing is due', async () => {
    upsertArtistMeta(db, { artistId: 'ar1', bio: 'x', urls: [], source: 'discogs' });
    upsertArtistOrigin(db, { artistId: 'ar1', country: 'US', source: 'musicbrainz' });
    recordPortraitAttempts(db, ['ar1'], Date.now());
    const d = deps();
    expect((await completeArtist(db, d, artist)).filled).toEqual([]);
    expect(d.fetchInfo).not.toHaveBeenCalled();
    expect(d.origin!.lookupArtistOrigin).not.toHaveBeenCalled();
    expect(d.portrait!.spotifyLookup).not.toHaveBeenCalled();
  });

  it('a portrait miss is stamped, so the next visit does not ask again', async () => {
    const d = deps({
      portrait: {
        lidarr: null,
        spotifyLookup: mock(async () => null),
        discogsLookup: null,
        coverCacheDir,
      },
    });
    expect((await completeArtist(db, d, artist)).filled).not.toContain('portrait');
    expect(dueCompletionSteps(db, 'ar1').has('portrait')).toBe(false);
  });

  it('a transient origin failure writes nothing and stays due', async () => {
    const d = deps({
      origin: {
        lidarr: null,
        lookupArtistOrigin: mock(async () => ({ ok: false, country: null })),
      },
    });
    await completeArtist(db, d, artist);
    expect(getArtistOrigin(db, 'ar1')).toBeNull();
    expect(dueCompletionSteps(db, 'ar1').has('origin')).toBe(true);
  });
});
