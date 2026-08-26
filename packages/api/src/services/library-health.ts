import type { Database } from 'bun:sqlite';
import { normalizeTitle, titlesOverlap } from '@nicotind/core';
import { auditLibrary, type AuditSeverity } from './library-audit.js';
import { checkFragments } from './library-fragments.js';
import { artistImageCoverage, type ArtistImageCoverage } from './artist-image-fill.js';
import { missingAlbumArtSql } from './artwork-store.js';
import { losslessSuffixSql } from './library-track-select.js';
import { unresolvedGenreSql } from './genre-split.js';
import { countOpenCurationFlags } from './curation-flags.js';
import { matchingLocalAlbums, onDiskTitles } from './library-completeness.js';

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
      metric: { visible: number; missing: number };
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
      metric: { visibleAlbums: number; missing: number };
      worklist: (AlbumRef & { songCount: number })[];
      remediation: string;
    };
    classification: {
      metric: { visibleUnknown: number; oversized: number; hidden: number };
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
      metric: { confirmedIncomplete: number; suspected: number };
      worklist: { confirmed: ConfirmedIncomplete[]; suspected: SuspectedGap[] };
      remediation: string;
    };
    /** Lyrics are fetched on demand by design — count only, no worklist. */
    lyrics: { metric: { songs: number; withLyrics: number } };
    flags: { metric: { open: number; oldestAt: number | null }; remediation: string };
  };
}

function count(db: Database, sql: string): number {
  return db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM ${sql}`).get()?.c ?? 0;
}

function confirmedIncomplete(db: Database): ConfirmedIncomplete[] {
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
    return [];
  }

  const out: ConfirmedIncomplete[] = [];
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
    out.push({
      albumId: matchingLocalAlbums(db, j.artist_name, j.album_title)[0]?.id ?? null,
      artist: j.artist_name,
      album: j.album_title,
      expected: titles.length,
      owned: titles.length - missing,
      missing,
      lidarrAlbumId: j.lidarr_album_id,
      state: j.state,
    });
  }
  // Most completable first — one missing track is the cheapest win.
  return out.sort((a, b) => a.missing - b.missing);
}

export function libraryHealth(db: Database, opts: LibraryHealthOptions = {}): LibraryHealthReport {
  const sample = Math.min(50, Math.max(1, Math.trunc(opts.sampleSize ?? 10)));

  const audit = auditLibrary(db);
  const fragments = checkFragments(db);

  const albumCoverWorklist = db
    .query<{ id: string; name: string; artist: string; song_count: number }, [number]>(
      `SELECT id, name, artist, song_count FROM library_albums
       WHERE hidden = 0 AND ${missingAlbumArtSql()}
       ORDER BY song_count DESC, id LIMIT ?`,
    )
    .all(sample);

  const genreWhere = `library_songs WHERE landed_at IS NOT NULL AND ${unresolvedGenreSql()}`;
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

  const confirmed = confirmedIncomplete(db);

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
          missing: count(db, `library_albums WHERE hidden = 0 AND ${missingAlbumArtSql()}`),
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
          songs: count(db, 'library_songs WHERE landed_at IS NOT NULL'),
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
          })),
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
        metric: { confirmedIncomplete: confirmed.length, suspected: suspectedCount },
        worklist: {
          confirmed: confirmed.slice(0, sample),
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
      lyrics: {
        metric: {
          songs: count(db, 'library_songs WHERE landed_at IS NOT NULL'),
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
