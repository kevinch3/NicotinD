import { Hono } from 'hono';

/**
 * Unauthenticated liveness probe — the target of the Docker HEALTHCHECK, the
 * compose healthcheck, the desktop sidecar handshake, and the e2e webServer
 * wait. Reports the running version so `curl /api/health` verifies what a
 * deploy actually shipped (clients must only rely on `ok`).
 */
export function healthRoutes(version?: string) {
  const app = new Hono();
  app.get('/', (c) => c.json({ ok: true, version: version ?? 'unknown' }));
  return app;
}
