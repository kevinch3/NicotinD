/**
 * Boot-time warnings for shipped defaults that are unsafe, ahead of removing
 * them (issue #612).
 *
 * WHY WARN FIRST: the GHCR image is public and the licence is AGPL, so this
 * deployment's defaults are the ones strangers run. Two of them are dangerous —
 * a `docker.sock` mount that is host-root-equivalent, and addon tokens that
 * default to the literal `change-me` — and both are load-bearing for someone's
 * running install. Changing them without notice breaks that install silently.
 * A release that warns, then a release that enforces, gives an operator a
 * window in which the thing still works and the message says what to do.
 *
 * WHY THESE CHECKS AND NOT AN ENV SCAN: core never sees `SLSKD_ADDON_TOKEN` —
 * those are env vars on the addon containers, which live in their own repos.
 * What core holds is `addon_registrations.token`, which is the credential an
 * admin actually registered. That is also the better signal: an unused default
 * sitting in a compose file harms nobody, a registered one is live.
 */
import { existsSync } from 'node:fs';
import type { Database } from 'bun:sqlite';

/** The release these defaults stop being defaults. A breaking change on 0.x bumps the minor. */
export const REMOVAL_RELEASE = '0.4.0';

export const DOCKER_SOCKET = '/var/run/docker.sock';

/** The compose placeholder. Anything registered with it is effectively unauthenticated. */
export const PLACEHOLDER_TOKEN = 'change-me';

export interface InsecureDefault {
  code: 'addon-token-default' | 'docker-socket-mounted';
  message: string;
}

export interface InsecureDefaultsDeps {
  /** Injected so the socket check is testable without one. */
  socketExists?: (path: string) => boolean;
}

/**
 * Deployment defaults that will be removed, in the order they matter.
 *
 * Read-only: it reports, it never mutates or refuses to boot. Failing closed is
 * the *next* release's job, deliberately — see the module docstring.
 */
export function findInsecureDefaults(
  db: Database,
  deps: InsecureDefaultsDeps = {},
): InsecureDefault[] {
  const socketExists = deps.socketExists ?? existsSync;
  const found: InsecureDefault[] = [];

  // A token, not the socket, first: a placeholder credential is exploitable by
  // anything already on the Docker network, which is a lower bar than RCE.
  let placeholders: { url: string }[] = [];
  try {
    placeholders = db
      .query<{ url: string }, [string]>('SELECT url FROM addon_registrations WHERE token = ?')
      .all(PLACEHOLDER_TOKEN);
  } catch {
    // Pre-dates the table (or a partially-migrated DB). Nothing to warn about,
    // and a boot-time advisory must never be the thing that stops a boot.
    placeholders = [];
  }
  if (placeholders.length > 0) {
    found.push({
      code: 'addon-token-default',
      message:
        `${placeholders.length} addon(s) are registered with the placeholder token ` +
        `"${PLACEHOLDER_TOKEN}": ${placeholders.map((p) => p.url).join(', ')}. ` +
        `Anything that can reach them on the Docker network can drive them. ` +
        `Set a real token (compose: SLSKD_ADDON_TOKEN / YTDLP_ADDON_TOKEN / SPOTDL_ADDON_TOKEN) ` +
        `and re-register. From ${REMOVAL_RELEASE} the addons refuse to start without one.`,
    });
  }

  if (socketExists(DOCKER_SOCKET)) {
    found.push({
      code: 'docker-socket-mounted',
      message:
        `${DOCKER_SOCKET} is mounted into this container. The Docker API is read-write ` +
        `regardless of the :ro flag, so this is host-root-equivalent privilege, granted ` +
        `for one admin log viewer. From ${REMOVAL_RELEASE} it is no longer in the default ` +
        `compose file; move it to docker-compose.override.yml if you need the log viewer ` +
        `(see docker-compose.override.example.yml and docs/deployment.md).`,
    });
  }

  return found;
}
