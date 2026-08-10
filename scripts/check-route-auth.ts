/**
 * Fail when an `/api` route group is mounted without a decision about auth.
 *
 *   bun run check:route-auth
 *
 * WHY: `/api/radio` was mounted with `app.route(...)` and simply never added to
 * the `app.use('/api/<x>/*', auth)` list (issue #461). Nothing caught it —
 * there is no catch-all, the route's own tests mount it directly without
 * middleware, and it returned data happily, so the omission was invisible.
 * Auditing for that turned up `/api/catalog` in the same state, whose
 * `/discography` endpoint provisions an artist into Lidarr.
 *
 * The failure mode is *silence*: forgetting a line makes a route public and
 * nothing complains. So the gate inverts the default — every mounted group must
 * either be behind `auth` or be named here with a reason. Adding a route now
 * forces the question instead of leaving it to be noticed months later.
 *
 * A prefix counts as coverage: `app.use('/api/admin/*', auth)` protects
 * `/api/admin/remote-access` without a second entry.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

/**
 * Route groups deliberately NOT behind the JWT middleware. Every entry needs a
 * reason — the same discipline as check-claude-md's allowlist.
 */
export const PUBLIC_ROUTES: Array<{ route: string; reason: string }> = [
  { route: '/api/health', reason: 'Docker healthcheck + unauthenticated liveness probe' },
  {
    route: '/api/mcp',
    reason: 'authenticates with an agent token, not a JWT (issue #232) — see docs/mcp-agent.md',
  },
  { route: '/api/share', reason: 'public share links; its own short-lived scoped tokens' },
];

export interface AuthAudit {
  mounted: string[];
  authed: string[];
  unprotected: string[];
}

/** Route groups mounted with `app.route('/api/...', …)`. */
export function mountedRoutes(source: string): string[] {
  return [...new Set([...source.matchAll(/app\.route\('(\/api\/[^']*)'/g)].map((m) => m[1] ?? ''))]
    .filter(Boolean)
    .sort();
}

/** Prefixes covered by `app.use('/api/.../*', auth)`. */
export function authedPrefixes(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/app\.use\('(\/api\/[^']+)\/\*',\s*auth\)/g)].map((m) => m[1] ?? ''),
    ),
  ]
    .filter(Boolean)
    .sort();
}

/** `app.use('/api/admin/*')` covers `/api/admin/remote-access`. */
export function isCovered(route: string, authed: string[]): boolean {
  return authed.some((a) => route === a || route.startsWith(`${a}/`));
}

export function auditRouteAuth(source: string): AuthAudit {
  const mounted = mountedRoutes(source);
  const authed = authedPrefixes(source);
  const allowed = new Set(PUBLIC_ROUTES.map((p) => p.route));
  const unprotected = mounted.filter((r) => !isCovered(r, authed) && !allowed.has(r));
  return { mounted, authed, unprotected };
}

if (import.meta.main) {
  const source = readFileSync(resolve(ROOT, 'packages/api/src/index.ts'), 'utf8');
  const { mounted, authed, unprotected } = auditRouteAuth(source);

  if (mounted.length === 0) {
    console.error(
      "check:route-auth: found no `app.route('/api/…')` mounts — has index.ts been restructured?",
    );
    process.exit(1);
  }

  if (unprotected.length > 0) {
    console.error(`\n${unprotected.length} /api route group(s) mounted without auth:\n`);
    for (const r of unprotected) console.error(`  ✗ ${r}`);
    console.error(
      `\nForgetting the \`app.use('<route>/*', auth)\` line makes a route public and\n` +
        `nothing else complains — that is how /api/radio and /api/catalog stayed open\n` +
        `(issue #461). Add the middleware, or add the route to PUBLIC_ROUTES in\n` +
        `scripts/check-route-auth.ts with a reason.\n`,
    );
    process.exit(1);
  }

  console.log(
    `Route auth: ${mounted.length} /api groups — ${mounted.length - PUBLIC_ROUTES.length} behind auth, ` +
      `${PUBLIC_ROUTES.length} deliberately public.`,
  );
}
