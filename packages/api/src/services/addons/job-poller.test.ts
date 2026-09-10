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
import {
  AddonJobPoller,
  addonTransferKey,
  mapAddonJob,
  parseAddonJobId,
  sanitizeAddonError,
  type IngestReceipt,
} from './job-poller.js';
import { createJob, markPartialDiscarded, requestJobCancel } from '../acquisition-job-store.js';
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

/**
 * `listSince` opts into a cursor-honouring `listJobs`, the way a real addon
 * filters on `?since=`. The default deliberately ignores the cursor — that is
 * what every pre-existing test assumes, and it is also why #725 shipped
 * unnoticed: a stranded job is invisible to a lister that always returns
 * everything. `fetchFile` is overridable so a test can fail one ingest attempt.
 */
function harness(
  jobs: () => AddonJob[],
  getJob?: (id: string) => Promise<AddonJob>,
  opts: {
    listSince?: (since: number | undefined) => AddonJob[];
    fetchFile?: () => Promise<Response>;
    /** Defaults to 0 so the stranded sweep runs every tick under test. */
    strandedSweepIntervalMs?: number;
    /** Organized relPath → the copy the dedupe kept in its place (#1032). */
    supersede?: Record<string, string>;
  } = {},
) {
  const db = new Database(':memory:');
  applySchema(db);
  // Prod's `openDatabase` enforces foreign keys; a test DB that does not never
  // sees the throw #1081 is about (an item mirrored into a removed card).
  db.run('PRAGMA foreign_keys=ON');
  const registry = new PluginRegistry({ db, dataDir: '/tmp/nicotind-test' });
  const deleted: string[] = [];
  const client = {
    baseUrl: 'http://addon:9999',
    listJobs: async (since?: number) => (opts.listSince ? opts.listSince(since) : jobs()),
    // Default: the addon no longer knows any job (the orphan case after a restart).
    getJob:
      getJob ??
      (async (id: string): Promise<AddonJob> => {
        throw new AddonRequestError(`addon responded 404 for GET /addon/v1/jobs/${id}`, 404);
      }),
    fetchFile: opts.fetchFile ?? (async () => new Response('audio-bytes')),
    deleteJob: async (id: string) => {
      deleted.push(id);
    },
    cancelJob: async () => {},
    getHealth: async () => ({ ok: true, ready: true }),
    putConfig: async () => {},
  } as unknown as AddonClient;
  const plugin = new RemoteAddonPlugin(MANIFEST, client);
  registry.register(plugin);

  const organized: CompletedDownloadFile[] = [];
  const scanned: string[][] = [];
  const receipts: IngestReceipt[] = [];
  const poller = new AddonJobPoller({
    db,
    registry,
    incomingDir: mkdtempSync(join(tmpdir(), 'addon-incoming-')),
    strandedSweepIntervalMs: opts.strandedSweepIntervalMs ?? 0,
    organizer: {
      organizeBatch: async (files) => {
        const supersededRelPaths: Record<string, string> = {};
        for (const f of files) {
          organized.push(f);
          f.relativePath = `Artist/Album/${f.filename.split('/').pop()}`;
          // Model the real organizer: it stamps the path it wrote, then the
          // dedupe pass may unlink that file in favour of one already held.
          const winner = opts.supersede?.[f.relativePath];
          if (winner) supersededRelPaths[f.relativePath] = winner;
        }
        return { supersededRelPaths };
      },
    },
    scan: (relPaths) => {
      scanned.push(relPaths);
    },
    onIngestReceipt: (r) => {
      receipts.push(r);
    },
  });
  return { db, registry, poller, organized, scanned, deleted, receipts };
}

describe('AddonJobPoller', () => {
  let h: ReturnType<typeof harness>;

  it('does nothing while the addon plugin is disabled', async () => {
    h = harness(() => [makeJob()]);
    await h.poller.tick();
    await h.poller.idle();
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
      await h.poller.idle();
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
      await h.poller.idle();
      expect(h.db.query(`SELECT id FROM acquisition_jobs`).all()).toHaveLength(1);
    });

    it('a fallback repoint updates the same mirrored item in place', async () => {
      await h.poller.tick();
      await h.poller.idle();
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
      await h.poller.idle();
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
      await h.poller.idle();

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

    it('records the surviving copy when dedupe collapses the acquired file (#1032)', async () => {
      // Prod shape: the album already held `01 - Song One.mp3`, so the organizer
      // stamped the path it wrote and the dedupe pass then unlinked it. Recording
      // the dead path stranded the item at `organized` forever, and its job at
      // `stage=scanning`, for an acquisition that had actually succeeded.
      h = harness(() => jobsData, undefined, {
        supersede: { 'Artist/Album/01 Song One.mp3': 'Artist/Album/01 - Song One.mp3' },
      });
      await h.registry.enable('fixture-addon', 'admin');
      jobsData = [
        makeJob({
          state: 'done',
          updatedAt: 4000,
          items: [{ ...makeJob().items[0]!, state: 'completed', fileReady: true, updatedAt: 4000 }],
        }),
      ];
      await h.poller.tick();
      await h.poller.idle();

      const item = h.db
        .query<{ state: string; relative_path: string }, []>(`SELECT * FROM acquisition_job_items`)
        .get()!;
      // The path that survived on disk, not the one that was deleted.
      expect(item.relative_path).toBe('Artist/Album/01 - Song One.mp3');
      // And the scan is asked about a file that exists, so the item can resolve.
      expect(h.scanned[0]).toEqual(['Artist/Album/01 - Song One.mp3']);
    });

    it('leaves the recorded path alone when nothing was superseded', async () => {
      h = harness(() => jobsData, undefined, { supersede: {} });
      await h.registry.enable('fixture-addon', 'admin');
      jobsData = [
        makeJob({
          state: 'done',
          updatedAt: 4000,
          items: [{ ...makeJob().items[0]!, state: 'completed', fileReady: true, updatedAt: 4000 }],
        }),
      ];
      await h.poller.tick();
      await h.poller.idle();

      const item = h.db
        .query<{ relative_path: string }, []>(`SELECT * FROM acquisition_job_items`)
        .get()!;
      expect(item.relative_path).toBe('Artist/Album/01 Song One.mp3');
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
      await h.poller.idle();

      const job = h.db
        .query<{ state: string; error: string | null }, [string]>(
          `SELECT state, error FROM acquisition_jobs WHERE id = ?`,
        )
        .get('ghost-1')!;
      expect(job.state).toBe('failed');
      expect(job.error).toContain('stopped reporting');
    });

    it('leaves a stale active job the addon still knows about', async () => {
      h = harness(
        () => [],
        async () => makeJob(), // addon still has the job → not orphaned
      );
      await h.registry.enable('fixture-addon', 'admin');
      insertActiveUrlJob(h, 'live-1', 'live-uuid');

      await h.poller.tick();
      await h.poller.idle();

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

    /**
     * #744. `maybeReleaseAddonJob` deletes the addon-side job once the addon is
     * terminal and every file is fetched, and records that in `released:<id>`.
     * The core row can still be `active` at that moment — items organized but
     * not yet scanned. The reconcile then re-checks it, gets a 404 *we*
     * caused, and used to declare the addon had restarted.
     *
     * Measured on prod 2026-08-26: a 5-CD album whose 98 files had all landed
     * and scanned was shown as `Error · 98 of 100 · 2 unavailable` — while the
     * addon container had `RestartCount=0` and 7 days of uptime.
     */
    function armReleasedMarker(h: ReturnType<typeof harness>, addonJobId: string) {
      h.db.run(`INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?, ?, '1')`, [
        'addon-poller:fixture-addon',
        `released:${addonJobId}`,
      ]);
    }

    it('does not fail a job whose addon-side 404 came from our own release', async () => {
      h = harness(() => []); // default getJob throws 404
      await h.registry.enable('fixture-addon', 'admin');
      insertActiveUrlJob(h, 'released-1', 'released-uuid');
      armReleasedMarker(h, 'released-uuid');

      await h.poller.tick();
      await h.poller.idle();

      const job = h.db
        .query<{ state: string; error: string | null }, [string]>(
          `SELECT state, error FROM acquisition_jobs WHERE id = ?`,
        )
        .get('released-1')!;
      expect(job.state).toBe('active');
      expect(job.error).toBeNull();
    });

    it('still fails a job the addon genuinely forgot (no release marker)', async () => {
      h = harness(() => []);
      await h.registry.enable('fixture-addon', 'admin');
      insertActiveUrlJob(h, 'ghost-2', 'forgotten-uuid');

      await h.poller.tick();
      await h.poller.idle();

      const job = h.db
        .query<{ state: string; error: string | null }, [string]>(
          `SELECT state, error FROM acquisition_jobs WHERE id = ?`,
        )
        .get('ghost-2')!;
      expect(job.state).toBe('failed');
      expect(job.error).toBeTruthy();
    });

    /**
     * A `completed` item is a file we already hold on disk. Relabelling it
     * `unavailable` is how prod's card claimed "2 unavailable" for a source
     * that had in fact served every track it offered.
     */
    it('an orphan sweep never relabels a downloaded item as unavailable', async () => {
      h = harness(() => []);
      await h.registry.enable('fixture-addon', 'admin');
      insertActiveUrlJob(h, 'ghost-3', 'forgotten-uuid-2');
      h.db.run(
        `INSERT INTO acquisition_job_items (job_id, track_title, username, filename, transfer_key, state, updated_at)
         VALUES ('ghost-3', 'Downloaded', 'peer', 'f1.mp3', 'k1', 'completed', ?),
                ('ghost-3', 'Organized', 'peer', 'f2.mp3', 'k2', 'organized', ?),
                ('ghost-3', 'InFlight', 'peer', 'f3.mp3', 'k3', 'downloading', ?)`,
        [STALE, STALE, STALE],
      );

      await h.poller.tick();
      await h.poller.idle();

      const states = Object.fromEntries(
        h.db
          .query<{ track_title: string; state: string }, [string]>(
            `SELECT track_title, state FROM acquisition_job_items WHERE job_id = ?`,
          )
          .all('ghost-3')
          .map((r) => [r.track_title, r.state]),
      );
      expect(states['Downloaded']).toBe('completed');
      expect(states['Organized']).toBe('organized');
      expect(states['InFlight']).toBe('unavailable');
    });

    /** The poller cannot know why the addon 404s — it must not invent a cause. */
    it('states what it observed rather than guessing at a restart', async () => {
      h = harness(() => []);
      await h.registry.enable('fixture-addon', 'admin');
      insertActiveUrlJob(h, 'ghost-4', 'forgotten-uuid-3');

      await h.poller.tick();
      await h.poller.idle();

      const job = h.db
        .query<{ error: string | null }, [string]>(
          `SELECT error FROM acquisition_jobs WHERE id = ?`,
        )
        .get('ghost-4')!;
      expect(job.error).not.toContain('restarted');
      expect(job.error).toContain('stopped reporting');
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
      await h.poller.idle();
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
      await h.poller.idle();
      title = 'Grateful Dead Live at Barton Hall';
      await h.poller.tick();
      await h.poller.idle();
      const row = h.db
        .query<{ display_title: string | null }, []>(`SELECT display_title FROM acquisition_jobs`)
        .get()!;
      expect(row.display_title).toBe('Grateful Dead Live at Barton Hall');
    });

    it('bounds an absurd title rather than storing it whole', async () => {
      h = harness(() => [makeJob({ title: 'x'.repeat(5000) })]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      await h.poller.idle();
      const row = h.db
        .query<{ display_title: string }, []>(`SELECT display_title FROM acquisition_jobs`)
        .get()!;
      expect(row.display_title.length).toBeLessThanOrEqual(500);
    });

    it('leaves the column null for an addon that sends no title', async () => {
      h = harness(() => [makeJob()]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      await h.poller.idle();
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
      await h.poller.idle();
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
      await h.poller.idle();
      error = null;
      await h.poller.tick();
      await h.poller.idle();
      const row = h.db
        .query<{ error: string | null }, []>(`SELECT error FROM acquisition_jobs`)
        .get()!;
      expect(row.error).toBeNull();
    });

    // An addon that reports failures live (spotDL's `LookupError` lines) can
    // have only `unavailable` items for its first few tracks. `recomputeStage`
    // reads "nothing in flight, nothing scanned" as failed — so a 100-track
    // playlist showed "Error · 0 of 3" while spotDL was on track 4 of 100 (prod,
    // 2026-08-20). The addon's own state is the authority while it is active.
    it('keeps an active job active while its only items so far are failures', async () => {
      const job = makeJob({
        state: 'active',
        items: [
          { ...makeJob().items[0]!, itemId: 'a', state: 'unavailable', fileReady: false },
          { ...makeJob().items[0]!, itemId: 'b', state: 'unavailable', fileReady: false },
        ],
      });
      h = harness(() => [job]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      await h.poller.idle();
      const row = h.db
        .query<{ state: string; stage: string }, []>(`SELECT state, stage FROM acquisition_jobs`)
        .get()!;
      expect(row.state).toBe('active');
      expect(row.stage).toBe('downloading');
    });

    it('reads Downloading, not Organizing, while the addon is still active with files landed', async () => {
      const job = makeJob({
        state: 'active',
        items: [
          { ...makeJob().items[0]!, itemId: 'a', state: 'completed', fileReady: true },
          { ...makeJob().items[0]!, itemId: 'b', state: 'unavailable', fileReady: false },
        ],
      });
      h = harness(() => [job]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      await h.poller.idle();
      const row = h.db
        .query<{ state: string; stage: string }, []>(`SELECT state, stage FROM acquisition_jobs`)
        .get()!;
      expect(row).toEqual({ state: 'active', stage: 'downloading' });
    });

    it('leaves an item-less active job at its submit stage (queued)', async () => {
      const job = urlJob({ state: 'active' });
      h = harness(() => [job]);
      await h.registry.enable('fixture-addon', 'admin');
      // The acquire route pre-maps a `queued` row before the addon has resolved anything.
      const coreJobId = createJob(h.db, {
        kind: 'url',
        method: 'fixture-addon',
        stage: 'queued',
        sourceRef: `addon:fixture-addon:${job.id}`,
        files: [],
      });
      mapAddonJob(h.db, 'fixture-addon', job.id, coreJobId);
      await h.poller.tick();
      await h.poller.idle();
      const row = h.db
        .query<{ state: string; stage: string }, []>(`SELECT state, stage FROM acquisition_jobs`)
        .get()!;
      expect(row).toEqual({ state: 'active', stage: 'queued' });
    });

    // An addon that knows the track count up front (spotDL's `Found 100 songs`)
    // can send 100 `queued` placeholders on its first poll so the card reads
    // "0 of 100" from the start; when it closes, whatever is still queued was
    // never reached and must not linger as in-flight.
    it('turns queued placeholders unavailable when the addon closes', async () => {
      const job = makeJob({
        state: 'partial',
        error: 'spotDL reached 1 of 2',
        items: [
          { ...makeJob().items[0]!, itemId: 'a', state: 'completed', fileReady: true },
          { ...makeJob().items[0]!, itemId: 'b', state: 'queued', fileReady: false },
        ],
      });
      h = harness(() => [job]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      await h.poller.idle();
      const states = h.db
        .query<{ state: string }, []>(`SELECT state FROM acquisition_job_items ORDER BY id`)
        .all()
        .map((r) => r.state);
      expect(states).not.toContain('queued');
      expect(states).toContain('unavailable');
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
      await h.poller.idle();

      const states = h.db
        .query<{ state: string }, []>(`SELECT state FROM acquisition_job_items ORDER BY id`)
        .all()
        .map((r) => r.state);
      expect(states).toContain('unavailable');
      const row = h.db.query<{ stage: string }, []>(`SELECT stage FROM acquisition_jobs`).get()!;
      expect(row.stage).not.toBe('downloading');
    });

    /**
     * Prod showed two `Error · 0 of 12` cards stating a failure and declining
     * to say why: every item failed, and the addon closed reporting no error,
     * so the row's `error` was written as NULL.
     */
    it('gives a reason when every item failed and the addon reported none', async () => {
      const job = makeJob({
        state: 'partial',
        error: null,
        items: [
          { ...makeJob().items[0]!, itemId: 'a', state: 'failed', fileReady: false },
          { ...makeJob().items[0]!, itemId: 'b', state: 'unavailable', fileReady: false },
        ],
      });
      h = harness(() => [job]);
      await h.registry.enable('fixture-addon', 'admin');
      await h.poller.tick();
      await h.poller.idle();

      const row = h.db
        .query<{ stage: string; error: string | null }, []>(
          `SELECT stage, error FROM acquisition_jobs`,
        )
        .get()!;
      expect(row.stage).toBe('error');
      expect(row.error).toBeTruthy();
    });

    /**
     * Releasing a terminal job addon-side is what makes the later `getJob`
     * 404 — so without COALESCE the orphan reconcile would overwrite the real
     * reason with the generic "stopped reporting this job" line. Since #744 a
     * released job is skipped outright; this stays as the second line of
     * defence for a job that 404s without a release marker.
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
      await h.poller.idle();

      const row = h.db
        .query<{ state: string; error: string }, []>(
          `SELECT state, error FROM acquisition_jobs WHERE id = 'known-1'`,
        )
        .get()!;
      expect(row.state).toBe('failed');
      expect(row.error).toBe('Unsupported URL: beatport');
    });
  });

  /**
   * Issue #997. The real job: a `intl-es/album/` link, 13 tracks, spotdl
   * reporting `title` but never `album`. With `album_title` null the organizer
   * declines to stamp the ALBUM tag, the files land in `<Artist>/Unknown/`, and
   * the scanner's loose-single rule turns each track into its own album.
   */
  describe('album link names the album (issue #997)', () => {
    const seedUrlJob = (sourceUrl: string, isPlaylist: boolean): string => {
      const coreJobId = createJob(h.db, {
        kind: 'url',
        method: 'fixture-addon',
        sourceUrl,
        isPlaylist,
        stage: 'queued',
      });
      mapAddonJob(h.db, 'fixture-addon', 'aj-1', coreJobId);
      return coreJobId;
    };
    const albumTitleOf = (id: string): string | null =>
      h.db
        .query<{ album_title: string | null }, [string]>(
          `SELECT album_title FROM acquisition_jobs WHERE id = ?`,
        )
        .get(id)!.album_title;

    it('adopts the addon title as filing metadata for a locale-prefixed album link', async () => {
      let localJobs: AddonJob[] = [];
      h = harness(() => localJobs);
      await h.registry.enable('fixture-addon', 'admin');
      const coreJobId = seedUrlJob(
        'https://open.spotify.com/intl-es/album/5aqBD2HHSWt6VpSjSZfiMw',
        false,
      );
      localJobs = [makeJob({ intent: 'url', artist: null, album: null, title: 'Gondwana' })];

      await h.poller.tick();
      await h.poller.idle();

      expect(albumTitleOf(coreJobId)).toBe('Gondwana');
    });

    it('leaves a playlist alone, so a playlist name never becomes an album', async () => {
      let localJobs: AddonJob[] = [];
      h = harness(() => localJobs);
      await h.registry.enable('fixture-addon', 'admin');
      const coreJobId = seedUrlJob(
        'https://open.spotify.com/playlist/37i9dQZF1DWVYs6zNzJ0ci',
        true,
      );
      localJobs = [
        makeJob({ intent: 'url', artist: null, album: null, title: 'Reggae en Espanol' }),
      ];

      await h.poller.tick();
      await h.poller.idle();

      expect(albumTitleOf(coreJobId)).toBeNull();
    });

    it('never overrides an album the addon actually reported', async () => {
      let localJobs: AddonJob[] = [];
      h = harness(() => localJobs);
      await h.registry.enable('fixture-addon', 'admin');
      const coreJobId = seedUrlJob('https://open.spotify.com/intl-es/album/abc', false);
      localJobs = [makeJob({ intent: 'url', album: 'Real Album Name', title: 'Card Title' })];

      await h.poller.tick();
      await h.poller.idle();

      expect(albumTitleOf(coreJobId)).toBe('Real Album Name');
    });
  });

  describe('playlist-from-acquisition on the addon lane (issue #587)', () => {
    it('generates a native playlist once a playlist job lands its tracks', async () => {
      let localJobs: AddonJob[] = [];
      h = harness(() => localJobs);
      await h.registry.enable('fixture-addon', 'admin');
      h.db.run(`INSERT INTO users (id, username, password_hash) VALUES ('user-1', 'a', 'x')`);
      // The exact relative path the harness's organizeBatch stub derives for
      // makeJob()'s default item — seeded up front so the pipeline's own
      // library_songs lookup (markItemsScanned) finds a real song to link.
      h.db.run(
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
         VALUES ('song-1', 'alb', 'Song One', 'Artist', 'art', 60, 'Artist/Album/01 Song One.mp3', 1)`,
      );
      // The eager mirror row a real `startAddonUrlJob` submit would have
      // created — mapped ahead of the tick, exactly like the real submit path.
      const coreJobId = createJob(h.db, {
        kind: 'url',
        method: 'fixture-addon',
        sourceUrl: 'https://open.spotify.com/playlist/abc',
        userId: 'user-1',
        isPlaylist: true,
        stage: 'queued',
      });
      mapAddonJob(h.db, 'fixture-addon', 'aj-1', coreJobId);

      localJobs = [
        makeJob({
          intent: 'url',
          state: 'done',
          title: 'My Playlist',
          items: [{ ...makeJob().items[0]!, state: 'completed', fileReady: true }],
        }),
      ];
      await h.poller.tick();
      await h.poller.idle();

      const row = h.db
        .query<{ playlist_id: string | null }, [string]>(
          `SELECT playlist_id FROM acquisition_jobs WHERE id = ?`,
        )
        .get(coreJobId)!;
      expect(row.playlist_id).toBeTruthy();
      const songs = h.db
        .query<{ song_id: string }, [string]>(
          `SELECT song_id FROM playlist_songs WHERE playlist_id = ?`,
        )
        .all(row.playlist_id!);
      expect(songs.map((s) => s.song_id)).toEqual(['song-1']);
    });

    it('never generates a playlist for a job the addon did not classify as one', async () => {
      let localJobs: AddonJob[] = [];
      h = harness(() => localJobs);
      await h.registry.enable('fixture-addon', 'admin');
      h.db.run(`INSERT INTO users (id, username, password_hash) VALUES ('user-1', 'a', 'x')`);
      const coreJobId = createJob(h.db, {
        kind: 'url',
        method: 'fixture-addon',
        sourceUrl: 'https://open.spotify.com/watch?v=abc',
        userId: 'user-1',
        isPlaylist: false,
        stage: 'queued',
      });
      mapAddonJob(h.db, 'fixture-addon', 'aj-1', coreJobId);
      localJobs = [
        makeJob({
          intent: 'url',
          state: 'done',
          items: [{ ...makeJob().items[0]!, state: 'completed', fileReady: true }],
        }),
      ];

      await h.poller.tick();
      await h.poller.idle();

      const row = h.db
        .query<{ playlist_id: string | null }, [string]>(
          `SELECT playlist_id FROM acquisition_jobs WHERE id = ?`,
        )
        .get(coreJobId)!;
      expect(row.playlist_id).toBeNull();
    });
  });
});

describe('sanitizeAddonError (issue #601)', () => {
  // The real thing prod put on a Downloads card: spotdl's startup preflight died
  // inside ytmusicapi and the addon shipped Rich's box-drawn traceback verbatim.
  const RICH_TRACEBACK = [
    '\u001b[31m╭─────────────── Traceback (most recent call last) ────────────────╮\u001b[0m',
    '│ /usr/local/bin/spotdl:8 in <module>                              │',
    '│ ❱ 8 │   sys.exit(console_entry_point())                          │',
    '│ /usr/lib/python3.13/json/__init__.py:346 in loads                │',
    '│ ❱ 346 │   │   return _default_decoder.decode(s)                   │',
    '╰──────────────────────────────────────────────────────────────────╯',
    'JSONDecodeError: Expecting value: line 1 column 1 (char 0)',
  ].join('\n');

  it('reduces a Python traceback to its exception line', () => {
    expect(sanitizeAddonError(RICH_TRACEBACK)).toBe(
      'JSONDecodeError: Expecting value: line 1 column 1 (char 0)',
    );
  });

  it('strips ANSI escapes', () => {
    expect(sanitizeAddonError('\u001b[31mboom\u001b[0m')).toBe('boom');
  });

  // The addon's own summaries are the useful ones — they must survive intact.
  it('leaves an ordinary multi-line addon message untouched', () => {
    const msg =
      'Downloaded 7 of 32 tracks — the rest failed or were skipped.\n' +
      'https://open.spotify.com/track/abc - LookupError: No results found for song: X';
    expect(sanitizeAddonError(msg)).toBe(msg);
  });

  it('falls back to the last meaningful line when a traceback has no exception line', () => {
    const t = [
      '╭── Traceback (most recent call last) ──╮',
      '│ /app/x.py:1 in <module>               │',
      '╰───────────────────────────────────────╯',
      'the process exited unexpectedly',
    ].join('\n');
    expect(sanitizeAddonError(t)).toBe('the process exited unexpectedly');
  });

  it('still clamps an over-long message', () => {
    const out = sanitizeAddonError('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never returns an empty string for non-empty input', () => {
    expect(sanitizeAddonError('│ │ │')).not.toBe('');
  });
});

describe('stranded ingest — a job the poll cursor moved past (#725)', () => {
  /** A terminal job carrying one already-downloaded file core has not fetched. */
  function strandedJob(): AddonJob {
    return makeJob({
      id: 'aj-stranded',
      state: 'done',
      updatedAt: 2000,
      items: [
        {
          itemId: 't:one',
          title: 'Song One',
          username: 'peer',
          filename: 'Music\\Album\\01 Song One.mp3',
          size: 100,
          bitRateKbps: 320,
          audioFormat: 'MP3 320kbps',
          state: 'completed',
          fileReady: true,
          updatedAt: 2000,
        },
      ],
    });
  }

  /**
   * The first fetch fails, leaving the item `completed` with a null
   * relative_path — the exact prod shape. Every later attempt succeeds, so the
   * only thing that can keep the file stranded is never being retried.
   */
  function flakyFirstFetch() {
    let attempt = 0;
    return async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('addon fetch blipped');
      return new Response('audio-bytes');
    };
  }

  it('ingests outstanding files after the cursor has advanced past their job', async () => {
    const all = [strandedJob(), makeJob({ id: 'aj-newer', updatedAt: 9000, items: [] })];
    const h = harness(
      () => all,
      async (id) => all.find((j) => j.id === id)!,
      {
        listSince: (since) => all.filter((j) => !since || j.updatedAt > since),
        fetchFile: flakyFirstFetch(),
      },
    );
    await h.registry.enable('fixture-addon', 'admin');

    await h.poller.tick();
    await h.poller.idle(); // both listed; the stranded fetch fails; cursor -> 9000
    const afterFirst = h.db
      .query<{ state: string; relative_path: string | null }, []>(
        `SELECT state, relative_path FROM acquisition_job_items`,
      )
      .get()!;
    expect(afterFirst.state).toBe('completed');
    expect(afterFirst.relative_path).toBeNull();

    await h.poller.tick();
    await h.poller.idle(); // cursor 9000 now EXCLUDES aj-stranded from listJobs

    const item = h.db
      .query<{ state: string; relative_path: string | null }, []>(
        `SELECT state, relative_path FROM acquisition_job_items`,
      )
      .get()!;
    expect(item.relative_path).not.toBeNull();
    expect(item.state).toBe('organized');
  });

  it('throttles the sweep so a dead file is not re-fetched every 5s tick', async () => {
    const all = [strandedJob(), makeJob({ id: 'aj-newer', updatedAt: 9000, items: [] })];
    let getJobCalls = 0;
    const h = harness(
      () => all,
      async (id) => {
        getJobCalls += 1;
        return all.find((j) => j.id === id)!;
      },
      {
        listSince: (since) => all.filter((j) => !since || j.updatedAt > since),
        // The addon still has the job but can never serve the file.
        fetchFile: async () => {
          throw new Error('file gone');
        },
        strandedSweepIntervalMs: 60_000,
      },
    );
    await h.registry.enable('fixture-addon', 'admin');

    await h.poller.tick();
    await h.poller.idle();
    const afterFirst = getJobCalls;
    // The poller ticks every 5s; the recovery sweep must not follow it.
    await h.poller.tick();
    await h.poller.idle();
    await h.poller.tick();
    await h.poller.idle();
    expect(getJobCalls).toBe(afterFirst);
  });

  it('fails a stranded job the addon has genuinely forgotten', async () => {
    const all = [strandedJob(), makeJob({ id: 'aj-newer', updatedAt: 9000, items: [] })];
    // getJob 404s: the addon restarted and dropped the job, so the file is gone.
    const h = harness(() => all, undefined, {
      listSince: (since) => all.filter((j) => !since || j.updatedAt > since),
      fetchFile: flakyFirstFetch(),
    });
    await h.registry.enable('fixture-addon', 'admin');

    await h.poller.tick();
    await h.poller.idle();
    await h.poller.tick();
    await h.poller.idle();

    const job = h.db
      .query<{ state: string; stage: string }, []>(
        `SELECT state, stage FROM acquisition_jobs WHERE source_ref LIKE '%aj-stranded'`,
      )
      .get()!;
    expect(job.state).toBe('failed');
    expect(job.stage).toBe('error');
  });
});

describe('byte progress mirroring (#805)', () => {
  it('mirrors size and bytesTransferred on insert and on update', async () => {
    let jobsData = [
      makeJob({
        items: [{ ...makeJob().items[0]!, bytesTransferred: 40 }],
      }),
    ];
    const h = harness(() => jobsData);
    await h.registry.enable('fixture-addon', 'admin');
    await h.poller.tick();
    await h.poller.idle();

    const item = () =>
      h.db
        .query<{ size_bytes: number | null; bytes_transferred: number | null }, []>(
          `SELECT size_bytes, bytes_transferred FROM acquisition_job_items`,
        )
        .get()!;
    expect(item().size_bytes).toBe(100);
    expect(item().bytes_transferred).toBe(40);

    jobsData = [
      makeJob({
        updatedAt: 3000,
        items: [{ ...makeJob().items[0]!, bytesTransferred: 70, updatedAt: 3000 }],
      }),
    ];
    await h.poller.tick();
    await h.poller.idle();
    expect(item().bytes_transferred).toBe(70);
  });
});

describe('cancel intent (#806)', () => {
  const coreJob = (h: ReturnType<typeof harness>) =>
    h.db
      .query<{ id: string; state: string; stage: string; error: string | null }, []>(
        `SELECT id, state, stage, error FROM acquisition_jobs`,
      )
      .get()!;

  it('stops mirroring and never re-pins a cancel-requested job while the addon is still active', async () => {
    let jobsData = [makeJob()];
    const h = harness(() => jobsData);
    await h.registry.enable('fixture-addon', 'admin');
    await h.poller.tick();
    await h.poller.idle();

    const { id } = coreJob(h);
    expect(requestJobCancel(h.db, id)).toBe(true);
    // Force a non-downloading stage: the next tick must not re-pin it.
    h.db.run(`UPDATE acquisition_jobs SET stage = 'queued' WHERE id = ?`, [id]);
    jobsData = [
      makeJob({
        updatedAt: 3000,
        items: [{ ...makeJob().items[0]!, bytesTransferred: 99, updatedAt: 3000 }],
      }),
    ];
    await h.poller.tick();
    await h.poller.idle();

    expect(coreJob(h).stage).toBe('queued');
    const item = h.db
      .query<{ bytes_transferred: number | null }, []>(
        `SELECT bytes_transferred FROM acquisition_job_items`,
      )
      .get()!;
    expect(item.bytes_transferred).toBeNull(); // mirror skipped
  });

  it('the grace valve closes a cancel request the addon never acted on', async () => {
    const jobsData = [makeJob()];
    const h = harness(() => jobsData);
    await h.registry.enable('fixture-addon', 'admin');
    await h.poller.tick();
    await h.poller.idle();

    const { id } = coreJob(h);
    requestJobCancel(h.db, id, Date.now() - 120_000); // well past the grace period
    await h.poller.tick();
    await h.poller.idle();

    const after = coreJob(h);
    expect(after.state).not.toBe('active');
    expect(after.error && after.error.length > 0).toBe(true);
    const item = h.db
      .query<{ state: string }, []>(`SELECT state FROM acquisition_job_items`)
      .get()!;
    expect(item.state).toBe('unavailable');

    // The addon still lists the job as active — the closed row must stay closed.
    await h.poller.tick();
    await h.poller.idle();
    expect(coreJob(h).state).toBe(after.state);
  });

  it("the addon's own cancelled verdict still closes the job through the normal path", async () => {
    let jobsData = [makeJob()];
    const h = harness(() => jobsData);
    await h.registry.enable('fixture-addon', 'admin');
    await h.poller.tick();
    await h.poller.idle();

    const { id } = coreJob(h);
    requestJobCancel(h.db, id);
    jobsData = [
      makeJob({
        state: 'cancelled',
        updatedAt: 3000,
        items: [{ ...makeJob().items[0]!, updatedAt: 3000 }],
      }),
    ];
    await h.poller.tick();
    await h.poller.idle();

    const after = coreJob(h);
    expect(after.state).not.toBe('active');
    const item = h.db
      .query<{ state: string }, []>(`SELECT state FROM acquisition_job_items`)
      .get()!;
    expect(item.state).toBe('unavailable');
  });
});

describe('partial discard (#810)', () => {
  it('never ingests a fileReady item of a partial-discarded job', async () => {
    let jobsData = [makeJob()];
    const h = harness(() => jobsData);
    await h.registry.enable('fixture-addon', 'admin');
    await h.poller.tick();
    await h.poller.idle();

    const { id } = h.db.query<{ id: string }, []>(`SELECT id FROM acquisition_jobs`).get()!;
    markPartialDiscarded(h.db, id);

    // The file arrives AFTER the discard — the exact late-landing race.
    jobsData = [
      makeJob({
        state: 'done',
        updatedAt: 4000,
        items: [{ ...makeJob().items[0]!, state: 'completed', fileReady: true, updatedAt: 4000 }],
      }),
    ];
    await h.poller.tick();
    await h.poller.idle();

    expect(h.organized).toHaveLength(0);
    expect(h.scanned).toHaveLength(0);
  });
});

describe('ingest decoupled from the tick (#809)', () => {
  function gatedFetch() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const fetchFile = async () => {
      calls++;
      await gate;
      return new Response('audio-bytes');
    };
    return { fetchFile, release: () => release(), calls: () => calls };
  }

  const readyJob = (bytes?: number) =>
    makeJob({
      state: 'done',
      updatedAt: 4000,
      items: [
        {
          ...makeJob().items[0]!,
          state: 'completed',
          fileReady: true,
          bytesTransferred: bytes,
          updatedAt: 4000,
        },
      ],
    });

  it('a slow ingest no longer freezes mirroring — the next tick still lands updates', async () => {
    const gate = gatedFetch();
    let jobsData = [readyJob()];
    const h = harness(() => jobsData, undefined, { fetchFile: gate.fetchFile });
    await h.registry.enable('fixture-addon', 'admin');

    await h.poller.tick(); // schedules the ingest; fetch now hangs
    expect(gate.calls()).toBe(1);

    // A second addon-side update arrives while the ingest is still in flight.
    // The old code could not even start this tick until the fetch finished.
    jobsData = [
      makeJob({
        id: 'aj-2',
        updatedAt: 5000,
        items: [
          {
            ...makeJob().items[0]!,
            itemId: 't:song two',
            filename: 'Music\\Album\\02 Song Two.mp3',
            bytesTransferred: 40,
            updatedAt: 5000,
          },
        ],
      }),
    ];
    await h.poller.tick();
    const mirrored = h.db
      .query<{ bytes_transferred: number | null }, [string]>(
        `SELECT bytes_transferred FROM acquisition_job_items WHERE transfer_key = ?`,
      )
      .get(addonTransferKey('fixture-addon', 't:song two'));
    expect(mirrored?.bytes_transferred).toBe(40); // mirrored DURING the hung ingest

    gate.release();
    await h.poller.idle();
    expect(h.organized).toHaveLength(1);
  });

  it('re-observing a job mid-ingest never double-ingests it', async () => {
    const gate = gatedFetch();
    const h = harness(() => [readyJob()], undefined, { fetchFile: gate.fetchFile });
    await h.registry.enable('fixture-addon', 'admin');

    await h.poller.tick();
    await h.poller.tick(); // same job again while its finish is in flight
    expect(gate.calls()).toBe(1); // single-flight held

    gate.release();
    await h.poller.idle();
    expect(h.organized).toHaveLength(1);
  });

  it('a failing fetch never wedges the queue — the next tick retries it', async () => {
    let calls = 0;
    const h = harness(() => [readyJob()], undefined, {
      fetchFile: async () => {
        calls++;
        throw new Error('addon fell over mid-transfer');
      },
    });
    await h.registry.enable('fixture-addon', 'admin');

    await h.poller.tick();
    await h.poller.idle();
    expect(calls).toBe(1);
    expect(h.organized).toHaveLength(0);

    // Same contract as the old inline path: a fetch failure is a retry, not a
    // verdict — the job stays open and the single-flight slot was released,
    // so the next observation re-queues the ingest.
    await h.poller.tick();
    await h.poller.idle();
    expect(calls).toBe(2);
  });
});

describe('ingest measurement', () => {
  it('reports one receipt per ingested job, counting the bytes it actually fetched', async () => {
    const base = makeJob().items[0]!;
    const h = harness(() => [
      makeJob({
        state: 'done',
        updatedAt: 4000,
        items: [
          { ...base, state: 'completed', fileReady: true, updatedAt: 4000 },
          {
            ...base,
            itemId: 't:song two',
            title: 'Song Two',
            filename: 'Music\\Album\\02 Song Two.mp3',
            state: 'completed',
            fileReady: true,
            updatedAt: 4000,
          },
        ],
      }),
    ]);
    await h.registry.enable('fixture-addon', 'admin');
    await h.poller.tick();
    await h.poller.idle();

    expect(h.receipts).toHaveLength(1);
    const r = h.receipts[0]!;
    expect(r.files).toBe(2);
    // The harness serves 'audio-bytes' (11 bytes) per file. Asserting the real
    // total is the point: a byte counter wired to the wrong variable still
    // produces a plausible-looking log line.
    expect(r.fetchBytes).toBe(22);
    expect(r.addonId).toBe('fixture-addon');
    for (const ms of [
      r.fetchSumMs,
      r.fetchMaxMs,
      r.organizeMs,
      r.scanMs,
      r.totalMs,
      r.queueWaitMs,
    ]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    expect(r.fetchMaxMs).toBeLessThanOrEqual(r.fetchSumMs);
  });

  it('reports no receipt for a job it did not ingest', async () => {
    let jobsData = [makeJob()];
    const h = harness(() => jobsData);
    await h.registry.enable('fixture-addon', 'admin');
    await h.poller.tick();
    await h.poller.idle();

    const { id } = h.db.query<{ id: string }, []>(`SELECT id FROM acquisition_jobs`).get()!;
    markPartialDiscarded(h.db, id);
    jobsData = [
      makeJob({
        state: 'done',
        updatedAt: 4000,
        items: [{ ...makeJob().items[0]!, state: 'completed', fileReady: true, updatedAt: 4000 }],
      }),
    ];
    await h.poller.tick();
    await h.poller.idle();

    expect(h.organized).toHaveLength(0);
    expect(h.receipts).toHaveLength(0);
  });

  /**
   * Re-sourcing (#1065) is the first thing that puts TWO addon jobs on one
   * card. Every terminal sweep used to say `WHERE job_id = ?`, which was
   * correct only while that could not happen: the abandoned peer's job going
   * terminal would otherwise mark the replacement's live downloads
   * `unavailable`, and the card would report a partial while the new peer was
   * still uploading. Delete the `OWNED_BY_ADDON_JOB` predicate and this fails.
   */
  it('a terminal addon job does not touch a second addon job on the same card', async () => {
    const stuck = makeJob({
      id: 'aj-stuck',
      items: [{ ...makeJob().items[0]!, itemId: 't:song one', state: 'downloading' }],
    });
    const replacement = makeJob({
      id: 'aj-replacement',
      items: [
        {
          ...makeJob().items[0]!,
          itemId: 't:song two',
          title: 'Song Two',
          username: 'other-peer',
          filename: 'Music\\Album\\02 Song Two.mp3',
          state: 'downloading',
        },
      ],
    });
    let jobsData: AddonJob[] = [stuck, replacement];
    const h = harness(() => jobsData);
    await h.registry.enable('fixture-addon', 'admin');
    await h.poller.tick();
    await h.poller.idle();

    // Put both addon jobs on ONE card, the way the re-source route does.
    const coreJobId = h.db
      .query<{ id: string }, []>(`SELECT id FROM acquisition_jobs ORDER BY created_at LIMIT 1`)
      .get()!.id;
    mapAddonJob(h.db, 'fixture-addon', 'aj-replacement', coreJobId);
    h.db.run(`UPDATE acquisition_job_items SET job_id = ? WHERE addon_job_id = ?`, [
      coreJobId,
      'aj-replacement',
    ]);

    // The abandoned peer gives up. Its own item may die; the other must not.
    // The replacement is listed FIRST on purpose: it is mirrored before the
    // stuck job closes, so nothing re-writes its row afterwards and the tick's
    // final state is the honest one. (Listed last, an unscoped sweep is masked
    // within the same tick by the very next mirror — which is how a bug this
    // visible could hide from a test that only reads item states.)
    jobsData = [replacement, { ...stuck, state: 'failed', updatedAt: 5000 }];
    await h.poller.tick();
    await h.poller.idle();

    const states = new Map(
      h.db
        .query<{ addon_job_id: string; state: string }, [string]>(
          `SELECT addon_job_id, state FROM acquisition_job_items WHERE job_id = ?`,
        )
        .all(coreJobId)
        .map((r) => [r.addon_job_id, r.state]),
    );
    expect(states.get('aj-stuck')).toBe('unavailable');
    expect(states.get('aj-replacement')).toBe('downloading');
    // ...and the card must still read as a live download, not close as a
    // partial while the new peer is uploading.
    const card = h.db
      .query<{ state: string; stage: string }, [string]>(
        `SELECT state, stage FROM acquisition_jobs WHERE id = ?`,
      )
      .get(coreJobId)!;
    expect(card.stage).toBe('downloading');
    expect(card.state).toBe('active');
  });
});

describe('one job never wedges the poll for the rest (#1081)', () => {
  let h: ReturnType<typeof harness>;

  function itemsOf(h: ReturnType<typeof harness>, addonJobId: string) {
    return h.db
      .query<{ state: string }, [string]>(
        `SELECT i.state FROM acquisition_job_items i
           JOIN acquisition_jobs j ON j.id = i.job_id
          WHERE j.source_ref = ?`,
      )
      .all(`addon:fixture-addon:${addonJobId}`);
  }

  function cursor(h: ReturnType<typeof harness>) {
    return h.db
      .query<{ value: string }, []>(
        `SELECT value FROM plugin_kv WHERE plugin_id = 'addon-poller:fixture-addon' AND key = 'poll_cursor'`,
      )
      .get()?.value;
  }

  it('releases the addon job behind a removed card and keeps mirroring the others', async () => {
    const removed = makeJob({ id: 'aj-removed', createdAt: 1000, updatedAt: 3000 });
    const live = makeJob({ id: 'aj-live', createdAt: 2000, updatedAt: 3000 });
    h = harness(() => [removed, live]);
    await h.registry.enable('fixture-addon', 'admin');
    // The acquire route pre-maps the card; Remove then deletes the rows and
    // leaves the map behind (the route's addon-side delete is best-effort, and
    // on kpc it did not land — the addon kept listing the job).
    const coreId = createJob(h.db, {
      kind: 'album-hunt',
      method: 'fixture-addon',
      artistName: 'Artist',
      albumTitle: 'Album',
      sourceRef: 'addon:fixture-addon:aj-removed',
      files: [],
    });
    mapAddonJob(h.db, 'fixture-addon', 'aj-removed', coreId);
    h.db.run(`DELETE FROM acquisition_jobs WHERE id = ?`, [coreId]);

    await h.poller.tick();
    await h.poller.idle();

    // The job behind the removed card is neither re-minted as a ghost card…
    expect(
      h.db
        .query(`SELECT id FROM acquisition_jobs WHERE source_ref = ?`)
        .all('addon:fixture-addon:aj-removed'),
    ).toHaveLength(0);
    // …nor left addon-side for ever: it is released, once.
    expect(h.deleted).toEqual(['aj-removed']);
    // And the job after it in the list still landed — the whole point.
    expect(itemsOf(h, 'aj-live')).toHaveLength(1);
    expect(cursor(h)).toBe('3000');

    await h.poller.tick();
    await h.poller.idle();
    expect(h.deleted).toEqual(['aj-removed']);
  });

  it('a job the mirror cannot store is skipped, and the cursor still moves on', async () => {
    const poisoned = makeJob({
      id: 'aj-bad',
      createdAt: 1000,
      updatedAt: 3000,
      items: [{ ...makeJob().items[0]!, state: 'exploded' as never }],
    });
    const live = makeJob({ id: 'aj-live', createdAt: 2000, updatedAt: 3000 });
    h = harness(() => [poisoned, live]);
    await h.registry.enable('fixture-addon', 'admin');

    await h.poller.tick();
    await h.poller.idle();

    expect(itemsOf(h, 'aj-live')).toHaveLength(1);
    expect(cursor(h)).toBe('3000');
  });
});
