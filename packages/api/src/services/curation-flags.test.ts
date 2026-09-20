import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  createCurationFlag,
  listOpenCurationFlags,
  countOpenCurationFlags,
  resolveCurationFlag,
  snoozeCurationFlag,
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

  it('a system actor does not spend a human reason to stay idempotent', () => {
    // The loss this prevents: a curator writes why a song is ambiguous, then an
    // automated tag-write failure refreshes the same open flag and the judgement
    // is gone. Still one row — idempotency must not cost the human's wording.
    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's1',
      reason: 'title is a live medley; needs the setlist to split',
      createdBy: 'kevin',
    });
    const res = createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's1',
      reason: 'Tag write did not persist: title',
      createdBy: 'system:tag-write',
    });
    expect(res.created).toBe(false);
    expect(countOpenCurationFlags(db)).toBe(1);
    expect(listOpenCurationFlags(db)[0]!.reason).toBe(
      'title is a live medley; needs the setlist to split',
    );
    expect(res.flag.reason).toBe('title is a live medley; needs the setlist to split');
  });

  it('a system actor still refreshes its own earlier reason', () => {
    const sys = (reason: string) =>
      createCurationFlag(db, {
        targetKind: 'song',
        targetId: 's2',
        reason,
        createdBy: 'system:tag-write',
      });
    sys('Tag write did not persist: title');
    sys('Tag write did not persist: title, artist');
    expect(countOpenCurationFlags(db)).toBe(1);
    expect(listOpenCurationFlags(db)[0]!.reason).toBe('Tag write did not persist: title, artist');
  });

  it('a human still overwrites a system reason', () => {
    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's3',
      reason: 'Tag write did not persist: title',
      createdBy: 'system:tag-write',
    });
    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's3',
      reason: 'the file is fine, the tracklist is wrong',
      createdBy: 'kevin',
    });
    expect(listOpenCurationFlags(db)[0]!.reason).toBe('the file is fine, the tracklist is wrong');
  });
});

describe('typed case fields', () => {
  const typed = (question: string, optionsJson = '[{"id":"a"}]') =>
    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's1',
      reason: 'long research',
      createdBy: 'agent:t1',
      caseKind: 'duplicate',
      question,
      optionsJson,
    });

  it('stores and lists the question beside the options', () => {
    typed('Same recording?');
    const [f] = listOpenCurationFlags(db);
    expect(f!.question).toBe('Same recording?');
    expect(f!.caseKind).toBe('duplicate');
    expect(f!.optionsJson).toBe('[{"id":"a"}]');
    expect(f!.snoozedUntil).toBeNull();
  });

  it('a re-flag that supplies the case replaces question, kind and options together', () => {
    typed('Same recording?');
    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's1',
      reason: 'new research',
      createdBy: 'agent:t1',
      question: 'Different take?',
    });
    const [f] = listOpenCurationFlags(db);
    expect(f!.question).toBe('Different take?');
    expect(f!.caseKind).toBeNull();
    expect(f!.optionsJson).toBeNull();
  });

  it('a prose re-flag keeps the existing case', () => {
    typed('Same recording?');
    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's1',
      reason: 'more notes',
      createdBy: 'agent:t1',
    });
    const [f] = listOpenCurationFlags(db);
    expect(f!.question).toBe('Same recording?');
    expect(f!.optionsJson).toBe('[{"id":"a"}]');
    expect(f!.reason).toBe('more notes');
  });
});

describe('snoozeCurationFlag', () => {
  it('hides a deferred flag from the round until the deadline, not from the plain list', () => {
    const { flag: f } = flag('A');
    expect(snoozeCurationFlag(db, f.id, 1_000)).toBe(true);
    expect(listOpenCurationFlags(db).map((x) => x.snoozedUntil)).toEqual([1_000]);
    expect(listOpenCurationFlags(db, 100, { excludeSnoozedAt: 999 })).toHaveLength(0);
    expect(listOpenCurationFlags(db, 100, { excludeSnoozedAt: 1_000 })).toHaveLength(1);
    expect(countOpenCurationFlags(db)).toBe(1);
  });

  it('refuses an unknown or resolved id', () => {
    const { flag: f } = flag('A');
    resolveCurationFlag(db, f.id, 'kevin');
    expect(snoozeCurationFlag(db, f.id, 1_000)).toBe(false);
    expect(snoozeCurationFlag(db, 9999, 1_000)).toBe(false);
  });

  it('a re-flag lifts the deferral: new information is worth a fresh look', () => {
    const { flag: f } = flag('A');
    snoozeCurationFlag(db, f.id, Number.MAX_SAFE_INTEGER);
    flag('A', 'sharper');
    expect(listOpenCurationFlags(db, 100, { excludeSnoozedAt: Date.now() })).toHaveLength(1);
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

describe('typed case columns', () => {
  it('round-trips a case kind and options blob', () => {
    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's1',
      reason: 'which artist?',
      createdBy: 'agent:t1',
      caseKind: 'identity',
      optionsJson: '[{"id":"a"}]',
    });
    const [flag] = listOpenCurationFlags(db);
    expect(flag!.caseKind).toBe('identity');
    expect(flag!.optionsJson).toBe('[{"id":"a"}]');
  });

  it('leaves both null for a prose-only flag', () => {
    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's2',
      reason: 'ambiguous',
      createdBy: 'kevin',
    });
    const flag = listOpenCurationFlags(db).find((f) => f.targetId === 's2');
    expect(flag!.caseKind).toBeNull();
    expect(flag!.optionsJson).toBeNull();
  });

  it('re-flagging an open target with a new caseKind and no options clears the old options rather than pairing them', () => {
    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's3',
      reason: 'which artist?',
      createdBy: 'agent:t1',
      caseKind: 'identity',
      optionsJson: '[{"id":"a"}]',
    });

    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's3',
      reason: 'actually, placement',
      createdBy: 'agent:t2',
      caseKind: 'placement',
    });

    const flag = listOpenCurationFlags(db).find((f) => f.targetId === 's3');
    expect(flag!.caseKind).toBe('placement');
    expect(flag!.optionsJson).toBeNull();
  });

  it('re-flagging with neither caseKind nor options keeps the existing pair intact', () => {
    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's4',
      reason: 'which artist?',
      createdBy: 'agent:t1',
      caseKind: 'identity',
      optionsJson: '[{"id":"a"}]',
    });

    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 's4',
      reason: 'still unresolved',
      createdBy: 'agent:t2',
    });

    const flag = listOpenCurationFlags(db).find((f) => f.targetId === 's4');
    expect(flag!.caseKind).toBe('identity');
    expect(flag!.optionsJson).toBe('[{"id":"a"}]');
  });
});
