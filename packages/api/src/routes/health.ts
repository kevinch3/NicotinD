import { loadavg, availableParallelism } from 'node:os';
import type { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import {
  LOOP_BLOCK_SIGNAL_WINDOW_MS,
  recentLoopBlockDurations,
} from '../services/loop-block-store.js';

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
 *
 * `/signals` is what the droplet probe pages on (#1143, docs/host-monitoring.md):
 * the host's load average — a container reads the host's `/proc/loadavg` — and
 * the durations of recent event-loop blocks. Numbers only, because this route
 * is as public as `/`; the paging policy lives in scripts/kpc-probe.sh.
 */
export function healthRoutes(
  version?: string,
  commit = process.env.NICOTIND_BUILD_COMMIT,
  signals: { db?: Database; load?: () => number[]; now?: () => number } = {},
) {
  const app = new Hono();
  const built = commit?.trim() ? commit.trim() : null;
  app.get('/', (c) => c.json({ ok: true, version: version ?? 'unknown', commit: built }));
  app.get('/signals', (c) => {
    const now = (signals.now ?? Date.now)();
    return c.json({
      ok: true,
      load: (signals.load ?? loadavg)(),
      cpus: availableParallelism(),
      loopBlocks: {
        windowMs: LOOP_BLOCK_SIGNAL_WINDOW_MS,
        blockedMs: signals.db
          ? recentLoopBlockDurations(signals.db, LOOP_BLOCK_SIGNAL_WINDOW_MS, now)
          : null,
      },
    });
  });
  return app;
}
