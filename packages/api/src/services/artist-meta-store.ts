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
}

interface ArtistMetaSqlRow {
  artist_id: string;
  bio: string | null;
  urls: string;
  fetched_at: number;
  source: string;
  manual_override: number;
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
  },
): void {
  const manualOverride = row.manualOverride ? 1 : 0;
  db.run(
    `INSERT INTO library_artist_meta (artist_id, bio, urls, fetched_at, source, manual_override)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(artist_id) DO UPDATE SET
       bio = excluded.bio,
       urls = excluded.urls,
       fetched_at = excluded.fetched_at,
       source = excluded.source,
       manual_override = excluded.manual_override
     WHERE library_artist_meta.manual_override = 0 OR excluded.manual_override = 1`,
    [row.artistId, row.bio, JSON.stringify(row.urls), Date.now(), row.source, manualOverride],
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
