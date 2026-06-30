import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../../db.js';
import { createPluginHostContext, pluginStagingDir, type HostContextDeps } from './host-context.js';

// deps (db/emit) are injected; only allocStagingDir touches the fs, so it runs
// against a real temp dataDir instead of a mocked node:fs.
describe('createPluginHostContext', () => {
  let db: Database;
  let dataDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    dataDir = mkdtempSync(join(tmpdir(), 'nicotind-hostctx-'));
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function make(deps: Partial<HostContextDeps> = {}) {
    return createPluginHostContext('spotdl', { enabled: true }, { db, dataDir, ...deps });
  }

  it('exposes the resolved config and a namespaced logger', () => {
    const ctx = make();
    expect(ctx.config).toEqual({ enabled: true });
    expect(ctx.logger).toBeDefined();
  });

  it('allocStagingDir creates the canonical per-job staging path', () => {
    const ctx = make();
    const dir = ctx.allocStagingDir('job-1');
    expect(dir).toBe(pluginStagingDir(dataDir, 'spotdl', 'job-1'));
    expect(dir).toBe(join(dataDir, 'staging', 'plugins', 'spotdl', 'job-1'));
    expect(existsSync(dir)).toBe(true);
  });

  it('routes progress and label emissions to the injected callbacks', () => {
    const progress: Array<[string, { done: number; total: number }]> = [];
    const labels: Array<[string, string]> = [];
    const ctx = make({
      emitProgress: (jobId, p) => progress.push([jobId, p]),
      emitLabel: (jobId, l) => labels.push([jobId, l]),
    });
    ctx.emitProgress('job-1', { done: 2, total: 5 });
    ctx.emitLabel('job-1', 'My Playlist');
    expect(progress).toEqual([['job-1', { done: 2, total: 5 }]]);
    expect(labels).toEqual([['job-1', 'My Playlist']]);
  });

  it('tolerates missing emit callbacks (no throw)', () => {
    const ctx = make();
    expect(() => ctx.emitProgress('j', { done: 1, total: 1 })).not.toThrow();
    expect(() => ctx.emitLabel('j', 'x')).not.toThrow();
  });

  it('storage round-trips values scoped to the plugin id', () => {
    const ctx = make();
    expect(ctx.storage.get('k')).toBeNull();
    ctx.storage.set('k', 'v1');
    expect(ctx.storage.get('k')).toBe('v1');
    ctx.storage.set('k', 'v2'); // upsert
    expect(ctx.storage.get('k')).toBe('v2');
    ctx.storage.delete('k');
    expect(ctx.storage.get('k')).toBeNull();
  });

  it('scopes storage by plugin id (no cross-plugin leakage)', () => {
    const spotdl = make();
    const ytdlp = createPluginHostContext('ytdlp', {}, { db, dataDir });
    spotdl.storage.set('shared-key', 'spotdl-value');
    expect(ytdlp.storage.get('shared-key')).toBeNull();
    expect(spotdl.storage.get('shared-key')).toBe('spotdl-value');
  });
});
