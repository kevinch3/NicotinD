import type { Database } from 'bun:sqlite';
import { normalizeArtistForGrouping } from './album-grouping';
import { isAtomicArtist } from './artist-split';

/**
 * The two normalized sets that gate {@link splitArtists}. See {@link KnownArtistSets}.
 * `loadSplitAuthority` assembles them offline from (1) atomic artist names already in
 * the library and (2) the cached `library_artist_identity` decisions (Lidarr/MB). The
 * synchronous scanner consumes this — never a live network call.
 */
export interface SplitAuthority {
  confirmedArtists: ReadonlySet<string>;
  canonicalWhole: ReadonlySet<string>;
}

export function emptyAuthority(): SplitAuthority {
  return { confirmedArtists: new Set(), canonicalWhole: new Set() };
}

/**
 * Build the split authority from the current DB state. Fully offline:
 * - Every artist string already stored **atomically** (no delimiter / featuring) is a
 *   confirmed individual artist — a compound can never confirm itself this way.
 * - `library_artist_identity` rows contribute Lidarr/MB decisions: `single` → protect
 *   the whole compound (`canonicalWhole`); `split` → each resolved member is confirmed.
 */
export function loadSplitAuthority(db: Database): SplitAuthority {
  const confirmedArtists = new Set<string>();
  const canonicalWhole = new Set<string>();

  try {
    const rows = db
      .query<{ name: string }, []>(
        `SELECT DISTINCT artist AS name FROM library_songs WHERE artist IS NOT NULL
         UNION
         SELECT DISTINCT album_artist AS name FROM library_songs WHERE album_artist IS NOT NULL`,
      )
      .all();
    for (const r of rows) {
      if (r.name && isAtomicArtist(r.name))
        confirmedArtists.add(normalizeArtistForGrouping(r.name));
    }
  } catch {
    // library_songs absent (fresh db) — nothing to seed from.
  }

  try {
    const rows = db
      .query<{ raw_name: string; decision: string; members: string | null }, []>(
        `SELECT raw_name, decision, members FROM library_artist_identity`,
      )
      .all();
    for (const r of rows) {
      if (r.decision === 'single') {
        canonicalWhole.add(normalizeArtistForGrouping(r.raw_name));
      } else if (r.decision === 'split' && r.members) {
        let members: unknown;
        try {
          members = JSON.parse(r.members);
        } catch {
          continue;
        }
        if (Array.isArray(members)) {
          for (const m of members) {
            if (typeof m === 'string' && m) confirmedArtists.add(normalizeArtistForGrouping(m));
          }
        }
      }
    }
  } catch {
    // library_artist_identity absent (pre-migration) — degrade to library-only authority.
  }

  return { confirmedArtists, canonicalWhole };
}

/** Upsert a resolved split decision (written by the enrichment task / seed script). */
export function upsertArtistIdentity(
  db: Database,
  row: {
    artistKey: string;
    rawName: string;
    decision: 'single' | 'split' | 'unknown';
    members?: string[];
    source: string;
  },
): void {
  db.run(
    `INSERT INTO library_artist_identity (artist_key, raw_name, decision, members, source, checked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(artist_key) DO UPDATE SET
       raw_name = excluded.raw_name,
       decision = excluded.decision,
       members = excluded.members,
       source = excluded.source,
       checked_at = excluded.checked_at`,
    [
      row.artistKey,
      row.rawName,
      row.decision,
      row.members && row.members.length ? JSON.stringify(row.members) : null,
      row.source,
      Date.now(),
    ],
  );
}
