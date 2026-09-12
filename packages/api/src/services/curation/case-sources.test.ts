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
    expect(c.options).toHaveLength(2);
    expect(c.options[0]!.label).toBe('Move to Pharrell');
    expect(c.options[1]!.effect).toEqual({ type: 'resolve-only' });
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
    expect(c.options).toHaveLength(2);
    expect(c.options[0]!.label).toBe('Valid option');
    expect(c.options[0]!.effect).toEqual({
      type: 'song-metadata',
      songId: 's1',
      fields: { artist: 'Test' },
    });
    expect(c.options[1]!.effect).toEqual({ type: 'resolve-only' });
  });

  // A `fields` value that is not a string reaches `normalizeTagValue`, whose
  // `.trim()` throws — an uncaught 500 with the flag left open. Dropped instead.
  const withFields = (fields: unknown) =>
    flagToCase(
      flag({
        caseKind: 'identity',
        optionsJson: JSON.stringify([
          {
            id: 'opt',
            label: 'Option',
            rationale: 'r',
            effect: { type: 'song-metadata', songId: 's1', fields },
          },
        ]),
      }),
      target,
    );

  it('drops song-metadata whose field value is not a string', () => {
    const c = withFields({ artist: 123 });
    expect(c.options).toHaveLength(1);
    expect(c.options[0]!.effect).toEqual({ type: 'resolve-only' });
  });

  it('drops song-metadata carrying an unknown field key', () => {
    const c = withFields({ artist: 'Pharrell', year: '1999' });
    expect(c.options).toHaveLength(1);
    expect(c.options[0]!.effect).toEqual({ type: 'resolve-only' });
  });

  it('drops song-metadata with an empty fields bag', () => {
    expect(withFields({}).options).toHaveLength(1);
    expect(withFields([]).options).toHaveLength(1);
  });

  it('keeps a valid multi-field song-metadata effect', () => {
    const c = withFields({ title: 'T', artist: 'A', album: 'Al', albumArtist: 'AA' });
    expect(c.options).toHaveLength(2);
    expect(c.options[0]!.effect).toEqual({
      type: 'song-metadata',
      songId: 's1',
      fields: { title: 'T', artist: 'A', album: 'Al', albumArtist: 'AA' },
    });
  });

  it('includes resolve-only as last option on typed cases', () => {
    const c = flagToCase(
      flag({
        caseKind: 'placement',
        optionsJson: JSON.stringify([
          {
            id: 'opt1',
            label: 'First option',
            rationale: 'A typed option',
            effect: { type: 'song-metadata', songId: 's1', fields: { artist: 'Artist' } },
          },
          {
            id: 'opt2',
            label: 'Second option',
            rationale: 'Another typed option',
            effect: { type: 'artist-merge', mergeInto: 'a1', rawName: 'Raw Name' },
          },
        ]),
      }),
      target,
    );
    expect(c.options).toHaveLength(3);
    expect(c.options[0]!.id).toBe('opt1');
    expect(c.options[1]!.id).toBe('opt2');
    expect(c.options[2]!.effect).toEqual({ type: 'resolve-only' });
  });
});
