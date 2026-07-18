/**
 * Detect fragmented album groupings in `library_albums`: cases where the same
 * logical release is represented by multiple rows, or where a row should be a
 * piece of one but was assigned its own id. Pure, DB-only — unit-testable with
 * an in-memory sqlite. The matching CLI script + admin route surface the report
 * so users can repair (alias the artist, run a full rescan, drop noise rows).
 *
 * Failure modes this catches — each **calibrated against real prod data** so the
 * report is a short, actionable list rather than a false-positive firehose:
 *
 *  1. **Same release, artist-spelling variants.** A release whose album-artist is
 *     tagged inconsistently ("La Konga" / "La K'onga", "Mr Gato" / "Mr. Gato")
 *     mints a distinct `library_albums` row per spelling — the scanner only
 *     auto-merges rows whose artist *normalizes identically* (`albumGroupKey`
 *     uses `normalizeArtistForGrouping`, which preserves punctuation/spacing), so
 *     punctuation/spacing variants survive as separate rows. Detection: group by
 *     `normalizeForGrouping(title)`, then **sub-cluster by an alnum-only artist
 *     fold** and flag a sub-cluster only when its members share that fold but
 *     differ in raw spelling or artist id. This is the true alias candidate —
 *     it deliberately does **not** flag identically-titled albums by genuinely
 *     different artists ("Off the Wall" by Michael Jackson vs Pink Floyd,
 *     "Greatest Hits" by six artists), which title-only grouping wrongly did.
 *
 *  2. **Full album mis-classified (and thus hidden from the grid).** The grid's
 *     default filter (`classification = 'album'`) drops singles/EPs — *by
 *     design*, so flagging every single/EP is noise. What's a real defect is a
 *     row whose track count contradicts its class: a `single`/`ep` with an
 *     album-sized tracklist (e.g. "Future Nostalgia" tagged `single`, 18 tracks)
 *     is a full album the grid wrongly hides. Also surfaced: `unknown`
 *     classification and `hidden = 1` rows (both low-volume, worth a look).
 *     Legitimate short singles/EPs/compilations are **not** flagged.
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

// A `single` with this many tracks or more is almost certainly a full album (or
// EP) mis-tagged — a real single is 1–2 tracks (A-side + B-side / radio edit).
const SINGLE_MAX_TRACKS = 2;
// An `ep` this long or longer reads as a full album — an EP is ~3–6 tracks.
const EP_MAX_TRACKS = 7;

/**
 * Alnum-only, diacritic-stripped, lowercased artist key. Collapses the
 * punctuation/spacing spelling variants the scanner keeps distinct
 * ("La Konga"/"La K'onga" → "lakonga", "Mr Gato"/"Mr. Gato" → "mrgato") so a
 * genuine alias split can be detected, while still separating truly different
 * artists ("Pink Floyd" vs "Michael Jackson").
 */
function artistFold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

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

/**
 * An album row the default grid suppresses that looks like it *shouldn't* be —
 * a real defect, not a legitimately-short single/EP. `songCount` is included so
 * the UI can show "18 tracks, tagged single" as the tell.
 */
export interface HiddenByClassification {
  albumId: string;
  name: string;
  artist: string;
  classification: string;
  hidden: boolean;
  songCount: number;
  /**
   * Why it's flagged:
   *  - `hidden`      — `hidden = 1` (curator hid it).
   *  - `unknown`     — classification never resolved past `'unknown'`.
   *  - `oversized`   — a `single`/`ep` with an album-sized tracklist (looks like
   *                    a full album mis-classified, so the grid wrongly hides it).
   */
  reason: 'hidden' | 'unknown' | 'oversized';
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
 * Same release split by artist-spelling variants. Group rows by
 * `normalizeForGrouping(title)`, then **sub-cluster by `artistFold`** and flag a
 * sub-cluster only when its rows share the folded artist yet differ in raw
 * spelling or artist id — the genuine "alias these spellings then rescan"
 * candidate.
 *
 * Why sub-cluster by folded artist (vs the old title-only grouping): albums that
 * merely share a title but belong to different artists ("Off the Wall" by
 * Michael Jackson vs Pink Floyd, "Greatest Hits" by many artists) are NOT one
 * release and must not be flagged. The scanner already auto-merges rows whose
 * artist normalizes identically (`albumGroupKey`), so the only surviving
 * fragments are punctuation/spacing spelling variants — exactly what `artistFold`
 * collapses. Single-track rows are included (a real split, e.g. "La K'onga"'s
 * one-track singles, is often single-track); the distinct `checkMisSplitAlbums`
 * signal (≥3 same-title one-track singles regardless of artist) is orthogonal.
 */
export function detectDuplicateAlbums(db: Database): DuplicateAlbumCluster[] {
  const rows = loadAlbums(db);
  const byTitle = new Map<string, AlbumMemberRow[]>();
  for (const r of rows) {
    const key = normalizeForGrouping(r.name);
    if (!key) continue; // un-groupable name (rare; survives for editorial review)
    const arr = byTitle.get(key) ?? [];
    arr.push(r);
    byTitle.set(key, arr);
  }

  const out: DuplicateAlbumCluster[] = [];
  for (const [key, titleMembers] of byTitle) {
    if (titleMembers.length < 2) continue;
    // Sub-cluster the same-title rows by folded artist so only same-artist
    // spelling variants group together.
    const byArtist = new Map<string, AlbumMemberRow[]>();
    for (const m of titleMembers) {
      const af = artistFold(m.artist);
      if (!af) continue;
      const arr = byArtist.get(af) ?? [];
      arr.push(m);
      byArtist.set(af, arr);
    }
    for (const members of byArtist.values()) {
      if (members.length < 2) continue;
      const distinctSpellings = new Set(members.map((m) => m.artist));
      const distinctIds = new Set(members.map((m) => m.artist_id));
      // A real fragment = two+ distinct album rows for the same folded artist,
      // differing in how the artist is spelled OR in which artist id they landed
      // on. Same spelling + same id would already be one row (scanner merge).
      if (distinctSpellings.size < 2 && distinctIds.size < 2) continue;
      const artistCounts = new Map<string, number>();
      for (const m of members) {
        artistCounts.set(m.artist, (artistCounts.get(m.artist) ?? 0) + 1);
      }
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
 * Album rows the default grid suppresses that look like genuine defects — NOT
 * every non-`'album'` row (singles/EPs/compilations are meant to be off the grid).
 * Flagged: `hidden = 1`, `classification = 'unknown'`, and a `single`/`ep` whose
 * track count is album-sized (`SINGLE_MAX_TRACKS` / `EP_MAX_TRACKS`) — the
 * "Future Nostalgia tagged as a single, 18 tracks" case where a full album is
 * wrongly invisible. Legitimately-short singles/EPs and compilations are left
 * out so the report stays a short, actionable list.
 */
export function detectHiddenByClassification(db: Database): HiddenByClassification[] {
  const rows = loadAlbums(db);
  const out: HiddenByClassification[] = [];
  for (const r of rows) {
    const base = {
      albumId: r.id,
      name: r.name,
      artist: r.artist,
      classification: r.classification,
      hidden: r.hidden === 1,
      songCount: r.song_count,
    };
    if (r.hidden === 1) {
      out.push({ ...base, reason: 'hidden' });
      continue;
    }
    if (r.classification === 'unknown') {
      out.push({ ...base, reason: 'unknown' });
      continue;
    }
    if (
      (r.classification === 'single' && r.song_count > SINGLE_MAX_TRACKS) ||
      (r.classification === 'ep' && r.song_count > EP_MAX_TRACKS)
    ) {
      out.push({ ...base, reason: 'oversized' });
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
