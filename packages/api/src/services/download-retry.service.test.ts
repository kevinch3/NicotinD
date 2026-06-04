import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { DownloadRetryService } from './download-retry.service.js';
import type { Slskd } from '@nicotind/slskd-client';

interface MockFile {
  id: string;
  filename: string;
  size: number;
  state: string;
}

function makeSlskdMock(files: MockFile[], username = 'peer') {
  const cancel = mock(async (_u: string, _id: string) => undefined);
  const enqueue = mock(
    async (_u: string, _files: Array<{ filename: string; size: number }>) => undefined,
  );
  const getDownloads = mock(async () => [
    {
      username,
      directories: [{ directory: 'Album', fileCount: files.length, files }],
    },
  ]);
  const slskd = { transfers: { getDownloads, cancel, enqueue } } as unknown as Slskd;
  return { slskd, cancel, enqueue, getDownloads };
}

function makeDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function retryRow(db: Database, key: string) {
  return db
    .query('SELECT attempts, gave_up FROM transfer_retries WHERE transfer_key = ?')
    .get(key) as { attempts: number; gave_up: number } | undefined;
}

describe('DownloadRetryService', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('re-enqueues an errored transfer and records the attempt', async () => {
    const { slskd, cancel, enqueue } = makeSlskdMock([
      { id: 't1', filename: 'Album/01.flac', size: 100, state: 'Completed, Errored' },
    ]);
    const svc = new DownloadRetryService(slskd, { db, cooldownMs: 0 });

    await svc.sweep();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('peer', [{ filename: 'Album/01.flac', size: 100 }]);
    expect(retryRow(db, 'peer::Album/01.flac')?.attempts).toBe(1);
  });

  it('retries TimedOut and Rejected but never Cancelled', async () => {
    const { slskd, enqueue } = makeSlskdMock([
      { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, TimedOut' },
      { id: 't2', filename: 'b.flac', size: 1, state: 'Completed, Rejected' },
      { id: 't3', filename: 'c.flac', size: 1, state: 'Completed, Cancelled' },
    ]);
    const svc = new DownloadRetryService(slskd, { db, cooldownMs: 0 });

    await svc.sweep();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(retryRow(db, 'peer::c.flac')).toBeNull();
  });

  it('gives up after maxAttempts and stops retrying', async () => {
    const { slskd, enqueue } = makeSlskdMock([
      { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
    ]);
    const svc = new DownloadRetryService(slskd, { db, cooldownMs: 0, maxAttempts: 2 });

    await svc.sweep(); // attempt 1
    await svc.sweep(); // attempt 2
    await svc.sweep(); // attempts == max -> gave_up, no enqueue
    await svc.sweep(); // gave_up -> skip

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(retryRow(db, 'peer::a.flac')?.gave_up).toBe(1);
  });

  it('respects the cooldown between attempts', async () => {
    const { slskd, enqueue } = makeSlskdMock([
      { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
    ]);
    const svc = new DownloadRetryService(slskd, { db, cooldownMs: 60_000 });

    await svc.sweep(); // attempt 1
    await svc.sweep(); // within cooldown -> skipped

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('skips hidden transfers', async () => {
    const { slskd, enqueue } = makeSlskdMock([
      { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
    ]);
    db.run('INSERT INTO hidden_transfers (id) VALUES (?)', ['t1']);
    const svc = new DownloadRetryService(slskd, { db, cooldownMs: 0 });

    await svc.sweep();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('clears the retry record once a transfer succeeds', async () => {
    db.run(
      'INSERT INTO transfer_retries (transfer_key, username, filename, attempts) VALUES (?, ?, ?, ?)',
      ['peer::a.flac', 'peer', 'a.flac', 2],
    );
    const { slskd } = makeSlskdMock([
      { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Succeeded' },
    ]);
    const svc = new DownloadRetryService(slskd, { db, cooldownMs: 0 });

    await svc.sweep();

    expect(retryRow(db, 'peer::a.flac')).toBeNull();
  });
});
