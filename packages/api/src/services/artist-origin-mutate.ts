/**
 * Artist-origin mutation — extracted out of `PUT /api/library/artists/:id/origin`
 * in routes/library.ts (issue #759), the fifth instance of the shape
 * services/library-deletion.ts (#232), services/artist-identity-mutate.ts
 * (#339), services/song-genre-mutate.ts (#677) and
 * services/song-metadata-mutate.ts (#722) established: an MCP curator tool must
 * run the *same* tested write an HTTP request runs, never a second copy of the
 * logic in routes/mcp.ts.
 *
 * `recordAudit` stays caller-side — the HTTP route audits as the logged-in
 * curator, the MCP tool as `agent:<tokenId>` with a `(via MCP agent)` suffix.
 */
import type { Database } from 'bun:sqlite';
import { normalizeMbCountry } from '@nicotind/core';
import { getArtistOrigin, upsertArtistOrigin, type ArtistOriginRow } from './artist-origins.js';

export type ArtistOriginMutateResult =
  | {
      ok: true;
      origin: { country: string | null; source: 'user' };
      previous: ArtistOriginRow | null;
    }
  | { ok: false; error: string; status: 400 | 404 };

/**
 * Set an artist's origin as a curator decision.
 *
 * `country: null` is meaningful, not a no-op: it writes the permanent `user`
 * tombstone that stops the MusicBrainz task re-deriving a wrong value on the
 * next pass (`upsertArtistOrigin` refuses to let a 'musicbrainz' write clobber
 * a 'user' row). That is why `undefined` and `null` are distinguished here
 * rather than both meaning "unset".
 */
export function mutateArtistOrigin(
  db: Database,
  artistId: string,
  country: string | null | undefined,
): ArtistOriginMutateResult {
  if (country === undefined) return { ok: false, error: 'country required', status: 400 };

  const exists = db
    .query<{ id: string }, [string]>(`SELECT id FROM library_artists WHERE id = ?`)
    .get(artistId);
  if (!exists) return { ok: false, error: 'Artist not found', status: 404 };

  const normalized = country === null ? null : normalizeMbCountry(country);
  if (country !== null && normalized === null) {
    return { ok: false, error: 'Not an ISO 3166-1 alpha-2 code', status: 400 };
  }

  // Read before write so the caller can audit what it replaced — a wrong origin
  // is usually inherited from a wrong MBID, and knowing the old value is what
  // tells a curator whether the MBID needs fixing too (issue #759).
  const previous = getArtistOrigin(db, artistId);
  upsertArtistOrigin(db, { artistId, country: normalized, source: 'user' });
  return { ok: true, origin: { country: normalized, source: 'user' }, previous };
}
