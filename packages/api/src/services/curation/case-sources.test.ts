import { describe, it, expect } from 'bun:test';
import { CASE_TEXT_LIMITS } from '@nicotind/core';
import {
  FALLBACK_OPTION_ID,
  flagHasActionableOptions,
  flagToCase,
  parseTypedCaseInput,
  validateCaseOptions,
} from './case-sources.js';
import type { CurationFlag } from '../curation-flags.js';

const target = { kind: 'song' as const, id: 's1', title: 'Chase the Cool', subtitle: 'Rocky' };

const flag = (over: Partial<CurationFlag> = {}): CurationFlag => ({
  id: 19,
  targetKind: 'song',
  targetId: 's1',
  reason: 'which Rocky is this? Long research follows.',
  createdBy: 'agent:t1',
  createdAt: 1,
  source: 'curator',
  reportCount: 1,
  caseKind: null,
  optionsJson: null,
  question: null,
  snoozedUntil: null,
  ...over,
});

const retag = {
  id: 'move',
  label: 'Move to Pharrell',
  rationale: 'The recording is Pharrell ft. Gwen',
  effect: { type: 'song-metadata' as const, songId: 's1', fields: { artist: 'Pharrell' } },
};

const typed = (options: unknown[], over: Partial<CurationFlag> = {}) =>
  flag({
    caseKind: 'placement',
    question: 'Whose recording is this?',
    optionsJson: JSON.stringify(options),
    ...over,
  });

describe('flagToCase', () => {
  // The contract with the human: a card is a question plus closed options that
  // each do something. A prose flag has nothing to press, so it is not a card.
  it('returns null for a prose-only flag', () => {
    expect(flagToCase(flag(), target)).toBeNull();
    expect(flagHasActionableOptions(flag())).toBe(false);
  });

  it('returns null for a typed flag whose only option changes nothing', () => {
    const c = flagToCase(
      typed([{ id: 'keep', label: 'Keep', rationale: '', effect: { type: 'resolve-only' } }]),
      target,
    );
    expect(c).toBeNull();
  });

  it('serves the question, folds the reason into details, and appends Leave as is', () => {
    const c = flagToCase(typed([retag]), target)!;
    expect(c.id).toBe('flag:19');
    expect(c.kind).toBe('placement');
    expect(c.question).toBe('Whose recording is this?');
    expect(c.details).toBe('which Rocky is this? Long research follows.');
    expect(c.options.map((o) => o.id)).toEqual(['move', FALLBACK_OPTION_ID]);
    expect(c.options[1]!.effect).toEqual({ type: 'resolve-only' });
    expect(flagHasActionableOptions(typed([retag]))).toBe(true);
  });

  it('does not append a second "change nothing" when the agent labelled its own', () => {
    const c = flagToCase(
      typed([
        retag,
        {
          id: 'both',
          label: 'Keep both',
          rationale: 'different takes',
          effect: { type: 'resolve-only' },
        },
      ]),
      target,
    )!;
    expect(c.options.map((o) => o.id)).toEqual(['move', 'both']);
  });

  it('serves a pre-question typed row with its reason as the question, and no details', () => {
    const c = flagToCase(typed([retag], { question: null }), target)!;
    expect(c.question).toBe('which Rocky is this? Long research follows.');
    expect(c.details).toBeNull();
  });

  it('marks a song-delete destructive whatever the agent wrote', () => {
    const c = flagToCase(
      typed([
        {
          id: 'del',
          label: 'Delete this copy',
          rationale: '',
          effect: { type: 'song-delete', songId: 's1' },
        },
      ]),
      target,
    )!;
    expect(c.options[0]!.destructive).toBe(true);
  });

  it('falls back to null when options_json is malformed', () => {
    expect(flagToCase(typed([], { optionsJson: '{not json' }), target)).toBeNull();
  });

  it('drops an option whose effect type is unknown rather than trusting it', () => {
    const c = flagToCase(
      typed([retag, { id: 'x', label: 'x', rationale: 'x', effect: { type: 'rm -rf' } }]),
      target,
    )!;
    expect(c.options.map((o) => o.id)).toEqual(['move', FALLBACK_OPTION_ID]);
  });

  it('always reports a flag-sourced case at full confidence', () => {
    const c = flagToCase(typed([retag]), target)!;
    expect(c.confidence).toBe(1);
    expect(c.source).toBe('flag');
  });

  it('carries the reporter count as evidence when listeners corroborated', () => {
    const c = flagToCase(typed([retag], { source: 'listener', reportCount: 12 }), target)!;
    expect(c.evidence.some((e) => e.value.includes('12'))).toBe(true);
  });

  // A `fields` value that is not a string reaches `normalizeTagValue`, whose
  // `.trim()` throws — an uncaught 500 with the flag left open. Dropped instead.
  const withFields = (fields: unknown) =>
    flagToCase(
      typed([
        {
          id: 'opt',
          label: 'Option',
          rationale: 'r',
          effect: { type: 'song-metadata', songId: 's1', fields },
        },
      ]),
      target,
    );

  it('drops song-metadata whose field value is not a string', () => {
    expect(withFields({ artist: 123 })).toBeNull();
  });

  it('drops song-metadata carrying an unknown field key', () => {
    expect(withFields({ artist: 'Pharrell', year: '1999' })).toBeNull();
  });

  it('drops song-metadata with an empty fields bag', () => {
    expect(withFields({})).toBeNull();
    expect(withFields([])).toBeNull();
  });

  it('keeps a valid multi-field song-metadata effect', () => {
    const c = withFields({ title: 'T', artist: 'A', album: 'Al', albumArtist: 'AA' })!;
    expect(c.options[0]!.effect).toEqual({
      type: 'song-metadata',
      songId: 's1',
      fields: { title: 'T', artist: 'A', album: 'Al', albumArtist: 'AA' },
    });
  });

  it('drops artist-merge missing rawName and song-delete missing songId', () => {
    expect(
      flagToCase(
        typed([{ id: 'm', label: 'm', effect: { type: 'artist-merge', mergeInto: 'a1' } }]),
        target,
      ),
    ).toBeNull();
    expect(
      flagToCase(typed([{ id: 'd', label: 'd', effect: { type: 'song-delete' } }]), target),
    ).toBeNull();
  });
});

describe('validateCaseOptions', () => {
  const bad = (raw: unknown) => {
    const r = validateCaseOptions(raw);
    return r.ok ? null : r.error;
  };

  it('accepts a valid list and normalises the stored shape', () => {
    const r = validateCaseOptions([{ ...retag, rationale: undefined, extra: 'ignored' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options).toEqual([{ ...retag, rationale: '' }]);
  });

  it('refuses a non-array, an empty list, and a list with nothing to apply', () => {
    expect(bad({ id: 'x' })).toContain('array');
    expect(bad([])).toContain('at least one');
    expect(bad([{ id: 'k', label: 'Keep', effect: { type: 'resolve-only' } }])).toContain(
      'changes data',
    );
  });

  it('names the option and the problem', () => {
    expect(bad([{ label: 'x', effect: retag.effect }])).toBe('options[0] needs an id');
    expect(bad([retag, { id: 'y', label: '', effect: retag.effect }])).toBe(
      'options[1] needs a label',
    );
    expect(bad([{ id: 'x', label: 'x', effect: { type: 'rm -rf' } }])).toContain(
      'unknown effect type "rm -rf"',
    );
    expect(
      bad([
        {
          id: 'x',
          label: 'x',
          effect: { type: 'song-metadata', songId: 's1', fields: { year: '1' } },
        },
      ]),
    ).toContain('fields.year');
  });

  it('refuses the reserved fallback id and duplicate ids', () => {
    expect(bad([{ ...retag, id: FALLBACK_OPTION_ID }])).toContain('reserved');
    expect(bad([retag, retag])).toContain('duplicates id move');
  });

  it('caps the label and the rationale at the shared limits', () => {
    expect(bad([{ ...retag, label: 'x'.repeat(CASE_TEXT_LIMITS.label + 1) }])).toContain(
      `over ${CASE_TEXT_LIMITS.label}`,
    );
    expect(bad([{ ...retag, rationale: 'x'.repeat(CASE_TEXT_LIMITS.rationale + 1) }])).toContain(
      `over ${CASE_TEXT_LIMITS.rationale}`,
    );
  });

  it('forces destructive on a delete and keeps an explicit destructive flag', () => {
    const r = validateCaseOptions([
      { id: 'd', label: 'Delete', effect: { type: 'song-delete', songId: 's1' } },
      { ...retag, destructive: true },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.map((o) => o.destructive)).toEqual([true, true]);
  });
});

describe('parseTypedCaseInput', () => {
  it('passes a prose flag through untouched', () => {
    expect(parseTypedCaseInput({})).toEqual({ ok: true });
  });

  it('requires question and options together', () => {
    expect(parseTypedCaseInput({ options: [retag] })).toMatchObject({ ok: false });
    expect(parseTypedCaseInput({ question: 'Which?' })).toMatchObject({ ok: false });
  });

  it('trims and caps the question', () => {
    const ok = parseTypedCaseInput({ question: '  Which?  ', options: [retag] });
    expect(ok).toMatchObject({ ok: true, question: 'Which?' });
    expect(
      parseTypedCaseInput({
        question: 'x'.repeat(CASE_TEXT_LIMITS.question + 1),
        options: [retag],
      }),
    ).toMatchObject({ ok: false });
    expect(parseTypedCaseInput({ question: '   ', options: [retag] })).toMatchObject({ ok: false });
  });

  it('stores the validated options, not the caller object', () => {
    const r = parseTypedCaseInput({
      caseKind: 'duplicate',
      question: 'Same recording?',
      options: [{ ...retag, extra: 'dropped' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.caseKind).toBe('duplicate');
      expect(JSON.parse(r.optionsJson!)).toEqual([retag]);
    }
  });

  it('refuses an unknown caseKind', () => {
    expect(parseTypedCaseInput({ caseKind: 'Placement' })).toMatchObject({ ok: false });
  });
});
