import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { createCurationFlag, resolveCurationFlag } from './curation-flags.js';
import { AUTO_APPLY_GATE, agentPrecision, autoApplyRefusal } from './agent-precision.js';

let db: Database;
let n = 0;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  n = 0;
});

const GENRE_OPTIONS = JSON.stringify([
  {
    id: 'genre-1',
    label: 'Techno',
    effect: { type: 'song-genre', songIds: ['s'], genre: 'Techno' },
  },
  { id: 'genre-2', label: 'House', effect: { type: 'song-genre', songIds: ['s'], genre: 'House' } },
]);

/** One card from `tokenId`; returns its flag id. */
function card(tokenId: string, optionsJson: string | null = GENRE_OPTIONS): number {
  db.run(
    `INSERT INTO curation_flags (target_kind, target_id, reason, created_by, created_at, options_json)
     VALUES ('album', ?, 'r', ?, 1, ?)`,
    [`al-${++n}`, `agent:${tokenId}`, optionsJson],
  );
  return Number(db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id);
}
const pick = (id: number, optionId: string | null, by = 'owner') =>
  resolveCurationFlag(db, id, by, 10, optionId);
const judged = (tokenId: string, accepted: number, corrected: number, dismissed = 0) => {
  for (let i = 0; i < accepted; i++) pick(card(tokenId), 'genre-1');
  for (let i = 0; i < corrected; i++) pick(card(tokenId), 'genre-2');
  for (let i = 0; i < dismissed; i++) pick(card(tokenId), null);
};

describe('agentPrecision (#1516 P6)', () => {
  it('counts a first-option pick as accepted, another option as corrected, no pick as dismissed', () => {
    judged('t1', 3, 1, 1);
    card('t1');
    expect(agentPrecision(db)).toEqual([
      {
        tokenId: 't1',
        proposed: 6,
        open: 1,
        accepted: 3,
        corrected: 1,
        dismissed: 1,
        judged: 5,
        precision: 0.6,
        autoApply: false,
      },
    ]);
  });

  it('measures each token by itself, most proposals first', () => {
    judged('quiet', 1, 0);
    judged('busy', 2, 1);
    expect(agentPrecision(db).map((p) => [p.tokenId, p.judged])).toEqual([
      ['busy', 3],
      ['quiet', 1],
    ]);
    expect(agentPrecision(db, 'quiet')).toHaveLength(1);
  });

  it('ignores cards that do not propose a genre, and prose-only flags', () => {
    const keep = JSON.stringify([{ id: 'keep', label: 'Keep', effect: { type: 'resolve-only' } }]);
    pick(card('t1', keep), 'keep');
    pick(card('t1', null), null);
    pick(card('t1', 'not json'), null);
    expect(agentPrecision(db)).toEqual([]);
  });

  it('does not judge a proposal by a card an automated pass closed', () => {
    pick(card('t1'), null, 'run-revert:owner');
    pick(card('t1'), null, 'agent:t1');
    expect(agentPrecision(db)[0]).toMatchObject({ proposed: 2, judged: 0, precision: null });
  });

  it('has no precision with nothing judged', () => {
    card('t1');
    expect(agentPrecision(db)[0]).toMatchObject({ open: 1, judged: 0, precision: null });
  });
});

describe('the auto-apply gate (#1516 P6)', () => {
  it('refuses a token with no track record, naming the numbers and the alternative', () => {
    const refusal = autoApplyRefusal(db, 'new');
    expect(refusal).toContain('0 of 0 judged proposals');
    expect(refusal).toContain(`at least ${AUTO_APPLY_GATE.minJudged} judged and 90% accepted`);
    expect(refusal).toContain('flag_for_review');
  });

  it('refuses a high rate on too few cards, and enough cards at too low a rate', () => {
    judged('few', AUTO_APPLY_GATE.minJudged - 1, 0);
    expect(autoApplyRefusal(db, 'few')).not.toBeNull();
    judged('sloppy', 17, 3);
    expect(autoApplyRefusal(db, 'sloppy')).toContain('17 of 20');
  });

  it('counts a dismissed card against the token', () => {
    judged('t', 18, 0, 2);
    expect(agentPrecision(db, 't')[0]!.precision).toBe(0.9);
    expect(autoApplyRefusal(db, 't')).toBeNull();
    pick(card('t'), null);
    expect(autoApplyRefusal(db, 't')).not.toBeNull();
  });

  it('lets a token through once it has the cards and the rate, and takes it away again', () => {
    judged('good', 20, 0);
    expect(autoApplyRefusal(db, 'good')).toBeNull();
    expect(agentPrecision(db, 'good')[0]!.autoApply).toBe(true);
    judged('good', 0, 3);
    expect(autoApplyRefusal(db, 'good')).toContain('20 of 23');
  });
});

describe('resolveCurationFlag records the pick', () => {
  it('stores the option id with the resolution, and null without one', () => {
    const made = createCurationFlag(db, {
      targetKind: 'album',
      targetId: 'x',
      reason: 'r',
      createdBy: 'agent:t',
    });
    const id = 'flag' in made ? made.flag.id : card('t');
    expect(resolveCurationFlag(db, id, 'owner', 5, 'genre-2')).toBe(true);
    expect(
      db
        .query<{ resolved_option: string | null }, [number]>(
          'SELECT resolved_option FROM curation_flags WHERE id = ?',
        )
        .get(id),
    ).toEqual({ resolved_option: 'genre-2' });
    const plain = card('t');
    resolveCurationFlag(db, plain, 'owner');
    expect(
      db
        .query<{ resolved_option: string | null }, [number]>(
          'SELECT resolved_option FROM curation_flags WHERE id = ?',
        )
        .get(plain),
    ).toEqual({ resolved_option: null });
  });
});
