import { describe, it, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { SongMetadataMutateBody } from '../song-metadata-mutate.js';
import type { ArtistIdentityMutateBody } from '../artist-identity-mutate.js';
import type { SongGenreMutateBody } from '../song-genre-mutate.js';
import { applySchema } from '../../db.js';
import { applyCaseEffect } from './apply.js';

// Mock callbacks declare their (unused) parameters explicitly, rather than
// relying on a contextual type from `ApplyEffectDeps`, so `mock()` infers a
// real parameter tuple — `.mock.calls[n]` needs it to check `call[2]`/`call[3]`
// below, and a `deps(): ApplyEffectDeps` annotation would instead widen `d`'s
// properties to plain functions and lose the `.mock` bookkeeping entirely.
const deps = () => ({
  mutateSongMetadata: mock(
    async (_db: Database, _deps: unknown, _songId: string, _body: SongMetadataMutateBody) => ({
      ok: true as const,
      applied: {},
      verified: true,
    }),
  ),
  mutateArtistIdentity: mock((_db: Database, _deps: unknown, _body: ArtistIdentityMutateBody) => ({
    ok: true as const,
    moved: 3,
  })),
  deleteSong: mock(async (_db: Database, _songId: string, _deps: unknown) => ({ ok: true })),
  mutateSongGenre: mock(
    async (_db: Database, _deps: unknown, _songId: string, _body: SongGenreMutateBody) => ({
      ok: true as const,
      genres: [],
      tagWritten: null,
    }),
  ),
  songGenreDeps: {} as never,
  songMetadataDeps: {} as never,
  artistIdentityDeps: {} as never,
  deletionDeps: {} as never,
});

describe('applyCaseEffect', () => {
  it('resolve-only touches no mutation service', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    const d = deps();
    const res = await applyCaseEffect(db, { type: 'resolve-only' }, d);
    expect(res.ok).toBe(true);
    expect(d.mutateSongMetadata).not.toHaveBeenCalled();
    expect(d.mutateArtistIdentity).not.toHaveBeenCalled();
  });

  it('song-metadata delegates to mutateSongMetadata with the requested fields', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    const d = deps();
    const res = await applyCaseEffect(
      db,
      { type: 'song-metadata', songId: 's1', fields: { artist: 'Pharrell' } },
      d,
    );
    expect(res.ok).toBe(true);
    expect(d.mutateSongMetadata).toHaveBeenCalledTimes(1);
    const call = d.mutateSongMetadata.mock.calls[0]!;
    expect(call[2]).toBe('s1');
    expect(call[3]).toEqual({ artist: 'Pharrell' });
  });

  it('artist-merge delegates to mutateArtistIdentity', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    const d = deps();
    const res = await applyCaseEffect(
      db,
      { type: 'artist-merge', mergeInto: 'Rocky', rawName: 'rocky ' },
      d,
    );
    expect(res.ok).toBe(true);
    expect(d.mutateArtistIdentity).toHaveBeenCalledTimes(1);
  });

  // A merge applied from the triage page used to re-bucket nothing at all: it
  // stayed invisible until the next full scan (#1521).
  it('artist-merge re-buckets the raw and target names', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    const rebucket = mock(async (_names: string[]) => ({ songs: 1, albumIds: ['a'] }));
    const res = await applyCaseEffect(
      db,
      { type: 'artist-merge', mergeInto: 'Rocky', rawName: 'rocky ' },
      { ...deps(), rebucket },
    );
    expect(res.ok).toBe(true);
    expect(rebucket.mock.calls[0]![0]).toEqual(['rocky ', 'Rocky']);
  });

  it('song-genre replaces the genre on every song, and nothing else', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    for (const id of ['s1', 's2']) {
      db.run(
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at) VALUES (?, 'al', 't', 'a', 'ar', ?, 1)`,
        [id, `/m/${id}.opus`],
      );
    }
    const d = deps();
    const res = await applyCaseEffect(
      db,
      { type: 'song-genre', songIds: ['s1', 's2'], genre: 'Tech House' },
      d,
    );
    expect(res).toEqual({ ok: true, detail: 'genre Tech House on 2 song(s)' });
    expect(d.mutateSongGenre.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ['s1', { genre: 'Tech House', mode: 'replace' }],
      ['s2', { genre: 'Tech House', mode: 'replace' }],
    ]);
    expect(d.mutateSongMetadata).not.toHaveBeenCalled();
  });

  it('song-genre writes nothing when any song is gone', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at) VALUES ('s1', 'al', 't', 'a', 'ar', '/m/s1.opus', 1)`,
    );
    const d = deps();
    const res = await applyCaseEffect(
      db,
      { type: 'song-genre', songIds: ['s1', 'gone'], genre: 'Techno' },
      d,
    );
    expect(res.ok).toBe(false);
    expect(d.mutateSongGenre).not.toHaveBeenCalled();
  });

  it('song-delete delegates to deleteOne and touches no other service', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    const d = deps();
    const res = await applyCaseEffect(db, { type: 'song-delete', songId: 's9' }, d);
    expect(res.ok).toBe(true);
    expect(d.deleteSong).toHaveBeenCalledTimes(1);
    expect(d.deleteSong.mock.calls[0]![1]).toBe('s9');
    expect(d.mutateSongMetadata).not.toHaveBeenCalled();
    expect(d.mutateArtistIdentity).not.toHaveBeenCalled();
  });

  it('reports a failed delete with its reason', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    const failing = {
      ...deps(),
      deleteSong: mock(async () => ({ ok: false, error: 'Song not found in library' })),
    };
    const res = await applyCaseEffect(db, { type: 'song-delete', songId: 'nope' }, failing);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('not found');
  });

  it('reports a failed mutation rather than claiming success', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    // A fresh literal rather than `deps()` + reassignment: the ok:true mock
    // above is inferred with an ok:true-only return type, so overwriting the
    // property with an ok:false mock doesn't typecheck against it — build the
    // failing case's own deps instead of mutating a differently-shaped one.
    const failingDeps = {
      ...deps(),
      mutateSongMetadata: mock(async () => ({ ok: false as const, error: 'song not found' })),
    };
    const res = await applyCaseEffect(
      db,
      { type: 'song-metadata', songId: 'nope', fields: { title: 'x' } },
      failingDeps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('song not found');
  });
});
