import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  createCurationFlag,
  listOpenCurationFlags,
  countOpenCurationFlags,
  resolveCurationFlag,
  isFlagTargetKind,
} from './curation-flags.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

const flag = (
  targetId: string,
  reason = 'ambiguous',
  kind: 'artist' | 'album' | 'song' = 'artist',
) => createCurationFlag(db, { targetKind: kind, targetId, reason, createdBy: 'agent:t1' });

describe('createCurationFlag', () => {
  it('records a flag and reports it as newly created', () => {
    const res = flag('Secret Cinema B2B Egbert', 'two acts, no single target');
    expect(res.created).toBe(true);
    expect(res.flag.targetId).toBe('Secret Cinema B2B Egbert');
    expect(res.flag.reason).toBe('two acts, no single target');
    expect(countOpenCurationFlags(db)).toBe(1);
  });

  it('re-flagging an open target updates it instead of piling up rows', () => {
    // The failure this prevents: an agent re-running its sweep every night and
    // minting a new row each pass for the same unresolved case.
    flag('A', 'first reason');
    const again = flag('A', 'sharper reason');
    expect(again.created).toBe(false);
    expect(countOpenCurationFlags(db)).toBe(1);
    expect(listOpenCurationFlags(db)[0]!.reason).toBe('sharper reason');
  });

  it('separates targets of different kinds with the same id', () => {
    flag('x', 'r', 'artist');
    flag('x', 'r', 'album');
    expect(countOpenCurationFlags(db)).toBe(2);
  });

  it('allows re-flagging a target once its previous flag is resolved', () => {
    const first = flag('A');
    expect(resolveCurationFlag(db, first.flag.id, 'kevin')).toBe(true);
    const second = flag('A', 'it came back');
    expect(second.created).toBe(true);
    expect(second.flag.id).not.toBe(first.flag.id);
    expect(countOpenCurationFlags(db)).toBe(1);
  });
});

describe('listOpenCurationFlags', () => {
  it('returns open flags oldest-first and excludes resolved ones', () => {
    const a = createCurationFlag(
      db,
      { targetKind: 'artist', targetId: 'old', reason: 'r', createdBy: 'u' },
      100,
    );
    createCurationFlag(
      db,
      { targetKind: 'artist', targetId: 'new', reason: 'r', createdBy: 'u' },
      200,
    );
    expect(listOpenCurationFlags(db).map((f) => f.targetId)).toEqual(['old', 'new']);
    resolveCurationFlag(db, a.flag.id, 'kevin');
    expect(listOpenCurationFlags(db).map((f) => f.targetId)).toEqual(['new']);
  });

  it('clamps the limit into range', () => {
    for (let i = 0; i < 5; i++) flag(`a${i}`);
    expect(listOpenCurationFlags(db, 2)).toHaveLength(2);
    // A nonsense limit must not return zero rows or throw.
    expect(listOpenCurationFlags(db, 0)).toHaveLength(1);
  });
});

describe('resolveCurationFlag', () => {
  it('is false for an unknown id and for one already resolved', () => {
    const f = flag('A');
    expect(resolveCurationFlag(db, 9999, 'kevin')).toBe(false);
    expect(resolveCurationFlag(db, f.flag.id, 'kevin')).toBe(true);
    expect(resolveCurationFlag(db, f.flag.id, 'someone-else')).toBe(false);
    const row = db
      .query<{ resolved_by: string }, [number]>(
        'SELECT resolved_by FROM curation_flags WHERE id = ?',
      )
      .get(f.flag.id);
    // The second call must not re-stamp who handled it.
    expect(row?.resolved_by).toBe('kevin');
  });
});

describe('isFlagTargetKind', () => {
  it('accepts the three kinds and nothing else', () => {
    expect(isFlagTargetKind('artist')).toBe(true);
    expect(isFlagTargetKind('album')).toBe(true);
    expect(isFlagTargetKind('song')).toBe(true);
    expect(isFlagTargetKind('playlist')).toBe(false);
    expect(isFlagTargetKind(undefined)).toBe(false);
  });
});
