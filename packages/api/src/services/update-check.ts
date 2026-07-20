/**
 * Server update check + version history (Immich's `version-check` /
 * `version-history` pattern).
 *
 * The daily guard (`maybeCheckForUpdate`) polls the GitHub releases API from
 * the processor tick and stores the newest release in a `library_sync_state`
 * marker — the admin endpoint then serves the cached result and computes
 * `updateAvailable` against the running version, so reading never phones home.
 * Strictly opt-out (`NICOTIND_UPDATE_CHECK=off`); an attempt marker enforces a
 * 1h backoff so a failing/rate-limited GitHub API is never hammered per tick.
 *
 * `recordBootVersion` appends to `version_history` once per version at boot.
 */
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';

const log = createLogger('update-check');

const RESULT_MARKER = 'update_check_result';
const ATTEMPT_MARKER = 'update_check_attempt';
const FRESH_MS = 24 * 3_600_000;
const BACKOFF_MS = 3_600_000;
const RELEASES_URL = 'https://api.github.com/repos/kevinch3/NicotinD/releases/latest';

export interface StoredUpdateCheck {
  checkedAt: number;
  /** Newest release version, no `v` prefix (e.g. `0.1.231`). */
  latestVersion: string;
  releaseUrl: string | null;
}

export interface VersionHistoryRow {
  version: string;
  firstSeenAt: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Numeric dot-segment compare: >0 when `a` is newer than `b`. Non-numeric segments compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.');
  const pb = b.replace(/^v/, '').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0) || 0;
    const nb = Number(pb[i] ?? 0) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function readMarker(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM library_sync_state WHERE key = ?')
    .get(key);
  return row?.value ?? null;
}

function writeMarker(db: Database, key: string, value: string, now: number): void {
  db.run(
    `INSERT INTO library_sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now],
  );
}

export function getStoredUpdateCheck(db: Database): StoredUpdateCheck | null {
  const raw = readMarker(db, RESULT_MARKER);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUpdateCheck;
  } catch {
    return null;
  }
}

/** One GitHub poll, unconditionally; stores the result. Returns it, or null on failure. */
export async function checkForUpdateNow(
  db: Database,
  opts: { now?: number; fetchImpl?: FetchLike } = {},
): Promise<StoredUpdateCheck | null> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  writeMarker(db, ATTEMPT_MARKER, String(now), now);
  try {
    const res = await fetchImpl(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub releases API ${res.status}`);
    const body = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!body.tag_name) throw new Error('release response has no tag_name');
    const result: StoredUpdateCheck = {
      checkedAt: now,
      latestVersion: body.tag_name.replace(/^v/, ''),
      releaseUrl: body.html_url ?? null,
    };
    writeMarker(db, RESULT_MARKER, JSON.stringify(result), now);
    return result;
  } catch (err) {
    log.warn({ err }, 'update check failed');
    return null;
  }
}

/**
 * Daily guard, safe to call every processor tick: polls at most once per 24h,
 * with a 1h backoff between failed attempts. `NICOTIND_UPDATE_CHECK=off`
 * disables it. Returns true when a poll ran (successfully or not).
 */
export async function maybeCheckForUpdate(
  db: Database,
  opts: { now?: number; fetchImpl?: FetchLike; enabled?: boolean } = {},
): Promise<boolean> {
  const enabled =
    opts.enabled ?? process.env.NICOTIND_UPDATE_CHECK?.trim().toLowerCase() !== 'off';
  if (!enabled) return false;
  const now = opts.now ?? Date.now();
  const stored = getStoredUpdateCheck(db);
  if (stored && now - stored.checkedAt < FRESH_MS) return false;
  const lastAttempt = Number(readMarker(db, ATTEMPT_MARKER) ?? 0);
  if (now - lastAttempt < BACKOFF_MS) return false;
  await checkForUpdateNow(db, { ...opts, now });
  return true;
}

/** Append the running version to `version_history` (no-op if already recorded). */
export function recordBootVersion(db: Database, version: string, now = Date.now()): void {
  db.run('INSERT OR IGNORE INTO version_history (version, first_seen_at) VALUES (?, ?)', [
    version,
    now,
  ]);
}

/** Every version this server has run, newest-first by first boot. */
export function listVersionHistory(db: Database): VersionHistoryRow[] {
  return db
    .query<{ version: string; first_seen_at: number }, []>(
      'SELECT version, first_seen_at FROM version_history ORDER BY first_seen_at DESC',
    )
    .all()
    .map((r) => ({ version: r.version, firstSeenAt: r.first_seen_at }));
}
