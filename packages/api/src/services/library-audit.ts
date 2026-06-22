import type { Database } from 'bun:sqlite';
import { isUnknownLike } from './audio-tags.js';
import { isPlaceholderArtist } from './artwork-backfill.js';
import { normalizeForGrouping } from './album-grouping.js';
import { looksLikeSourceWatermark, isNumericLikeName } from './library-quality.js';

/**
 * Library quality auditor — asserts that the canonical `library_*` tables (and,
 * via the CLI, the music dir on disk) are reliable: free of DJ-pool/VA-source
 * pollution, internally consistent (aggregate counts + foreign refs), and
 * renderable (year/artwork present). Pure DB logic so it's unit-testable with an
 * in-memory database; disk-level findings are produced by the CLI and merged in
 * via `summarize`.
 *
 * Each rule emits zero or more `AuditFinding`s. `auditLibrary` runs them all and
 * `summarize`s into a report whose `ok` flag is false when any HIGH-severity
 * finding exists — the CLI exits non-zero on that, so it can gate a scheduled
 * check. → See docs/library-audit.md.
 */

export type AuditSeverity = 'high' | 'medium' | 'low';

export interface AuditFinding {
  /** Stable rule id, e.g. `watermark_artist`. */
  rule: string;
  severity: AuditSeverity;
  /** The offending id/name/path so the report (and repair) can act on it. */
  subject: string;
  message: string;
}

export interface AuditReport {
  findings: AuditFinding[];
  summary: { rule: string; severity: AuditSeverity; count: number }[];
  totals: { artists: number; albums: number; songs: number; visibleSingles: number };
  highSeverityCount: number;
  /** True when there are no HIGH-severity findings. */
  ok: boolean;
}

interface ArtistRow {
  id: string;
  name: string;
  album_count: number;
}
interface AlbumRow {
  id: string;
  name: string;
  artist: string;
  artist_id: string;
  song_count: number;
  classification: string;
  hidden: number;
  year: number | null;
  cover_art: string | null;
}

// ---------------------------------------------------------------------------
// Integrity rules
// ---------------------------------------------------------------------------

/** Artist.album_count drift + artists orphaned with zero releases & songs. */
export function checkArtistIntegrity(db: Database): AuditFinding[] {
  const out: AuditFinding[] = [];
  const artists = db.query<ArtistRow, []>('SELECT id, name, album_count FROM library_artists').all();
  for (const a of artists) {
    const albums =
      db
        .query<{ c: number }, [string]>('SELECT COUNT(*) c FROM library_albums WHERE artist_id = ?')
        .get(a.id)?.c ?? 0;
    const songs =
      db
        .query<{ c: number }, [string]>('SELECT COUNT(*) c FROM library_songs WHERE artist_id = ?')
        .get(a.id)?.c ?? 0;
    if (albums === 0 && songs === 0) {
      out.push({
        rule: 'orphan_artist',
        severity: 'medium',
        subject: a.id,
        message: `Artist "${a.name}" has no albums and no songs (should be pruned)`,
      });
      continue;
    }
    if (a.album_count !== albums) {
      out.push({
        rule: 'album_count_mismatch',
        severity: 'high',
        subject: a.id,
        message: `Artist "${a.name}" album_count=${a.album_count} but has ${albums} albums`,
      });
    }
  }
  return out;
}

/** Album.song_count drift + albums/songs referencing a missing parent row. */
export function checkAlbumIntegrity(db: Database): AuditFinding[] {
  const out: AuditFinding[] = [];
  const albums = db
    .query<
      { id: string; name: string; song_count: number; artist_id: string },
      []
    >('SELECT id, name, song_count, artist_id FROM library_albums')
    .all();
  for (const al of albums) {
    const songs =
      db
        .query<{ c: number }, [string]>('SELECT COUNT(*) c FROM library_songs WHERE album_id = ?')
        .get(al.id)?.c ?? 0;
    if (al.song_count !== songs) {
      out.push({
        rule: 'album_song_count_mismatch',
        severity: 'high',
        subject: al.id,
        message: `Album "${al.name}" song_count=${al.song_count} but has ${songs} songs`,
      });
    }
    const hasArtist =
      db
        .query<{ c: number }, [string]>('SELECT COUNT(*) c FROM library_artists WHERE id = ?')
        .get(al.artist_id)?.c ?? 0;
    if (!hasArtist) {
      out.push({
        rule: 'dangling_album_artist',
        severity: 'high',
        subject: al.id,
        message: `Album "${al.name}" references missing artist_id ${al.artist_id}`,
      });
    }
  }
  // Songs whose album_id has no album row.
  const orphanSongs = db
    .query<
      { id: string; title: string; album_id: string },
      []
    >(
      `SELECT s.id, s.title, s.album_id FROM library_songs s
       WHERE NOT EXISTS (SELECT 1 FROM library_albums a WHERE a.id = s.album_id)`,
    )
    .all();
  for (const s of orphanSongs) {
    out.push({
      rule: 'dangling_song_album',
      severity: 'high',
      subject: s.id,
      message: `Song "${s.title}" references missing album_id ${s.album_id}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pollution rules
// ---------------------------------------------------------------------------

/** Artists whose name is a DJ-pool/VA-source watermark or a bare number. */
export function checkPollutedArtists(db: Database): AuditFinding[] {
  const out: AuditFinding[] = [];
  const artists = db.query<ArtistRow, []>('SELECT id, name, album_count FROM library_artists').all();
  for (const a of artists) {
    if (looksLikeSourceWatermark(a.name)) {
      out.push({
        rule: 'watermark_artist',
        severity: 'high',
        subject: a.id,
        message: `Artist "${a.name}" is a DJ-pool/VA-source watermark, not a real artist`,
      });
    } else if (isNumericLikeName(a.name)) {
      out.push({
        rule: 'numeric_artist',
        severity: 'high',
        subject: a.id,
        message: `Artist "${a.name}" is a bare/disc-track number (mis-parsed tag)`,
      });
    }
  }
  return out;
}

/**
 * Polluted albums: watermark album titles, numeric single-track "albums" (a
 * single called a number), and visible singles whose artist is a placeholder /
 * unknown. Multi-track albums with a numeric title (e.g. "1989") are NOT flagged.
 */
export function checkPollutedAlbums(db: Database): AuditFinding[] {
  // Detection is hidden-agnostic on purpose: the curator may auto-hide watermark
  // pollution (good for the UI), but it's still DB/disk bloat the cleanup pass
  // must be able to find and delete. Render rules below stay visible-only.
  const out: AuditFinding[] = [];
  const albums = loadAlbums(db);
  for (const al of albums) {
    if (looksLikeSourceWatermark(al.name)) {
      out.push({
        rule: 'watermark_album',
        severity: 'high',
        subject: al.id,
        message: `Album "${al.name}" (${al.artist}) is a source watermark, not a real release`,
      });
      continue;
    }
    if (al.song_count <= 1 && isNumericLikeName(al.name)) {
      out.push({
        rule: 'numeric_single',
        severity: 'high',
        subject: al.id,
        message: `Single "${al.name}" (${al.artist}) is a track-number-titled one-track album`,
      });
      continue;
    }
    if (al.classification === 'single' && (isPlaceholderArtist(al.artist) || isUnknownLike(al.name))) {
      out.push({
        rule: 'placeholder_single',
        severity: 'medium',
        subject: al.id,
        message: `Single "${al.name}" has a placeholder/unknown identity (artist "${al.artist}")`,
      });
    }
  }
  return out;
}

/**
 * Mis-split albums: ≥3 visible singles sharing the same edition-stripped name
 * (`normalizeForGrouping`) — a real album fragmented one-track-per-single because
 * each track's tags differ (often a numeric per-track artist). One finding per
 * cluster, listing the shared title + member count.
 */
export function checkMisSplitAlbums(db: Database): AuditFinding[] {
  // Hidden-agnostic (see checkPollutedAlbums): a watermark-named mis-split the
  // curator already hid is still a real-or-junk cluster the cleanup must reason about.
  const out: AuditFinding[] = [];
  const singles = loadAlbums(db).filter((a) => a.classification === 'single');
  const clusters = new Map<string, AlbumRow[]>();
  for (const s of singles) {
    const key = normalizeForGrouping(s.name);
    if (!key) continue;
    const arr = clusters.get(key);
    if (arr) arr.push(s);
    else clusters.set(key, [s]);
  }
  for (const [key, members] of clusters) {
    if (members.length < 3) continue;
    out.push({
      rule: 'missplit_album',
      severity: 'high',
      subject: key,
      message: `"${members[0]!.name}" is split into ${members.length} one-track singles (mis-tagged album)`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Render rules
// ---------------------------------------------------------------------------

/** Visible albums missing a usable year, artwork, or stuck at 'unknown'. */
export function checkRenderGaps(db: Database): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const al of loadAlbums(db)) {
    if (al.hidden) continue;
    if (al.year == null || al.year <= 1) {
      out.push({
        rule: 'missing_year',
        severity: 'low',
        subject: al.id,
        message: `Album "${al.name}" (${al.artist}) has no year`,
      });
    }
    const hasArtwork =
      db
        .query<{ c: number }, [string]>('SELECT COUNT(*) c FROM library_artwork WHERE id = ?')
        .get(al.id)?.c ?? 0;
    if (!hasArtwork && !al.cover_art) {
      out.push({
        rule: 'missing_artwork',
        severity: 'medium',
        subject: al.id,
        message: `Album "${al.name}" (${al.artist}) has no artwork`,
      });
    }
    if (al.classification === 'unknown') {
      out.push({
        rule: 'visible_unknown',
        severity: 'medium',
        subject: al.id,
        message: `Album "${al.name}" (${al.artist}) is visible but classified 'unknown'`,
      });
    }
  }
  return out;
}

function loadAlbums(db: Database): AlbumRow[] {
  return db
    .query<AlbumRow, []>(
      `SELECT id, name, artist, artist_id, song_count, classification, hidden, year, cover_art
       FROM library_albums`,
    )
    .all();
}

/** Build the report (totals + summary + ok) from a flat finding list. */
export function summarize(db: Database, findings: AuditFinding[]): AuditReport {
  const counts = new Map<string, { severity: AuditSeverity; count: number }>();
  for (const f of findings) {
    const prev = counts.get(f.rule);
    if (prev) prev.count++;
    else counts.set(f.rule, { severity: f.severity, count: 1 });
  }
  const summary = [...counts.entries()]
    .map(([rule, v]) => ({ rule, severity: v.severity, count: v.count }))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.count - a.count);
  const highSeverityCount = findings.filter((f) => f.severity === 'high').length;
  const totals = {
    artists: db.query<{ c: number }, []>('SELECT COUNT(*) c FROM library_artists').get()?.c ?? 0,
    albums: db.query<{ c: number }, []>('SELECT COUNT(*) c FROM library_albums').get()?.c ?? 0,
    songs: db.query<{ c: number }, []>('SELECT COUNT(*) c FROM library_songs').get()?.c ?? 0,
    visibleSingles:
      db
        .query<
          { c: number },
          []
        >(`SELECT COUNT(*) c FROM library_albums WHERE classification='single' AND hidden=0`)
        .get()?.c ?? 0,
  };
  return { findings, summary, totals, highSeverityCount, ok: highSeverityCount === 0 };
}

function severityRank(s: AuditSeverity): number {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Cleanup target selection (used by scripts/repair-pollution.ts)
// ---------------------------------------------------------------------------

/**
 * Rules whose albums are safe to **delete** outright (the metadata identity is
 * junk, not a recoverable release). Deliberately EXCLUDES `numeric_artist` and
 * `missplit_album`: those are real albums that were mis-split per-track (e.g. an
 * opera tagged with numeric per-track artists) — deleting them would lose real
 * music, so they are protected and routed to manual re-tagging instead.
 */
export type DeletableRule =
  | 'watermark_artist'
  | 'watermark_album'
  | 'numeric_single'
  | 'placeholder_single';

export const DELETABLE_RULES: DeletableRule[] = [
  'watermark_artist',
  'watermark_album',
  'numeric_single',
  'placeholder_single',
];

export interface PollutionTarget {
  albumId: string;
  artistId: string;
  name: string;
  artist: string;
  rules: string[];
}

/**
 * Resolve the chosen pollution `rules` into a deduped list of album rows to
 * delete, **always protecting mis-split-cluster members** (a real album
 * fragmented into ≥3 one-track singles is never auto-deleted). `watermark_artist`
 * findings (whose subject is an artist id) expand to all that artist's albums.
 * Pure DB read — no writes — so the cleanup script can dry-run it.
 */
export function selectPollutionTargets(
  db: Database,
  rules: DeletableRule[],
): { targets: PollutionTarget[]; protectedMisSplit: number } {
  const report = auditLibrary(db);
  const albums = loadAlbums(db);
  const byId = new Map(albums.map((a) => [a.id, a]));
  const want = new Set(rules);

  // Protect mis-split clusters that represent a REAL release (single-artist album
  // fragmented per-track, or a real VA compilation) — these hold wanted music and
  // should be re-merged, not deleted. A mis-split whose shared title is itself a
  // source watermark (e.g. "MUSICAUNO.COM") is NOT protected: it's pure pollution
  // and stays deletable via the `watermark_album` rule.
  const protectedKeys = new Set(
    report.findings
      .filter((f) => f.rule === 'missplit_album')
      .map((f) => f.subject)
      .filter((key) => {
        const rep = albums.find((a) => normalizeForGrouping(a.name) === key);
        return rep != null && !looksLikeSourceWatermark(rep.name);
      }),
  );

  // Collect (albumId → matched rules), protecting mis-split members.
  const matched = new Map<string, Set<string>>();
  let protectedMisSplit = 0;
  const add = (albumId: string, rule: string): void => {
    const al = byId.get(albumId);
    if (!al) return;
    if (protectedKeys.has(normalizeForGrouping(al.name))) {
      protectedMisSplit++;
      return;
    }
    const set = matched.get(albumId) ?? new Set<string>();
    set.add(rule);
    matched.set(albumId, set);
  };

  for (const f of report.findings) {
    if (!want.has(f.rule as DeletableRule)) continue;
    if (f.rule === 'watermark_artist') {
      // subject is an artist id — expand to all its albums.
      for (const al of albums) if (al.artist_id === f.subject) add(al.id, f.rule);
    } else {
      add(f.subject, f.rule);
    }
  }

  const targets: PollutionTarget[] = [...matched.entries()].map(([albumId, rs]) => {
    const al = byId.get(albumId)!;
    return { albumId, artistId: al.artist_id, name: al.name, artist: al.artist, rules: [...rs] };
  });
  return { targets, protectedMisSplit };
}

/** Run every DB rule (plus any caller-supplied disk findings) into one report. */
export function auditLibrary(db: Database, extraFindings: AuditFinding[] = []): AuditReport {
  const findings = [
    ...checkArtistIntegrity(db),
    ...checkAlbumIntegrity(db),
    ...checkPollutedArtists(db),
    ...checkPollutedAlbums(db),
    ...checkMisSplitAlbums(db),
    ...checkRenderGaps(db),
    ...extraFindings,
  ];
  return summarize(db, findings);
}
