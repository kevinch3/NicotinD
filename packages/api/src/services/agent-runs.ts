import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeAudioTags } from './audio-tags.js';
import { resolveCurationFlag } from './curation-flags.js';
import {
  deleteGenreOverride,
  getGenreOverride,
  upsertGenreOverride,
  type GenreOverrideRow,
} from './genre-overrides.js';
import { genreKey, loadGenreSets, setSongGenres } from './genre-split.js';
import { libraryEvents } from './library-events.js';
import { expandDir, isUnderMusicDir, resolveSongPath } from './song-path.js';

/**
 * Unattended agent runs (#1516 P2, docs/mcp-agent.md "Runs and revert").
 *
 * A `refiner:auto` token's writes are grouped into a **run**, with the value
 * before and after each one, so a bad run can be undone as a unit. The rules:
 *
 * - **A run is implicit.** The token's first write opens it; it ends once the
 *   token has written nothing for `RUN_IDLE_MS`. The runner needs no protocol.
 * - **One run at a time.** While a run is open, another unattended token's write
 *   is refused: two models rewriting the same backlog is how one overwrites the
 *   other.
 * - **A revert never overwrites a later correction.** A write is undone only if
 *   the target still holds exactly what the run left there. Anything a person
 *   (or a scan, or another run) has changed since is skipped and reported.
 */
export const RUN_IDLE_MS = 30 * 60_000;

export interface AgentRun {
  id: string;
  tokenId: string;
  userId: string;
  startedAt: number;
  lastAt: number;
  endedAt: number | null;
  revertedAt: number | null;
  revertedBy: string | null;
  /** Writes recorded, and how many of them a revert has undone. */
  writes: number;
  reverted: number;
}

export interface AgentRunWrite {
  id: number;
  at: number;
  tool: string;
  targetKind: string;
  targetId: string;
  before: unknown;
  after: unknown;
  revertedAt: number | null;
  /** Why a revert left this write alone, when it did. */
  revertNote: string | null;
}

/** What a genre write replaced, and what it left. */
export interface GenreWriteBefore {
  genres: string[];
  override: GenreOverrideRow | null;
}
export interface GenreWriteAfter {
  genres: string[];
}

interface RunRow {
  id: string;
  token_id: string;
  user_id: string;
  started_at: number;
  last_at: number;
  ended_at: number | null;
  reverted_at: number | null;
  reverted_by: string | null;
}

/** End every open run that has been idle for `RUN_IDLE_MS`, at its last write. */
function endIdleRuns(db: Database, now: number): void {
  db.run(`UPDATE agent_runs SET ended_at = last_at WHERE ended_at IS NULL AND last_at < ?`, [
    now - RUN_IDLE_MS,
  ]);
}

/**
 * The run a write by `tokenId` belongs to: its own open run, or a new one. A
 * refusal when another token holds the open run.
 */
export function claimRun(
  db: Database,
  identity: { tokenId: string; userId: string },
  now = Date.now(),
): { runId: string } | { refusal: string } {
  endIdleRuns(db, now);
  const open = db
    .query<RunRow, []>(
      `SELECT * FROM agent_runs WHERE ended_at IS NULL ORDER BY started_at LIMIT 1`,
    )
    .get();
  if (open && open.token_id !== identity.tokenId) {
    const idleFor = Math.round((now - open.last_at) / 60_000);
    return {
      refusal:
        `Another unattended run is in progress (started by a different token, last write ` +
        `${idleFor} min ago). It ends after ${RUN_IDLE_MS / 60_000} min without a write. Stop and retry later.`,
    };
  }
  if (open) {
    db.run(`UPDATE agent_runs SET last_at = ? WHERE id = ?`, [now, open.id]);
    return { runId: open.id };
  }
  const runId = randomUUID();
  db.run(
    `INSERT INTO agent_runs (id, token_id, user_id, started_at, last_at) VALUES (?, ?, ?, ?, ?)`,
    [runId, identity.tokenId, identity.userId, now, now],
  );
  return { runId };
}

/** A song's genre state as a genre write would replace it. */
export function snapshotSongGenre(db: Database, songId: string): GenreWriteBefore {
  return {
    genres: loadGenreSets(db, [songId]).get(songId) ?? [],
    override: getGenreOverride(db, 'song', songId),
  };
}

export function recordRunWrite(
  db: Database,
  runId: string,
  write: {
    tool: string;
    targetKind: string;
    targetId: string;
    before: unknown;
    after: unknown;
  },
  now = Date.now(),
): void {
  db.run(
    `INSERT INTO agent_run_writes (run_id, at, tool, target_kind, target_id, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      now,
      write.tool,
      write.targetKind,
      write.targetId,
      JSON.stringify(write.before ?? null),
      JSON.stringify(write.after ?? null),
    ],
  );
  db.run(`UPDATE agent_runs SET last_at = ? WHERE id = ?`, [now, runId]);
}

const RUN_SELECT = `
  SELECT r.*,
    (SELECT COUNT(*) FROM agent_run_writes w WHERE w.run_id = r.id) AS writes,
    (SELECT COUNT(*) FROM agent_run_writes w WHERE w.run_id = r.id AND w.reverted_at IS NOT NULL) AS reverted
  FROM agent_runs r`;

type RunListRow = RunRow & { writes: number; reverted: number };

const toRun = (r: RunListRow): AgentRun => ({
  id: r.id,
  tokenId: r.token_id,
  userId: r.user_id,
  startedAt: r.started_at,
  lastAt: r.last_at,
  endedAt: r.ended_at,
  revertedAt: r.reverted_at,
  revertedBy: r.reverted_by,
  writes: r.writes,
  reverted: r.reverted,
});

/** Runs, newest first. Idle runs are ended first, so `endedAt` is current. */
export function listAgentRuns(db: Database, limit = 50, now = Date.now()): AgentRun[] {
  endIdleRuns(db, now);
  const n = Math.min(Math.max(limit, 1), 200);
  return db
    .query<RunListRow, [number]>(`${RUN_SELECT} ORDER BY r.started_at DESC LIMIT ?`)
    .all(n)
    .map(toRun);
}

const parse = (json: string | null): unknown => {
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

interface WriteRow {
  id: number;
  at: number;
  tool: string;
  target_kind: string;
  target_id: string;
  before_json: string | null;
  after_json: string | null;
  reverted_at: number | null;
  revert_note: string | null;
}

/** One run with every write it made, oldest first; null for an unknown id. */
export function getAgentRun(
  db: Database,
  runId: string,
  now = Date.now(),
): (AgentRun & { log: AgentRunWrite[] }) | null {
  endIdleRuns(db, now);
  const row = db.query<RunListRow, [string]>(`${RUN_SELECT} WHERE r.id = ?`).get(runId);
  if (!row) return null;
  const log = db
    .query<WriteRow, [string]>(`SELECT * FROM agent_run_writes WHERE run_id = ? ORDER BY id`)
    .all(runId)
    .map((w) => ({
      id: w.id,
      at: w.at,
      tool: w.tool,
      targetKind: w.target_kind,
      targetId: w.target_id,
      before: parse(w.before_json),
      after: parse(w.after_json),
      revertedAt: w.reverted_at,
      revertNote: w.revert_note,
    }));
  return { ...toRun(row), log };
}

const sameGenres = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((g, i) => genreKey(g) === genreKey(b[i] ?? ''));

export interface RevertResult {
  reverted: number;
  skipped: Array<{ writeId: number; tool: string; targetId: string; reason: string }>;
}

export interface RevertDeps {
  musicDir?: string;
  writeTags?: (abs: string, tags: { genre: string }) => Promise<boolean>;
}

/**
 * Undo a run's writes, newest first. Each is undone only while its target still
 * holds what the run left; otherwise it is skipped with the reason recorded on
 * the write. Running it again retries only what is still neither reverted nor
 * changed. An open run is ended first, so the token cannot keep writing into it.
 */
export async function revertAgentRun(
  db: Database,
  deps: RevertDeps,
  runId: string,
  actor: string,
  now = Date.now(),
): Promise<RevertResult | null> {
  const run = db.query<RunRow, [string]>(`SELECT * FROM agent_runs WHERE id = ?`).get(runId);
  if (!run) return null;
  if (run.ended_at === null) {
    db.run(`UPDATE agent_runs SET ended_at = ? WHERE id = ?`, [now, runId]);
  }
  const writes = db
    .query<WriteRow, [string]>(
      `SELECT * FROM agent_run_writes WHERE run_id = ? AND reverted_at IS NULL ORDER BY id DESC`,
    )
    .all(runId);
  const result: RevertResult = { reverted: 0, skipped: [] };
  const skip = (w: WriteRow, reason: string) => {
    db.run(`UPDATE agent_run_writes SET revert_note = ? WHERE id = ?`, [reason, w.id]);
    result.skipped.push({ writeId: w.id, tool: w.tool, targetId: w.target_id, reason });
  };
  const done = (w: WriteRow) => {
    db.run(`UPDATE agent_run_writes SET reverted_at = ?, revert_note = NULL WHERE id = ?`, [
      now,
      w.id,
    ]);
    result.reverted++;
  };

  for (const w of writes) {
    if (w.tool === 'set_song_genre') {
      const reason = await revertGenreWrite(db, deps, w);
      if (reason) skip(w, reason);
      else done(w);
    } else if (w.tool === 'flag_for_review') {
      // A flag changes no library data; taking it back means closing the card.
      const id = Number((parse(w.after_json) as { flagId?: number } | null)?.flagId);
      if (Number.isFinite(id) && resolveCurationFlag(db, id, `run-revert:${actor}`, now)) done(w);
      else skip(w, 'the flag was already resolved, or no longer exists');
    } else {
      skip(w, `no revert is defined for ${w.tool}`);
    }
  }
  db.run(`UPDATE agent_runs SET reverted_at = ?, reverted_by = ? WHERE id = ?`, [
    now,
    actor,
    runId,
  ]);
  return result;
}

/** Null when the genre write was undone; otherwise why it was left alone. */
async function revertGenreWrite(
  db: Database,
  deps: RevertDeps,
  w: WriteRow,
): Promise<string | null> {
  const before = parse(w.before_json) as GenreWriteBefore | null;
  const after = parse(w.after_json) as GenreWriteAfter | null;
  if (!before || !after) return 'the write has no before/after record';
  const song = db
    .query<{ path: string; album_id: string }, [string]>(
      `SELECT path, album_id FROM library_songs WHERE id = ?`,
    )
    .get(w.target_id);
  if (!song) return 'the song no longer exists under this id';
  const current = loadGenreSets(db, [w.target_id]).get(w.target_id) ?? [];
  if (!sameGenres(current, after.genres)) {
    return `the genres were changed after the run (now: ${current.join('; ') || 'none'})`;
  }
  if (before.override) upsertGenreOverride(db, before.override);
  else deleteGenreOverride(db, 'song', w.target_id);
  setSongGenres(db, w.target_id, before.genres);
  // The file tag mirrors the genre set. It is rewritten even when the set goes
  // back to empty: left alone it would hold the run's value, and with the
  // override gone the next scan would read that value straight back in.
  if (deps.musicDir) {
    const root = expandDir(deps.musicDir);
    const abs = resolveSongPath(root, song.path);
    if (isUnderMusicDir(root, abs) && existsSync(abs)) {
      await (deps.writeTags ?? writeAudioTags)(abs, { genre: before.genres.join('; ') }).catch(
        () => false,
      );
    }
  }
  libraryEvents.emit({ type: 'album.changed', albumId: song.album_id });
  return null;
}
