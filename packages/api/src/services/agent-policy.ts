import type { Database } from 'bun:sqlite';
import { JUNK_GENRES, LOW_INFORMATION_GENRES, genreKey } from './genre-split.js';
import { parseGenreList } from './song-genre-mutate.js';

/**
 * Server-side policy for `refiner:auto` agent tokens (#1516) — the credential a
 * scheduled, unattended runner holds, possibly driving a small quantized model.
 *
 * Every rule the curation skill states in prose is something a weak model will
 * eventually break, so for this scope the rules are code: a narrow tool
 * allowlist, a genre write that can only fill a genre-less or catch-all-only
 * song with a genre the library already uses, and a daily write budget. A
 * `confirm: true` is a boolean any model can pass; none of these can be talked
 * past. → docs/mcp-agent.md "Unattended tokens".
 */

/** The only non-read tools a `refiner:auto` token may call. */
export const AUTO_SCOPE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'set_song_genre',
  'flag_for_review',
]);

/**
 * Per-token, per-UTC-day ceilings, counted from the audit rows the writes
 * already leave (`username = agent:<tokenId>`), so the count is of writes that
 * landed rather than attempts.
 */
export const AUTO_DAILY_LIMITS: Readonly<Record<string, { action: string; limit: number }>> = {
  set_song_genre: { action: 'song.genre', limit: 200 },
  flag_for_review: { action: 'curation.flag', limit: 25 },
};

/**
 * A genre is a valid auto target only once at least this many songs carry it,
 * so a one-off mistag already in the library (`Alt-Pop` beside `Alt Pop`) never
 * becomes something a model can spread.
 */
export const AUTO_VOCAB_MIN_SONGS = 3;

/** Default and ceiling lifetime of a `refiner:auto` token, in days. */
export const AUTO_TOKEN_DEFAULT_DAYS = 30;
export const AUTO_TOKEN_MAX_DAYS = 90;

/**
 * Whether a song's current genre set may be overwritten without losing
 * information: no genre at all, only junk vocab, or exactly one real genre that
 * is a low-information catch-all (junk beside it is dropped harmlessly).
 */
export function isAutoReplaceableGenreSet(genres: readonly string[]): boolean {
  const real = genres.filter((g) => !JUNK_GENRES.has(genreKey(g)));
  return real.length === 0 || (real.length === 1 && LOW_INFORMATION_GENRES.has(genreKey(real[0]!)));
}

/** genreKey → display spelling of every genre an auto token may write. */
export function autoGenreVocabulary(db: Database): Map<string, string> {
  const vocab = new Map<string, string>();
  for (const r of db
    .query<{ name: string }, [number]>(
      `SELECT name FROM library_genres WHERE song_count >= ? ORDER BY song_count ASC`,
    )
    .all(AUTO_VOCAB_MIN_SONGS)) {
    const k = genreKey(r.name);
    if (!k || r.name.includes('/') || JUNK_GENRES.has(k) || LOW_INFORMATION_GENRES.has(k)) continue;
    vocab.set(k, r.name.trim());
  }
  return vocab;
}

/**
 * The refusal for an auto-scope `set_song_genre`, or null when it may proceed.
 * Each branch names the rule, so a model's retry has something to act on.
 */
export function autoGenreRefusal(
  db: Database,
  args: { songId: string; genre: string; mode: string },
): string | null {
  if (args.mode !== 'replace') {
    return 'refiner:auto tokens must pass mode: "replace" — an append is lost on rescan.';
  }
  const song = db
    .query<{ genre: string | null }, [string]>('SELECT genre FROM library_songs WHERE id = ?')
    .get(args.songId);
  if (!song) return 'Song not found';
  const rows = db
    .query<{ genre: string }, [string]>(
      'SELECT genre FROM library_song_genres WHERE song_id = ? ORDER BY position',
    )
    .all(args.songId)
    .map((r) => r.genre);
  const current = rows.length > 0 ? rows : song.genre ? [song.genre] : [];
  if (!isAutoReplaceableGenreSet(current)) {
    return (
      `Song already has a specific genre (${current.join('; ')}); refiner:auto tokens only fill ` +
      'genre-less or catch-all-only (Electronic, Dance) songs. Flag it instead if it looks wrong.'
    );
  }
  const wanted = parseGenreList(args.genre);
  const vocab = autoGenreVocabulary(db);
  const unknown = wanted.filter((g) => !vocab.has(genreKey(g)));
  if (wanted.length === 0 || unknown.length > 0) {
    return (
      `Not in the library's genre vocabulary: ${unknown.join(', ') || '(empty)'}. refiner:auto ` +
      `tokens may only write a specific genre at least ${AUTO_VOCAB_MIN_SONGS} songs already carry.`
    );
  }
  return null;
}

/** Start of the UTC day containing `now`, in epoch ms. */
function utcDayStart(now: number): number {
  return now - (now % 86_400_000);
}

/** The refusal once a tool's daily budget for this token is spent, else null. */
export function autoBudgetRefusal(
  db: Database,
  tokenId: string,
  toolName: string,
  now = Date.now(),
): string | null {
  const budget = AUTO_DAILY_LIMITS[toolName];
  if (!budget) return null;
  const used =
    db
      .query<{ n: number }, [string, string, number]>(
        'SELECT COUNT(*) AS n FROM audit_log WHERE username = ? AND action = ? AND at >= ?',
      )
      .get(`agent:${tokenId}`, budget.action, utcDayStart(now))?.n ?? 0;
  if (used < budget.limit) return null;
  return `Daily budget exhausted: ${used}/${budget.limit} ${toolName} calls today (UTC). Stop the run.`;
}
