import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';

/**
 * Privacy controls for the data NicotinD holds about a person (issue #454).
 *
 * The listening log (`play_events`) changed what this app stores: a per-user,
 * timestamped, indefinitely-retained behavioural record. That is personal data
 * in a way a playlist is not, so it gets consent, access, erasure and a
 * retention cap rather than an assurance.
 *
 * Everything here is **caller-scoped by construction** — no function takes both
 * "who is asking" and "whose data", so there is no parameter to get wrong.
 *
 * See docs/privacy.md.
 */

/** Instance-wide switch, stored in `app_settings`. */
export const HISTORY_SETTING_KEY = 'history_collection_enabled';
/** Max age of a play event in days; 0 = keep forever. */
export const RETENTION_SETTING_KEY = 'history_retention_days';

/** Which level said no. `env` is the one an admin cannot fix from the UI. */
export type HistoryBlocker = 'env' | 'instance' | 'user' | null;

export interface HistoryCollectionState {
  enabled: boolean;
  blockedBy: HistoryBlocker;
}

/**
 * Three-level precedence, pure so the asymmetry is testable on its own.
 *
 * Opt-**out**: an unset instance or user preference means "on", so the Stats
 * tab and the radio recency demotion work without every user hunting for a
 * toggle first. The env var is a hard floor, exactly like the acquisition
 * kill-switch (#235): an operator who disabled collection must not be
 * overridden by whoever happens to hold an admin account.
 */
export function resolveHistoryCollection(
  envEnabled: boolean,
  instance: boolean | null,
  user: boolean | null,
): boolean {
  if (!envEnabled) return false;
  if (instance === false) return false;
  return user ?? true;
}

function readAppSetting(db: Database, key: string): string | null {
  try {
    return (
      db.query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?').get(key)
        ?.value ?? null
    );
  } catch {
    return null;
  }
}

function writeAppSetting(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export function getInstanceHistoryEnabled(db: Database): boolean | null {
  const raw = readAppSetting(db, HISTORY_SETTING_KEY);
  return raw === null ? null : raw === 'true';
}

export function setInstanceHistoryEnabled(db: Database, enabled: boolean): void {
  writeAppSetting(db, HISTORY_SETTING_KEY, enabled ? 'true' : 'false');
}

export function isHistoryEnabledForUser(db: Database, userId: string): boolean {
  const row = db
    .query<{ history_enabled: number }, [string]>(
      'SELECT history_enabled FROM user_settings WHERE user_id = ?',
    )
    .get(userId);
  // No settings row yet = never touched a preference = the opt-out default.
  return row ? row.history_enabled === 1 : true;
}

export function setUserHistoryEnabled(db: Database, userId: string, enabled: boolean): void {
  db.run(
    `INSERT INTO user_settings (user_id, history_enabled) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET history_enabled = excluded.history_enabled`,
    [userId, enabled ? 1 : 0],
  );
}

/**
 * Whether to record this user's plays, and which level said no — the UI needs
 * the reason to know whether to offer a fix or an explanation.
 *
 * Reports the **most restrictive** blocker: if the env floor is down, saying
 * "you turned this off" would invite a user to flip a toggle that changes
 * nothing.
 */
export function historyCollectionState(
  db: Database,
  userId: string,
  envEnabled: boolean,
): HistoryCollectionState {
  if (!envEnabled) return { enabled: false, blockedBy: 'env' };
  if (getInstanceHistoryEnabled(db) === false) return { enabled: false, blockedBy: 'instance' };
  if (!isHistoryEnabledForUser(db, userId)) return { enabled: false, blockedBy: 'user' };
  return { enabled: true, blockedBy: null };
}

/**
 * Right to erasure (Art. 17), scoped to the listening log.
 *
 * Deliberately does NOT touch the consent flag: "forget what I listened to" and
 * "stop recording" are different asks, and silently doing the second when asked
 * for the first would be its own surprise. Returns the row count so the UI can
 * confirm what actually happened.
 */
export function deleteUserHistory(db: Database, userId: string): number {
  db.run('DELETE FROM play_events WHERE user_id = ?', [userId]);
  const changed = db.query<{ n: number }, []>('SELECT changes() AS n').get();
  return changed?.n ?? 0;
}

export function getRetentionDays(db: Database): number {
  const raw = Number(readAppSetting(db, RETENTION_SETTING_KEY) ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function setRetentionDays(db: Database, days: number): void {
  const clamped = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  writeAppSetting(db, RETENTION_SETTING_KEY, String(clamped));
}

/**
 * Storage limitation (Art. 5(1)(e)): drop play events past the configured age.
 *
 * Default 0 = keep forever, which is the pre-#454 policy and still the right
 * default for a personal instance — a year review needs multi-year data. This
 * exists so an operator who wants a bound can set one, not to impose one.
 *
 * Unlike the orphan prune there is no grace period and no mark/sweep: an event
 * past the cap is past the cap, and the whole point is that it stops existing.
 */
export function pruneExpiredHistory(db: Database, now: number = Date.now()): number {
  const days = getRetentionDays(db);
  if (days <= 0) return 0;
  const cutoff = now - days * 24 * 3_600_000;
  db.run('DELETE FROM play_events WHERE at < ?', [cutoff]);
  const changed = db.query<{ n: number }, []>('SELECT changes() AS n').get();
  return changed?.n ?? 0;
}

/**
 * Tables holding rows about one person, and the column that ties them to it.
 *
 * `redact` names columns whose *value* is a secret: the export must show that a
 * credential exists (it is the user's data) without handing over the credential
 * itself. Listed explicitly rather than pattern-matched on the name — a rename
 * should break the test, not silently start leaking.
 */
const USER_TABLES: Array<{ table: string; column: string; redact?: string[] }> = [
  { table: 'user_settings', column: 'user_id' },
  { table: 'play_events', column: 'user_id' },
  { table: 'playlists', column: 'user_id' },
  { table: 'paired_devices', column: 'user_id' },
  { table: 'pairing_tokens', column: 'user_id' },
  { table: 'agent_tokens', column: 'user_id', redact: ['token_hash'] },
  { table: 'share_tokens', column: 'created_by' },
  // Poll scenarios/votes have no user column by design (anonymous rater_key,
  // not an identity) and cascade off the poll row.
  { table: 'radio_polls', column: 'created_by' },
  { table: 'generation_feedback', column: 'user_id' },
  { table: 'audit_log', column: 'user_id' },
];

export interface UserDataExport {
  exportedAt: number;
  user: {
    id: string;
    username: string;
    role: string;
    status: string;
    createdAt: string | null;
    lastSeenAt: number | null;
  };
  tables: Record<string, Array<Record<string, unknown>>>;
  /** Tables checked but absent from this schema version — a visible gap, not a silent one. */
  skipped: string[];
}

/**
 * Right of access (Art. 15): everything tied to this user, as JSON.
 *
 * For the `USER_TABLES` below, columns are read from `PRAGMA table_info` at runtime
 * rather than hardcoded — the same technique as the admin config export, so a schema
 * change cannot silently start omitting a column from someone's data request.
 *
 * The `users` row itself is the exception: it is not in `USER_TABLES` (it is keyed by
 * `id`, not a `user_id`) and is projected explicitly below, so **a new `users` column
 * must be added to this SELECT and to `UserDataExport['user']` by hand** or it will be
 * missing from the export. `last_seen_at` is the first column that hit this.
 */
export function exportUserData(db: Database, userId: string): UserDataExport {
  const user = db
    .query<
      {
        id: string;
        username: string;
        role: string;
        status: string;
        created_at: string | null;
        last_seen_at: number | null;
      },
      [string]
    >('SELECT id, username, role, status, created_at, last_seen_at FROM users WHERE id = ?')
    .get(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  const tables: UserDataExport['tables'] = {};
  const skipped: string[] = [];

  for (const spec of USER_TABLES) {
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(${spec.table})`)
      .all()
      .map((c) => c.name);
    if (cols.length === 0 || !cols.includes(spec.column)) {
      skipped.push(spec.table);
      continue;
    }
    const rows = db
      .query<Record<string, unknown>, [string]>(
        `SELECT * FROM ${spec.table} WHERE ${spec.column} = ?`,
      )
      .all(userId);
    tables[spec.table] = rows.map((r) => {
      if (!spec.redact) return r;
      const copy = { ...r };
      for (const c of spec.redact) if (c in copy) copy[c] = '[redacted]';
      return copy;
    });
  }

  return {
    exportedAt: Date.now(),
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      createdAt: user.created_at,
      lastSeenAt: user.last_seen_at,
    },
    tables,
    skipped,
  };
}

const log = createLogger('privacy');

const RETENTION_MARKER = 'history_retention_last_day';

/**
 * Once-a-day retention sweep, marker-guarded in `library_sync_state` exactly
 * like the backup / orphan / cover-cache passes.
 *
 * Wrapped in try/catch for the same reason they are: a retention failure must
 * never break the processing tick, and it is retried on the next one.
 */
export function maybeRunDailyHistoryRetention(db: Database, opts: { now?: number } = {}): number {
  const now = opts.now ?? Date.now();
  try {
    if (getRetentionDays(db) <= 0) return 0;
    const day = new Date(now).toISOString().slice(0, 10);
    const seen = db
      .query<{ value: string }, [string]>('SELECT value FROM library_sync_state WHERE key = ?')
      .get(RETENTION_MARKER)?.value;
    if (seen === day) return 0;

    const deleted = pruneExpiredHistory(db, now);
    db.run(
      `INSERT INTO library_sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [RETENTION_MARKER, day, now],
    );
    return deleted;
  } catch (err) {
    // Never break the processing tick — but say so. Swallowing silently is how
    // a missing `updated_at` in this very statement looked like "nothing to
    // prune" instead of a bug.
    log.warn({ err }, 'history retention prune failed; retrying next tick');
    return 0;
  }
}
