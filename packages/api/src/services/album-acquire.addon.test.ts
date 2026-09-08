import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ADDON_PROTOCOL_VERSION, type AddonManifest } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import { applySchema } from '../db.js';
import { albumIdFor, artistIdFor } from './library-scanner.js';
import { acquireAlbum } from './album-acquire.js';
import { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError, type AddonClient } from './addons/client.js';

const MANIFEST: AddonManifest = {
  id: 'fixture-addon',
  name: 'Fixture',
  description: 'x',
  version: '0.1.0',
  protocolVersion: ADDON_PROTOCOL_VERSION,
  kind: 'acquisition',
  capabilities: ['search', 'download'],
};

const CANDIDATE = {
  candidateRef: 'ref-1',
  username: 'peer',
  directory: 'Music\\Album',
  matchedTracks: 2,
  totalTracks: 2,
  matchPct: 100,
  format: 'MP3 320kbps',
  estimatedSizeMb: 10,
  isLive: false,
  files: [],
};

function lidarrStub(): Lidarr {
  return {
    track: {
      listByAlbum: async () => [{ title: 'Song One' }, { title: 'Song Two' }],
    },
  } as unknown as Lidarr;
}

function makeDeps(clientOver: Partial<AddonClient> = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const jobRequests: unknown[] = [];
  const client = {
    baseUrl: 'http://addon:9999',
    albumsSearch: async () => ({ candidates: [CANDIDATE], queries: [], skewNeeded: false }),
    createJob: async (req: unknown) => {
      jobRequests.push(req);
      return { id: 'aj-9', intent: 'album', items: [] };
    },
    ...clientOver,
  } as unknown as AddonClient;
  const addon = new RemoteAddonPlugin(MANIFEST, client);
  const deps = { db, lidarr: lidarrStub(), getAddon: () => addon };
  return { db, deps, jobRequests };
}

const INPUT = {
  lidarrAlbumId: 42,
  artistName: 'Artist',
  albumTitle: 'Album',
  minMatchPct: 80,
  artistMbid: null,
};

describe('acquireAlbum via a remote addon', () => {
  let h: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    h = makeDeps();
  });

  it('hunts + creates the addon job and records the mapped feed row', async () => {
    const result = await acquireAlbum(h.deps, INPUT);
    expect(result).toEqual({ outcome: 'enqueued' });
    expect(h.jobRequests).toHaveLength(1);
    expect(h.jobRequests[0]).toMatchObject({
      intent: 'album',
      candidateRef: 'ref-1',
      wantedTracks: [{ title: 'Song One' }, { title: 'Song Two' }],
    });

    const job = h.db
      .query<{ method: string; lidarr_album_id: number; source_ref: string }, []>(
        `SELECT * FROM acquisition_jobs`,
      )
      .get()!;
    expect(job.method).toBe('fixture-addon');
    expect(job.lidarr_album_id).toBe(42);
    expect(job.source_ref).toBe('addon:fixture-addon:aj-9');

    // The poller mapping points the addon job at this feed row.
    const kv = h.db
      .query<{ value: string }, [string, string]>(
        `SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?`,
      )
      .get('addon-poller:fixture-addon', 'jobmap:aj-9');
    expect(kv?.value).toBe(job.source_ref.length ? kv!.value : '');
  });

  it('maps the addon 409 to in-flight, with no detail', async () => {
    h = makeDeps({
      createJob: async () => {
        throw new AddonRequestError('conflict', 409);
      },
    });
    expect(await acquireAlbum(h.deps, INPUT)).toEqual({ outcome: 'in-flight' });
  });

  it('carries why the enqueue failed (issue #858)', async () => {
    h = makeDeps({
      createJob: async () => {
        throw new AddonRequestError('addon responded 400 for POST /addon/v1/jobs', 400);
      },
    });
    expect(await acquireAlbum(h.deps, INPUT)).toEqual({
      outcome: 'enqueue-failed',
      detail: 'addon responded 400 for POST /addon/v1/jobs',
    });
  });

  it('returns no-candidate below the threshold', async () => {
    h = makeDeps({
      albumsSearch: async () => ({
        candidates: [{ ...CANDIDATE, matchPct: 40 }],
        queries: [],
        skewNeeded: false,
      }),
    });
    expect(await acquireAlbum(h.deps, INPUT)).toEqual({ outcome: 'no-candidate' });
    expect(h.jobRequests).toHaveLength(0);
  });

  it('returns already-complete when the album is on disk (no addon call)', async () => {
    const albumId = albumIdFor('Artist', 'Album');
    h.db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
       VALUES (?, 'Album', 'Artist', ?, 2, 0, '2024-01-01', 0)`,
      [albumId, artistIdFor('Artist')],
    );
    expect(await acquireAlbum(h.deps, INPUT)).toEqual({ outcome: 'already-complete' });
    expect(h.jobRequests).toHaveLength(0);
  });

  it('returns slskd-unavailable when no addon is enabled (phase 3: addon-only)', async () => {
    expect(
      await acquireAlbum({ db: h.db, lidarr: h.deps.lidarr, getAddon: () => null }, INPUT),
    ).toEqual({ outcome: 'slskd-unavailable', detail: 'No acquisition addon is enabled' });
  });

  it('returns slskd-unavailable when the addon search fails, and says so', async () => {
    h = makeDeps({
      albumsSearch: async () => {
        throw new AddonRequestError('addon unreachable at http://addon:9999: timed out');
      },
    });
    expect(await acquireAlbum(h.deps, INPUT)).toEqual({
      outcome: 'slskd-unavailable',
      detail: 'addon unreachable at http://addon:9999: timed out',
    });
  });
});

// #1040. slskd's HTTP API stays healthy while its Soulseek session is down, so
// an outage used to arrive here as an ordinary empty candidate list. Recorded as
// 'no-candidate' it reads "this album is not obtainable" — a curator stops
// asking, and the watchlist keeps re-deciding the same wrong thing — when the
// truth is "we never asked Soulseek". The two outcomes differ in what a caller
// should DO, which is the whole reason they are separate tokens.
describe('acquireAlbum when the source is offline', () => {
  it('reports slskd-unavailable, not no-candidate, for an offline empty hunt', async () => {
    const h = makeDeps({
      albumsSearch: async () => ({
        candidates: [],
        queries: [],
        skewNeeded: false,
        sourceOffline: true,
      }),
    });
    const result = await acquireAlbum(h.deps, INPUT);
    expect(result.outcome).toBe('slskd-unavailable');
    expect(result.detail).toMatch(/offline/i);
  });

  // An empty hunt that DID reach Soulseek is still an honest miss — the flag
  // must not become a blanket excuse that hides real absence.
  it('still reports no-candidate when the source was reachable', async () => {
    const h = makeDeps({
      albumsSearch: async () => ({ candidates: [], queries: [], skewNeeded: false }),
    });
    expect((await acquireAlbum(h.deps, INPUT)).outcome).toBe('no-candidate');
  });

  // A partial outage that still produced a good-enough folder is an acquire, not
  // a deferral: the candidate in hand is real.
  it('acquires normally when a candidate cleared the bar despite the flag', async () => {
    const h = makeDeps({
      albumsSearch: async () => ({
        candidates: [CANDIDATE],
        queries: [],
        skewNeeded: false,
        sourceOffline: true,
      }),
    });
    expect((await acquireAlbum(h.deps, INPUT)).outcome).toBe('enqueued');
  });

  // The watchlist maps 'enqueue-failed' to state='failed', which is TERMINAL.
  // A source that went down between the hunt and the enqueue would therefore
  // permanently kill the row over a transient outage. Ask the addon whether it
  // is ready before calling an enqueue failure final.
  it('defers instead of failing terminally when the enqueue died with the source down', async () => {
    const h = makeDeps({
      createJob: async () => {
        throw new AddonRequestError('addon responded 502 for POST /addon/v1/jobs', 502);
      },
      getHealth: async () => ({ ok: true, ready: false, detail: 'Soulseek source offline' }),
    });
    const result = await acquireAlbum(h.deps, INPUT);
    expect(result.outcome).toBe('slskd-unavailable');
    expect(result.detail).toMatch(/offline/i);
  });

  it('keeps a genuine enqueue rejection terminal when the source is healthy', async () => {
    const h = makeDeps({
      createJob: async () => {
        throw new AddonRequestError('addon responded 400 for POST /addon/v1/jobs', 400);
      },
      getHealth: async () => ({ ok: true, ready: true }),
    });
    expect((await acquireAlbum(h.deps, INPUT)).outcome).toBe('enqueue-failed');
  });

  // Readiness is a hint used only to downgrade a failure to a retry. If asking
  // throws, we must not lose the original error.
  it('falls back to enqueue-failed when readiness cannot be determined', async () => {
    const h = makeDeps({
      createJob: async () => {
        throw new AddonRequestError('addon responded 502 for POST /addon/v1/jobs', 502);
      },
      getHealth: async () => {
        throw new Error('unreachable');
      },
    });
    expect((await acquireAlbum(h.deps, INPUT)).outcome).toBe('enqueue-failed');
  });
});
