import type { Env, Hono, MiddlewareHandler } from 'hono';

/**
 * `Bun.serve`'s `idleTimeout` (seconds). A socket is closed when nothing is
 * written for this long — including while a handler is still awaiting its first
 * byte. Bun checks in 4 s ticks, so a close lands 26–30 s after the last write;
 * the library-events SSE pings every 25 s (`PING_MS`) to stay under that.
 * See docs/design-patterns.md "Outbound Lidarr calls are bounded".
 */
export const SERVER_IDLE_TIMEOUT_S = 30;

/** Bun's idle-timer granularity, measured: a close fires up to this early. */
export const IDLE_TIMER_GRANULARITY_S = 4;

/** The budget the route groups that legitimately work longer keep (the old global). */
export const LONG_REQUEST_IDLE_S = 60;

interface IdleTimeoutServer {
  timeout?: (request: Request, seconds: number) => void;
}

/**
 * Raise this request's idle budget via Bun's per-request `server.timeout()`.
 * Hono receives the Bun server as `c.env`; outside `Bun.serve` (unit tests'
 * `app.request`) there is none and this is a no-op.
 */
export function idleBudget(seconds = LONG_REQUEST_IDLE_S): MiddlewareHandler {
  return async (c, next) => {
    (c.env as IdleTimeoutServer | undefined)?.timeout?.(c.req.raw, seconds);
    await next();
  };
}

/** Groups whose handlers legitimately await past the global before their first byte. */
export const LONG_REQUEST_GROUPS = [
  '/api/discography/*',
  '/api/downloads/*',
  '/api/uploads/*',
  '/api/acquire/*',
  '/api/admin/*',
  '/api/system/*',
  '/api/mcp',
  '/api/mcp/*',
  '/api/stream/*',
  '/api/peaks/*',
] as const;

/**
 * Hunts, rescans, MCP tools and first-play transcodes keep the old 60 s. Library
 * GETs are web-aborted at 30 s anyway, and its events SSE must live on its pings.
 */
export function applyIdleBudgets(app: Hono<Env>): void {
  const long = idleBudget();
  for (const group of LONG_REQUEST_GROUPS) app.use(group, long);
  app.use('/api/library/*', (c, next) => (c.req.method === 'GET' ? next() : long(c, next)));
}
