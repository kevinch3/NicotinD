import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ADDON_PROTOCOL_VERSION, type AddonManifest } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import { applySchema } from '../db.js';
import { acquireAlbum } from './album-acquire.js';
import { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError, type AddonClient } from './addons/client.js';
import type { AlbumHunterService } from './album-hunter.service.js';

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
  const deps = {
    db,
    hunter: null as unknown as AlbumHunterService, // must never be touched on the addon path
    lidarr: lidarrStub(),
    slskdRef: { current: null },
    getAddon: () => addon,
  };
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
    const outcome = await acquireAlbum(h.deps, INPUT);
    expect(outcome).toBe('enqueued');
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

  it('maps the addon 409 to in-flight', async () => {
    h = makeDeps({
      createJob: async () => {
        throw new AddonRequestError('conflict', 409);
      },
    });
    expect(await acquireAlbum(h.deps, INPUT)).toBe('in-flight');
  });

  it('returns no-candidate below the threshold', async () => {
    h = makeDeps({
      albumsSearch: async () => ({
        candidates: [{ ...CANDIDATE, matchPct: 40 }],
        queries: [],
        skewNeeded: false,
      }),
    });
    expect(await acquireAlbum(h.deps, INPUT)).toBe('no-candidate');
    expect(h.jobRequests).toHaveLength(0);
  });

  it('returns slskd-unavailable when the addon search fails', async () => {
    h = makeDeps({
      albumsSearch: async () => {
        throw new AddonRequestError('down');
      },
    });
    expect(await acquireAlbum(h.deps, INPUT)).toBe('slskd-unavailable');
  });
});
