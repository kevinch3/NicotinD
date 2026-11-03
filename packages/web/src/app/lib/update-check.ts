import { compareVersions } from '@nicotind/core';

/**
 * Is the build the server serves the build running here — and did the last
 * update actually land?
 *
 * The service worker's answer cannot settle either question (docs/web-ui.md
 * "App updates"): it says "no new version" for a version it already holds, and
 * "no new version" again when it could not reach the server at all. A version
 * string cannot settle the first one either: an `:edge` build carries the last
 * release's version until the next release, so two different builds both read
 * `0.8.119`. The commit both sides are stamped with (`NICOTIND_BUILD_COMMIT`,
 * baked into the bundle and reported by `GET /api/health`) can.
 */

/** What `GET /api/health` says the server is running. */
export interface ServedBuild {
  version: string | null;
  commit: string | null;
}

/** What this bundle was built from (`APP_VERSION` + `BUILD_INFO.commit`). */
export interface RunningBuild {
  version: string;
  commit: string | null;
}

/** `update`: the server serves a different build than the one running here. */
export type BuildVerdict = 'update' | 'current';

const SHA = /^[0-9a-f]{7,40}$/i;

/** The `{ ok, version, commit }` body of `/api/health`, or null when it is not one. */
export function parseHealth(body: unknown): ServedBuild | null {
  if (typeof body !== 'object' || body === null) return null;
  const { version, commit } = body as { version?: unknown; commit?: unknown };
  const v = typeof version === 'string' && version !== 'unknown' ? version : null;
  const c = typeof commit === 'string' && SHA.test(commit.trim()) ? commit.trim() : null;
  return { version: v, commit: c };
}

/** Same build, allowing one side to be an abbreviated sha. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
}

/**
 * The commit decides whenever both sides have one: a different build is an
 * update, whatever the version strings say — the shell is only ever served by
 * this server, so "different" can only mean "the one loading the app would
 * get". Without a commit on either side (an unstamped self-built image, a dev
 * bundle) the version decides, and only a strictly newer one counts.
 */
export function servedBuildVerdict(served: ServedBuild, running: RunningBuild): BuildVerdict {
  if (served.commit && running.commit) {
    return sameCommit(served.commit, running.commit) ? 'current' : 'update';
  }
  if (served.version && compareVersions(served.version, running.version) > 0) return 'update';
  return 'current';
}

// ---------------------------------------------------------------------------
// Did the update land?
// ---------------------------------------------------------------------------

/** localStorage key for the update an apply is reloading into. */
export const PENDING_UPDATE_KEY = 'nicotind-pending-update';

/**
 * Reloads an apply may spend before giving up: the plain one, then one after
 * the service worker is reset. Bounded so a server whose bundle and health
 * report disagree cannot reload the app forever.
 */
export const MAX_UPDATE_ATTEMPTS = 2;

/** A record older than this describes some other session, not the reload just made. */
export const PENDING_UPDATE_TTL_MS = 10 * 60_000;

export interface PendingUpdate {
  /** The commit the reload should land on; null when only the worker knew of the update. */
  commit: string | null;
  /** Reloads spent so far, the one about to happen included. */
  attempts: number;
  /** When the latest reload was started (ms). */
  at: number;
}

export function readPendingUpdate(storage: Pick<Storage, 'getItem'>): PendingUpdate | null {
  try {
    const raw = storage.getItem(PENDING_UPDATE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingUpdate>;
    if (typeof p.attempts !== 'number' || typeof p.at !== 'number') return null;
    return {
      commit: typeof p.commit === 'string' ? p.commit : null,
      attempts: p.attempts,
      at: p.at,
    };
  } catch {
    return null;
  }
}

export function writePendingUpdate(storage: Pick<Storage, 'setItem'>, p: PendingUpdate): void {
  try {
    storage.setItem(PENDING_UPDATE_KEY, JSON.stringify(p));
  } catch {
    /* private mode / quota: the apply still reloads, it just cannot verify */
  }
}

export function clearPendingUpdate(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(PENDING_UPDATE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * What a boot does about the apply that reloaded into it.
 *
 * - `landed`: this bundle is the build the apply aimed at (or it had no target
 *   to check against) — forget the record.
 * - `escalate`: the reload came back on the old build — the worker served its
 *   stale cache to the navigation. Reset the worker and reload once more.
 * - `give-up`: the attempts are spent, or the record is stale.
 */
export function afterUpdateReload(
  pending: PendingUpdate,
  runningCommit: string | null,
  now: number,
): 'landed' | 'escalate' | 'give-up' {
  if (now - pending.at > PENDING_UPDATE_TTL_MS) return 'give-up';
  if (!pending.commit || !runningCommit) return 'landed';
  if (sameCommit(pending.commit, runningCommit)) return 'landed';
  return pending.attempts < MAX_UPDATE_ATTEMPTS ? 'escalate' : 'give-up';
}

/**
 * Unregister the service worker and drop its caches, so the next navigation
 * is answered by the network and re-registers a fresh worker.
 *
 * Only the worker's own `ngsw:*` caches: offline downloads live in IndexedDB
 * (`nicotind-preserve`) and are not touched. Callers must have just reached
 * the server — a reset while offline would leave an installed app with nothing
 * to load.
 */
export async function resetServiceWorker(
  container: Pick<ServiceWorkerContainer, 'getRegistrations'> | undefined = globalThis.navigator
    ?.serviceWorker,
  cacheStorage: Pick<CacheStorage, 'keys' | 'delete'> | undefined = globalThis.caches,
): Promise<void> {
  const registrations = (await container?.getRegistrations?.()) ?? [];
  await Promise.all(registrations.map((r) => r.unregister()));
  if (cacheStorage) {
    const keys = await cacheStorage.keys();
    await Promise.all(keys.filter((k) => k.startsWith('ngsw:')).map((k) => cacheStorage.delete(k)));
  }
}
