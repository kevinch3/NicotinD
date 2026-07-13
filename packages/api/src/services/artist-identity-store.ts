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
  /** normalizeArtistForGrouping(variant) → canonical display spelling (see deriveMbidAliases). */
  aliases: ReadonlyMap<string, string>;
}

export function emptyAuthority(): SplitAuthority {
  return { confirmedArtists: new Set(), canonicalWhole: new Set(), aliases: new Map() };
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
  const aliases = new Map<string, string>();

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

  try {
    const rows = db
      .query<{ alias_norm: string; canonical_name: string }, []>(
        `SELECT alias_norm, canonical_name FROM library_artist_aliases`,
      )
      .all();
    for (const r of rows) aliases.set(r.alias_norm, r.canonical_name);
  } catch {
    // library_artist_aliases absent (pre-migration) — no alias rewriting.
  }

  return { confirmedArtists, canonicalWhole, aliases };
}

/** Write one alias row; a task-derived ('mbid') write never clobbers a user merge. */
export function upsertArtistAlias(
  db: Database,
  row: { aliasNorm: string; canonicalName: string; mbid?: string | null; source: 'mbid' | 'user' },
): void {
  db.run(
    `INSERT INTO library_artist_aliases (alias_norm, canonical_name, mbid, source, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(alias_norm) DO UPDATE SET
       canonical_name = excluded.canonical_name,
       mbid = excluded.mbid,
       source = excluded.source,
       created_at = excluded.created_at
     WHERE library_artist_aliases.source != 'user' OR excluded.source = 'user'`,
    [row.aliasNorm, row.canonicalName, row.mbid ?? null, row.source, Date.now()],
  );
}

export interface AliasProposal {
  aliasNorm: string;
  variantName: string;
  canonicalName: string;
  mbid: string;
}

/**
 * Derive artist-name alias PROPOSALS from MBID equality: when several
 * `library_artists` rows' cached `artist_discography_links` MBIDs coincide, they are
 * likely spelling variants of ONE MusicBrainz artist that `artistIdFor` (a pure
 * string hash) minted as separate entities. The spelling with the most songs (tie:
 * most albums, then name) becomes canonical; every other spelling is proposed as an
 * alias so a rescan can mint the canonical id for all of them.
 *
 * NOT written unattended, and deliberately so: the MBID cache is only as trustworthy
 * as its writer, and `DiscographyService` stores Lidarr's *top fuzzy lookup hit*
 * (`candidates[0]`) with no name verification — verified against the real library,
 * where the one live MBID-equal pair was "Âme" vs "ME": two different artists whose
 * lookups fuzzy-matched to the same MusicBrainz id. An automatic merge would corrupt
 * the library, so proposals go through a human: `resolve-artist-identity.ts --aliases`
 * prints them for review and `--apply` writes the reviewed set (source='mbid'); the
 * admin merge flow writes its own rows (source='user'). Pass `apply: true` to write.
 */
export function deriveMbidAliases(db: Database, opts: { apply?: boolean } = {}): AliasProposal[] {
  const rows = db
    .query<{ mbid: string; name: string; songs: number; albums: number }, []>(
      `SELECT l.mbid AS mbid, a.name AS name, a.album_count AS albums,
              (SELECT COUNT(*) FROM library_songs s WHERE s.artist_id = a.id) AS songs
       FROM artist_discography_links l
       JOIN library_artists a ON a.id = l.artist_id
       WHERE l.mbid IS NOT NULL`,
    )
    .all();

  const byMbid = new Map<string, typeof rows>();
  for (const r of rows) {
    const group = byMbid.get(r.mbid);
    if (group) group.push(r);
    else byMbid.set(r.mbid, [r]);
  }

  const proposals: AliasProposal[] = [];
  for (const [mbid, group] of byMbid) {
    if (group.length < 2) continue;
    const canonical = [...group].sort(
      (a, b) => b.songs - a.songs || b.albums - a.albums || a.name.localeCompare(b.name),
    )[0];
    for (const variant of group) {
      const aliasNorm = normalizeArtistForGrouping(variant.name);
      if (aliasNorm === normalizeArtistForGrouping(canonical.name)) continue;
      proposals.push({ aliasNorm, variantName: variant.name, canonicalName: canonical.name, mbid });
    }
  }

  if (opts.apply) {
    for (const p of proposals) {
      upsertArtistAlias(db, {
        aliasNorm: p.aliasNorm,
        canonicalName: p.canonicalName,
        mbid: p.mbid,
        source: 'mbid',
      });
    }
  }
  return proposals;
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

/**
 * Upsert a resolved split decision (written by the enrichment task / seed script /
 * acquisition / the admin fix flow). A `source='user'` row is the highest authority:
 * background writers (lidarr/mb/library) can never overwrite it — only another user
 * decision can. See also {@link pendingArtistIdentityRows}, which keeps user rows out
 * of the background task's pending set permanently (no TTL re-resolution).
 */
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
       checked_at = excluded.checked_at
     WHERE library_artist_identity.source != 'user' OR excluded.source = 'user'`,
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
