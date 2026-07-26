import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { SlskdUserTransferGroup } from '@nicotind/core';
import { applySchema } from '../db.js';
import {
  planHiddenTransferReconciliation,
  pruneHiddenTransfers,
  reconcileHiddenTransfers,
} from './hidden-transfers.js';

function groups(
  files: Array<{ username: string; id: string; state: string }>,
): SlskdUserTransferGroup[] {
  const byUser = new Map<string, Array<{ id: string; state: string }>>();
  for (const f of files) {
    const list = byUser.get(f.username) ?? [];
    list.push({ id: f.id, state: f.state });
    byUser.set(f.username, list);
  }
  return [...byUser].map(([username, list]) => ({
    username,
    directories: [
      {
        directory: 'dir',
        fileCount: list.length,
        files: list.map((f) => ({
          id: f.id,
          filename: `${f.id}.mp3`,
          state: f.state,
          size: 1,
          bytesTransferred: 0,
          percentComplete: 0,
        })),
      },
    ],
  })) as unknown as SlskdUserTransferGroup[];
}

describe('planHiddenTransferReconciliation', () => {
  it('prunes a hidden id slskd no longer reports', () => {
    const plan = planHiddenTransferReconciliation(
      ['gone', 'here'],
      groups([{ username: 'u1', id: 'here', state: 'InProgress' }]),
    );
    expect(plan.prune).toEqual(['gone']);
  });

  it('keeps a hidden id that is still present', () => {
    const plan = planHiddenTransferReconciliation(
      ['here'],
      groups([{ username: 'u1', id: 'here', state: 'InProgress' }]),
    );
    expect(plan.prune).toEqual([]);
  });

  it('re-asks removal for a hidden id still listed in a completed state', () => {
    const plan = planHiddenTransferReconciliation(
      ['done'],
      groups([{ username: 'u1', id: 'done', state: 'Completed, Cancelled' }]),
    );
    expect(plan.remove).toEqual([{ username: 'u1', id: 'done' }]);
    expect(plan.prune).toEqual([]);
  });

  it('leaves an in-flight hidden transfer strictly alone', () => {
    // Removal would be a no-op (slskd only removes completed transfers) and the
    // hide is the only thing keeping it off screen.
    const plan = planHiddenTransferReconciliation(
      ['flying'],
      groups([{ username: 'u1', id: 'flying', state: 'InProgress' }]),
    );
    expect(plan.remove).toEqual([]);
    expect(plan.prune).toEqual([]);
  });
});

describe('reconcileHiddenTransfers', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('prunes stale rows and retries removal for completed ones', async () => {
    for (const id of ['gone', 'done', 'flying']) {
      db.run('INSERT INTO hidden_transfers (id) VALUES (?)', [id]);
    }

    const cancel = mock(() => Promise.resolve());
    const result = await reconcileHiddenTransfers(db, {
      getDownloads: () =>
        Promise.resolve(
          groups([
            { username: 'u1', id: 'done', state: 'Completed, Succeeded' },
            { username: 'u1', id: 'flying', state: 'InProgress' },
          ]),
        ),
      cancel,
    });

    expect(result).toEqual({ pruned: 1, removed: 1 });
    expect(cancel).toHaveBeenCalledWith('u1', 'done', { remove: true });

    const left = (db.query('SELECT id FROM hidden_transfers').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(left.sort()).toEqual(['done', 'flying']);
  });

  it('is a no-op when slskd is unreachable (never blocks boot)', async () => {
    db.run('INSERT INTO hidden_transfers (id) VALUES (?)', ['gone']);

    const result = await reconcileHiddenTransfers(db, {
      getDownloads: () => Promise.reject(new Error('FailedToOpenSocket')),
      cancel: () => Promise.resolve(),
    });

    expect(result).toEqual({ pruned: 0, removed: 0 });
    expect(db.query('SELECT id FROM hidden_transfers').all()).toHaveLength(1);
  });
});

describe('pruneHiddenTransfers', () => {
  it('deletes only the given ids', () => {
    const db = new Database(':memory:');
    applySchema(db);
    for (const id of ['a', 'b', 'c']) {
      db.run('INSERT INTO hidden_transfers (id) VALUES (?)', [id]);
    }

    expect(pruneHiddenTransfers(db, ['a', 'c'])).toBe(2);
    const left = (db.query('SELECT id FROM hidden_transfers').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(left).toEqual(['b']);
  });
});
