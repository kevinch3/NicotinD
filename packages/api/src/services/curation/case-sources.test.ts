import { describe, it, expect } from 'bun:test';
import { flagToCase } from './case-sources.js';
import type { CurationFlag } from '../curation-flags.js';

const target = { kind: 'song' as const, id: 's1', title: 'Chase the Cool', subtitle: 'Rocky' };

const flag = (over: Partial<CurationFlag> = {}): CurationFlag => ({
  id: 19,
  targetKind: 'song',
  targetId: 's1',
  reason: 'which Rocky is this?',
  createdBy: 'agent:t1',
  createdAt: 1,
  source: 'curator',
  reportCount: 1,
  caseKind: null,
  optionsJson: null,
  ...over,
});

describe('flagToCase', () => {
  it('gives a prose-only flag a single resolve-only option', () => {
    const c = flagToCase(flag(), target);
    expect(c.id).toBe('flag:19');
    expect(c.kind).toBe('identity');
    expect(c.question).toBe('which Rocky is this?');
    expect(c.options).toHaveLength(1);
    expect(c.options[0]!.effect).toEqual({ type: 'resolve-only' });
  });

  it('uses the typed kind and parsed options when present', () => {
    const c = flagToCase(
      flag({
        caseKind: 'placement',
        optionsJson: JSON.stringify([
          {
            id: 'move',
            label: 'Move to Pharrell',
            rationale: 'The recording is Pharrell ft. Gwen',
            effect: { type: 'song-metadata', songId: 's1', fields: { artist: 'Pharrell' } },
          },
        ]),
      }),
      target,
    );
    expect(c.kind).toBe('placement');
    expect(c.options).toHaveLength(1);
    expect(c.options[0]!.label).toBe('Move to Pharrell');
  });

  it('falls back to resolve-only when options_json is malformed', () => {
    const c = flagToCase(flag({ caseKind: 'identity', optionsJson: '{not json' }), target);
    expect(c.options).toHaveLength(1);
    expect(c.options[0]!.effect).toEqual({ type: 'resolve-only' });
  });

  it('drops an option whose effect type is unknown rather than trusting it', () => {
    const c = flagToCase(
      flag({
        caseKind: 'identity',
        optionsJson: JSON.stringify([
          { id: 'x', label: 'x', rationale: 'x', effect: { type: 'rm -rf' } },
        ]),
      }),
      target,
    );
    expect(c.options).toHaveLength(1);
    expect(c.options[0]!.effect).toEqual({ type: 'resolve-only' });
  });

  it('always reports a flag-sourced case at full confidence', () => {
    expect(flagToCase(flag(), target).confidence).toBe(1);
    expect(flagToCase(flag(), target).source).toBe('flag');
  });

  it('carries the reporter count as evidence when listeners corroborated', () => {
    const c = flagToCase(flag({ source: 'listener', reportCount: 12 }), target);
    expect(c.evidence.some((e) => e.value.includes('12'))).toBe(true);
  });

  it('drops song-metadata option with no songId', () => {
    const c = flagToCase(
      flag({
        caseKind: 'identity',
        optionsJson: JSON.stringify([
          {
            id: 'bad',
            label: 'Bad option',
            rationale: 'Missing songId',
            effect: { type: 'song-metadata', fields: { artist: 'Test' } },
          },
        ]),
      }),
      target,
    );
    expect(c.options).toHaveLength(1);
    expect(c.options[0]!.effect).toEqual({ type: 'resolve-only' });
  });

  it('drops song-metadata option with no fields', () => {
    const c = flagToCase(
      flag({
        caseKind: 'identity',
        optionsJson: JSON.stringify([
          {
            id: 'bad',
            label: 'Bad option',
            rationale: 'Missing fields',
            effect: { type: 'song-metadata', songId: 's1' },
          },
        ]),
      }),
      target,
    );
    expect(c.options).toHaveLength(1);
    expect(c.options[0]!.effect).toEqual({ type: 'resolve-only' });
  });

  it('drops artist-merge option missing rawName', () => {
    const c = flagToCase(
      flag({
        caseKind: 'identity',
        optionsJson: JSON.stringify([
          {
            id: 'bad',
            label: 'Bad option',
            rationale: 'Missing rawName',
            effect: { type: 'artist-merge', mergeInto: 'a1' },
          },
        ]),
      }),
      target,
    );
    expect(c.options).toHaveLength(1);
    expect(c.options[0]!.effect).toEqual({ type: 'resolve-only' });
  });

  it('keeps valid song-metadata option with all required fields', () => {
    const c = flagToCase(
      flag({
        caseKind: 'identity',
        optionsJson: JSON.stringify([
          {
            id: 'valid',
            label: 'Valid option',
            rationale: 'All fields present',
            effect: { type: 'song-metadata', songId: 's1', fields: { artist: 'Test' } },
          },
        ]),
      }),
      target,
    );
    expect(c.options).toHaveLength(1);
    expect(c.options[0]!.label).toBe('Valid option');
    expect(c.options[0]!.effect).toEqual({ type: 'song-metadata', songId: 's1', fields: { artist: 'Test' } });
  });
});
