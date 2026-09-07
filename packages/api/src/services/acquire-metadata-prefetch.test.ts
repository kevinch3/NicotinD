import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { createJob, listJobFeed } from './acquisition-job-store.js';
import { AcquireMetadataPrefetch, type ReleaseLookup } from './acquire-metadata-prefetch.js';

const GONDWANA = 'https://open.spotify.com/intl-es/album/5aqBD2HHSWt6VpSjSZfiMw';
const PLAYLIST = 'https://open.spotify.com/playlist/37i9dQZF1DWVYs6zNzJ0ci';

function freshDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function lookupOf(
  result: Awaited<ReturnType<ReleaseLookup['lookupRelease']>>,
): ReleaseLookup & { calls: number } {
  return {
    calls: 0,
    async lookupRelease() {
      this.calls++;
      return result;
    },
  };
}

const ALBUM = {
  name: 'Gondwana',
  artist: 'Gondwana',
  trackTitles: ['Reggae Is Coming', 'Chainga Langa', 'Irie'],
};

describe('AcquireMetadataPrefetch', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  const seed = (sourceUrl: string): string =>
    createJob(db, {
      kind: 'url',
      method: 'spotdl-addon',
      stage: 'resolving',
      sourceUrl,
      files: [],
    });

  const row = (id: string) =>
    db
      .query<
        {
          display_title: string | null;
          artist_name: string | null;
          album_title: string | null;
          canonical_tracks_json: string | null;
        },
        [string]
      >(
        `SELECT display_title, artist_name, album_title, canonical_tracks_json
           FROM acquisition_jobs WHERE id = ?`,
      )
      .get(id)!;

  it('names a queued album job before a single byte moves', async () => {
    const jobId = seed(GONDWANA);
    const p = new AcquireMetadataPrefetch(db, lookupOf(ALBUM));
    p.start(jobId, GONDWANA);
    await p.idle();

    const r = row(jobId);
    expect(r.display_title).toBe('Gondwana');
    expect(r.artist_name).toBe('Gondwana');
    expect(r.album_title).toBe('Gondwana');
    expect(JSON.parse(r.canonical_tracks_json!)).toHaveLength(3);
  });

  /**
   * Issue #990. `progress.expected` is COUNT(*) over the mirrored item rows, so
   * it climbs as they arrive. The committed size has to come from somewhere the
   * arrivals cannot move.
   */
  it('fixes the denominator at resolve time, before any item exists', async () => {
    const jobId = seed(GONDWANA);
    const p = new AcquireMetadataPrefetch(db, lookupOf(ALBUM));
    p.start(jobId, GONDWANA);
    await p.idle();

    const feed = listJobFeed(db).find((j) => j.id === jobId)!;
    expect(feed.progress.expected).toBe(0); // nothing has arrived yet
    expect(feed.progress.canonical).toBe(3); // ...but the size is already known
  });

  it('names a playlist without minting an album from its name', async () => {
    const jobId = seed(PLAYLIST);
    const p = new AcquireMetadataPrefetch(
      db,
      lookupOf({ name: 'Reggae en Espanol', artist: null, trackTitles: ['a', 'b'] }),
    );
    p.start(jobId, PLAYLIST);
    await p.idle();

    const r = row(jobId);
    expect(r.display_title).toBe('Reggae en Espanol');
    expect(r.album_title).toBeNull();
  });

  it('never overwrites metadata the addon already reported', async () => {
    const jobId = createJob(db, {
      kind: 'url',
      method: 'spotdl-addon',
      stage: 'resolving',
      sourceUrl: GONDWANA,
      artistName: 'Real Artist',
      albumTitle: 'Real Album',
      displayTitle: 'Real Title',
      files: [],
    });
    const p = new AcquireMetadataPrefetch(db, lookupOf(ALBUM));
    p.start(jobId, GONDWANA);
    await p.idle();

    const r = row(jobId);
    expect(r.display_title).toBe('Real Title');
    expect(r.album_title).toBe('Real Album');
    expect(r.artist_name).toBe('Real Artist');
  });

  it('leaves the job untouched when the lookup finds nothing', async () => {
    const jobId = seed(GONDWANA);
    const p = new AcquireMetadataPrefetch(db, lookupOf(null));
    p.start(jobId, GONDWANA);
    await p.idle();

    const r = row(jobId);
    expect(r.display_title).toBeNull();
    expect(r.canonical_tracks_json).toBeNull();
  });

  it('survives a lookup that throws — the addon stays the authority', async () => {
    const jobId = seed(GONDWANA);
    const p = new AcquireMetadataPrefetch(db, {
      async lookupRelease() {
        throw new Error('Spotify unavailable');
      },
    });
    p.start(jobId, GONDWANA);
    await p.idle();
    expect(row(jobId).display_title).toBeNull();
  });

  it('does not call out for a link Spotify does not name', async () => {
    const jobId = seed('https://music.youtube.com/playlist?list=OLAK5uy_x');
    const lookup = lookupOf(ALBUM);
    const p = new AcquireMetadataPrefetch(db, lookup);
    p.start(jobId, 'https://music.youtube.com/playlist?list=OLAK5uy_x');
    await p.idle();
    expect(lookup.calls).toBe(0);
    expect(row(jobId).display_title).toBeNull();
  });
});
