import { describe, it, expect } from 'vitest';
import {
  classifyTrackFailure,
  parseJobFailureSummary,
  summarizeFailures,
} from './download-failure.js';

describe('parseJobFailureSummary', () => {
  it('pulls one entry per failed track out of an addon summary', () => {
    const summary = [
      'Downloaded 2 of 4 tracks — the rest failed or were skipped.',
      'https://open.spotify.com/track/aaa - LookupError: No results found for song: Gustav Mahler',
      'https://open.spotify.com/track/bbb - JSONDecodeError: Expecting value: line 1 column 1 (char 0)',
    ].join('\n');

    expect(parseJobFailureSummary(summary)).toEqual([
      {
        url: 'https://open.spotify.com/track/aaa',
        reason: 'LookupError: No results found for song: Gustav Mahler',
      },
      {
        url: 'https://open.spotify.com/track/bbb',
        reason: 'JSONDecodeError: Expecting value: line 1 column 1 (char 0)',
      },
    ]);
  });

  // A whole-job crash is a single sentence with no per-track detail. Returning
  // [] keeps the card on its existing single-line rendering.
  it('returns nothing for a hard failure carrying no per-track lines', () => {
    expect(
      parseJobFailureSummary('JSONDecodeError: Expecting value: line 1 column 1 (char 0)'),
    ).toEqual([]);
    expect(parseJobFailureSummary('')).toEqual([]);
  });
});

describe('classifyTrackFailure', () => {
  it('treats a throttled or refused fetch as transient — retrying is likely to work', () => {
    expect(classifyTrackFailure('JSONDecodeError: Expecting value: line 1 column 1 (char 0)')).toBe(
      'transient',
    );
    expect(
      classifyTrackFailure(
        'AudioProviderError: YT-DLP download error - https://youtu.be/OyTgbDocK-k',
      ),
    ).toBe('transient');
  });

  /**
   * Under throttling YouTube Music search returns nothing, so this line means
   * either "the source lacks it" or "the source was rate-limited" and there is
   * no way to tell which. Reported as its own bucket rather than guessed —
   * #601 proved tracks that fail this way (Katy Perry, Lizzo) do exist there.
   */
  it('reports a no-results miss as unknown rather than guessing either way', () => {
    expect(classifyTrackFailure('LookupError: No results found for song: Gustav Mahler')).toBe(
      'unknown',
    );
    expect(classifyTrackFailure('no usable results')).toBe('unknown');
  });

  it('falls back to unknown for a reason it does not recognize', () => {
    expect(classifyTrackFailure('KeyError: 42')).toBe('unknown');
    expect(classifyTrackFailure('')).toBe('unknown');
  });
});

describe('summarizeFailures', () => {
  it('groups by class, commonest first, keeping the commonest reason as the example', () => {
    const failures = [
      { url: 'u1', reason: 'LookupError: No results found for song: A' },
      { url: 'u2', reason: 'JSONDecodeError: Expecting value: line 1 column 1 (char 0)' },
      { url: 'u3', reason: 'JSONDecodeError: Expecting value: line 1 column 1 (char 0)' },
      { url: 'u4', reason: 'AudioProviderError: YT-DLP download error - https://youtu.be/x' },
    ];

    expect(summarizeFailures(failures)).toEqual([
      {
        class: 'transient',
        count: 3,
        example: 'JSONDecodeError: Expecting value: line 1 column 1 (char 0)',
      },
      { class: 'unknown', count: 1, example: 'LookupError: No results found for song: A' },
    ]);
  });

  it('has nothing to summarize when no track failed', () => {
    expect(summarizeFailures([])).toEqual([]);
  });
});
