import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { listAudit, recordAudit } from './audit-log.js';

const db = new Database(':memory:');
applySchema(db);

const actor = { sub: 'u1', username: 'kevin' };

beforeEach(() => {
  db.run('DELETE FROM audit_log');
});

describe('audit log', () => {
  it('records and lists entries newest-first', () => {
    recordAudit(db, actor, 'album.delete', {
      targetKind: 'album',
      targetId: 'al1',
      detail: 'X — Y, 10 song(s) deleted',
      now: 100,
    });
    recordAudit(db, actor, 'user.role', { targetKind: 'user', targetId: 'u2', detail: 'refiner', now: 200 });

    const rows = listAudit(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: 'user.role',
      userId: 'u1',
      username: 'kevin',
      targetId: 'u2',
      detail: 'refiner',
      at: 200,
    });
    expect(rows[1]!.action).toBe('album.delete');
  });

  it('paginates with limit/offset and clamps limit', () => {
    for (let i = 0; i < 10; i++) recordAudit(db, actor, `a${i}`, { now: i });
    expect(listAudit(db, { limit: 3 }).map((r) => r.action)).toEqual(['a9', 'a8', 'a7']);
    expect(listAudit(db, { limit: 3, offset: 3 }).map((r) => r.action)).toEqual(['a6', 'a5', 'a4']);
    expect(listAudit(db, { limit: 0 })).toHaveLength(1); // clamped to ≥1
  });

  it('tolerates a missing username and never throws on bad input', () => {
    recordAudit(db, { sub: 'u2' }, 'user.delete', { now: 1 });
    expect(listAudit(db)[0]).toMatchObject({ userId: 'u2', username: null });
  });
});
