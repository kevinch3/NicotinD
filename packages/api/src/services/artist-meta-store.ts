/**
 * Artist bio + external links (issue #195), sourced from Discogs. Side table
 * like library_artist_identity: keyed on the scanner-minted artist id, survives
 * rescans. See db.ts for the manual_override / tombstone discipline.
 */

import type { Database } from 'bun:sqlite';

export interface ArtistMetaRow {
  artistId: string;
  bio: string | null;
  urls: string[];
  fetchedAt: number;
  source: string;
  manualOverride: boolean;
  /**
   * The MBID this bio was derived from, or `null` for a tombstone, a manual
   * write, or a row written before #1114 added the column. A bio is only as
   * trustworthy as the identity behind it, and this is what lets an mbid
   * correction invalidate it instead of leaving the page contradicting itself.
   */
  mbid: string | null;
}

interface ArtistMetaSqlRow {
  artist_id: string;
  bio: string | null;
  urls: string;
  fetched_at: number;
  source: string;
  manual_override: number;
  mbid: string | null;
}

export function getArtistMeta(db: Database, artistId: string): ArtistMetaRow | null {
  const r = db
    .query<ArtistMetaSqlRow, [string]>(`SELECT * FROM library_artist_meta WHERE artist_id = ?`)
    .get(artistId);
  if (!r) return null;
  return {
    artistId: r.artist_id,
    bio: r.bio,
    urls: parseUrls(r.urls),
    fetchedAt: r.fetched_at,
    source: r.source,
    manualOverride: r.manual_override === 1,
    mbid: r.mbid,
  };
}

/**
 * Write a resolved (or tombstoned) row. A background write (manualOverride
 * unset/false) can never clobber an existing manual_override=1 row; a manual
 * write (manualOverride=true) always wins — same discipline as
 * upsertArtistIdentity's source='user' protection.
 */
export function upsertArtistMeta(
  db: Database,
  row: {
    artistId: string;
    bio: string | null;
    urls: string[];
    source: string;
    manualOverride?: boolean;
    /** The MBID the bio came from — omit (or null) for a tombstone. */
    mbid?: string | null;
  },
): void {
  const manualOverride = row.manualOverride ? 1 : 0;
  db.run(
    `INSERT INTO library_artist_meta (artist_id, bio, urls, fetched_at, source, manual_override, mbid)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artist_id) DO UPDATE SET
       bio = excluded.bio,
       urls = excluded.urls,
       fetched_at = excluded.fetched_at,
       source = excluded.source,
       manual_override = excluded.manual_override,
       mbid = excluded.mbid
     WHERE library_artist_meta.manual_override = 0 OR excluded.manual_override = 1`,
    [
      row.artistId,
      row.bio,
      JSON.stringify(row.urls),
      Date.now(),
      row.source,
      manualOverride,
      row.mbid ?? null,
    ],
  );
}

/**
 * Drop an artist's automatically-derived bio so the next `artist-info` pass
 * refetches it from whatever identity is current.
 *
 * Deleting rather than tombstoning is deliberate: the task's pending set is
 * `NOT EXISTS (SELECT 1 FROM library_artist_meta ...)`, so an absent row is
 * exactly "fetch this one again" while a `bio = NULL` row reads as "already
 * decided, leave alone". A curator's `manual_override = 1` bio is never touched —
 * they have overruled the derivation, so re-deriving is not an improvement.
 *
 * Called when the artist's MBID changes or is tombstoned (#1112, #1114): every
 * MusicBrainz-derived value has to move with the identity, or the page ends up
 * asserting two different people in adjacent blocks.
 *
 * @returns true when a row was removed.
 */
export function clearDerivedArtistMeta(db: Database, artistId: string): boolean {
  return (
    db.run(`DELETE FROM library_artist_meta WHERE artist_id = ? AND manual_override = 0`, [
      artistId,
    ]).changes > 0
  );
}

function parseUrls(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}
