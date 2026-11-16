/**
 * "Try another source" (#1674, docs/lyrics-options.md §1): the host gathers every
 * source's candidates, gates them on duration, folds duplicates, ranks them, and
 * the walk applies the one after the stored row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LyricsCandidate, LyricsResult } from '@nicotind/core';
import { applySchema } from '../db.js';
import { listLyricsCandidates, nextSongLyrics } from './lyrics-next.js';
import { getLyrics, getLyricsChoice, setLyrics, setLyricsOffset } from './lyrics-store.js';
import type { PluginRegistry } from './plugins/registry.js';

const SONG = 's1';
const DURATION = 200;
const lrc = (word: string) => `[00:01.00]${word}\n[00:05.00]more ${word}`;

function cand(
  key: string,
  over: Partial<LyricsCandidate> & { timed?: boolean; word?: string } = {},
): LyricsCandidate {
  const { timed = true, word = key, ...rest } = over;
  return {
    plain: `${word}\nmore ${word}`,
    synced: timed ? lrc(word) : null,
    source: 'lrclib',
    sourceTrackId: key,
    candidateKey: key,
    matchedDurationSec: DURATION,
    ...rest,
  };
}

type Source =
  { candidates: LyricsCandidate[] | 'throw' } | { single: LyricsResult | null | 'throw' };

function registry(...sources: Source[]): PluginRegistry {
  const plugins = sources.map((s) => ({
    lyrics:
      'candidates' in s
        ? {
            fetchLyrics: async (): Promise<LyricsResult | null> => null,
            fetchCandidates: async (): Promise<LyricsCandidate[]> => {
              if (s.candidates === 'throw') throw new Error('source down');
              return s.candidates;
            },
          }
        : {
            fetchLyrics: async (): Promise<LyricsResult | null> => {
              if (s.single === 'throw') throw new Error('source down');
              return s.single;
            },
          },
  }));
  return {
    hasCapability: () => true,
    getEnabledWithCapability: () => plugins,
  } as unknown as PluginRegistry;
}

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, duration, path,
       size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'album-1', 'Selva', 'La Portuaria', 'artist-1', ?,
       'La Portuaria/Huija/01 - Selva.flac', 1000, 1000, 'flac', 'audio/flac', '2024-01-01', 0)`,
    [SONG, DURATION],
  );
});
afterEach(() => db.close());

const query = { title: 'Selva', artist: 'La Portuaria', durationSec: DURATION };
const next = (plugins: PluginRegistry, confirmReplaceEdit = false) =>
  nextSongLyrics(db, { plugins }, SONG, { confirmReplaceEdit });

describe('listLyricsCandidates', () => {
  it('ranks timed before untimed, verified before unverified, then the smaller delta', async () => {
    const { candidates } = await listLyricsCandidates(
      registry({
        candidates: [
          cand('plain', { timed: false }),
          cand('unverified', { matchedDurationSec: undefined }),
          cand('far', { matchedDurationSec: DURATION + 4 }),
          cand('near', { matchedDurationSec: DURATION - 1 }),
        ],
      }),
      query,
    );
    expect(candidates.map((c) => c.candidateKey)).toEqual(['near', 'far', 'unverified', 'plain']);
    expect(candidates.map((c) => c.verified)).toEqual([true, true, false, true]);
    expect(candidates[1]!.durationDeltaSec).toBe(4);
  });

  it('drops a candidate beyond the duration tolerance even when a source returns it', async () => {
    const { candidates } = await listLyricsCandidates(
      registry({
        candidates: [cand('other-take', { matchedDurationSec: DURATION + 30 }), cand('ok')],
      }),
      query,
    );
    expect(candidates.map((c) => c.candidateKey)).toEqual(['ok']);
  });

  it('folds candidates with the same text into one and counts the copies', async () => {
    const { candidates } = await listLyricsCandidates(
      registry({
        candidates: [
          cand('a', { word: 'same' }),
          cand('b', { word: 'same', synced: `${lrc('same')}\r\n` }),
          cand('c', { word: 'same' }),
          cand('d', { word: 'different' }),
        ],
      }),
      query,
    );
    expect(candidates.map((c) => [c.candidateKey, c.duplicates])).toEqual([
      ['a', 2],
      ['d', 0],
    ]);
  });

  it('keeps the registry order between sources and wraps a single-answer source as one candidate', async () => {
    const { candidates } = await listLyricsCandidates(
      registry(
        { candidates: [cand('first', { source: 'one' })] },
        { single: { plain: 'x', synced: lrc('x'), source: 'two', matchedDurationSec: DURATION } },
      ),
      query,
    );
    expect(candidates.map((c) => c.source)).toEqual(['one', 'two']);
    expect(candidates[1]!.candidateKey).toMatch(/^text:/);
  });

  it('reports a source that threw and still returns the others', async () => {
    const r = await listLyricsCandidates(
      registry({ candidates: 'throw' }, { candidates: [cand('ok')] }),
      query,
    );
    expect(r.errored).toBe(true);
    expect(r.candidates).toHaveLength(1);
  });
});

describe('nextSongLyrics', () => {
  it('applies the first candidate to a song with no row, and records where it sits', async () => {
    const r = await next(registry({ candidates: [cand('a'), cand('b')] }));
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.applied).toMatchObject({ candidateKey: 'a', index: 1, total: 2, timed: true });
    expect(r.lyrics.walk).toEqual({ index: 1, total: 2 });
    expect(getLyrics(db, SONG)!.walk).toEqual({ index: 1, total: 2 });
    expect(getLyricsChoice(db, SONG)).toMatchObject({ via: 'next', candidateKey: 'a', index: 1 });
  });

  it('visits candidates in rank order and wraps', async () => {
    const plugins = registry({ candidates: [cand('a'), cand('b'), cand('c')] });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await next(plugins);
      if (r.kind === 'applied') seen.push(`${r.applied.candidateKey}:${r.applied.index}`);
    }
    expect(seen).toEqual(['a:1', 'b:2', 'c:3', 'a:1']);
    expect(getLyricsChoice(db, SONG)!.passedOver).toEqual([]);
  });

  it('records the better-ranked candidates it passed', async () => {
    const plugins = registry({ candidates: [cand('a'), cand('b')] });
    await next(plugins);
    await next(plugins);
    expect(getLyricsChoice(db, SONG)!.passedOver).toEqual([
      { source: 'lrclib', candidateKey: 'a', timed: true, durationDeltaSec: 0 },
    ]);
  });

  it('never re-applies the stored candidate while another exists, matching a pre-walk row by text', async () => {
    setLyrics(db, SONG, { plain: 'a', synced: lrc('a'), source: 'lrclib', customized: false });
    const r = await next(registry({ candidates: [cand('a'), cand('b')] }));
    expect(r.kind === 'applied' && r.applied.candidateKey).toBe('b');
  });

  it('answers only-one and leaves the row unchanged when the stored words are the only candidate', async () => {
    const plugins = registry({ candidates: [cand('a')] });
    await next(plugins);
    const before = getLyrics(db, SONG)!;
    const r = await next(plugins);
    expect(r.kind).toBe('only-one');
    expect(getLyrics(db, SONG)!.updatedAt).toBe(before.updatedAt);
  });

  it('answers no-match and leaves the row unchanged when no source has anything', async () => {
    setLyrics(db, SONG, { plain: 'kept', synced: null, source: 'file-tag', customized: false });
    const r = await next(registry({ candidates: [] }));
    expect(r.kind).toBe('no-match');
    expect(getLyrics(db, SONG)!.plain).toBe('kept');
  });

  it('answers source-error when the only source threw', async () => {
    expect((await next(registry({ candidates: 'throw' }))).kind).toBe('source-error');
  });

  it('walks timed candidates only when the stored row is timed (#1672)', async () => {
    const plugins = registry({
      candidates: [cand('t1'), cand('p1', { timed: false }), cand('t2')],
    });
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await next(plugins);
      if (r.kind === 'applied') seen.push(`${r.applied.candidateKey} of ${r.applied.total}`);
    }
    expect(seen).toEqual(['t1 of 3', 't2 of 2', 't1 of 2']);
  });

  it('upgrades a plain row to the best timed candidate', async () => {
    setLyrics(db, SONG, {
      plain: 'p1\nmore p1',
      synced: null,
      source: 'lrclib',
      customized: false,
    });
    const r = await next(registry({ candidates: [cand('p1', { timed: false }), cand('t1')] }));
    expect(r.kind === 'applied' && r.applied).toMatchObject({ candidateKey: 't1', timed: true });
  });

  it('lets an untimed candidate replace a timed row that is another take (#1205)', async () => {
    setLyrics(db, SONG, {
      plain: 'wrong',
      synced: lrc('wrong'),
      source: 'lrclib',
      customized: false,
      matchedDurationSec: DURATION + 60,
    });
    const r = await next(registry({ candidates: [cand('p1', { timed: false })] }));
    expect(r.kind === 'applied' && r.applied.timed).toBe(false);
    expect(getLyricsChoice(db, SONG)!.replacedOtherTake).toBe(true);
  });

  it('refuses a customized row without confirmReplaceEdit, and restarts at the first with it (#1786)', async () => {
    setLyrics(db, SONG, { plain: 'my edit', synced: null, source: 'user', customized: true });
    const plugins = registry({ candidates: [cand('a'), cand('b')] });

    const refused = await next(plugins);
    expect(refused.kind).toBe('customized');
    expect(getLyrics(db, SONG)!.plain).toBe('my edit');

    const confirmed = await next(plugins, true);
    expect(confirmed.kind === 'applied' && confirmed.applied.candidateKey).toBe('a');
    expect(getLyrics(db, SONG)!.customized).toBe(false);
  });

  it('keeps the sync offset when the applied text is the stored text, and resets it otherwise (#1785)', async () => {
    const plugins = registry({ candidates: [cand('a'), cand('b', { word: 'a' }), cand('c')] });
    // a and b fold into one, so the walk is [a, c].
    await next(plugins);
    setLyricsOffset(db, SONG, -750);
    const toC = await next(plugins);
    expect(toC.kind === 'applied' && toC.lyrics.offsetMs).toBe(0);

    // A curator edited the words but kept the timing: the LRC is still candidate a's.
    setLyrics(db, SONG, { plain: 'edited', synced: lrc('a'), source: 'user', customized: true });
    setLyricsOffset(db, SONG, 500);
    const toA = await next(plugins, true);
    expect(toA.kind === 'applied' && toA.applied.candidateKey).toBe('a');
    expect(getLyrics(db, SONG)!.offsetMs).toBe(500);
  });

  it('answers song-not-found and no-source', async () => {
    expect((await nextSongLyrics(db, { plugins: registry() }, 'nope')).kind).toBe('song-not-found');
    const none = { hasCapability: () => false } as unknown as PluginRegistry;
    expect((await nextSongLyrics(db, { plugins: none }, SONG)).kind).toBe('no-source');
  });
});
