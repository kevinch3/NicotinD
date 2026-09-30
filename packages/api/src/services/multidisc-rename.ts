import type { Database } from 'bun:sqlite';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, posix } from 'node:path';
import { songId } from './library-scanner.js';
import { isReservedPath } from './library-paths.js';
import { parseOrganizerStem, trackNumberPrefix } from './path-sanitize.js';
import {
  carrySongCuration,
  SONG_CARRY_TABLES,
  type SongCarryTable,
} from './song-curation-carry.js';
import { refreshAlbumAggregate } from './library-aggregates.js';

/**
 * Rename the existing library's multi-disc tracks to the organizer's `D-NN - Title`
 * shape (#1392), carrying every song-id-keyed row across the re-minted id.
 *
 * The organizer names *new* placements that way since #1393; this is the
 * one-off pass for files already on disk. A rename only changes the path, so
 * unlike the transcode pass it does not rescan: the song row is rewritten in
 * place under its new id, which keeps every column (starred, analysis, tag
 * edits) without depending on the file's tags parsing back identically.
 *
 * → docs/download-pipeline.md "Migrating existing multi-disc files"
 */

export interface RenameRow {
  id: string;
  path: string;
  disc: number | null;
  track: number | null;
  /** The tag title. A ` (N)` the title does not end in is `uniquePath`'s, not the song's. */
  title?: string | null;
}

export type SkipReason = 'unparsed' | 'no-disc' | 'disc-mismatch' | 'duplicate';

export interface PlannedRename {
  fromId: string;
  toId: string;
  /** Music-dir-relative, forward slashes, as `library_songs.path` holds it. */
  from: string;
  to: string;
  disc: number;
  /** A ` (N)` `uniquePath` suffix came off the name. */
  suffixStripped: boolean;
}

export interface RenamePlan {
  multiDiscFolders: number;
  alreadyDone: number;
  renames: PlannedRename[];
  skipped: { path: string; reason: SkipReason }[];
}

const SUFFIX = /^(.*\S) \((\d+)\)$/;

function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

/**
 * Only an `<Artist>/<Album>/<file>` placement carries a disc, matching the
 * organizer: `Singles/`, unsorted and every reserved path keep their names.
 */
function isAlbumPlacement(path: string, reserved: ReadonlySet<string>): boolean {
  const segs = path.split('/');
  return segs.length === 3 && segs[1] !== 'Singles' && !isReservedPath(path, reserved);
}

/**
 * Pure: decide every rename from the library rows alone.
 *
 * Deterministic in the rows, so re-planning mid-way through an apply yields the
 * remainder: a file already named `D-NN` for its own disc is done, and a
 * ` (2)` suffix is recognised by a sibling with the same track and base title
 * in *either* shape, so it still comes off after the sibling was renamed.
 */
export function planMultiDiscRenames(
  rows: readonly RenameRow[],
  reserved: ReadonlySet<string>,
): RenamePlan {
  const plan: RenamePlan = { multiDiscFolders: 0, alreadyDone: 0, renames: [], skipped: [] };
  const folders = new Map<string, RenameRow[]>();
  for (const r of rows) {
    if (!isAlbumPlacement(r.path, reserved)) continue;
    const dir = posix.dirname(r.path);
    const list = folders.get(dir);
    if (list) list.push(r);
    else folders.set(dir, [r]);
  }

  for (const [dir, list] of folders) {
    // `isMultiDiscRelease` over the rows; the scanner stores no disc total, so
    // a folder holding only disc 1 of a set stays as it is — it has nothing to
    // collide with.
    if (!list.some((r) => (r.disc ?? 0) > 1)) continue;
    plan.multiDiscFolders += 1;

    const parsed = list.map((r) => {
      const { stem, ext } = splitExt(posix.basename(r.path));
      return { row: r, ext, own: parseOrganizerStem(stem) };
    });
    const siblingKeys = new Set(
      parsed.filter((p) => p.own).map((p) => `${p.own!.track}\u0000${p.own!.title}`),
    );

    const proposals: PlannedRename[] = [];
    for (const { row, ext, own } of parsed) {
      if (!own) {
        plan.skipped.push({ path: row.path, reason: 'unparsed' });
        continue;
      }
      if (!row.disc || row.disc < 1) {
        plan.skipped.push({ path: row.path, reason: 'no-disc' });
        continue;
      }
      if (own.disc !== undefined) {
        if (own.disc === row.disc) plan.alreadyDone += 1;
        else plan.skipped.push({ path: row.path, reason: 'disc-mismatch' });
        continue;
      }
      let title = own.title;
      let suffixStripped = false;
      const m = title.match(SUFFIX);
      // `uniquePath` appends ` (N)` to the whole stem. It is its suffix, not the
      // song's, when a sibling still holds the unsuffixed name, or when the tag
      // title does not end in it (the sibling it dodged has since gone).
      const notInTitle =
        typeof row.title === 'string' &&
        row.title !== '' &&
        !row.title.trimEnd().endsWith(`(${m?.[2]})`);
      if (m && Number(m[2]) >= 2 && (siblingKeys.has(`${own.track}\u0000${m[1]}`) || notInTitle)) {
        title = m[1]!;
        suffixStripped = true;
      }
      const to = `${dir}/${trackNumberPrefix(own.track, row.disc)}${title}${ext}`;
      proposals.push({
        fromId: row.id,
        toId: songId(to),
        from: row.path,
        to,
        disc: row.disc,
        suffixStripped,
      });
    }

    // No two sources onto one target, and no target another row already holds:
    // either is a same-disc duplicate, which is dedupe's job, not a rename's.
    const held = new Set(list.map((r) => r.path));
    const byTarget = new Map<string, PlannedRename[]>();
    for (const p of proposals) {
      const group = byTarget.get(p.to);
      if (group) group.push(p);
      else byTarget.set(p.to, [p]);
    }
    for (const p of proposals) {
      if (byTarget.get(p.to)!.length > 1 || held.has(p.to)) {
        plan.skipped.push({ path: p.from, reason: 'duplicate' });
      } else {
        plan.renames.push(p);
      }
    }
  }
  return plan;
}

/**
 * Where one rename stands on disk. Every state but `missing`/`conflict` is a
 * point the apply can continue from, so a crash at any step resumes:
 * `pending` (untouched) → `linked` (hard link made, source still there) →
 * `moved` (source gone, DB not yet carried).
 */
export type StageState = 'pending' | 'linked' | 'moved' | 'missing' | 'conflict';

export interface StagedRename extends PlannedRename {
  state: StageState;
}

export interface Staged {
  ready: StagedRename[];
  unresolved: StagedRename[];
}

function sameFile(a: string, b: string): boolean {
  const sa = statSync(a);
  const sb = statSync(b);
  return sa.ino === sb.ino && sa.dev === sb.dev;
}

/** Resolve every planned path against the filesystem the apply will run on. */
export function stageRenames(renames: readonly PlannedRename[], musicDir: string): Staged {
  const out: Staged = { ready: [], unresolved: [] };
  for (const r of renames) {
    const src = join(musicDir, r.from);
    const dst = join(musicDir, r.to);
    const hasSrc = existsSync(src);
    const hasDst = existsSync(dst);
    let state: StageState;
    if (hasSrc && !hasDst) state = 'pending';
    else if (hasSrc && hasDst) state = sameFile(src, dst) ? 'linked' : 'conflict';
    else if (hasDst) state = 'moved';
    else state = 'missing';
    (state === 'missing' || state === 'conflict' ? out.unresolved : out.ready).push({
      ...r,
      state,
    });
  }
  return out;
}

/**
 * Song-keyed tables a *rename* moves beyond `SONG_CARRY_TABLES`.
 *
 * `carrySongCuration` exempts these because its other callers re-encode or
 * re-scan: the scan rebuilds artists and genres, and a new encode is a new file
 * for the failure ledger. A rename rescans nothing and the file is the same
 * bytes, so each of these would otherwise just be lost. `play_events` moves
 * too: its snapshot columns defend history *text*, but play counts and the
 * recently-played demotion join on `song_id`.
 */
export const RENAME_ALSO_MOVES: readonly SongCarryTable[] = [
  {
    table: 'library_song_artists',
    column: 'song_id',
    why: 'not rebuilt: a rename does not rescan',
  },
  { table: 'library_song_genres', column: 'song_id', why: 'not rebuilt: a rename does not rescan' },
  {
    table: 'library_song_analysis_failures',
    column: 'song_id',
    why: 'same bytes, same outcome; dropping it re-runs a known failure',
  },
  {
    table: 'library_pending_tag_writes',
    column: 'song_id',
    why: 'the row is rewritten, not rebuilt from tags, so the pending writes still apply',
  },
  { table: 'play_events', column: 'song_id', why: 'play counts and recency join on song_id' },
  {
    table: 'acquisition_job_items',
    column: 'song_id',
    why: 'addon playlists resolve a job item to its song through this column',
  },
  {
    table: 'curation_flags',
    column: 'target_id',
    why: "an open flag on the song (target_kind 'song')",
  },
  {
    table: 'curation_flag_reports',
    column: 'target_id',
    why: "a listener's report on the song (target_kind 'song')",
  },
];

/** Song-keyed columns a rename deliberately leaves. Each is a record, not a link. */
export const RENAME_KEEPS: readonly SongCarryTable[] = [
  { table: 'radio_poll_scenarios', column: 'seed_song_id', why: 'a recorded measurement' },
  { table: 'radio_poll_votes', column: 'candidate_song_id', why: 'a recorded measurement' },
  {
    table: 'library_song_provenance',
    column: 'song_path',
    why: 'a log of what was applied to the file at that path, at the time',
  },
  { table: 'audit_log', column: 'target_id', why: 'an audit trail records what was true then' },
];

function tableExists(db: Database, table: string): boolean {
  return !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
}

export interface IdentityMove {
  fromId: string;
  toId: string;
  from: string;
  to: string;
}

export interface IdentityMoveResult {
  /** False when there was no row at `fromId` — already migrated, or pruned. */
  rowMoved: boolean;
  moved: Record<string, number>;
}

/**
 * Move one song onto its new path and id. Caller supplies the transaction.
 * Idempotent: every statement is keyed on `fromId`/`from`, so a second call
 * finds nothing left to move.
 */
export function migrateSongIdentity(db: Database, m: IdentityMove): IdentityMoveResult {
  const result: IdentityMoveResult = { rowMoved: false, moved: {} };
  if (m.fromId === m.toId) return result;
  const old = db
    .query<{ album_id: string | null }, [string]>('SELECT album_id FROM library_songs WHERE id = ?')
    .get(m.fromId);

  if (old) {
    // A scan may have minted the new id bare in the window between the rename
    // and this step; the old row carries the curation, so it wins.
    db.run('DELETE FROM library_songs WHERE id = ?', [m.toId]);
    const cols = db
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('library_songs')`)
      .all()
      .map((c) => c.name);
    const select = cols.map((c) => (c === 'id' ? '?' : c === 'path' ? '?' : c)).join(', ');
    db.run(
      `INSERT INTO library_songs (${cols.join(', ')}) SELECT ${select} FROM library_songs WHERE id = ?`,
      [
        ...cols.flatMap((c) => (c === 'id' ? [m.toId] : c === 'path' ? [m.to] : [])),
        m.fromId,
      ] as string[],
    );
    db.run('DELETE FROM library_songs WHERE id = ?', [m.fromId]);
    result.rowMoved = true;
  }

  const carried = carrySongCuration(db, {
    fromId: m.fromId,
    toId: m.toId,
    fromPath: m.from,
    toPath: m.to,
  });
  Object.assign(result.moved, carried.moved);

  for (const e of RENAME_ALSO_MOVES) {
    if (!tableExists(db, e.table)) continue;
    const scope = e.column === 'target_id' ? ` AND target_kind = 'song'` : '';
    const upd = db.run(
      `UPDATE OR IGNORE ${e.table} SET ${e.column} = ? WHERE ${e.column} = ?${scope}`,
      [m.toId, m.fromId],
    );
    db.run(`DELETE FROM ${e.table} WHERE ${e.column} = ?${scope}`, [m.fromId]);
    if (Number(upd.changes ?? 0) > 0) result.moved[e.table] = Number(upd.changes);
  }
  if (tableExists(db, 'acquisition_job_items')) {
    db.run('UPDATE acquisition_job_items SET relative_path = ? WHERE relative_path = ?', [
      m.to,
      m.from,
    ]);
  }
  // The cached track embeds its old relPath, so moving the row would make the
  // next scan re-mint the old id. Dropped: the next scan re-parses the file once.
  db.run('DELETE FROM scan_cache WHERE path = ?', [m.from]);

  if (old?.album_id) refreshAlbumAggregate(db, old.album_id);
  return result;
}

/**
 * Rows keyed on `ids` in every table a rename moves, plus `library_songs`
 * itself and the song-scope genre overrides. Read-only; the before/after pair
 * is the evidence that nothing was lost.
 */
export function countCarriedRows(db: Database, ids: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const specs: { table: string; column: string; scope?: string }[] = [
    { table: 'library_songs', column: 'id' },
    ...SONG_CARRY_TABLES,
    ...RENAME_ALSO_MOVES.map((e) =>
      e.column === 'target_id' ? { ...e, scope: ` AND target_kind = 'song'` } : e,
    ),
    { table: 'library_genre_overrides', column: 'key', scope: ` AND scope = 'song'` },
  ];
  for (const spec of specs) {
    if (!tableExists(db, spec.table)) continue;
    let n = 0;
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400) as string[];
      const row = db
        .query<{ c: number }, string[]>(
          `SELECT COUNT(*) AS c FROM ${spec.table}
            WHERE ${spec.column} IN (${chunk.map(() => '?').join(',')})${spec.scope ?? ''}`,
        )
        .get(...chunk);
      n += row?.c ?? 0;
    }
    out[spec.table] = n;
  }
  return out;
}

export interface JournalEntry {
  event: 'begin' | 'done';
  from: string;
  to: string;
  fromId: string;
  toId: string;
  at: number;
}

function journalAppend(path: string, e: JournalEntry): void {
  appendFileSync(path, JSON.stringify(e) + '\n');
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface ApplyResult {
  applied: number;
  moved: Record<string, number>;
}

/**
 * Apply staged renames, serially. Per file: journal `begin` → hard-link to the
 * target (fails rather than clobbers) → unlink the source → one DB transaction
 * → journal `done`. The disk step comes first so the DB never names a path
 * that does not exist yet; a crash leaves a state `stageRenames` resumes from.
 * Refuses outright when any entry is unresolved.
 */
export function applyRenames(
  db: Database,
  musicDir: string,
  staged: Staged,
  journalPath: string,
  onProgress?: (done: number, total: number) => void,
): ApplyResult {
  if (staged.unresolved.length > 0) {
    throw new Error(
      `${staged.unresolved.length} unresolved rename(s) — a missing source or an occupied ` +
        `target; nothing was applied`,
    );
  }
  const result: ApplyResult = { applied: 0, moved: {} };
  for (const r of staged.ready) {
    const src = join(musicDir, r.from);
    const dst = join(musicDir, r.to);
    const ids = { from: r.from, to: r.to, fromId: r.fromId, toId: r.toId };
    journalAppend(journalPath, { event: 'begin', ...ids, at: Date.now() });
    if (r.state === 'pending') linkSync(src, dst);
    if (r.state === 'pending' || r.state === 'linked') unlinkSync(src);
    const moved = db.transaction(() => migrateSongIdentity(db, r))();
    for (const [t, n] of Object.entries(moved.moved)) result.moved[t] = (result.moved[t] ?? 0) + n;
    journalAppend(journalPath, { event: 'done', ...ids, at: Date.now() });
    result.applied += 1;
    onProgress?.(result.applied, staged.ready.length);
  }
  return result;
}

/** Every rename a journal records as `done`, in order. */
export function readJournal(journalPath: string): PlannedRename[] {
  const done: PlannedRename[] = [];
  for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as JournalEntry;
    if (e.event === 'done') {
      done.push({
        fromId: e.fromId,
        toId: e.toId,
        from: e.from,
        to: e.to,
        disc: 0,
        suffixStripped: false,
      });
    }
  }
  return done;
}

/**
 * Undo a run from its journal: the same staged, resumable apply with each
 * rename reversed, so the ids — and everything carried onto them — go back too.
 * Writes its own journal next to the original.
 */
export function revertRenames(db: Database, musicDir: string, journalPath: string): ApplyResult {
  const reversed = readJournal(journalPath)
    .reverse()
    .map((r) => ({ ...r, from: r.to, to: r.from, fromId: r.toId, toId: r.fromId }));
  return applyRenames(db, musicDir, stageRenames(reversed, musicDir), `${journalPath}.revert`);
}
