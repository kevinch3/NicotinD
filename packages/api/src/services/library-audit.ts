import type { Database } from 'bun:sqlite';
import { isUnknownLike } from './audio-tags.js';
import { isPlaceholderArtistStrict } from './artwork-backfill.js';
import { missingAlbumArtSql } from './artwork-store.js';
import { normalizeForGrouping } from './album-grouping.js';
import {
  looksLikeSourceWatermark,
  isNumericLikeName,
  looksLikeDjSetTag,
  looksLikeVenueCredit,
  djSetArtistName,
  findArtistFragmentClusters,
} from './library-quality.js';

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
  const artists = db
    .query<ArtistRow, []>('SELECT id, name, album_count FROM library_artists')
    .all();
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
    .query<{ id: string; name: string; song_count: number; artist_id: string }, []>(
      'SELECT id, name, song_count, artist_id FROM library_albums',
    )
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
    .query<{ id: string; title: string; album_id: string }, []>(
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

/**
 * True when the *artist* identity is itself junk — a source watermark, a bare
 * disc/track number, or a genuine placeholder. Used to corroborate album-level
 * rules: junk album metadata next to a REAL artist is usually a real release
 * with a bad tag, not pollution.
 */
function artistLooksJunk(artist: string | undefined | null): boolean {
  if (!artist) return true;
  return (
    looksLikeSourceWatermark(artist) ||
    isNumericLikeName(artist) ||
    isPlaceholderArtistStrict(artist)
  );
}

/** Artists whose name is a DJ-pool/VA-source watermark or a bare number. */
export function checkPollutedArtists(db: Database): AuditFinding[] {
  const out: AuditFinding[] = [];
  const artists = db
    .query<ArtistRow, []>('SELECT id, name, album_count FROM library_artists')
    .all();
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
    } else if (looksLikeDjSetTag(a.name) || looksLikeVenueCredit(a.name)) {
      // Issue #679. Deliberately NOT a `DeletableRule`: unlike a watermark, the
      // real artist is usually recoverable from the string, so the remediation
      // is a merge (see `djSetArtistName`) and never deleting the music.
      const suggestion = djSetArtistName(a.name);
      out.push({
        rule: 'djset_artist',
        severity: 'medium',
        subject: a.id,
        message:
          `Artist "${a.name}" is a DJ-set / release-listing line, not an artist` +
          (suggestion ? ` — merge into "${suggestion}"` : ' — needs a human decision'),
      });
    }
  }
  return out;
}

/**
 * Issue #864: artist rows that are one base name plus a per-track credit —
 * `Sanampay, V. PARRA`, `Luciano Pavarotti, Philharmonia Orchestra, Piero Gamba`.
 * A per-track credit list mints one artist row per track, so a single album
 * arrives as a dozen tiles in the artists grid and no other rule sees it: the
 * fragmentation detectors key on album *title*, and every pollution predicate
 * judges a name on its own, which cannot separate these from a real duo.
 *
 * Reported against the **base** row so the finding names what to merge into.
 */
export function checkFragmentedArtists(db: Database): AuditFinding[] {
  const rows = db
    .query<{ id: string; name: string }, []>('SELECT id, name FROM library_artists')
    .all();
  const idByName = new Map(rows.map((r) => [r.name, r.id]));

  return findArtistFragmentClusters(
    rows.map((r) => r.name),
    2,
  ).map((c) => ({
    rule: 'fragmented_artist',
    severity: 'medium' as const,
    subject: idByName.get(c.base) ?? c.base,
    message:
      `Artist "${c.base}" has ${c.fragments.length} rows extending it with a per-track credit ` +
      `(${c.fragments.slice(0, 3).join('; ')}${c.fragments.length > 3 ? '; …' : ''}) — ` +
      `confirm each is not a real collaboration, then merge into "${c.base}"`,
  }));
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
    // A domain-shaped title is not decisive on its own: some real releases are
    // genuinely named after a domain (issue #819 — Coolio's 2001 album is titled
    // "coolio.com", and it was 1 of only 3 findings on prod, so a third of a
    // high-severity bucket was false). Corroborate the way `numeric_single`
    // below already does, but on three axes at once rather than the artist
    // alone: the two genuine prod hits both have REAL artists and at least one
    // real track title, so either signal by itself would suppress them too and
    // take the rule to zero findings.
    //
    // What separates them is that a real release is real on every axis at once
    // — more than one track, real titles on them, and an artist that is not
    // itself junk. A pool rip is missing at least one (both genuine hits are
    // single-track). An album that somehow clears all three and still carries a
    // watermark title is a real release with a bad album tag, whose remediation
    // is a retag, never the delete this rule feeds.
    if (looksLikeSourceWatermark(al.name) && !looksLikeRealRelease(db, al)) {
      out.push({
        rule: 'watermark_album',
        severity: 'high',
        subject: al.id,
        message: `Album "${al.name}" (${al.artist}) is a source watermark, not a real release`,
      });
      continue;
    }
    // A one-track album with a numeric title is EXACTLY what a real numeric-titled
    // single looks like ("777" by Latto, "2000" by Manuel Turizo, "666", "222").
    // The track-count guard the predicate's docblock recommends cannot separate the
    // two, so require the *artist* to be junk as well: a mis-parsed disc/track
    // number lands next to a mis-parsed artist, whereas a real single has a real
    // one. (Issue #705 — all five numeric singles flagged on prod were real.)
    if (al.song_count <= 1 && isNumericLikeName(al.name) && artistLooksJunk(al.artist)) {
      out.push({
        rule: 'numeric_single',
        severity: 'high',
        subject: al.id,
        message: `Single "${al.name}" (${al.artist}) is a track-number-titled one-track album`,
      });
      continue;
    }
    // `isPlaceholderArtistStrict`, not `isPlaceholderArtist`: the latter answers
    // "is this usable as a Lidarr query key?", under which the real band `!!!`
    // (and, before the normalizeName fix, every non-Latin-script artist) reads as
    // a placeholder. Deleting on that answer destroyed real music (issue #705).
    if (
      al.classification === 'single' &&
      (isPlaceholderArtistStrict(al.artist) || isUnknownLike(al.name))
    ) {
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
 *
 * A shared *title* is not evidence of a shared *release* (issues #875, #881): all
 * 4 clusters flagged on prod before this guard — "Closer" (Adriatique / Christian
 * Löffler / The Chainsmokers), "Baila Conmigo" (Jennifer Lopez / Rafa Barrios /
 * Tiësto), "20 Grandes Exitos", "Pensando en Tí" — were coincidental title
 * collisions across genuinely unrelated artists' own singles, landed months
 * apart. #881's own suggested fix — require the members to share/overlap an
 * artist — is backwards: the two genuine prod clusters (the Piazzolla opera,
 * "DUSK VA010") have a **different**, often numeric, per-track artist on every
 * member BY CONSTRUCTION — that's exactly why they're mis-split in the first
 * place, so an artist-agreement gate would take this rule to zero findings.
 *
 * What actually separates them is the members' original **track number**
 * (`library_songs.track`, not carried on `AlbumRow` — one extra batched query,
 * cheap because it only runs for candidate clusters already at ≥3 members): a
 * real split release keeps each track's number from the original release (92,
 * 97, 99 on "Latin Only"; 2, 3, 8 on "DUSK VA010"), while a single is tagged
 * track 1 — or not tagged at all — essentially always, so a false-positive
 * cluster's members carry the same (or absent) track number. Requiring the
 * cluster's track numbers to be genuinely distinct — not all-identical/all-null
 * — removes all 4 known false positives while keeping both known true positives.
 * `library-audit.test.ts` asserts both directions so this doesn't regress.
 */
export function checkMisSplitAlbums(db: Database): AuditFinding[] {
  // Hidden-agnostic (see checkPollutedAlbums): a watermark-named mis-split the
  // curator already hid is still a real-or-junk cluster the cleanup must reason about.
  //
  // `song_count <= 1` is required, not assumed: `classification === 'single'` is
  // metadata-driven (`contradictsTrackCount`/`IMPLAUSIBLE_SHORT_RELEASE_TRACKS` in
  // library-curator.ts lets it hold up to 9 songs), and the per-album track lookup
  // below is a plain `Map` that keeps only the last SQL-returned row per album_id —
  // safe only when each candidate has at most one `library_songs` row to contribute.
  // Without this floor, a multi-song "single" cluster's Map-captured value becomes
  // order-dependent rather than a real per-track-number signal, reintroducing the
  // false-positive class this rule exists to close.
  const singles = loadAlbums(db).filter((a) => a.classification === 'single' && a.song_count <= 1);
  const clusters = new Map<string, AlbumRow[]>();
  for (const s of singles) {
    const key = normalizeForGrouping(s.name);
    if (!key) continue;
    const arr = clusters.get(key);
    if (arr) arr.push(s);
    else clusters.set(key, [s]);
  }
  const candidates = [...clusters.entries()].filter(([, members]) => members.length >= 3);
  if (candidates.length === 0) return [];

  // Every candidate is a one-song single (enforced above), so one query
  // covers every member across every candidate cluster at once.
  const candidateIds = candidates.flatMap(([, members]) => members.map((m) => m.id));
  const trackByAlbumId = new Map<string, number | null>(
    db
      .query<{ album_id: string; track: number | null }, string[]>(
        `SELECT album_id, track FROM library_songs WHERE album_id IN (${candidateIds.map(() => '?').join(',')})`,
      )
      .all(...candidateIds)
      .map((r) => [r.album_id, r.track]),
  );

  const out: AuditFinding[] = [];
  for (const [key, members] of candidates) {
    // A null track (untagged) carries the same "undifferentiated" signal as a
    // shared track=1, so distinctness is judged over the non-null values only —
    // a lone real value shared by every member (or absent everywhere) must not
    // read as corroboration just because a null sorts differently from it.
    const distinctTracks = new Set(
      members.map((m) => trackByAlbumId.get(m.id)).filter((t): t is number => t != null),
    );
    if (distinctTracks.size < 2) continue; // all-identical/all-null: not corroborated as one release
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
  // "No artwork" = no canonical row (issue #732). `cover_art` is NOT art — the
  // scanner fills it with the album id unconditionally.
  const missingArt = new Set(
    db
      .query<{ id: string }, []>(`SELECT id FROM library_albums WHERE ${missingAlbumArtSql()}`)
      .all()
      .map((r) => r.id),
  );
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
    if (missingArt.has(al.id)) {
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
        .query<{ c: number }, []>(
          `SELECT COUNT(*) c FROM library_albums WHERE classification='single' AND hidden=0`,
        )
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
  'watermark_artist' | 'watermark_album' | 'numeric_single' | 'placeholder_single';

export const DELETABLE_RULES: DeletableRule[] = [
  'watermark_artist',
  'watermark_album',
  'numeric_single',
  'placeholder_single',
];

/**
 * True when at least one of the album's tracks carries a real title — meaning
 * there is music here worth keeping regardless of how junk the album or artist
 * name is. A genuine dumping ground names its files after the watermark or a
 * bare number, so it has no real titles and stays deletable.
 */
function albumHasRealTrackTitles(db: Database, albumId: string): boolean {
  const rows = db
    .query<{ title: string | null }, [string]>('SELECT title FROM library_songs WHERE album_id = ?')
    .all(albumId);
  return rows.some(({ title }) => {
    if (!title || !title.trim()) return false;
    return !looksLikeSourceWatermark(title) && !isNumericLikeName(title);
  });
}

/**
 * True when the album looks like a genuine release on every axis at once, so a
 * watermark-shaped *title* is more likely a real name than pollution (#819).
 * All three are required together — each alone is satisfied by known real
 * pollution, and the conjunction is what the prod data actually separates on.
 */
function looksLikeRealRelease(db: Database, al: AlbumRow): boolean {
  return al.song_count > 1 && albumHasRealTrackTitles(db, al.id) && !artistLooksJunk(al.artist);
}

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
): { targets: PollutionTarget[]; protectedMisSplit: number; protectedRealAudio: number } {
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
  let protectedRealAudio = 0;
  const add = (albumId: string, rule: string): void => {
    const al = byId.get(albumId);
    if (!al) return;
    if (protectedKeys.has(normalizeForGrouping(al.name))) {
      protectedMisSplit++;
      return;
    }
    // Junk METADATA is not junk AUDIO. Every rule here judges an album or artist
    // *name*, but the thing `--apply` destroys is the files. `You Love Dance.TV`
    // is a genuine DJ-pool watermark — and it held a real 4 Strings track, so the
    // right remediation was a retag, not a delete. Anything whose own tracks carry
    // real titles is protected and left for manual re-tagging. (Issue #705: on the
    // prod library this protected 100% of the flagged targets, which is the honest
    // answer — these rules cannot by themselves identify deletable audio.)
    if (albumHasRealTrackTitles(db, albumId)) {
      protectedRealAudio++;
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
  return { targets, protectedMisSplit, protectedRealAudio };
}

/** Run every DB rule (plus any caller-supplied disk findings) into one report. */
export function auditLibrary(db: Database, extraFindings: AuditFinding[] = []): AuditReport {
  const findings = [
    ...checkArtistIntegrity(db),
    ...checkAlbumIntegrity(db),
    ...checkPollutedArtists(db),
    ...checkFragmentedArtists(db),
    ...checkPollutedAlbums(db),
    ...checkMisSplitAlbums(db),
    ...checkRenderGaps(db),
    ...extraFindings,
  ];
  return summarize(db, findings);
}
