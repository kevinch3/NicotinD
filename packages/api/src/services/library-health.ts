import { dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { normalizeTitle, titlesOverlap } from '@nicotind/core';
import { auditLibrary, type AuditSeverity } from './library-audit.js';
import { unjustifiedHiddenAlbums } from './library-curator.js';
import { checkFragments } from './library-fragments.js';
import { artistImageCoverage, type ArtistImageCoverage } from './artist-image-fill.js';
import { missingAlbumArtSql } from './artwork-store.js';
import { folderArtBelongsToAlbum } from './album-folder.js';
import { findFolderCoverName } from './cover-sources.js';
import { losslessSuffixSql } from './library-track-select.js';
import { unresolvedGenreSql } from './genre-split.js';
import { countOpenCurationFlags } from './curation-flags.js';
import { albumAlreadyComplete, matchingLocalAlbums, onDiskTitles } from './library-completeness.js';

/**
 * Library health report — the one aggregation of every curation dimension:
 * what is missing/incohesive, how much, a bounded worst-first worklist sample,
 * and which remediation acts on it. The route, the CLI and the MCP
 * `get_library_health` tool are three renderings of this one object (as will be
 * the Admin panel, issue #736), so a dimension's metric is by construction the
 * number its remediation would change — the `NEEDS_PORTRAIT_SQL` doctrine.
 *
 * Pure, synchronous, DB-only: no network, no disk walk (disk findings remain
 * the audit CLI's job). Cheap aggregate queries except `auditLibrary`, which is
 * why this is computed on demand and deliberately NOT a polled ServiceReview
 * slice. → docs/library-audit.md "Library health report" (issue #734).
 */

export interface LibraryHealthOptions {
  /** Per-dimension worklist cap. Default 10, clamped 1–50. */
  sampleSize?: number;
  /**
   * Absolute music dir. Only the artwork dimension uses it, to probe the folder
   * tier for the shortlist of albums that have neither a canonical row nor
   * embedded art. Omitted ⇒ `unrenderable` is reported as `null` ("not
   * measured"), never as a number that silently ignores a tier.
   */
  musicDir?: string;
}

// Calibrated on prod 2026-08-26 (16,386 songs): 128/96 floors flag 15 albums,
// while a 160 floor would flag 39% of all mp3s. The suspected-gap guards cut
// 1,627 raw hits to 463 real-looking ones. Re-measure before moving any of these.
const LOW_BITRATE_FLOOR_LOSSY_KBPS = 128;
const LOW_BITRATE_FLOOR_OPUS_KBPS = 96;
const TRACK_GAP_MAX_TRACK = 40;
const TRACK_GAP_MIN_OWNED = 3;

export interface AlbumRef {
  albumId: string;
  name: string;
  artist: string;
}

export interface SongRef {
  songId: string;
  title: string;
  artist: string;
}

export interface MixedFormatFinding extends AlbumRef {
  songCount: number;
  suffixes: string[];
}

export interface LowBitrateFinding extends AlbumRef {
  songCount: number;
  avgKbps: number;
}

export interface ConfirmedIncomplete {
  /** Local album id when the hunted pair still resolves to a library row. */
  albumId: string | null;
  artist: string;
  album: string;
  expected: number;
  owned: number;
  missing: number;
  lidarrAlbumId: number | null;
  state: string;
}

/**
 * An album whose canonical titles do not all match on disk, but which already
 * holds at least as many songs as the release has (issue #758).
 *
 * Not a gap: `complete_album` refuses it as `already-complete`, and hunting it
 * would re-download a file that is present under a different spelling. The
 * remediation is retagging, so it is reported apart from `confirmed` rather
 * than dropped — 40% of a sampled `confirmed` worklist was this.
 */
export interface TitleMismatch {
  albumId: string | null;
  artist: string;
  album: string;
  expected: number;
  /** Songs the local album actually holds — at or above `expected`. */
  onDisk: number;
  /** Canonical titles with no on-disk counterpart. */
  unmatched: number;
}

export interface SuspectedGap extends AlbumRef {
  disc: number;
  maxTrack: number;
  numbered: number;
}

export interface LibraryHealthReport {
  collectedAt: number;
  totals: { artists: number; albums: number; visibleAlbums: number; songs: number };
  dimensions: {
    audit: {
      metric: { high: number; medium: number; low: number };
      worklist: { rule: string; severity: AuditSeverity; count: number }[];
      remediation: string;
    };
    fragments: {
      metric: { duplicateAlbums: number; hiddenByClassification: number; misSplitAlbums: number };
      worklist: {
        displayTitle: string;
        members: number;
        totalSongs: number;
        artistSpellings: string[];
      }[];
      remediation: string;
    };
    albumCovers: {
      /**
       * Four different questions, which were one number until issues #952/#969.
       *
       *  - `missing`       — no canonical `library_artwork` row. What
       *                      `backfillArtwork` acts on. 4,271 on prod.
       *  - `noEmbeddedArt` — …and no track carries an attached picture either.
       *                      ~2,859 of the 4,271 render fine through the
       *                      embedded fallback, so this is ~3x smaller.
       *  - `unrenderable`  — …and no folder image. The number a curator should
       *                      act on and the only one worth a network backfill.
       *                      `null` when no `musicDir` was supplied, because a
       *                      folder tier that was not checked must not be
       *                      reported as absent.
       *  - `missingMultiTrack` — the part of `missing` that behaves like a work
       *                      queue. 81% of visible albums are single-track rows
       *                      and 93% of `missing` lands on them, so the rest is
       *                      inventory rather than a backlog (#969).
       */
      metric: {
        visible: number;
        missing: number;
        missingMultiTrack: number;
        noEmbeddedArt: number;
        unrenderable: number | null;
      };
      worklist: (AlbumRef & { songCount: number })[];
      remediation: string;
    };
    artistPortraits: { metric: ArtistImageCoverage; remediation: string };
    genres: {
      metric: { songs: number; missing: number };
      worklist: SongRef[];
      remediation: string;
    };
    years: {
      /** Split for the same reason as `albumCovers.missing` — 95% of it is
       *  single-track rows with no year anywhere to derive one from (#969). */
      metric: { visibleAlbums: number; missing: number; missingMultiTrack: number };
      worklist: (AlbumRef & { songCount: number })[];
      remediation: string;
    };
    classification: {
      metric: {
        visibleUnknown: number;
        oversized: number;
        hidden: number;
        /** Hidden with no rule justifying it — always a bug (#967). */
        hiddenUnjustified: number;
      };
      worklist: (AlbumRef & { classification: string; songCount: number; reason: string })[];
      remediation: string;
    };
    formatCohesion: {
      metric: { mixedFormatAlbums: number; lowBitrateAlbums: number; losslessSongs: number };
      worklist: { mixed: MixedFormatFinding[]; lowBitrate: LowBitrateFinding[] };
      remediation: string;
    };
    completeness: {
      /** `suspected` is advisory-only — never hunted without a curator confirming. */
      metric: { confirmedIncomplete: number; suspected: number; titleMismatch: number };
      worklist: {
        confirmed: ConfirmedIncomplete[];
        suspected: SuspectedGap[];
        /** Full track count, unmatched titles — retag, never hunt (#758). */
        titleMismatches: TitleMismatch[];
      };
      remediation: string;
    };
    /**
     * Disk-side facts the DB-only dimensions cannot see (issue #955). `orphan_file`
     * and friends are produced by a walk, so they appear in `audit-library.ts`
     * and nowhere a curation pass would look — ten stretches of health-driven
     * curation never surfaced 393 unplayable files. The scanner already walks, so
     * it records what it learns and this reports it, with the scan time attached
     * so a stale number is visibly stale rather than quietly wrong.
     */
    disk: {
      metric: {
        /** scan_cache rows staged for deletion whose file is still present. */
        wronglyOrphaned: number | null;
        /** When the scan that produced these numbers finished. */
        measuredAt: number | null;
      };
      remediation: string;
    };
    /** Lyrics are fetched on demand by design — count only, no worklist. */
    lyrics: { metric: { songs: number; withLyrics: number } };
    flags: { metric: { open: number; oldestAt: number | null }; remediation: string };
  };
}

/**
 * The three artwork tiers, in the order `extractCover` consults them.
 *
 * `missingAlbumArtSql` answers "no canonical override", which is what
 * `backfillArtwork` acts on — but the name, the worklist framing and the
 * remediation hint all said "no artwork", and an album with embedded art in its
 * files renders perfectly while counting as missing. On prod that made the
 * single largest number in the report ~3x the user-visible problem (#952).
 *
 * The folder tier needs disk, so it is probed only for the shortlist that has
 * already failed the first two — bounded (~1,412 on prod), one `readdir` per
 * album directory, and skipped entirely when no `musicDir` is supplied.
 */
function artworkTiers(
  db: Database,
  musicDir?: string,
): {
  missing: number;
  missingMultiTrack: number;
  noEmbeddedArt: number;
  unrenderable: number | null;
} {
  const missing = count(db, `library_albums WHERE hidden = 0 AND ${missingAlbumArtSql()}`);
  const missingMultiTrack = count(
    db,
    `library_albums WHERE hidden = 0 AND song_count > 1 AND ${missingAlbumArtSql()}`,
  );
  const candidates = db
    .query<{ id: string; path: string }, []>(
      `SELECT a.id, MIN(s.path) AS path
         FROM library_albums a
         JOIN library_songs s ON s.album_id = a.id
        WHERE a.hidden = 0 AND ${missingAlbumArtSql('a')}
        GROUP BY a.id
       HAVING SUM(CASE WHEN s.has_embedded_art = 1 THEN 1 ELSE 0 END) = 0`,
    )
    .all();
  if (!musicDir) {
    return { missing, missingMultiTrack, noEmbeddedArt: candidates.length, unrenderable: null };
  }
  const probed = new Map<string, boolean>();
  let unrenderable = 0;
  for (const c of candidates) {
    // Folder art only counts as this album's art when the directory is its
    // folder and not a shared bucket — the same question the cover route asks
    // before serving it (#978). Without this the report calls 644 bucketed
    // albums renderable while the app shows them a placeholder.
    if (!folderArtBelongsToAlbum(db, c.path)) {
      unrenderable++;
      continue;
    }
    const dir = dirname(join(musicDir, c.path));
    let covered = probed.get(dir);
    if (covered === undefined) probed.set(dir, (covered = findFolderCoverName(dir) != null));
    if (!covered) unrenderable++;
  }
  return { missing, missingMultiTrack, noEmbeddedArt: candidates.length, unrenderable };
}

/** Disk-side facts the last full scan recorded. Nulls mean "no scan has run". */
function diskFacts(db: Database): { wronglyOrphaned: number | null; measuredAt: number | null } {
  const row = db
    .query<{ value: string; updated_at: number }, [string]>(
      'SELECT value, updated_at FROM library_sync_state WHERE key = ?',
    )
    .get('scan_cache_wrongly_orphaned');
  if (!row) return { wronglyOrphaned: null, measuredAt: null };
  const n = Number(row.value);
  return {
    wronglyOrphaned: Number.isFinite(n) ? n : null,
    measuredAt: row.updated_at ?? null,
  };
}

function count(db: Database, sql: string): number {
  return db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM ${sql}`).get()?.c ?? 0;
}

function confirmedIncomplete(db: Database): {
  confirmed: ConfirmedIncomplete[];
  titleMismatches: TitleMismatch[];
} {
  let jobs: Array<{
    artist_name: string;
    album_title: string;
    canonical_tracks_json: string;
    lidarr_album_id: number | null;
    state: string;
  }>;
  try {
    jobs = db
      .query<(typeof jobs)[number], []>(
        `SELECT artist_name, album_title, canonical_tracks_json, lidarr_album_id, state
         FROM album_jobs
         WHERE artist_name IS NOT NULL AND album_title IS NOT NULL
         ORDER BY id DESC`,
      )
      .all();
  } catch {
    return { confirmed: [], titleMismatches: [] };
  }

  const out: ConfirmedIncomplete[] = [];
  const titleMismatches: TitleMismatch[] = [];
  const seen = new Set<string>();
  for (const j of jobs) {
    const key = `${j.artist_name.trim().toLowerCase()}|${j.album_title.trim().toLowerCase()}`;
    if (seen.has(key)) continue; // newest job (id DESC) wins for a re-hunted pair
    seen.add(key);
    let titles: string[];
    try {
      const parsed: unknown = JSON.parse(j.canonical_tracks_json);
      titles = Array.isArray(parsed)
        ? parsed.filter((t): t is string => typeof t === 'string')
        : [];
    } catch {
      continue;
    }
    if (titles.length === 0) continue;
    // Same matcher acquireAlbum uses, so "incomplete here" ⇒ "a hunt would enqueue".
    const onDisk = onDiskTitles(db, j.artist_name, j.album_title);
    if (onDisk.length === 0) continue; // absent, not partial — deletion is a curator decision
    const missing = titles.filter(
      (t) => !onDisk.some((d) => titlesOverlap(d, normalizeTitle(t))),
    ).length;
    if (missing === 0) continue;
    const local = matchingLocalAlbums(db, j.artist_name, j.album_title);
    // This list's contract is "a hunt would enqueue these" — so it must apply
    // the SAME guard the hunt applies (#758). `albumAlreadyComplete` counts
    // ROWS while the loop above matches TITLES, and the two disagree whenever a
    // song is on disk under a different spelling: the title matcher reports it
    // missing, the hunt refuses it as `already-complete`, and a curator spends
    // bounded hunt budget on a no-op. Measured at 4 of 10 on prod.
    if (albumAlreadyComplete(db, j.artist_name, j.album_title, titles.length)) {
      titleMismatches.push({
        albumId: local[0]?.id ?? null,
        artist: j.artist_name,
        album: j.album_title,
        expected: titles.length,
        onDisk: Math.max(...local.map((r) => r.song_count), 0),
        unmatched: missing,
      });
      continue;
    }
    out.push({
      albumId: local[0]?.id ?? null,
      artist: j.artist_name,
      album: j.album_title,
      expected: titles.length,
      owned: titles.length - missing,
      missing,
      lidarrAlbumId: j.lidarr_album_id,
      state: j.state,
    });
  }
  return {
    // Most completable first — one missing track is the cheapest win.
    confirmed: out.sort((a, b) => a.missing - b.missing),
    titleMismatches: titleMismatches.sort((a, b) => b.unmatched - a.unmatched),
  };
}

export function libraryHealth(db: Database, opts: LibraryHealthOptions = {}): LibraryHealthReport {
  const sample = Math.min(50, Math.max(1, Math.trunc(opts.sampleSize ?? 10)));

  const audit = auditLibrary(db);
  const fragments = checkFragments(db);
  const unjustified = unjustifiedHiddenAlbums(db);

  const albumCoverWorklist = db
    .query<{ id: string; name: string; artist: string; song_count: number }, [number]>(
      `SELECT id, name, artist, song_count FROM library_albums
       WHERE hidden = 0 AND ${missingAlbumArtSql()}
       ORDER BY song_count DESC, id LIMIT ?`,
    )
    .all(sample);

  const artwork = artworkTiers(db, opts.musicDir);

  const genreWhere = `library_songs WHERE ${unresolvedGenreSql()}`;
  const genreWorklist = db
    .query<{ id: string; title: string; artist: string }, [number]>(
      `SELECT id, title, artist FROM ${genreWhere} ORDER BY artist, title LIMIT ?`,
    )
    .all(sample);

  const yearWorklist = db
    .query<{ id: string; name: string; artist: string; song_count: number }, [number]>(
      `SELECT id, name, artist, song_count FROM library_albums
       WHERE hidden = 0 AND (year IS NULL OR year <= 1)
       ORDER BY song_count DESC, id LIMIT ?`,
    )
    .all(sample);

  const mixed = db
    .query<
      { id: string; name: string; artist: string; song_count: number; suffixes: string },
      [number]
    >(
      `SELECT a.id, a.name, a.artist, a.song_count,
              GROUP_CONCAT(DISTINCT LOWER(COALESCE(s.suffix, '?'))) suffixes
       FROM library_albums a JOIN library_songs s ON s.album_id = a.id
       WHERE a.hidden = 0
       GROUP BY a.id
       HAVING COUNT(DISTINCT LOWER(COALESCE(s.suffix, '?'))) > 1 AND COUNT(*) >= 2
       ORDER BY a.song_count DESC, a.id LIMIT ?`,
    )
    .all(sample);
  const mixedCount = count(
    db,
    `(SELECT a.id FROM library_albums a JOIN library_songs s ON s.album_id = a.id
      WHERE a.hidden = 0
      GROUP BY a.id
      HAVING COUNT(DISTINCT LOWER(COALESCE(s.suffix, '?'))) > 1 AND COUNT(*) >= 2)`,
  );

  // bit_rate 0 = probe failure, treated as unknown alongside NULL (prod has such rows).
  const lowSql = `
    SELECT a.id, a.name, a.artist, a.song_count,
           CAST(AVG(CASE WHEN s.bit_rate > 0 THEN s.bit_rate END) AS INT) avgKbps
    FROM library_albums a JOIN library_songs s ON s.album_id = a.id
    WHERE a.hidden = 0
    GROUP BY a.id
    HAVING SUM(CASE WHEN s.bit_rate > 0 THEN 1 ELSE 0 END) > 0
       AND SUM(CASE WHEN s.bit_rate > 0 AND (
             (LOWER(COALESCE(s.suffix, '')) = 'opus' AND s.bit_rate < ${LOW_BITRATE_FLOOR_OPUS_KBPS})
             OR (LOWER(COALESCE(s.suffix, '')) IN ('mp3', 'm4a', 'aac', 'ogg', 'wma')
                 AND s.bit_rate < ${LOW_BITRATE_FLOOR_LOSSY_KBPS})
           ) THEN 1 ELSE 0 END) * 2
           >= SUM(CASE WHEN s.bit_rate > 0 THEN 1 ELSE 0 END)`;
  const lowBitrate = db
    .query<
      { id: string; name: string; artist: string; song_count: number; avgKbps: number },
      [number]
    >(`${lowSql} ORDER BY avgKbps ASC, a.id LIMIT ?`)
    .all(sample);
  const lowBitrateCount = count(db, `(${lowSql})`);

  const gapSql = `
    SELECT a.id, a.name, a.artist, COALESCE(s.disc, 1) disc,
           MAX(s.track) maxTrack, COUNT(DISTINCT s.track) numbered
    FROM library_albums a JOIN library_songs s ON s.album_id = a.id
    WHERE a.hidden = 0 AND a.classification IN ('album', 'ep', 'compilation')
    GROUP BY a.id, COALESCE(s.disc, 1)
    HAVING SUM(CASE WHEN s.track IS NULL THEN 1 ELSE 0 END) = 0
       AND COUNT(*) = COUNT(DISTINCT s.track)
       AND COUNT(DISTINCT s.track) >= ${TRACK_GAP_MIN_OWNED}
       AND MAX(s.track) <= ${TRACK_GAP_MAX_TRACK}
       AND MAX(s.track) > COUNT(DISTINCT s.track)`;
  const suspected = db
    .query<
      {
        id: string;
        name: string;
        artist: string;
        disc: number;
        maxTrack: number;
        numbered: number;
      },
      [number]
    >(`${gapSql} ORDER BY (maxTrack - numbered) ASC, a.id LIMIT ?`)
    .all(sample);
  const suspectedCount = count(db, `(${gapSql})`);

  const { confirmed, titleMismatches } = confirmedIncomplete(db);

  const oldestFlag =
    db
      .query<{ t: number | null }, []>(
        'SELECT MIN(created_at) t FROM curation_flags WHERE resolved_at IS NULL',
      )
      .get()?.t ?? null;

  const severityTally = { high: 0, medium: 0, low: 0 };
  for (const s of audit.summary) severityTally[s.severity] += s.count;

  return {
    collectedAt: Date.now(),
    totals: {
      artists: audit.totals.artists,
      albums: audit.totals.albums,
      visibleAlbums: count(db, 'library_albums WHERE hidden = 0'),
      songs: audit.totals.songs,
    },
    dimensions: {
      audit: {
        metric: severityTally,
        worklist: audit.summary.slice(0, sample),
        remediation:
          'scripts/audit-library.ts --rule=<id> for detail; repair via repair-pollution / retag-pollution / fix_album_metadata',
      },
      fragments: {
        metric: fragments.totals,
        worklist: fragments.duplicateAlbums
          .slice()
          .sort((a, b) => b.totalSongs - a.totalSongs)
          .slice(0, sample)
          .map((c) => ({
            displayTitle: c.displayTitle,
            members: c.memberIds.length,
            totalSongs: c.totalSongs,
            artistSpellings: c.artistSpellings.map((s) => s.name),
          })),
        remediation:
          'merge_artist for spelling variants; /api/library/fragments missplit preview → merge for clusters',
      },
      albumCovers: {
        metric: {
          visible: count(db, 'library_albums WHERE hidden = 0'),
          missing: artwork.missing,
          missingMultiTrack: artwork.missingMultiTrack,
          noEmbeddedArt: artwork.noEmbeddedArt,
          unrenderable: artwork.unrenderable,
        },
        worklist: albumCoverWorklist.map((r) => ({
          albumId: r.id,
          name: r.name,
          artist: r.artist,
          songCount: r.song_count,
        })),
        remediation:
          'maintenance artwork-backfill (bulk); set_album_cover / the web cover picker (per album)',
      },
      artistPortraits: {
        metric: artistImageCoverage(db),
        remediation: 'artist-image enrichment task; per-artist auto-fetch or upload in the web UI',
      },
      genres: {
        metric: {
          songs: count(db, 'library_songs'),
          missing: count(db, genreWhere),
        },
        worklist: genreWorklist.map((r) => ({ songId: r.id, title: r.title, artist: r.artist })),
        remediation:
          'genre → genre-discogs → genre-audio enrichment chain; residuals via set_song_genre',
      },
      years: {
        metric: {
          visibleAlbums: count(db, 'library_albums WHERE hidden = 0'),
          missing: count(db, 'library_albums WHERE hidden = 0 AND (year IS NULL OR year <= 1)'),
          missingMultiTrack: count(
            db,
            'library_albums WHERE hidden = 0 AND song_count > 1 AND (year IS NULL OR year <= 1)',
          ),
        },
        worklist: yearWorklist.map((r) => ({
          albumId: r.id,
          name: r.name,
          artist: r.artist,
          songCount: r.song_count,
        })),
        remediation: 'maintenance metadata-optimize; scripts/backfill-years.ts; fix_album_metadata',
      },
      classification: {
        metric: {
          visibleUnknown: count(
            db,
            `library_albums WHERE hidden = 0 AND classification = 'unknown'`,
          ),
          oversized: fragments.hiddenByClassification.filter((h) => h.reason === 'oversized')
            .length,
          hidden: fragments.hiddenByClassification.filter((h) => h.reason === 'hidden').length,
          hiddenUnjustified: unjustified.length,
        },
        worklist: db
          .query<
            {
              id: string;
              name: string;
              artist: string;
              classification: string;
              song_count: number;
            },
            [number]
          >(
            `SELECT id, name, artist, classification, song_count FROM library_albums
             WHERE hidden = 0 AND classification = 'unknown'
             ORDER BY song_count DESC, id LIMIT ?`,
          )
          .all(sample)
          .map((r) => ({
            albumId: r.id,
            name: r.name,
            artist: r.artist,
            classification: r.classification,
            songCount: r.song_count,
            reason: 'unknown',
          }))
          // Wrongly-hidden rows lead the worklist: a visible `unknown` is untidy,
          // an unjustifiably hidden album is music the user cannot reach (#967).
          .concat(
            unjustified.slice(0, sample).map((r) => ({
              albumId: r.id,
              name: r.name,
              artist: r.artist,
              classification: 'unknown',
              songCount: r.songCount,
              reason: 'hidden-unjustified',
            })),
          ),
        remediation: 'set_album_classification / POST /api/library/albums/:id/reclassify',
      },
      formatCohesion: {
        metric: {
          mixedFormatAlbums: mixedCount,
          lowBitrateAlbums: lowBitrateCount,
          losslessSongs: count(db, `library_songs WHERE ${losslessSuffixSql('suffix')}`),
        },
        worklist: {
          mixed: mixed.map((r) => ({
            albumId: r.id,
            name: r.name,
            artist: r.artist,
            songCount: r.song_count,
            suffixes: r.suffixes.split(','),
          })),
          lowBitrate: lowBitrate.map((r) => ({
            albumId: r.id,
            name: r.name,
            artist: r.artist,
            songCount: r.song_count,
            avgKbps: r.avgKbps,
          })),
        },
        remediation:
          'maintenance transcode-library clears lossless; mixed/low-bitrate albums are re-hunt candidates (complete_album / web hunt)',
      },
      completeness: {
        metric: {
          confirmedIncomplete: confirmed.length,
          suspected: suspectedCount,
          titleMismatch: titleMismatches.length,
        },
        worklist: {
          confirmed: confirmed.slice(0, sample),
          titleMismatches: titleMismatches.slice(0, sample),
          suspected: suspected.map((r) => ({
            albumId: r.id,
            name: r.name,
            artist: r.artist,
            disc: r.disc,
            maxTrack: r.maxTrack,
            numbered: r.numbered,
          })),
        },
        remediation:
          'confirmed → complete_album (curator-approved, only-missing-tracks); suspected is advisory — confirm before any hunt',
      },
      disk: {
        metric: diskFacts(db),
        remediation:
          'a non-zero count is always a bug (#968); the full worklist stays in audit-library.ts --rule=orphan_file',
      },
      lyrics: {
        metric: {
          songs: count(db, 'library_songs'),
          withLyrics: count(db, 'library_lyrics'),
        },
      },
      flags: {
        metric: { open: countOpenCurationFlags(db), oldestAt: oldestFlag },
        remediation: 'resolve_review_flag (MCP) or the Admin Needs-review card',
      },
    },
  };
}
