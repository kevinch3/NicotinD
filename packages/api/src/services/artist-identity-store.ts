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

/**
 * Record the canonical artist identity resolved during acquisition (hunt / watchlist /
 * auto-acquire), so a freshly-downloaded album's artist is a known identity *before*
 * the scan lands — no background-task latency. The Lidarr canonical artist name is one
 * act by definition, so it's protected as `decision='single'` (a compound canonical
 * name like "Bob Marley & The Wailers" instantly joins `canonicalWhole`). The MBID is
 * cached in `artist_discography_links` keyed on the same deterministic artist id the
 * scanner will mint, preserving any `lidarr_id` a prior discography fetch stored.
 */
export function recordAcquiredArtistIdentity(
  db: Database,
  input: { artistKey: string; artistName: string; mbid?: string | null },
): void {
  upsertArtistIdentity(db, {
    artistKey: input.artistKey,
    rawName: input.artistName,
    decision: 'single',
    source: 'lidarr',
  });
  if (input.mbid) {
    db.run(
      `INSERT INTO artist_discography_links (artist_id, lidarr_id, mbid, checked_at)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(artist_id) DO UPDATE SET
         mbid = excluded.mbid,
         checked_at = excluded.checked_at`,
      [input.artistKey, input.mbid, Date.now()],
    );
  }
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
