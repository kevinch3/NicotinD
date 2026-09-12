/**
 * Dispatch a chosen case option's effect to the service that already
 * implements that write (docs/curator-triage.md §4).
 *
 * Two rules are encoded here rather than left to callers:
 *
 * 1. Never a second copy of a mutation. Each effect delegates to the same
 *    tested service the HTTP routes and the MCP tools call.
 * 2. No effect may take an apply path known to revert. A metadata change goes
 *    through `mutateSongMetadata`, which rewrites the FILE tag; there is
 *    deliberately no album-row-override effect, because an album-row artist
 *    write that contradicts the file tag is re-derived away on the next scan.
 *
 * The mutation services are injected via `ApplyEffectDeps`, typed to the
 * minimal *call shape* this dispatcher actually uses (the parameters it
 * passes, and the result fields it reads) rather than to the services'
 * concrete function types. That keeps the dispatch table honest about what it
 * depends on, and keeps it unit-testable with plain mocks that only stub the
 * `ok`/`error` shape below — a mock cannot practically satisfy the full
 * `SongMetadataMutateResult` / `ArtistIdentityMutateResult` discriminated
 * unions. Wiring the real service functions in (they satisfy these shapes) is
 * the composition root's job, not this module's.
 */
import type { Database } from 'bun:sqlite';
import type { CaseEffect } from '@nicotind/core';
import type { SongMetadataMutateBody, SongMetadataMutateDeps } from '../song-metadata-mutate.js';
import type {
  ArtistIdentityMutateBody,
  ArtistIdentityMutateDeps,
} from '../artist-identity-mutate.js';

export type ApplyEffectResult = { ok: true; detail: string } | { ok: false; error: string };

/** The result shape this dispatcher reads back from `mutateSongMetadata`. */
type SongMetadataApplyResult = { ok: true } | { ok: false; error: string };

/** The result shape this dispatcher reads back from `mutateArtistIdentity`. */
type ArtistIdentityApplyResult = { ok: true } | { ok: false; error: string };

export interface ApplyEffectDeps {
  mutateSongMetadata: (
    db: Database,
    deps: SongMetadataMutateDeps,
    songId: string,
    body: SongMetadataMutateBody,
  ) => Promise<SongMetadataApplyResult>;
  mutateArtistIdentity: (
    db: Database,
    deps: ArtistIdentityMutateDeps,
    body: ArtistIdentityMutateBody,
  ) => ArtistIdentityApplyResult;
  songMetadataDeps: SongMetadataMutateDeps;
  artistIdentityDeps: ArtistIdentityMutateDeps;
}

export async function applyCaseEffect(
  db: Database,
  effect: CaseEffect,
  deps: ApplyEffectDeps,
): Promise<ApplyEffectResult> {
  switch (effect.type) {
    case 'resolve-only':
      return { ok: true, detail: 'reviewed, no data change' };

    case 'song-metadata': {
      const res = await deps.mutateSongMetadata(
        db,
        deps.songMetadataDeps,
        effect.songId,
        effect.fields,
      );
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, detail: `retagged ${effect.songId}: ${JSON.stringify(effect.fields)}` };
    }

    case 'artist-merge': {
      const res = deps.mutateArtistIdentity(db, deps.artistIdentityDeps, {
        rawName: effect.rawName,
        mergeInto: effect.mergeInto,
      });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, detail: `merged ${effect.rawName} into ${effect.mergeInto}` };
    }
  }
}
