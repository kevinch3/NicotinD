import { Hono } from 'hono';

/**
 * Unauthenticated liveness probe — the target of the Docker HEALTHCHECK, the
 * compose healthcheck, the desktop sidecar handshake, and the e2e webServer
 * wait. Reports the running version so `curl /api/health` verifies what a
 * deploy actually shipped (clients must only rely on `ok`).
 *
 * `commit` is the git sha the image was built from (`NICOTIND_BUILD_COMMIT`,
 * stamped by the release build), or null for a build that was not given one.
 * A version identifies a release; a commit identifies a build, which is what a
 * deploy of an untagged master commit has to verify (docs/deployment.md). The
 * source is already public — the About page links to the same sha.
 */
export function healthRoutes(version?: string, commit = process.env.NICOTIND_BUILD_COMMIT) {
  const app = new Hono();
  const built = commit?.trim() ? commit.trim() : null;
  app.get('/', (c) => c.json({ ok: true, version: version ?? 'unknown', commit: built }));
  return app;
}
