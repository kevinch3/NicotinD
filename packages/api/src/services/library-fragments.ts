/**
 * Detect fragmented album groupings in `library_albums`: cases where the same
 * logical release is represented by multiple rows, or where a row should be a
 * piece of one but was assigned its own id. Pure, DB-only — unit-testable with
 * an in-memory sqlite. The matching CLI script + admin route surface the report
 * so users can repair (alias the artist, run a full rescan, drop noise rows).
 *
 * Failure modes this catches:
 *
 *  1. **Same release, different `albumArtist` spellings.** Soulseek rips often
 *     tag the album artist inconsistently across tracks ("C. Tangana" / "C.Tangana"
 *     / "C Tangana"). Each spelling mints a distinct `library_albums` row even
 *     though every track refers to the same release. Detection: group by
 *     `normalizeForGrouping(album)` alone (artist excluded), find clusters with
 *     ≥2 rows, surface each spelling pair as a candidate for the artist-alias
 *     flow.
 *
 *  2. **Album hidden from the grid by classification** (`classification !=
 *     'album'`, or `hidden = 1`). The grid's default filter
 *     (`GRID_CLASSIFICATION_SQL = classification = 'album'`) means an EP
 *     classified as a single or a hidden album disappears from `/library`,
 *     `/search`, and any dedicated view. Detection: every visible album that
 *     shouldn't be hidden per curator rules.
 *
 *  3. **Mis-split cluster (single-track rows sharing a title)** — covered by
 *     `library-audit.checkMisSplitAlbums`. Re-imported here so a single
 *     `checkFragments` call produces the full report (used by the diagnostic
 *     route + CLI).
 *
 * The detector never mutates the DB — suggestions are surfaced for the user to
 * act on. The merge itself is invasive (move `library_songs.album_id`, drop
 * duplicate rows, recompute aggregates) so it stays human-gated.
 */

import type { Database } from 'bun:sqlite';
import { normalizeForGrouping } from './album-grouping.js';
import { checkMisSplitAlbums, type AuditFinding } from './library-audit.js';

/** A cluster of `library_albums` rows that probably represent one release. */
export interface DuplicateAlbumCluster {
  /** Stable handle = the normalized album title only (artist excluded on purpose). */
  normalizedTitle: string;
  /** Representative display title (shortest member name, like `buildLibrary`'s pick). */
  displayTitle: string;
  memberIds: string[];
  /** Distinct album-artist spellings across the cluster (suggesting an alias fix). */
  artistSpellings: Array<{ name: string; occurrences: number }>;
  /** Sum of `song_count` across members — what a single merged row would show. */
  totalSongs: number;
}

/** Hidden classification: an album row that the grid (default) would suppress. */
export interface HiddenByClassification {
  albumId: string;
  name: string;
  artist: string;
  classification: string;
  hidden: boolean;
  /** True when the row is `hidden = 1` OR `classification IN ('unknown', 'single', 'ep', 'compilation')`. */
  reason: 'hidden' | 'classification';
}

export interface FragmentReport {
  /** Same release, different `albumArtist` spellings → suggest `library_artist_aliases`. */
  duplicateAlbums: DuplicateAlbumCluster[];
  /** An album row hidden from the default Albums grid by `hidden` or classification. */
  hiddenByClassification: HiddenByClassification[];
  /** One-track-per-title fragmentation (existing `checkMisSplitAlbums` re-emitted). */
  misSplitAlbums: AuditFinding[];
  totals: {
    duplicateAlbums: number;
    hiddenByClassification: number;
    misSplitAlbums: number;
  };
  /** True when no fragmentation was detected. */
  ok: boolean;
}

interface AlbumMemberRow {
  id: string;
  name: string;
  artist: string;
  artist_id: string;
  song_count: number;
  classification: string;
  hidden: number;
}

function loadAlbums(db: Database): AlbumMemberRow[] {
  return db
    .query<AlbumMemberRow, []>(
      `SELECT id, name, artist, artist_id, song_count, classification, hidden
       FROM library_albums`,
    )
    .all();
}

/**
 * Same release, different artist spellings — group rows by `normalizeForGrouping`
 * of the album title (artist excluded), find clusters with ≥2 multi-track rows.
 *
 * Editorial: the lower-cased/diacritic-stripped title is the strongest signal;
 * an artist alias collapses two cluster members in the next rescan (they mint
 * the same artist id, which joins them onto the same `albumGroupKey` and same
 * `library_albums` row). One-track rows are excluded: their fragmentation is
 * owned by `checkMisSplitAlbums` and merging them into this report would
 * double-count the mis-split case.
 */
export function detectDuplicateAlbums(db: Database): DuplicateAlbumCluster[] {
  const rows = loadAlbums(db);
  const groups = new Map<string, AlbumMemberRow[]>();
  for (const r of rows) {
    if (r.song_count < 2) continue;
    const key = normalizeForGrouping(r.name);
    if (!key) continue; // un-groupable name (rare; survives for editorial review)
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const out: DuplicateAlbumCluster[] = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const artistCounts = new Map<string, number>();
    for (const m of members) {
      artistCounts.set(m.artist, (artistCounts.get(m.artist) ?? 0) + 1);
    }
    // Only surface clusters where at least two distinct artist spellings exist —
    // same-artist splits are usually a separate problem (folder misorganization
    // handled by `repair-album-folders`), not an alias candidate.
    if (artistCounts.size < 2) continue;
    const displayTitle = members.reduce(
      (acc, m) => (m.name.length < acc.length ? m.name : acc),
      members[0]!.name,
    );
    out.push({
      normalizedTitle: key,
      displayTitle,
      memberIds: members.map((m) => m.id),
      artistSpellings: [...artistCounts.entries()]
        .map(([name, occurrences]) => ({ name, occurrences }))
        .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name)),
      totalSongs: members.reduce((sum, m) => sum + m.song_count, 0),
    });
  }
  // Largest fragmentation first — the most painful cases lead the report.
  out.sort(
    (a, b) =>
      b.memberIds.length - a.memberIds.length ||
      b.totalSongs - a.totalSongs ||
      a.displayTitle.localeCompare(b.displayTitle),
  );
  return out;
}

/**
 * Visible albums the default `/api/library/albums` grid would suppress — either
 * hidden by the user/curator or classified as something other than `'album'`.
 * Emitted so the diagnostic report can say "this row exists but the grid hides
 * it; toggle its classification via the curator or unhide it".
 */
export function detectHiddenByClassification(db: Database): HiddenByClassification[] {
  const rows = loadAlbums(db);
  const out: HiddenByClassification[] = [];
  for (const r of rows) {
    if (r.hidden === 1) {
      out.push({
        albumId: r.id,
        name: r.name,
        artist: r.artist,
        classification: r.classification,
        hidden: true,
        reason: 'hidden',
      });
      continue;
    }
    if (r.classification !== 'album') {
      out.push({
        albumId: r.id,
        name: r.name,
        artist: r.artist,
        classification: r.classification,
        hidden: false,
        reason: 'classification',
      });
    }
  }
  // Stable order for the diagnostic UI: by title, then artist.
  out.sort((a, b) => a.name.localeCompare(b.name) || a.artist.localeCompare(b.artist));
  return out;
}

/** Run all fragmentation checks; the default entry-point for the route + CLI. */
export function checkFragments(db: Database): FragmentReport {
  const duplicateAlbums = detectDuplicateAlbums(db);
  const hiddenByClassification = detectHiddenByClassification(db);
  const misSplitAlbums = checkMisSplitAlbums(db);
  return {
    duplicateAlbums,
    hiddenByClassification,
    misSplitAlbums,
    totals: {
      duplicateAlbums: duplicateAlbums.length,
      hiddenByClassification: hiddenByClassification.length,
      misSplitAlbums: misSplitAlbums.length,
    },
    ok:
      duplicateAlbums.length === 0 &&
      hiddenByClassification.length === 0 &&
      misSplitAlbums.length === 0,
  };
}
