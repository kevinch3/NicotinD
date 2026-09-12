import { describe, it, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { SongMetadataMutateBody } from '../song-metadata-mutate.js';
import type { ArtistIdentityMutateBody } from '../artist-identity-mutate.js';
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
  songMetadataDeps: {} as never,
  artistIdentityDeps: {} as never,
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

describe('durability', () => {
  it('offers no effect that writes an album row override', () => {
    // docs/curator-triage.md §4: an album-row artist write that contradicts the
    // file tag reverts on the next rescan, so it must never be an option's
    // apply path. This asserts the dispatch table, not a comment about it.
    const src = readFileSync(new URL('./apply.ts', import.meta.url).pathname, 'utf8');
    expect(src).not.toContain('fix_album_metadata');
    expect(src).not.toContain('mutateAlbumMetadata');
  });
});
