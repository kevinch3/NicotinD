import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { Plugin } from '@nicotind/core';
import { applySchema } from '../db.js';
import {
  AcquireWatcher,
  NoAcquisitionPluginError,
  PluginUnavailableError,
} from './acquire-watcher.js';
import { PluginRegistry } from './plugins/registry.js';
import { pluginStagingDir } from './plugins/host-context.js';
import type { CompletedDownloadFile } from './path-inference.js';

const DATA_DIR = '/tmp/nicotind-acquire-test';

// Fake resolve-capable plugin: handles example.com URLs and "stages" one file
// (path computed from the host staging scheme so the watcher maps it correctly).
function fakePlugin(opts: { available?: boolean } = {}): Plugin {
  return {
    manifest: {
      id: 'fake',
      name: 'fake',
      description: 'test',
      kind: 'acquisition',
      capabilities: ['resolve'],
      defaultEnabled: false,
    },
    async init() {},
    async isAvailable() {
      return opts.available ?? true;
    },
    resolve: {
      canHandle: (url: string) => url.includes('example.com'),
      resolve: async (_url: string, jobId: string) => [
        join(pluginStagingDir(DATA_DIR, 'fake', jobId), 'Artist', 'Album', 'track.mp3'),
      ],
    },
  };
}

async function waitForState(watcher: AcquireWatcher, id: string, state: string, ms = 1000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (watcher.getJob(id)?.state === state) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job ${id} did not reach state "${state}"`);
}

async function waitForStage(watcher: AcquireWatcher, id: string, stage: string, ms = 1000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (watcher.getJob(id)?.stage === stage) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job ${id} did not reach stage "${stage}"`);
}

interface Harness {
  watcher: AcquireWatcher;
  db: Database;
  registry: PluginRegistry;
  organize: ReturnType<typeof mock>;
  scan: ReturnType<typeof mock>;
}

function makeHarness(plugin: Plugin = fakePlugin()): Harness {
  const db = new Database(':memory:');
  applySchema(db);
  const registry = new PluginRegistry({ db, dataDir: DATA_DIR });
  registry.register(plugin);
  const organize = mock(async (files: CompletedDownloadFile[]) => {
    for (const f of files) f.relativePath = 'Artist/Album/track.mp3';
  });
  const scan = mock(async () => {});
  const watcher = new AcquireWatcher({
    db,
    dataDir: DATA_DIR,
    registry,
    organizeBatch: organize,
    scanIncremental: scan,
  });
  return { watcher, db, registry, organize, scan };
}

describe('AcquireWatcher (registry-driven)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('throws when no enabled plugin handles the URL', async () => {
    // plugin registered but not enabled → no routing
    await expect(h.watcher.submit('https://example.com/x')).rejects.toBeInstanceOf(
      NoAcquisitionPluginError,
    );
  });

  it('throws when the chosen plugin is unavailable', async () => {
    h = makeHarness(fakePlugin({ available: false }));
    await h.registry.enable('fake', 'admin');
    await expect(h.watcher.submit('https://example.com/x')).rejects.toBeInstanceOf(
      PluginUnavailableError,
    );
  });

  it('runs an enabled plugin and ingests the staged files', async () => {
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    expect(h.watcher.getJob(id)?.backend).toBe('fake');

    await waitForState(h.watcher, id, 'done');
    expect(h.organize).toHaveBeenCalledTimes(1);
    const files = h.organize.mock.calls[0]![0] as CompletedDownloadFile[];
    expect(files[0]!.directory).toBe(join('Artist', 'Album'));
    expect(files[0]!.username).toBe(`acquire:${id}`);
    expect(h.scan).toHaveBeenCalledTimes(1);
  });

  it('mirrors the job into acquisition_jobs and keeps state/stage in sync', async () => {
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');

    const mirror = h.db
      .query<{ kind: string; method: string; source_ref: string }, [string]>(
        `SELECT kind, method, source_ref FROM acquisition_jobs WHERE id = ?`,
      )
      .get(id);
    expect(mirror).toEqual({ kind: 'url', method: 'fake', source_ref: 'https://example.com/x' });

    await waitForStage(h.watcher, id, 'done');
    const after = h.db
      .query<{ state: string; stage: string }, [string]>(
        `SELECT state, stage FROM acquisition_jobs WHERE id = ?`,
      )
      .get(id);
    expect(after).toEqual({ state: 'done', stage: 'done' });
  });

  it('boot reconciliation fails the orphaned mirror row alongside acquire_jobs', () => {
    h.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, label, state, stage) VALUES ('orph', 'fake', 'u', NULL, 'running', 'downloading')`,
    );
    h.db.run(
      `INSERT INTO acquisition_jobs (id, kind, method, state, stage, source_ref, created_at, updated_at)
       VALUES ('orph', 'url', 'fake', 'active', 'downloading', 'u', 1, 1)`,
    );
    // A fresh watcher (server restart) must fail both rows.
    new AcquireWatcher({
      db: h.db,
      dataDir: DATA_DIR,
      registry: h.registry,
      organizeBatch: h.organize as never,
      scanIncremental: h.scan as never,
    });
    const mirror = h.db
      .query<{ state: string; stage: string }, [string]>(
        `SELECT state, stage FROM acquisition_jobs WHERE id = ?`,
      )
      .get('orph');
    expect(mirror).toEqual({ state: 'failed', stage: 'error' });
  });

  it('reaches stage "done", records storage_path, and writes an acquisitions row', async () => {
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForStage(h.watcher, id, 'done');

    const job = h.watcher.getJob(id)!;
    expect(job.stage).toBe('done');
    expect(job.storage_path).toBe('Artist/Album');

    const acq = h.db
      .query<{ method: string; source_ref: string; stage: string }, [string]>(
        'SELECT method, source_ref, stage FROM acquisitions WHERE relative_path = ?',
      )
      .get('Artist/Album/track.mp3');
    // 'fake' is not a known method id, so it maps to 'unknown'.
    expect(acq).toEqual({
      method: 'unknown',
      source_ref: 'https://example.com/x',
      stage: 'done',
    });
  });

  it('a single-album job populates destinationAlbums with one entry and the singular album fields', async () => {
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForStage(h.watcher, id, 'done');

    const job = h.watcher.getJob(id)!;
    expect(job.destinationAlbums).toHaveLength(1);
    expect(job.destinationAlbums[0]).toMatchObject({
      albumArtist: 'Artist',
      albumTitle: 'Album',
    });
    expect(job.albumId).not.toBeNull();
    expect(job.albumArtist).toBe('Artist');
    expect(job.albumTitle).toBe('Album');
  });

  it('a job whose files land in 3 distinct album dirs exposes all 3 in destinationAlbums, with albumId null', async () => {
    const plugin = fakePlugin();
    plugin.resolve!.resolve = async (_url, jobId) => [
      join(pluginStagingDir(DATA_DIR, 'fake', jobId), 'Artist A', 'Album One', 't1.mp3'),
      join(pluginStagingDir(DATA_DIR, 'fake', jobId), 'Artist B', 'Album Two', 't2.mp3'),
      join(pluginStagingDir(DATA_DIR, 'fake', jobId), 'Artist C', 'Album Three', 't3.mp3'),
    ];
    const db = new Database(':memory:');
    applySchema(db);
    const registry = new PluginRegistry({ db, dataDir: DATA_DIR });
    registry.register(plugin);
    let call = 0;
    const relPaths = [
      'Artist A/Album One/t1.mp3',
      'Artist B/Album Two/t2.mp3',
      'Artist C/Album Three/t3.mp3',
    ];
    const organize = mock(async (files: CompletedDownloadFile[]) => {
      for (const f of files) f.relativePath = relPaths[call++];
    });
    const scan = mock(async () => {});
    const watcher = new AcquireWatcher({
      db,
      dataDir: DATA_DIR,
      registry,
      organizeBatch: organize,
      scanIncremental: scan,
    });
    await registry.enable('fake', 'admin');
    const id = await watcher.submit('https://example.com/x');
    await waitForStage(watcher, id, 'done');

    const job = watcher.getJob(id)!;
    expect(job.destinationAlbums).toHaveLength(3);
    expect(new Set(job.destinationAlbums.map((a) => a.albumTitle))).toEqual(
      new Set(['Album One', 'Album Two', 'Album Three']),
    );
    expect(job.albumId).toBeNull();
    expect(job.albumArtist).toBeNull();
    expect(job.albumTitle).toBeNull();
  });

  it('mapRow round-trips a null dest_albums_json (pre-migration / not-yet-ingested row) as an empty array', () => {
    h.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state) VALUES ('no-dest', 'fake', 'u', 'queued')`,
    );
    const job = h.watcher.getJob('no-dest')!;
    expect(job.destinationAlbums).toEqual([]);
    expect(job.albumId).toBeNull();
  });

  it('mapRow exposes tracks, falling back to [] for a null tracks_json column', () => {
    h.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state) VALUES ('no-tracks', 'fake', 'u', 'queued')`,
    );
    expect(h.watcher.getJob('no-tracks')!.tracks).toEqual([]);

    h.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state, tracks_json) VALUES ('with-tracks', 'fake', 'u', 'queued', ?)`,
      [JSON.stringify([{ title: 'Song A', status: 'downloading' }])],
    );
    expect(h.watcher.getJob('with-tracks')!.tracks).toEqual([
      { title: 'Song A', status: 'downloading' },
    ]);
  });

  it('maps known backend ids to their acquisition method', async () => {
    const ytPlugin = fakePlugin();
    ytPlugin.manifest.id = 'ytdlp';
    ytPlugin.resolve!.resolve = async (_url, jobId) => [
      join(pluginStagingDir(DATA_DIR, 'ytdlp', jobId), 'Artist', 'Album', 'track.mp3'),
    ];
    h = makeHarness(ytPlugin);
    await h.registry.enable('ytdlp', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForStage(h.watcher, id, 'done');

    const method = h.db
      .query<{ method: string }, [string]>(
        'SELECT method FROM acquisitions WHERE relative_path = ?',
      )
      .get('Artist/Album/track.mp3')?.method;
    expect(method).toBe('ytdlp');
  });

  it('sets stage "error" when resolve produces zero files', async () => {
    const plugin = fakePlugin();
    plugin.resolve!.resolve = async () => [];
    h = makeHarness(plugin);
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForState(h.watcher, id, 'failed');
    expect(h.watcher.getJob(id)?.stage).toBe('error');
  });

  it('marks the job failed (no ingest) when resolve produces zero files', async () => {
    const plugin = fakePlugin();
    plugin.resolve!.resolve = async () => [];
    h = makeHarness(plugin);
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForState(h.watcher, id, 'failed');
    expect(h.watcher.getJob(id)?.error).toContain('no audio files');
    expect(h.organize).not.toHaveBeenCalled();
  });

  it('marks the job failed when resolve rejects', async () => {
    const plugin = fakePlugin();
    plugin.resolve!.resolve = async () => {
      throw new Error('download exploded');
    };
    h = makeHarness(plugin);
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForState(h.watcher, id, 'failed');
    expect(h.watcher.getJob(id)?.error).toContain('exploded');
    expect(h.organize).not.toHaveBeenCalled();
  });

  it('marks job failed and stage error when organizeBatch rejects', async () => {
    const plugin = fakePlugin();
    const { registry } = makeHarness(plugin);
    const failOrganize = mock(async () => {
      throw new Error('disk full');
    });
    const scan = mock(async () => {});
    const w = new AcquireWatcher({
      db: h.db,
      dataDir: DATA_DIR,
      registry,
      organizeBatch: failOrganize,
      scanIncremental: scan,
    });
    await registry.enable('fake', 'admin');
    const id = await w.submit('https://example.com/x');
    await waitForState(w, id, 'failed');
    const job = w.getJob(id)!;
    expect(job.stage).toBe('error');
    expect(job.error).toContain('disk full');
    expect(scan).not.toHaveBeenCalled();
  });

  it('only reaches state done after the full ingest pipeline completes', async () => {
    let resolveOrganize!: () => void;
    const organize = mock(
      (files: CompletedDownloadFile[]) =>
        new Promise<void>((resolve) => {
          for (const f of files) f.relativePath = 'Artist/Album/track.mp3';
          resolveOrganize = resolve;
        }),
    );
    const scan = mock(async () => {});
    const db = new Database(':memory:');
    applySchema(db);
    const registry = new PluginRegistry({ db, dataDir: DATA_DIR });
    registry.register(fakePlugin());
    await registry.enable('fake', 'admin');
    const watcher = new AcquireWatcher({
      db,
      dataDir: DATA_DIR,
      registry,
      organizeBatch: organize,
      scanIncremental: scan,
    });
    const id = await watcher.submit('https://example.com/x');
    // While organize is blocked, state must still be 'running'.
    await new Promise((r) => setTimeout(r, 20));
    expect(watcher.getJob(id)?.state).toBe('running');
    resolveOrganize();
    await waitForState(watcher, id, 'done');
  });

  it('marks jobs orphaned by a restart (queued/running) as failed on construction', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state, stage) VALUES ('orph-r', 'fake', 'u1', 'running', 'downloading')`,
    );
    db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state, stage) VALUES ('orph-q', 'fake', 'u2', 'queued', 'queued')`,
    );
    db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state, stage) VALUES ('kept', 'fake', 'u3', 'done', 'done')`,
    );
    const registry = new PluginRegistry({ db, dataDir: DATA_DIR });
    const watcher = new AcquireWatcher({
      db,
      dataDir: DATA_DIR,
      registry,
      organizeBatch: mock(async () => {}),
      scanIncremental: mock(async () => {}),
    });
    expect(watcher.getJob('orph-r')?.state).toBe('failed');
    expect(watcher.getJob('orph-r')?.stage).toBe('error');
    expect(watcher.getJob('orph-r')?.error).toContain('restart');
    expect(watcher.getJob('orph-q')?.state).toBe('failed');
    expect(watcher.getJob('kept')?.state).toBe('done');
  });

  it('keeps the staging dir when a job fails, so a retry can resume it', async () => {
    const plugin = fakePlugin();
    plugin.resolve!.resolve = async (_url, jobId) => {
      // Mirrors a truncated spotdl run: some files land before the process dies.
      const dir = pluginStagingDir(DATA_DIR, 'fake', jobId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'partial.mp3'), 'x');
      throw new Error('interrupted');
    };
    h = makeHarness(plugin);
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForState(h.watcher, id, 'failed');
    expect(existsSync(join(pluginStagingDir(DATA_DIR, 'fake', id), 'partial.mp3'))).toBe(true);
  });

  it('removes the staging dir once a job completes successfully', async () => {
    const plugin = fakePlugin();
    const stagedResolve = plugin.resolve!.resolve;
    plugin.resolve!.resolve = async (url, jobId) => {
      const dir = pluginStagingDir(DATA_DIR, 'fake', jobId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'marker.mp3'), 'x');
      return stagedResolve(url, jobId);
    };
    h = makeHarness(plugin);
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForState(h.watcher, id, 'done');
    expect(existsSync(pluginStagingDir(DATA_DIR, 'fake', id))).toBe(false);
  });

  it('deleteJob also removes the staging dir on disk', () => {
    const dir = pluginStagingDir(DATA_DIR, 'fake', 'd');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'leftover.mp3'), 'x');
    h.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state) VALUES ('d', 'fake', 'u', 'failed')`,
    );
    expect(h.watcher.deleteJob('d')).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes staging dirs for jobs pruned by the 7-day janitor', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const dir = pluginStagingDir(DATA_DIR, 'fake', 'old-stale');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'leftover.mp3'), 'x');
    db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state, created_at)
       VALUES ('old-stale', 'fake', 'u', 'failed', unixepoch() - 700000)`,
    );
    const registry = new PluginRegistry({ db, dataDir: DATA_DIR });
    new AcquireWatcher({
      db,
      dataDir: DATA_DIR,
      registry,
      organizeBatch: mock(async () => {}),
      scanIncremental: mock(async () => {}),
    });
    expect(existsSync(dir)).toBe(false);
  });

  it('deleteJob removes done/failed jobs but not running ones', () => {
    h.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state) VALUES ('d', 'fake', 'u', 'done')`,
    );
    h.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state) VALUES ('r', 'fake', 'u', 'running')`,
    );
    expect(h.watcher.deleteJob('d')).toBe(true);
    expect(h.watcher.deleteJob('r')).toBe(false);
    expect(h.watcher.deleteJob('nope')).toBe(false);
  });

  it('retryJob resumes the same job id (and staging dir) instead of starting fresh', async () => {
    await h.registry.enable('fake', 'admin');
    h.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state) VALUES ('old', 'fake', 'https://example.com/x', 'failed')`,
    );
    const id = await h.watcher.retryJob('old');
    expect(id).toBe('old');
    await waitForState(h.watcher, 'old', 'done');
    expect(h.watcher.getJob('old')?.url).toBe('https://example.com/x');
  });

  it('retryJob passes the same job id to resolve(), preserving files the failed attempt left in staging', async () => {
    const plugin = fakePlugin();
    const seenIds: string[] = [];
    plugin.resolve!.resolve = async (_url, jobId) => {
      seenIds.push(jobId);
      const dir = pluginStagingDir(DATA_DIR, 'fake', jobId);
      mkdirSync(dir, { recursive: true });
      if (seenIds.length === 1) throw new Error('interrupted');
      // Second attempt (the retry): the file from attempt 1 must still be there.
      expect(existsSync(join(dir, 'partial.mp3'))).toBe(true);
      return [join(dir, 'partial.mp3')];
    };
    h = makeHarness(plugin);
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForState(h.watcher, id, 'failed');
    // Attempt 1's staging dir survives the failure (Task 1); simulate the
    // partial file spotdl would have left behind before the interruption.
    writeFileSync(join(pluginStagingDir(DATA_DIR, 'fake', id), 'partial.mp3'), 'x');

    const retryId = await h.watcher.retryJob(id);
    expect(retryId).toBe(id);
    await waitForState(h.watcher, id, 'done');
    expect(seenIds).toEqual([id, id]);
  });

  it('retryJob no-ops (returns the existing id) when the job is already in flight', async () => {
    h.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state) VALUES ('r', 'fake', 'https://example.com/x', 'running')`,
    );
    expect(await h.watcher.retryJob('r')).toBe('r');
  });

  it('retryJob returns null for an unknown job', async () => {
    expect(await h.watcher.retryJob('nope')).toBeNull();
  });

  it('reuses the in-flight job instead of queueing a duplicate for the same URL', async () => {
    // A plugin whose resolve() never settles, simulating a job still running.
    let releaseResolve!: () => void;
    const plugin = fakePlugin();
    plugin.resolve!.resolve = (_url, jobId) =>
      new Promise((resolve) => {
        releaseResolve = () =>
          resolve([
            join(pluginStagingDir(DATA_DIR, 'fake', jobId), 'Artist', 'Album', 'track.mp3'),
          ]);
      });
    h = makeHarness(plugin);
    await h.registry.enable('fake', 'admin');

    const firstId = await h.watcher.submit('https://example.com/x');
    const secondId = await h.watcher.submit('https://example.com/x');
    expect(secondId).toBe(firstId);
    expect(h.watcher.listJobs().filter((j) => j.url === 'https://example.com/x')).toHaveLength(1);

    releaseResolve();
    await waitForState(h.watcher, firstId, 'done');
  });

  it('flags a truncated download (fewer files than the source reported) with a warning, but still marks it done', async () => {
    const plugin = fakePlugin();
    plugin.resolve!.resolve = async (_url, jobId) => {
      // Mirrors what spotdl's progress parser records ("Found 16 songs") before
      // only 1 track actually lands on disk.
      h.db.run(`UPDATE acquire_jobs SET progress = ? WHERE id = ?`, [
        JSON.stringify({ done: 1, total: 16 }),
        jobId,
      ]);
      return [join(pluginStagingDir(DATA_DIR, 'fake', jobId), 'Artist', 'Album', 'track.mp3')];
    };
    h = makeHarness(plugin);
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForState(h.watcher, id, 'done');
    const job = h.watcher.getJob(id)!;
    expect(job.state).toBe('done');
    expect(job.error).toContain('1 of 16');
  });

  it('does not flag a complete download as partial', async () => {
    const plugin = fakePlugin();
    plugin.resolve!.resolve = async (_url, jobId) => {
      h.db.run(`UPDATE acquire_jobs SET progress = ? WHERE id = ?`, [
        JSON.stringify({ done: 1, total: 1 }),
        jobId,
      ]);
      return [join(pluginStagingDir(DATA_DIR, 'fake', jobId), 'Artist', 'Album', 'track.mp3')];
    };
    h = makeHarness(plugin);
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForState(h.watcher, id, 'done');
    expect(h.watcher.getJob(id)?.error).toBeNull();
  });

  it('retryJob clears stale progress so a clean retry is not misreported as a partial download', async () => {
    const plugin = fakePlugin();
    let attempt = 0;
    plugin.resolve!.resolve = async (_url, jobId) => {
      attempt += 1;
      if (attempt === 1) {
        // Attempt 1: mirrors spotdl reporting "Found 16 songs" before the run
        // fails outright, leaving that stale total sitting in the row.
        h.db.run(`UPDATE acquire_jobs SET progress = ? WHERE id = ?`, [
          JSON.stringify({ done: 1, total: 16 }),
          jobId,
        ]);
        throw new Error('interrupted');
      }
      // Attempt 2 (the retry): a single-track URL that finishes before the
      // plugin ever emits its own progress line — the row must not still be
      // carrying attempt 1's stale total: 16.
      return [join(pluginStagingDir(DATA_DIR, 'fake', jobId), 'Artist', 'Album', 'track.mp3')];
    };
    h = makeHarness(plugin);
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForState(h.watcher, id, 'failed');

    const retryId = await h.watcher.retryJob(id);
    expect(retryId).toBe(id);
    await waitForState(h.watcher, id, 'done');
    expect(h.watcher.getJob(id)?.error).toBeNull();
  });

  it('specific plugin wins over catch-all when both are enabled', async () => {
    // Simulates archive (specific) vs yt-dlp (catch-all: !spotify).
    // The specific plugin must be registered first so find() returns it.
    const db = new Database(':memory:');
    applySchema(db);
    const registry = new PluginRegistry({ db, dataDir: DATA_DIR });

    const specificPlugin: Plugin = {
      manifest: {
        id: 'specific',
        name: 'specific',
        description: 'handles archive.example.com only',
        kind: 'acquisition',
        capabilities: ['resolve'],
        defaultEnabled: false,
      },
      async init() {},
      async isAvailable() {
        return true;
      },
      resolve: {
        canHandle: (url: string) => url.includes('archive.example.com'),
        resolve: async (_url: string, jobId: string) => [
          join(pluginStagingDir(DATA_DIR, 'specific', jobId), 'track.mp3'),
        ],
      },
    };
    const catchAllPlugin: Plugin = {
      manifest: {
        id: 'catchall',
        name: 'catchall',
        description: 'handles anything except spotify',
        kind: 'acquisition',
        capabilities: ['resolve'],
        defaultEnabled: false,
      },
      async init() {},
      async isAvailable() {
        return true;
      },
      resolve: {
        canHandle: (url: string) => !url.includes('spotify.com'),
        resolve: async (_url: string, jobId: string) => [
          join(pluginStagingDir(DATA_DIR, 'catchall', jobId), 'track.mp3'),
        ],
      },
    };

    // Specific first, then catch-all — mirrors the archive → ytdlp registration order.
    registry.register(specificPlugin);
    registry.register(catchAllPlugin);

    const organize = mock(async (files: CompletedDownloadFile[]) => {
      for (const f of files) f.relativePath = 'track.mp3';
    });
    const scan = mock(async () => {});
    const watcher = new AcquireWatcher({
      db,
      dataDir: DATA_DIR,
      registry,
      organizeBatch: organize,
      scanIncremental: scan,
    });

    await registry.enable('specific', 'admin');
    await registry.enable('catchall', 'admin');

    const id = await watcher.submit('https://archive.example.com/item');
    expect(watcher.getJob(id)?.backend).toBe('specific');

    await waitForState(watcher, id, 'done');
  });

  it('threads a plugin’s { paths, meta } onto the organizer’s jobMeta (untagged sources)', async () => {
    const plugin = fakePlugin();
    plugin.resolve!.resolve = async (_url, jobId) => ({
      paths: [join(pluginStagingDir(DATA_DIR, 'fake', jobId), 'Ignored', 'Ignored', 'track.mp3')],
      meta: { artist: 'The Grateful Dead', album: 'Live at the Fillmore' },
    });
    h = makeHarness(plugin);
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForState(h.watcher, id, 'done');

    const files = h.organize.mock.calls[0]![0] as CompletedDownloadFile[];
    expect(files[0]!.jobMeta).toMatchObject({
      kind: 'url',
      artistName: 'The Grateful Dead',
      albumTitle: 'Live at the Fillmore',
    });
  });

  it('leaves jobMeta null for a bare string[] return (tagged sources file from tags)', async () => {
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForState(h.watcher, id, 'done');

    const files = h.organize.mock.calls[0]![0] as CompletedDownloadFile[];
    expect(files[0]!.jobMeta).toBeNull();
  });

  it('marks the job done with a warning (and skips scan) when nothing was filed into the library', async () => {
    // organize that files nothing — every track landed unsorted / was dup-skipped,
    // so relativePath is never set. Without the honest-status guard this would
    // read as a clean green "Done" while the library got nothing.
    const organize = mock(async () => {});
    const scan = mock(async () => {});
    const db = new Database(':memory:');
    applySchema(db);
    const registry = new PluginRegistry({ db, dataDir: DATA_DIR });
    registry.register(fakePlugin());
    await registry.enable('fake', 'admin');
    const watcher = new AcquireWatcher({
      db,
      dataDir: DATA_DIR,
      registry,
      organizeBatch: organize,
      scanIncremental: scan,
    });
    const id = await watcher.submit('https://example.com/x');
    await waitForState(watcher, id, 'done');

    const job = watcher.getJob(id)!;
    expect(job.state).toBe('done');
    expect(job.error).toContain('no tracks were added to your library');
    expect(scan).not.toHaveBeenCalled();
  });
});

// Playlist-from-acquisition flow: a Spotify/YouTube playlist URL submission
// marks the job as `is_playlist=1` at submit time, the per-track rows land in
// `acquire_job_tracks` (simulated here via the host context's emitTrack), and
// the post-ingest playlist step materializes a per-user native playlist
// containing the landed songs in download order. See
// docs/playlist-from-acquisition.md.
//
// The shared fakePlugin above only handles example.com URLs and stages one
// file. The playlist tests need a plugin that handles Spotify URLs and
// stages 3 files (one per playlist track) at the expected staging paths so
// the organizer's per-album move produces the right library_songs rows.
function playlistPlugin(): Plugin {
  return {
    manifest: {
      id: 'fake',
      name: 'fake',
      description: 'test',
      kind: 'acquisition',
      capabilities: ['resolve'],
      defaultEnabled: false,
    },
    async init() {},
    async isAvailable() {
      return true;
    },
    resolve: {
      // Handles Spotify URLs (playlist + album) and the example.com URL the
      // `as: playlist` test uses — the playlist suite is small enough that
      // one fake plugin is simpler than two.
      canHandle: (url: string) => url.includes('spotify.com') || url.includes('example.com'),
      resolve: async (_url: string, jobId: string) => {
        const dir = pluginStagingDir(DATA_DIR, 'fake', jobId);
        mkdirSync(dir, { recursive: true });
        // Emit one file per "playlist track" so the playlist-generation
        // tests have something to resolve. Each file lands in the
        // staging/<artist>/<album>/<title>.<ext> shape so the organizer
        // moves it cleanly.
        return [
          join(dir, 'Artist1', 'Album1', 'Song A.mp3'),
          join(dir, 'Artist1', 'Album1', 'Song B.mp3'),
          join(dir, 'Artist1', 'Album1', 'Song C.mp3'),
        ];
      },
    },
  };
}

describe('AcquireWatcher (playlist generation)', () => {
  // Need a fresh users row because `playlists.user_id` has a FK.
  function dbWithUser(db: Database, userId: string): void {
    db.run(
      `INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'x', 'admin', 1)`,
      [userId, userId],
    );
  }

  function makePlaylistHarness(): Harness {
    const db = new Database(':memory:');
    applySchema(db);
    dbWithUser(db, 'user-1');
    const registry = new PluginRegistry({ db, dataDir: DATA_DIR });
    const plugin = playlistPlugin();
    registry.register(plugin);
    // organizeBatch simulates what LibraryOrganizer would do for a playlist:
    // set the relativePath on each file and (via the scan callback) insert a
    // library_songs row so the post-ingest playlist step can join it. It
    // also writes acquire_job_tracks rows — what a real plugin's
    // `emitTrack(jobId, { title, status, path })` would produce in production.
    const organize = mock(async (files: CompletedDownloadFile[]) => {
      const titles = ['Song A', 'Song B', 'Song C'];
      files.forEach((f, i) => {
        f.relativePath = `Artist1/Album1/${titles[i] ?? `track${i + 1}`}.mp3`;
      });
    });
    const scan = mock(async (relPaths: string[]) => {
      const titles = ['Song A', 'Song B', 'Song C'];
      // The fake plugin doesn't go through runAcquireProcess (it just returns
      // paths), so the host-context emitTrack wiring never fires. Simulate it
      // here by writing acquire_job_tracks rows in the order the files were
      // submitted — that's the only thing the real host emits.
      // (We need the jobId; in a test it's whatever the watcher assigned.
      // Read it from the only 'running'/'queued'/'done' job — the watcher
      // uses a uuid per submit so this works because there's only one job.)
      const jobRow = db
        .query<{ id: string }, []>(`SELECT id FROM acquire_jobs ORDER BY created_at DESC LIMIT 1`)
        .get();
      const jobId = jobRow?.id;
      for (let i = 0; i < relPaths.length; i++) {
        const path = relPaths[i]!;
        // OR IGNORE / OR REPLACE so a retryJob() re-run of the same job (which
        // re-organizes + re-scans the same files) doesn't blow up the mock.
        db.run(
          `INSERT OR IGNORE INTO library_songs (id, album_id, title, artist, artist_id, path, duration, landed_at, synced_at)
           VALUES (?, 'alb', ?, 'Artist1', 'art', ?, 100, 1, 1)`,
          [`s${i + 1}`, titles[i] ?? `track${i + 1}`, path],
        );
        if (jobId) {
          db.run(
            `INSERT OR REPLACE INTO acquire_job_tracks (job_id, position, title, status, path)
             VALUES (?, ?, ?, 'done', ?)`,
            [jobId, i, titles[i] ?? `track${i + 1}`, path.split('/').pop() ?? path],
          );
        }
      }
    });
    const watcher = new AcquireWatcher({
      db,
      dataDir: DATA_DIR,
      registry,
      organizeBatch: organize,
      scanIncremental: scan,
    });
    return { watcher, db, registry, organize, scan };
  }

  it('marks a Spotify playlist URL as is_playlist at submit time', async () => {
    const h = makePlaylistHarness();
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://open.spotify.com/playlist/abc', undefined, {
      userId: 'user-1',
    });
    await waitForState(h.watcher, id, 'done');
    expect(h.watcher.getJob(id)?.isPlaylist).toBe(true);
  });

  it('does NOT mark a Spotify album URL as is_playlist', async () => {
    const h = makePlaylistHarness();
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://open.spotify.com/album/abc', undefined, {
      userId: 'user-1',
    });
    await waitForState(h.watcher, id, 'done');
    expect(h.watcher.getJob(id)?.isPlaylist).toBe(false);
  });

  it('forces is_playlist when the caller passes `as: playlist` for an archive item', async () => {
    const h = makePlaylistHarness();
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x', undefined, {
      userId: 'user-1',
      as: 'playlist',
    });
    await waitForState(h.watcher, id, 'done');
    expect(h.watcher.getJob(id)?.isPlaylist).toBe(true);
  });

  it('skips playlist generation when is_playlist but no userId (server-side guard)', async () => {
    const h = makePlaylistHarness();
    await h.registry.enable('fake', 'admin');
    // Spotify playlist URL but no userId → classification would set
    // is_playlist but the submit() guard downgrades to false.
    const id = await h.watcher.submit('https://open.spotify.com/playlist/abc');
    await waitForState(h.watcher, id, 'done');
    expect(h.watcher.getJob(id)?.isPlaylist).toBe(false);
    expect(h.watcher.getJob(id)?.playlistId).toBeNull();
  });

  it('materializes a per-user native playlist after a playlist URL completes', async () => {
    const h = makePlaylistHarness();
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://open.spotify.com/playlist/abc', 'My Mix', {
      userId: 'user-1',
    });
    await waitForState(h.watcher, id, 'done');

    const job = h.watcher.getJob(id)!;
    expect(job.isPlaylist).toBe(true);
    expect(job.playlistId).toBeTruthy();
    // The playlist was created with the user's id and the label as name.
    const pl = h.db
      .query<{ id: string; name: string; user_id: string; kind: string }, [string]>(
        `SELECT id, name, user_id, kind FROM playlists WHERE id = ?`,
      )
      .get(job.playlistId!);
    expect(pl?.user_id).toBe('user-1');
    expect(pl?.name).toBe('My Mix');
    expect(pl?.kind).toBe('user');
    // The playlist contains the 3 landed songs in download order.
    const songIds = h.db
      .query<{ song_id: string }, [string]>(
        `SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position ASC`,
      )
      .all(job.playlistId!)
      .map((r) => r.song_id);
    expect(songIds).toEqual(['s1', 's2', 's3']);
  });

  it('reuses the existing playlist on retry instead of creating a duplicate', async () => {
    const h = makePlaylistHarness();
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://open.spotify.com/playlist/abc', 'My Mix', {
      userId: 'user-1',
    });
    await waitForState(h.watcher, id, 'done');
    const firstPlaylistId = h.watcher.getJob(id)!.playlistId;
    expect(firstPlaylistId).toBeTruthy();

    await h.watcher.retryJob(id, { userId: 'user-1' });
    await waitForState(h.watcher, id, 'done');

    // Same playlist id, exactly one playlist row, songs still in order.
    expect(h.watcher.getJob(id)!.playlistId).toBe(firstPlaylistId);
    const count = h.db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM playlists`).get();
    expect(count?.c).toBe(1);
    const songIds = h.db
      .query<{ song_id: string }, [string]>(
        `SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position ASC`,
      )
      .all(firstPlaylistId!)
      .map((r) => r.song_id);
    expect(songIds).toEqual(['s1', 's2', 's3']);
  });

  it('creates a fresh playlist on retry when the user deleted the original', async () => {
    const h = makePlaylistHarness();
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://open.spotify.com/playlist/abc', 'My Mix', {
      userId: 'user-1',
    });
    await waitForState(h.watcher, id, 'done');
    const firstPlaylistId = h.watcher.getJob(id)!.playlistId!;
    h.db.run(`DELETE FROM playlists WHERE id = ?`, [firstPlaylistId]);

    await h.watcher.retryJob(id, { userId: 'user-1' });
    await waitForState(h.watcher, id, 'done');

    const newPlaylistId = h.watcher.getJob(id)!.playlistId;
    expect(newPlaylistId).toBeTruthy();
    expect(newPlaylistId).not.toBe(firstPlaylistId);
    const count = h.db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM playlists`).get();
    expect(count?.c).toBe(1);
  });

  it('does not create a playlist when no tracks landed (acquisitions empty)', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    dbWithUser(db, 'user-1');
    const registry = new PluginRegistry({ db, dataDir: DATA_DIR });
    registry.register(playlistPlugin());
    // organize that drops everything to unsorted (no relativePath set).
    const organize = mock(async (_files: CompletedDownloadFile[]) => {});
    const scan = mock(async () => {});
    const watcher = new AcquireWatcher({
      db,
      dataDir: DATA_DIR,
      registry,
      organizeBatch: organize,
      scanIncremental: scan,
    });
    await registry.enable('fake', 'admin');
    const id = await watcher.submit('https://open.spotify.com/playlist/abc', 'Empty Mix', {
      userId: 'user-1',
    });
    await waitForState(watcher, id, 'done');
    expect(watcher.getJob(id)?.isPlaylist).toBe(true);
    expect(watcher.getJob(id)?.playlistId).toBeNull();
    const rows = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM playlists`).get();
    expect(rows?.c).toBe(0);
  });
});
