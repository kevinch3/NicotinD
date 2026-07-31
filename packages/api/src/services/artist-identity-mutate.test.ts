/**
 * Direct unit coverage of the artist-identity mutation service extracted out
 * of routes/library.ts (issue #339) — the route-level tests in
 * routes/library.test.ts already cover this exhaustively through HTTP; this
 * file exercises the same module directly so the MCP `merge_artist` tool
 * (which calls it without going through Hono) has a test surface of its own.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { mutateArtistIdentity } from './artist-identity-mutate.js';
import { artistIdFor } from './library-scanner.js';

const db = new Database(':memory:');
applySchema(db);

beforeEach(() => {
  db.run('DELETE FROM library_artist_aliases');
  db.run('DELETE FROM library_artist_identity');
});

describe('mutateArtistIdentity — rename', () => {
  it('mints an alias and returns the new artist id', () => {
    const result = mutateArtistIdentity(
      db,
      {},
      { rawName: 'Los Áutenticos', rename: 'Los Auténticos' },
    );
    expect(result).toEqual({
      ok: true,
      kind: 'renamed',
      artistId: artistIdFor('Los Auténticos'),
    });
    const row = db
      .query<{ canonical_name: string }, []>('SELECT canonical_name FROM library_artist_aliases')
      .get();
    expect(row?.canonical_name).toBe('Los Auténticos');
  });

  it('rejects an empty or unchanged rename', () => {
    expect(mutateArtistIdentity(db, {}, { rawName: 'Artist', rename: '' })).toEqual({
      ok: false,
      error: 'rename must be a non-empty, different name',
      status: 400,
    });
    expect(mutateArtistIdentity(db, {}, { rawName: 'Artist', rename: 'Artist' })).toEqual({
      ok: false,
      error: 'rename must be a non-empty, different name',
      status: 400,
    });
  });
});

describe('mutateArtistIdentity — merge', () => {
  it('mints an alias onto the target and returns its artist id', () => {
    const result = mutateArtistIdentity(
      db,
      {},
      { rawName: 'Ke Personajes', mergeInto: 'Ke Personaje' },
    );
    expect(result).toEqual({
      ok: true,
      kind: 'merged',
      artistId: artistIdFor('Ke Personaje'),
    });
  });

  it('rejects a same-normalized mergeInto target (that is a rename, not a merge)', () => {
    const result = mutateArtistIdentity(
      db,
      {},
      { rawName: 'The Beatles', mergeInto: 'the beatles' },
    );
    expect(result).toEqual({
      ok: false,
      error: 'mergeInto must be a different artist name',
      status: 400,
    });
  });
});

describe('mutateArtistIdentity — single / split', () => {
  it('records a one-act decision', () => {
    const result = mutateArtistIdentity(db, {}, { rawName: 'Ana Tijoux', decision: 'single' });
    expect(result).toEqual({ ok: true, kind: 'single', artistId: artistIdFor('Ana Tijoux') });
    const row = db
      .query<{ decision: string }, []>('SELECT decision FROM library_artist_identity')
      .get();
    expect(row?.decision).toBe('single');
  });

  it('records a split with its members and returns no single artist id', () => {
    const result = mutateArtistIdentity(
      db,
      {},
      {
        rawName: 'Bob Marley, Peter Tosh',
        decision: 'split',
        members: ['Bob Marley', 'Peter Tosh'],
      },
    );
    expect(result).toEqual({ ok: true, kind: 'split', artistId: null });
  });

  it('rejects a split with fewer than 2 members', () => {
    const result = mutateArtistIdentity(
      db,
      {},
      { rawName: 'Solo Act', decision: 'split', members: ['Solo Act'] },
    );
    expect(result).toEqual({
      ok: false,
      error: 'split requires at least 2 member names',
      status: 400,
    });
  });
});

describe('mutateArtistIdentity — validation', () => {
  it('requires a rawName', () => {
    expect(mutateArtistIdentity(db, {}, {})).toEqual({
      ok: false,
      error: 'rawName required',
      status: 400,
    });
  });

  it('requires one of decision/mergeInto/rename', () => {
    expect(mutateArtistIdentity(db, {}, { rawName: 'Nobody Home' })).toEqual({
      ok: false,
      error: 'decision (single|split), mergeInto, or rename required',
      status: 400,
    });
  });
});
