/**
 * `fetchSongLyrics` never replaces stored timed lyrics with untimed ones (#1672).
 * LRCLIB answers the same song with or without timings from one call to the next;
 * a plain-only answer used to overwrite the stored LRC and the user's sync offset
 * with NULL through `setLyrics`'s full-column upsert.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LyricsResult } from '@nicotind/core';
import { applySchema } from '../db.js';
import { fetchSongLyrics } from './lyrics-fetch.js';
import { getLyrics, setLyrics, setLyricsOffset } from './lyrics-store.js';
import type { PluginRegistry } from './plugins/registry.js';

const SONG = 's1';
const LRC = '[00:01.00]timed words\n[00:05.00]more';
const timed: LyricsResult = { plain: 'timed words\nmore', synced: LRC, source: 'lrclib' };
const plainOnly: LyricsResult = { plain: 'untimed words', synced: null, source: 'lrclib' };

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, duration, path,
       size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'album-1', 'Selva', 'La Portuaria', 'artist-1', 200,
       'La Portuaria/Huija/01 - Selva.flac', 1000, 1000, 'flac', 'audio/flac', '2024-01-01', 0)`,
    [SONG],
  );
});
afterEach(() => db.close());

/** One lyrics source per entry in `sources`; each answers from its own script in turn. */
function registry(...sources: Array<Array<LyricsResult | null | 'throw'>>): PluginRegistry {
  const plugins = sources.map((script) => {
    let i = 0;
    return {
      lyrics: {
        fetchLyrics: async () => {
          const next = script[Math.min(i++, script.length - 1)];
          if (next === 'throw') throw new Error('source down');
          return next;
        },
      },
    };
  });
  return {
    hasCapability: () => true,
    getEnabledWithCapability: () => plugins,
  } as unknown as PluginRegistry;
}

const refetch = (plugins: PluginRegistry) =>
  fetchSongLyrics(db, { plugins }, SONG, { force: true });

function storeTimed(offsetMs = 0): void {
  setLyrics(db, SONG, { plain: timed.plain, synced: LRC, source: 'lrclib', customized: false });
  if (offsetMs) setLyricsOffset(db, SONG, offsetMs);
}

describe('fetchSongLyrics never downgrades timed → untimed (#1672)', () => {
  it('a forced re-fetch that finds only untimed lyrics keeps the stored timed row and its offset', async () => {
    storeTimed(-750);
    const before = getLyrics(db, SONG)!;

    const r = await refetch(registry([plainOnly]));

    expect(r.kind).toBe('kept-timed');
    const after = getLyrics(db, SONG)!;
    expect(after.synced).toBe(LRC);
    expect(after.plain).toBe(timed.plain);
    expect(after.offsetMs).toBe(-750);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('asks the next source for a timed take before keeping the stored row', async () => {
    storeTimed();
    const newer = { ...timed, synced: '[00:02.00]a newer timed take', source: 'other' };

    const r = await refetch(registry([plainOnly], [newer]));

    expect(r.kind).toBe('fetched');
    expect(getLyrics(db, SONG)!.synced).toBe('[00:02.00]a newer timed take');
  });

  it('a timed answer still replaces a stored timed row', async () => {
    storeTimed();
    const r = await refetch(registry([{ ...timed, synced: '[00:03.00]replacement' }]));
    expect(r.kind).toBe('fetched');
    expect(getLyrics(db, SONG)!.synced).toBe('[00:03.00]replacement');
  });

  it('a plain answer may replace a plain row', async () => {
    setLyrics(db, SONG, { plain: 'old words', synced: null, source: 'lrclib', customized: false });
    const r = await refetch(registry([plainOnly]));
    expect(r.kind).toBe('fetched');
    expect(getLyrics(db, SONG)!.plain).toBe('untimed words');
  });

  it('a timed answer upgrades a plain row', async () => {
    setLyrics(db, SONG, { plain: 'old words', synced: null, source: 'lrclib', customized: false });
    await refetch(registry([timed]));
    expect(getLyrics(db, SONG)!.synced).toBe(LRC);
  });

  it('a source error after an untimed answer still keeps the timed row', async () => {
    storeTimed();
    const r = await refetch(registry([plainOnly], ['throw']));
    expect(r.kind).toBe('kept-timed');
    expect(getLyrics(db, SONG)!.synced).toBe(LRC);
  });

  it('a source that alternates timed/untimed answers never leaves the song untimed', async () => {
    const alternating = registry([timed, plainOnly, plainOnly, timed, plainOnly, timed, plainOnly]);
    for (let press = 0; press < 7; press++) {
      await refetch(alternating);
      expect(getLyrics(db, SONG)!.synced, `after press ${press + 1}`).toBe(LRC);
    }
  });

  it('a stored timed row matched to ANOTHER take may be replaced by untimed right words (#1205)', async () => {
    // Song is 200 s; the stored LRC came from a 140 s take — wrong words.
    setLyrics(db, SONG, {
      plain: 'wrong words',
      synced: '[00:01.00]wrong words',
      source: 'lrclib',
      customized: false,
      matchedDurationSec: 140,
    });
    const r = await refetch(registry([{ ...plainOnly, matchedDurationSec: 201 }]));
    expect(r.kind).toBe('fetched');
    expect(getLyrics(db, SONG)).toMatchObject({ plain: 'untimed words', synced: null });
  });

  it('a stored timed row within tolerance (same recording) is still protected', async () => {
    setLyrics(db, SONG, {
      plain: timed.plain,
      synced: LRC,
      source: 'lrclib',
      customized: false,
      matchedDurationSec: 203,
    });
    const r = await refetch(registry([plainOnly]));
    expect(r.kind).toBe('kept-timed');
    expect(getLyrics(db, SONG)!.synced).toBe(LRC);
  });

  it('a stored timed row with NO recorded duration whose LRC outlasts the file is replaceable', async () => {
    // Song is 200 s; the stored LRC's last line is at 4:20 — another take (#1205).
    setLyrics(db, SONG, {
      plain: 'wrong',
      synced: '[00:01.00]wrong\n[04:20.00]still wrong',
      source: 'lrclib',
      customized: false,
    });
    const r = await refetch(registry([plainOnly]));
    expect(r.kind).toBe('fetched');
    expect(getLyrics(db, SONG)).toMatchObject({ plain: 'untimed words', synced: null });
  });

  it('the same unverified row that ends inside the file stays protected', async () => {
    setLyrics(db, SONG, { plain: timed.plain, synced: LRC, source: 'lrclib', customized: false });
    expect(getLyrics(db, SONG)!.matchedDurationSec).toBeNull();
    const r = await refetch(registry([plainOnly]));
    expect(r.kind).toBe('kept-timed');
  });
});
