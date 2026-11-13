import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { AddonManifest } from '@nicotind/core';
import { applySchema } from '../db.js';
import { createJob, getJob, listJobFeed, recomputeStage } from './acquisition-job-store.js';
import { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError } from './addons/client.js';
import { AutoCompleteService } from './auto-complete.service.js';

const MANIFEST = {
  id: 'fixture-addon',
  name: 'Fixture',
  description: 'x',
  version: '0.1.0',
  protocolVersion: '1.0.0',
  kind: 'acquisition',
  capabilities: ['search', 'download'],
} as AddonManifest;

const FULL_PEER = {
  candidateRef: 'c-full',
  username: 'full-peer',
  directory: 'Europe\\The Final Countdown',
  format: 'FLAC',
  estimatedSizeMb: 90,
  files: [
    { filename: 'Europe\\The Final Countdown\\01 The Final Countdown.flac', size: 1 },
    { filename: 'Europe\\The Final Countdown\\02 Rock the Night.flac', size: 1 },
    { filename: 'Europe\\The Final Countdown\\03 Carrie.flac', size: 1 },
  ],
};

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

interface FakeAddon {
  searchResult?: { candidates: unknown[]; sourceOffline?: boolean; rateLimited?: boolean };
  searchThrows?: Error;
}

function fakeAddon(opts: FakeAddon = {}) {
  const calls = {
    searches: [] as Array<{ lane?: string }>,
    cancelled: [] as string[],
    created: [] as Array<{ wantedTracks?: { title: string }[]; candidateRef?: string }>,
  };
  // As strict as the real slskd addon: one active album job per release.
  const active = new Set<string>();
  const client = {
    baseUrl: 'http://addon:9999',
    albumsSearch: async (_req: unknown, o: { lane?: string }) => {
      calls.searches.push({ lane: o.lane });
      if (opts.searchThrows) throw opts.searchThrows;
      return opts.searchResult ?? { candidates: [FULL_PEER] };
    },
    cancelJob: async (id: string) => {
      calls.cancelled.push(id);
      active.delete(id);
    },
    createJob: async (req: { wantedTracks?: { title: string }[]; candidateRef?: string }) => {
      if (active.size > 0) throw new AddonRequestError('addon responded 409', 409);
      calls.created.push(req);
      const id = `aj-auto-${calls.created.length}`;
      active.add(id);
      return { id, items: [] };
    },
  } as unknown as import('./addons/client.js').AddonClient;
  const plugin = new RemoteAddonPlugin(MANIFEST, client);
  return { calls, getPlugin: (id: string) => (id === MANIFEST.id ? plugin : undefined) };
}

/**
 * The prod case, cut down: the first peer delivered one track and the addon's
 * fallback gave up on two, so the card closed `done · 1 of 3 · 2 unavailable`.
 */
function partialJob(opts: { kind?: 'album-hunt' | 'direct'; updatedAt?: number } = {}): string {
  const jobId = createJob(db, {
    kind: opts.kind ?? 'album-hunt',
    method: 'fixture-addon',
    userId: 'u',
    artistName: 'Europe',
    albumTitle: 'The Final Countdown',
    canonicalTracks: ['The Final Countdown', 'Rock the Night', 'Carrie'],
    sourceRef: 'addon:fixture-addon:aj-first',
    username: 'first-peer',
    files: [
      {
        filename: 'E\\TFC\\01 The Final Countdown.flac',
        size: 1,
        trackTitle: 'The Final Countdown',
      },
      { filename: 'E\\TFC\\02 Rock the Night.flac', size: 1, trackTitle: 'Rock the Night' },
      { filename: 'E\\TFC\\03 Carrie.flac', size: 1, trackTitle: 'Carrie' },
    ],
  });
  db.run(
    `UPDATE acquisition_job_items SET state = 'scanned', addon_job_id = 'aj-first'
      WHERE job_id = ? AND track_title = 'The Final Countdown'`,
    [jobId],
  );
  db.run(
    `UPDATE acquisition_job_items SET state = 'unavailable', addon_job_id = 'aj-first'
      WHERE job_id = ? AND track_title <> 'The Final Countdown'`,
    [jobId],
  );
  recomputeStage(db, jobId);
  if (opts.updatedAt !== undefined) {
    db.run(`UPDATE acquisition_jobs SET updated_at = ? WHERE id = ?`, [opts.updatedAt, jobId]);
  }
  return jobId;
}

function autoState(jobId: string) {
  return db
    .query<{ auto_resource_attempts: number; auto_resource_exhausted_at: number | null }, [string]>(
      `SELECT auto_resource_attempts, auto_resource_exhausted_at FROM acquisition_jobs WHERE id = ?`,
    )
    .get(jobId)!;
}

function service(addon: ReturnType<typeof fakeAddon>, extra: Partial<{ enabled: boolean }> = {}) {
  const scheduled: number[] = [];
  const svc = new AutoCompleteService({
    db,
    getPlugin: addon.getPlugin,
    enabled: () => extra.enabled ?? true,
    schedule: (_fn, ms) => scheduled.push(ms),
  });
  return { svc, scheduled };
}

describe('AutoCompleteService (#1879)', () => {
  it('hands a done partial to the best other peer, once, on the same card', async () => {
    const addon = fakeAddon();
    const { svc } = service(addon);
    const jobId = partialJob();
    expect(getJob(db, jobId)?.state).toBe('done');

    svc.onJobClosed(jobId);
    svc.onJobClosed(jobId); // the poller may report the same close twice
    await svc.settled(jobId);

    expect(addon.calls.searches).toEqual([{ lane: 'resource-auto' }]);
    expect(addon.calls.created).toHaveLength(1);
    expect(addon.calls.created[0]!.candidateRef).toBe('c-full');
    // Only what is missing; the landed track stays with the peer that delivered it.
    expect(addon.calls.created[0]!.wantedTracks).toEqual([
      { title: 'Rock the Night' },
      { title: 'Carrie' },
    ]);
    // The card reopened: the new peer's rows are queued on it.
    expect(getJob(db, jobId)?.state).toBe('active');
    expect(autoState(jobId).auto_resource_attempts).toBe(1);
  });

  it('stops asking once no other peer has the missing tracks, and records why', async () => {
    const addon = fakeAddon({ searchResult: { candidates: [] } });
    const { svc } = service(addon);
    const jobId = partialJob();

    svc.onJobClosed(jobId);
    await svc.settled(jobId);
    expect(addon.calls.created).toHaveLength(0);
    expect(autoState(jobId).auto_resource_exhausted_at).not.toBeNull();
    // The card says so, rather than looking like nobody tried.
    expect(listJobFeed(db).find((j) => j.id === jobId)?.autoResourceExhausted).toBe(true);

    svc.onJobClosed(jobId);
    await svc.settled(jobId);
    expect(addon.calls.searches).toHaveLength(1);
  });

  it('an offline source is "could not look", not "nobody has it": retried later, not given up', async () => {
    const addon = fakeAddon({ searchResult: { candidates: [], sourceOffline: true } });
    const { svc, scheduled } = service(addon);
    const jobId = partialJob();

    svc.onJobClosed(jobId);
    await svc.settled(jobId);
    expect(autoState(jobId).auto_resource_exhausted_at).toBeNull();
    expect(scheduled).toHaveLength(1);
  });

  it('respects the attempt budget', async () => {
    const addon = fakeAddon();
    const { svc } = service(addon);
    const jobId = partialJob();
    db.run(`UPDATE acquisition_jobs SET auto_resource_attempts = 2 WHERE id = ?`, [jobId]);

    svc.onJobClosed(jobId);
    await svc.settled(jobId);
    expect(addon.calls.searches).toHaveLength(0);
  });

  it('a search that throws still spends an attempt, so a broken source cannot loop', async () => {
    const addon = fakeAddon({ searchThrows: new Error('boom') });
    const { svc } = service(addon);
    const jobId = partialJob();

    svc.onJobClosed(jobId);
    await svc.settled(jobId);
    expect(autoState(jobId).auto_resource_attempts).toBe(1);
    expect(addon.calls.created).toHaveLength(0);
  });

  it('leaves alone a card someone cancelled, a raw grab, and a card still downloading', async () => {
    const addon = fakeAddon();
    const { svc } = service(addon);
    const cancelled = partialJob();
    db.run(`UPDATE acquisition_jobs SET cancel_requested_at = 1 WHERE id = ?`, [cancelled]);
    const direct = partialJob({ kind: 'direct' });
    const active = partialJob();
    db.run(
      `UPDATE acquisition_job_items SET state = 'downloading'
        WHERE job_id = ? AND track_title = 'Carrie'`,
      [active],
    );
    recomputeStage(db, active);

    for (const id of [cancelled, direct, active]) {
      svc.onJobClosed(id);
      await svc.settled(id);
    }
    expect(addon.calls.searches).toHaveLength(0);
  });

  it('does nothing while the toggle is off', async () => {
    const addon = fakeAddon();
    const { svc } = service(addon, { enabled: false });
    const jobId = partialJob();

    svc.onJobClosed(jobId);
    expect(svc.resumePending()).toBe(0);
    await svc.settled(jobId);
    expect(addon.calls.searches).toHaveLength(0);
  });

  it('a restart resumes recent partials, never the whole history', async () => {
    const addon = fakeAddon();
    const { svc } = service(addon);
    const recent = partialJob();
    partialJob({ updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 });

    expect(svc.resumePending()).toBe(1);
    await svc.settled(recent);
    expect(addon.calls.created).toHaveLength(1);
  });
});
