import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { join } from 'node:path';
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

  it('reaches stage "done", records storage_path, and writes an acquisitions row', async () => {
    await h.registry.enable('fake', 'admin');
    const id = await h.watcher.submit('https://example.com/x');
    await waitForStage(h.watcher, id, 'done');

    const job = h.watcher.getJob(id)!;
    expect(job.stage).toBe('done');
    expect(job.storage_path).toBe('Artist/Album');

    const acq = h.db
      .query<
        { method: string; source_ref: string; stage: string },
        [string]
      >('SELECT method, source_ref, stage FROM acquisitions WHERE relative_path = ?')
      .get('Artist/Album/track.mp3');
    // 'fake' is not a known method id, so it maps to 'unknown'.
    expect(acq).toEqual({
      method: 'unknown',
      source_ref: 'https://example.com/x',
      stage: 'done',
    });
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
      .query<
        { method: string },
        [string]
      >('SELECT method FROM acquisitions WHERE relative_path = ?')
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
    const { watcher, registry } = makeHarness(plugin);
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
    const watcher = new AcquireWatcher({ db, dataDir: DATA_DIR, registry, organizeBatch: organize, scanIncremental: scan });
    const id = await watcher.submit('https://example.com/x');
    // While organize is blocked, state must still be 'running'.
    await new Promise((r) => setTimeout(r, 20));
    expect(watcher.getJob(id)?.state).toBe('running');
    resolveOrganize();
    await waitForState(watcher, id, 'done');
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

  it('retryJob re-submits the same URL and removes the old row', async () => {
    await h.registry.enable('fake', 'admin');
    h.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state) VALUES ('old', 'fake', 'https://example.com/x', 'failed')`,
    );
    const newId = await h.watcher.retryJob('old');
    expect(typeof newId).toBe('string');
    expect(newId).not.toBe('old');
    expect(h.watcher.getJob('old')).toBeNull();
    expect(h.watcher.getJob(newId!)?.url).toBe('https://example.com/x');
  });

  it('retryJob returns null for an unknown job', async () => {
    expect(await h.watcher.retryJob('nope')).toBeNull();
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
});
