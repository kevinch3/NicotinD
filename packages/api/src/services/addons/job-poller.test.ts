import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADDON_PROTOCOL_VERSION, type AddonJob, type AddonManifest } from '@nicotind/core';
import { applySchema } from '../../db.js';
import { PluginRegistry } from '../plugins/registry.js';
import { AddonRequestError, type AddonClient } from './client.js';
import { RemoteAddonPlugin } from './remote-addon-plugin.js';
import { AddonJobPoller, addonTransferKey, parseAddonJobId } from './job-poller.js';
import type { CompletedDownloadFile } from '../path-inference.js';

const MANIFEST: AddonManifest = {
  id: 'fixture-addon',
  name: 'Fixture',
  description: 'x',
  version: '0.1.0',
  protocolVersion: ADDON_PROTOCOL_VERSION,
  kind: 'acquisition',
  capabilities: ['search', 'download'],
};

function makeJob(over: Partial<AddonJob> = {}): AddonJob {
  return {
    id: 'aj-1',
    intent: 'album',
    artist: 'Artist',
    album: 'Album',
    state: 'active',
    error: null,
    createdAt: 1000,
    updatedAt: 2000,
    items: [
      {
        itemId: 't:song one',
        title: 'Song One',
        username: 'peer',
        filename: 'Music\\Album\\01 Song One.mp3',
        size: 100,
        bitRateKbps: 320,
        audioFormat: 'MP3 320kbps',
        state: 'downloading',
        fileReady: false,
        updatedAt: 2000,
      },
    ],
    ...over,
  };
}

function harness(jobs: () => AddonJob[], getJob?: (id: string) => Promise<AddonJob>) {
  const db = new Database(':memory:');
  applySchema(db);
  const registry = new PluginRegistry({ db, dataDir: '/tmp/nicotind-test' });
  const deleted: string[] = [];
  const client = {
    baseUrl: 'http://addon:9999',
    listJobs: async () => jobs(),
    // Default: the addon no longer knows any job (the orphan case after a restart).
    getJob:
      getJob ??
      (async (id: string): Promise<AddonJob> => {
        throw new AddonRequestError(`addon responded 404 for GET /addon/v1/jobs/${id}`, 404);
      }),
    fetchFile: async () => new Response('audio-bytes'),
    deleteJob: async (id: string) => {
      deleted.push(id);
    },
    getHealth: async () => ({ ok: true, ready: true }),
    putConfig: async () => {},
  } as unknown as AddonClient;
  const plugin = new RemoteAddonPlugin(MANIFEST, client);
  registry.register(plugin);

  const organized: CompletedDownloadFile[] = [];
  const scanned: string[][] = [];
  const poller = new AddonJobPoller({
    db,
    registry,
    incomingDir: mkdtempSync(join(tmpdir(), 'addon-incoming-')),
    organizer: {
      organizeBatch: async (files) => {
        for (const f of files) {
          organized.push(f);
          f.relativePath = `Artist/Album/${f.filename.split('/').pop()}`;
        }
        return {};
      },
    },
    scan: (relPaths) => {
      scanned.push(relPaths);
    },
  });
  return { db, registry, poller, organized, scanned, deleted };
}

describe('AddonJobPoller', () => {
  let h: ReturnType<typeof harness>;

  it('does nothing while the addon plugin is disabled', async () => {
    h = harness(() => [makeJob()]);
    await h.poller.tick();
    const jobs = h.db.query(`SELECT * FROM acquisition_jobs`).all();
    expect(jobs).toHaveLength(0);
  });

  describe('with the addon enabled', () => {
    let jobsData: AddonJob[];

    beforeEach(async () => {
      jobsData = [makeJob()];
      h = harness(() => jobsData);
      await h.registry.enable('fixture-addon', 'admin');
    });

    it('mirrors an addon job + items into the feed tables', async () => {
      await h.poller.tick();
      const job = h.db
        .query<{ id: string; method: string; artist_name: string }, []>(
          `SELECT * FROM acquisition_jobs`,
        )
        .get()!;
      expect(job.method).toBe('fixture-addon');
      expect(job.artist_name).toBe('Artist');
      const item = h.db
        .query<{ transfer_key: string; state: string; username: string }, []>(
          `SELECT * FROM acquisition_job_items`,
        )
        .get()!;
      expect(item.transfer_key).toBe(addonTransferKey('fixture-addon', 't:song one'));
      expect(item.state).toBe('downloading');

      // A second tick with no updates creates nothing new (cursor advanced).
      await h.poller.tick();
      expect(h.db.query(`SELECT id FROM acquisition_jobs`).all()).toHaveLength(1);
    });

    it('a fallback repoint updates the same mirrored item in place', async () => {
      await h.poller.tick();
      jobsData = [
        makeJob({
          updatedAt: 3000,
          items: [
            {
              ...makeJob().items[0]!,
              username: 'altpeer',
              filename: 'Alt\\Song One.flac',
              audioFormat: 'FLAC',
              updatedAt: 3000,
            },
          ],
        }),
      ];
      await h.poller.tick();
      const items = h.db
        .query<{ username: string; audio_format: string }, []>(
          `SELECT * FROM acquisition_job_items`,
        )
        .all();
      expect(items).toHaveLength(1);
      expect(items[0]!.username).toBe('altpeer');
      expect(items[0]!.audio_format).toBe('FLAC');
    });

    it('ingests a fileReady completion: fetch → organize → scan → provenance', async () => {
      jobsData = [
        makeJob({
          state: 'done',
          updatedAt: 4000,
          items: [{ ...makeJob().items[0]!, state: 'completed', fileReady: true, updatedAt: 4000 }],
        }),
      ];
      await h.poller.tick();

      expect(h.organized).toHaveLength(1);
      expect(h.scanned[0]).toEqual(['Artist/Album/01 Song One.mp3']);

      const item = h.db
        .query<{ state: string; relative_path: string }, []>(`SELECT * FROM acquisition_job_items`)
        .get()!;
      expect(item.state).toBe('organized');
      expect(item.relative_path).toBe('Artist/Album/01 Song One.mp3');

      const acq = h.db
        .query<{ method: string; source_ref: string }, []>(`SELECT * FROM acquisitions`)
        .get()!;
      expect(acq.method).toBe('fixture-addon');
      expect(acq.source_ref).toBe('peer');

      // Fully ingested + terminal → released addon-side.
      expect(h.deleted).toEqual(['aj-1']);
    });
  });

  // The yt-dlp/spotdl addons keep jobs in memory, so a restart mid-download drops
  // them. The cursor-based poll only updates jobs the addon still lists, so a
  // dropped job sits "downloading" forever. reconcileOrphanedJobs re-checks stale
  // active jobs via getJob and fails the ones the addon 404s.
  describe('orphaned-job reconcile', () => {
    const STALE = Date.now() - 10 * 60_000;

    function insertActiveUrlJob(h: ReturnType<typeof harness>, id: string, addonJobId: string) {
      h.db.run(
        `INSERT INTO acquisition_jobs (id, kind, method, state, stage, source_ref, created_at, updated_at)
         VALUES (?, 'url', 'fixture-addon', 'active', 'downloading', ?, ?, ?)`,
        [id, `addon:fixture-addon:${addonJobId}`, STALE, STALE],
      );
    }

    it('fails a stale active job the addon 404s (dropped on restart)', async () => {
      h = harness(() => []); // default getJob throws 404
      await h.registry.enable('fixture-addon', 'admin');
      insertActiveUrlJob(h, 'ghost-1', 'gone-uuid');

      await h.poller.tick();

      const job = h.db
        .query<{ state: string; error: string | null }, [string]>(
          `SELECT state, error FROM acquisition_jobs WHERE id = ?`,
        )
        .get('ghost-1')!;
      expect(job.state).toBe('failed');
      expect(job.error).toContain('restarted');
    });

    it('leaves a stale active job the addon still knows about', async () => {
      h = harness(
        () => [],
        async () => makeJob(), // addon still has the job → not orphaned
      );
      await h.registry.enable('fixture-addon', 'admin');
      insertActiveUrlJob(h, 'live-1', 'live-uuid');

      await h.poller.tick();

      const job = h.db
        .query<{ state: string }, [string]>(`SELECT state FROM acquisition_jobs WHERE id = ?`)
        .get('live-1')!;
      expect(job.state).toBe('active');
    });

    it('parseAddonJobId extracts the addon-side id from the source_ref', () => {
      expect(parseAddonJobId('addon:fixture-addon:abc-123', 'fixture-addon')).toBe('abc-123');
      expect(parseAddonJobId('peer', 'fixture-addon')).toBeNull();
      expect(parseAddonJobId(null, 'fixture-addon')).toBeNull();
    });
  });

  /**
   * Protocol 1.1's `AddonJob.title`: the addon's own display name for the job
   * (a playlist name, a video title). Display-only — it must never leak into
   * `album_title`, which mints an album id and steers the organizer.
   */
  describe('display title (protocol 1.1)', () => {
    it("stores the addon's title without touching the filing album", async () => {
      h = harness(() => [makeJob({ artist: null, album: null, title: 'Summer Mix 2024' })]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      const row = h.db
        .query<{ display_title: string | null; album_title: string | null }, []>(
          `SELECT display_title, album_title FROM acquisition_jobs`,
        )
        .get()!;
      expect(row.display_title).toBe('Summer Mix 2024');
      expect(row.album_title).toBeNull();
    });

    /**
     * Not first-writer-wins, unlike artist/album: the bundled archive.org addon
     * sets a placeholder from the URL at createJob and replaces it with the real
     * item title once its background resolve lands. COALESCE pinned the card to
     * the placeholder forever.
     */
    it('lets the addon refine its title on a later poll', async () => {
      let title = 'Gd1977 05 08';
      h = harness(() => [makeJob({ title, updatedAt: title.length })]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      title = 'Grateful Dead Live at Barton Hall';
      await h.poller.tick();
      const row = h.db
        .query<{ display_title: string | null }, []>(`SELECT display_title FROM acquisition_jobs`)
        .get()!;
      expect(row.display_title).toBe('Grateful Dead Live at Barton Hall');
    });

    it('bounds an absurd title rather than storing it whole', async () => {
      h = harness(() => [makeJob({ title: 'x'.repeat(5000) })]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      const row = h.db
        .query<{ display_title: string }, []>(`SELECT display_title FROM acquisition_jobs`)
        .get()!;
      expect(row.display_title.length).toBeLessThanOrEqual(500);
    });

    it('leaves the column null for an addon that sends no title', async () => {
      h = harness(() => [makeJob()]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      const row = h.db
        .query<{ display_title: string | null; artist_name: string }, []>(
          `SELECT display_title, artist_name FROM acquisition_jobs`,
        )
        .get()!;
      expect(row.display_title).toBeNull();
      expect(row.artist_name).toBe('Artist'); // artist/album still mirror
    });
  });

  /**
   * The beatport regression. yt-dlp's addon manifest is the `^https?://`
   * catch-all, so every link no specific addon claims is handed to it — a
   * beatport release page included, which it cannot download. The addon
   * reported `failed`; core read `AddonJob.state`/`.error` nowhere, and
   * `recomputeStage` deliberately no-ops on an item-less job, so the card sat
   * at "Downloading 0 of 0" forever with no reason and no way out.
   */
  describe("mirrors the addon's own verdict (item-less jobs)", () => {
    function urlJob(over: Partial<AddonJob> = {}): AddonJob {
      return makeJob({
        id: 'aj-url',
        intent: 'url',
        artist: null,
        album: null,
        items: [],
        ...over,
      });
    }

    async function tickWith(job: AddonJob) {
      h = harness(() => [job]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      return h.db
        .query<{ state: string; stage: string; error: string | null }, []>(
          `SELECT state, stage, error FROM acquisition_jobs`,
        )
        .get()!;
    }

    it('fails an item-less job the addon failed, carrying its reason', async () => {
      const row = await tickWith(
        urlJob({
          state: 'failed',
          error: 'Unsupported URL: https://www.beatport.com/es/release/x',
        }),
      );
      expect(row.state).toBe('failed');
      expect(row.stage).toBe('error');
      expect(row.error).toContain('Unsupported URL');
    });

    it('fails an item-less job the addon finished empty, explaining why', async () => {
      const row = await tickWith(urlJob({ state: 'done', error: null }));
      expect(row.state).toBe('failed');
      expect(row.stage).toBe('error');
      expect(row.error).toBe('No downloadable audio was found at this link.');
    });

    it('leaves an item-less job the addon is still working on alone', async () => {
      const row = await tickWith(urlJob({ state: 'active' }));
      expect(row.state).toBe('active');
      expect(row.stage).not.toBe('error');
    });

    it('records the reason while the job is still active, without failing it', async () => {
      const row = await tickWith(urlJob({ state: 'active', error: 'retrying: 429 from source' }));
      expect(row.state).toBe('active');
      expect(row.error).toBe('retrying: 429 from source');
    });

    /**
     * The mirror is two-way. A one-way write would let a transient note outlive
     * its condition and then become the job's permanent verdict, because
     * `failOrphanedJob` deliberately COALESCEs rather than overwrites.
     */
    it('clears a transient reason once the addon clears its own', async () => {
      let error: string | null = 'retrying: 429 from source';
      h = harness(() => [urlJob({ state: 'active', error, updatedAt: error ? 1 : 2 })]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      error = null;
      await h.poller.tick();
      const row = h.db
        .query<{ error: string | null }, []>(`SELECT error FROM acquisition_jobs`)
        .get()!;
      expect(row.error).toBeNull();
    });

    it('closes a terminal job as an honest partial, never stuck downloading', async () => {
      // One item delivered, one the addon never got to: the second becomes
      // `unavailable` so the job can close instead of hanging on it forever.
      const job = makeJob({
        state: 'partial',
        error: 'one track was unavailable',
        items: [
          { ...makeJob().items[0]!, itemId: 'a', state: 'completed', fileReady: true },
          { ...makeJob().items[0]!, itemId: 'b', state: 'downloading', fileReady: false },
        ],
      });
      h = harness(() => [job]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();

      const states = h.db
        .query<{ state: string }, []>(`SELECT state FROM acquisition_job_items ORDER BY id`)
        .all()
        .map((r) => r.state);
      expect(states).toContain('unavailable');
      const row = h.db.query<{ stage: string }, []>(`SELECT stage FROM acquisition_jobs`).get()!;
      expect(row.stage).not.toBe('downloading');
    });

    /**
     * Releasing a terminal job addon-side is what makes the later `getJob`
     * 404 — so without COALESCE the orphan reconcile would overwrite the real
     * reason with a generic "it likely restarted mid-download" guess.
     */
    it('never lets the orphan reconcile clobber a recorded reason', async () => {
      h = harness(() => []); // default getJob 404s
      await h.registry.enable('fixture-addon', 'admin');
      const stale = Date.now() - 10 * 60_000;
      h.db.run(
        `INSERT INTO acquisition_jobs (id, kind, method, state, stage, source_ref, error, created_at, updated_at)
         VALUES ('known-1', 'url', 'fixture-addon', 'active', 'queued', 'addon:fixture-addon:x', 'Unsupported URL: beatport', ?, ?)`,
        [stale, stale],
      );

      await h.poller.tick();

      const row = h.db
        .query<{ state: string; error: string }, []>(
          `SELECT state, error FROM acquisition_jobs WHERE id = 'known-1'`,
        )
        .get()!;
      expect(row.state).toBe('failed');
      expect(row.error).toBe('Unsupported URL: beatport');
    });
  });
});
