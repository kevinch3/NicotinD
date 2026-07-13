import { describe, expect, it } from 'bun:test';
import {
  splitGenres,
  buildKnownFromRaw,
  emptyGenreContext,
  type GenreContext,
} from './genre-split.js';

function ctx(p?: Partial<GenreContext>): GenreContext {
  return { ...emptyGenreContext(), ...p };
}

const known = (...names: string[]): Map<string, string> =>
  new Map(names.map((n) => [n.toLowerCase(), n]));

describe('splitGenres', () => {
  it('returns [] for undefined/empty input', () => {
    expect(splitGenres(undefined, ctx())).toEqual([]);
    expect(splitGenres('', ctx())).toEqual([]);
    expect(splitGenres('   ', ctx())).toEqual([]);
    expect(splitGenres([], ctx())).toEqual([]);
  });

  it('keeps a plain single genre whole', () => {
    expect(splitGenres('Deep House', ctx())).toEqual(['Deep House']);
  });

  it('splits on ";", "," and "|" and trims/collapses whitespace', () => {
    expect(splitGenres('Latin Rock;Latin Music', ctx())).toEqual(['Latin Rock', 'Latin Music']);
    expect(splitGenres('Europop,  Italo   Dance', ctx())).toEqual(['Europop', 'Italo Dance']);
    expect(splitGenres('House|Techno', ctx())).toEqual(['House', 'Techno']);
  });

  it('accepts multi-frame array input and merges all frames', () => {
    expect(splitGenres(['Rock', 'Pop; Dance'], ctx())).toEqual(['Rock', 'Pop', 'Dance']);
  });

  it('de-dupes case-insensitively, preserving first-seen order', () => {
    expect(splitGenres('Pop;pop;POP;Rock', ctx())).toEqual(['Pop', 'Rock']);
  });

  it('never splits on "&"', () => {
    expect(splitGenres('Drum & Bass', ctx())).toEqual(['Drum & Bass']);
    expect(splitGenres('Contemporary R&B', ctx())).toEqual(['Contemporary R&B']);
    expect(
      splitGenres('Melodic House & Techno', ctx({ known: known('House', 'Techno') })),
    ).toEqual(['Melodic House & Techno']);
  });

  it('splits on "/" only when every side is a known genre', () => {
    const c = ctx({ known: known('Nu Disco', 'Disco', 'Pop', 'Rock') });
    expect(splitGenres('Nu Disco / Disco', c)).toEqual(['Nu Disco', 'Disco']);
    expect(splitGenres('Pop/Rock', c)).toEqual(['Pop', 'Rock']);
    // "Vinyl" is not a genre → kept whole for the alias table to handle.
    expect(splitGenres('Deep House / Vinyl', c)).toEqual(['Deep House / Vinyl']);
  });

  it('does NOT split concatenations like "BritPop" without an alias', () => {
    expect(splitGenres('BritPop', ctx({ known: known('Pop') }))).toEqual(['BritPop']);
  });

  it('expands a one-to-many alias and re-splits the canonical list', () => {
    const c = ctx({ aliases: new Map([['rockpunk', 'Rock;Punk']]) });
    expect(splitGenres('RockPunk', c)).toEqual(['Rock', 'Punk']);
  });

  it('drops junk via an empty-canonical alias', () => {
    const c = ctx({ aliases: new Map([['other', '']]) });
    expect(splitGenres('Other', c)).toEqual([]);
    expect(splitGenres('Rock;Other', c)).toEqual(['Rock']);
  });

  it('applies aliases to parts produced by splitting', () => {
    const c = ctx({ aliases: new Map([['deep-house', 'Deep House']]) });
    expect(splitGenres('deep-house; Techno', c)).toEqual(['Deep House', 'Techno']);
  });

  it('normalizes display casing to the known form', () => {
    const c = ctx({ known: known('Deep House') });
    expect(splitGenres('deep house', c)).toEqual(['Deep House']);
    expect(splitGenres('DEEP HOUSE;Techno', c)).toEqual(['Deep House', 'Techno']);
  });

  it('alias canonicals count as known for the "/" rule', () => {
    const c = ctx({ aliases: new Map([['hip-hop', 'Hip Hop']]), known: known('Rap') });
    expect(splitGenres('Rap/Hip Hop', c)).toEqual(['Rap', 'Hip Hop']);
  });
});

describe('buildKnownFromRaw', () => {
  it('collects the separator-split vocabulary with most-common casing as display', () => {
    const knownMap = buildKnownFromRaw([
      'Deep House',
      'deep house',
      'Deep House',
      'Techno;Deep House',
      undefined,
      ['Nu Disco', 'nu disco'],
    ]);
    expect(knownMap.get('deep house')).toBe('Deep House');
    expect(knownMap.get('techno')).toBe('Techno');
    expect(knownMap.get('nu disco')).toBe('Nu Disco');
  });

  it('does not add "/"-joined values as vocabulary entries', () => {
    const knownMap = buildKnownFromRaw(['Nu Disco / Disco']);
    expect(knownMap.has('nu disco / disco')).toBe(true); // whole string is fine
    expect(knownMap.has('nu disco')).toBe(false); // sides are NOT minted as known
  });
});

describe('loadGenreContext', () => {
  it('loads aliases and known vocabulary from the db', async () => {
    const { Database } = await import('bun:sqlite');
    const { applySchema } = await import('../db.js');
    const { loadGenreContext } = await import('./genre-split.js');
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_genre_aliases (alias, canonical, source, created_at) VALUES (?, ?, ?, ?)`,
      ['RockPunk', 'Rock;Punk', 'user', Date.now()],
    );
    db.run(
      `INSERT INTO library_genres (name, song_count, album_count, synced_at) VALUES (?, ?, ?, ?)`,
      ['Deep House', 3, 1, Date.now()],
    );
    const ctx2 = loadGenreContext(db);
    expect(ctx2.aliases.get('rockpunk')).toBe('Rock;Punk');
    expect(ctx2.known.get('deep house')).toBe('Deep House');
    expect(splitGenres('rockpunk;deep house', ctx2)).toEqual(['Rock', 'Punk', 'Deep House']);
  });

  it('scan_cache flush marker: applySchema bumps once and flushes stale cache rows', async () => {
    const { Database } = await import('bun:sqlite');
    const { applySchema } = await import('../db.js');
    const db = new Database(':memory:');
    applySchema(db);
    // simulate a pre-multi-genre cache row surviving into the next boot
    db.run(`INSERT INTO scan_cache (path, size, mtime_ms, track_json) VALUES (?, ?, ?, ?)`, [
      'a.mp3',
      1,
      1,
      '{}',
    ]);
    db.run(`DELETE FROM library_sync_state WHERE key = 'scan_cache_version'`);
    applySchema(db); // upgrade boot: version marker absent → flush
    const n = db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM scan_cache`).get();
    expect(n!.c).toBe(0);
    // marker now present → a further boot must NOT flush again
    db.run(`INSERT INTO scan_cache (path, size, mtime_ms, track_json) VALUES (?, ?, ?, ?)`, [
      'b.mp3',
      1,
      1,
      '{}',
    ]);
    applySchema(db);
    const n2 = db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM scan_cache`).get();
    expect(n2!.c).toBe(1);
  });
});
