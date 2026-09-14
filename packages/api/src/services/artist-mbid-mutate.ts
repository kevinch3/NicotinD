/**
 * Artist-MBID mutation — the sixth instance of the shape
 * services/library-deletion.ts (#232), services/artist-identity-mutate.ts
 * (#339), services/song-genre-mutate.ts (#677), services/song-metadata-mutate.ts
 * (#722) and services/artist-origin-mutate.ts (#759) established: one tested
 * write, shared by every surface that offers the action.
 *
 * Why this exists at all (#1112): `set_song_genre` and `set_artist_origin` can
 * patch the *symptoms* of a homonym collision durably, but nothing could touch
 * the cause. "Rocky" — an mbid pointing at an Israeli psytrance producer while
 * every song filed under it is a French electro-pop band — had its origin and
 * genre corrected while the mbid stayed attached, so the artist page rendered
 * `France` and `Pop 100%` with the Israeli producer's biography directly
 * underneath and a release list derived from his discography (#1114). Each new
 * MusicBrainz-derived surface inherits the same wrong identity until the mbid
 * itself is fixable.
 *
 * `recordAudit` stays caller-side — an HTTP route would audit as the logged-in
 * curator, the MCP tool as `agent:<tokenId>` with a `(via MCP agent)` suffix.
 */
import type { Database } from 'bun:sqlite';
import { isMbidShape } from '@nicotind/core';
import { normalizeArtistForGrouping } from './album-grouping.js';
import { clearDerivedArtistMeta } from './artist-meta-store.js';
import { getMbid, upsertMbid, type MbidRow } from './mbid-store.js';

export type ArtistMbidMutateResult =
  | {
      ok: true;
      /** `id: null` = tombstoned. `confidence` is 1 for a set, 0 for a tombstone. */
      mbid: { id: string | null; source: 'user'; confidence: number };
      previous: MbidRow | null;
      /** Whether a derived bio was dropped, so the caller can say so in its audit detail. */
      clearedBio: boolean;
      /** Whether a non-curator origin was dropped, likewise. */
      clearedOrigin: boolean;
    }
  | { ok: false; error: string; status: 400 | 404 };

/**
 * Attach, replace or detach an artist's MusicBrainz id as a curator decision.
 *
 * `mbid: null` is meaningful, not a no-op — it is the whole point of the tool.
 * It writes the permanent `user` tombstone (`isMbidTombstoned`) that stops the
 * next automatic pass re-resolving the same homonym, which a plain delete would
 * not: `library_mbids` caches a *resolution*, so an absent row means "not looked
 * up yet" and Lidarr returns the same wrong hit every time. That is why
 * `undefined` and `null` are distinguished here rather than both meaning "unset",
 * exactly as in `mutateArtistOrigin`.
 *
 * Either way the derived bio goes: it was fetched from the identity being
 * replaced, and a bio that outlives its mbid is how a page comes to assert two
 * different people at once (#1114). Dropping the row rather than blanking it
 * puts the artist back in `artist-info`'s pending set, so a *replacement* mbid
 * gets its bio refetched on the next pass instead of staying empty.
 */
export function mutateArtistMbid(
  db: Database,
  artistId: string,
  mbid: string | null | undefined,
): ArtistMbidMutateResult {
  if (mbid === undefined) return { ok: false, error: 'mbid required', status: 400 };

  const artist = db
    .query<{ id: string; name: string }, [string]>(
      `SELECT id, name FROM library_artists WHERE id = ?`,
    )
    .get(artistId);
  if (!artist) return { ok: false, error: 'Artist not found', status: 404 };

  const normalized = mbid === null ? null : mbid.trim().toLowerCase();
  if (normalized !== null && !isMbidShape(normalized)) {
    return { ok: false, error: 'Not a MusicBrainz id', status: 400 };
  }

  // `library_mbids` is keyed by NORMALIZED ARTIST NAME, not artist id — which is
  // where the homonym hazard lives in the first place (#1114: every library
  // artist whose name normalizes to `rocky` shares one entry). So a write here
  // moves every same-name artist at once. That is the right blast radius for a
  // curator saying "this name does not resolve to that person", and it is the
  // only radius the storage can express.
  const key = normalizeArtistForGrouping(artist.name);
  const previous = getMbid(db, 'artist', key);

  upsertMbid(db, {
    scope: 'artist',
    key,
    // The rejected id is kept as provenance on a tombstone — which id was wrong
    // is what a later investigation needs, and `usableMbid` never hands it out.
    // Empty only when there was nothing to reject: tombstoning an unresolved
    // name is still meaningful, since it pre-empts the wrong resolution.
    mbid: normalized ?? previous?.mbid ?? '',
    source: 'user',
    confidence: normalized === null ? 0 : 1,
  });

  // Evict only what a *source* derived: a curator's own bio/origin is the more
  // authoritative statement and must survive (the same discipline as the
  // background tasks' manual_override / source='user' guards).
  //
  // This runs on a CLEAR as well as a set, which the route it was extracted from
  // did not do — clearing left the wrong person's bio and the inherited country
  // sitting on the page, which is the contradiction #1114 recorded on "Rocky".
  const clearedBio = clearDerivedArtistMeta(db, artistId);
  const clearedOrigin =
    db.run(`DELETE FROM library_artist_origins WHERE artist_id = ? AND source != 'user'`, [
      artistId,
    ]).changes > 0;

  return {
    ok: true,
    mbid: { id: normalized, source: 'user', confidence: normalized === null ? 0 : 1 },
    previous,
    clearedBio,
    clearedOrigin,
  };
}
