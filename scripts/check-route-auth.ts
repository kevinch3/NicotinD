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
 *
 * WHY AN AST, NOT A REGEX: the first version matched `app.route('(/api/...)'`,
 * which requires the path literal on the same line as the call. Prettier wraps
 * long calls, so 11 of 35 mounts — `/api/auth`, `/api/admin`, `/api/mcp`,
 * `/api/library`, `/api/devices` among them — were invisible, and the gate
 * printed "24 /api groups" and exited 0. Whether a route got audited depended
 * on how long its arguments were. A gate that reports a false denominator is
 * worse than no gate: it is the #457/#606/#273 shape, silently green.
 *
 * So the parser is a real one, and it asserts its own denominator: every
 * `.route(` in the file must be accounted for, on a receiver it recognises,
 * with a path it can read. Anything it cannot explain fails the build rather
 * than being skipped.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dir, '..');

/** The router variable in `packages/api/src/index.ts` that mounts `/api`. */
const ROUTER = 'app';

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
  {
    route: '/api/radio-polls',
    reason:
      'public radio-evaluation poll links (the poll token is the credential); media served via short-lived read-only share JWTs — see docs/radio-eval-polls.md',
  },
  // The four below were invisible to the regex this gate used until the AST
  // rewrite. Each was checked against its route file rather than assumed safe.
  {
    route: '/api/auth',
    reason:
      'login and register must be reachable before a session exists; the routes here that need one take `auth` themselves',
  },
  {
    route: '/api/setup',
    reason:
      'first-run wizard, reachable before any user exists; POST /complete self-guards on `SELECT COUNT(*) FROM users > 0` and 400s once setup is done (routes/setup.ts:34)',
  },
  {
    route: '/api/devices',
    reason:
      'pairing flow: devicesRoutes applies `auth` per-route (/pair, /login-approve, GET /, DELETE /:id) and deliberately leaves /claim, /login-request and /login-claim open, where the short-lived pairing token is itself the credential — a blanket app.use would break pairing (docs/device-pairing.md)',
  },
  {
    route: '/api',
    reason:
      'bare mount for streamingRoutes, whose only paths are /stream/:id, /cover/:id and /cover/remote — each covered by its own app.use(auth) registered earlier in index.ts. RESIDUAL RISK: a route added at this mount root would land on /api/<name> and be public; narrowing the mount is tracked separately',
  },
];

export interface AuthAudit {
  mounted: string[];
  authed: string[];
  unprotected: string[];
  /** `app.route(...)` call nodes the walker found, before dedup. */
  mountCalls: number;
  /** `.route(` occurrences in the source text, on any receiver. */
  routeCallsInSource: number;
  /** Receivers other than `app` that `.route()` was called on. */
  unknownReceivers: string[];
  /** `app.route()` calls whose first argument is not a plain string literal. */
  unreadableMounts: string[];
}

/** Is this call `<receiver>.<method>(...)`? Returns the receiver name if so. */
function receiverOf(node: ts.CallExpression, method: string): string | null {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (callee.name.text !== method) return null;
  return ts.isIdentifier(callee.expression) ? callee.expression.text : '<expression>';
}

/** Every `.route()` / `.use()` call in the file, in source order. */
function calls(
  source: string,
  method: string,
): Array<{ receiver: string; node: ts.CallExpression }> {
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const found: Array<{ receiver: string; node: ts.CallExpression }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const receiver = receiverOf(node, method);
      if (receiver !== null) found.push({ receiver, node });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

/** A path we are willing to audit: `/api` itself, or something under it. */
function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** Route groups mounted with `app.route('/api...', …)`, wrapped or not. */
export function mountedRoutes(source: string): string[] {
  const paths: string[] = [];
  for (const { receiver, node } of calls(source, 'route')) {
    if (receiver !== ROUTER) continue;
    const first = node.arguments[0];
    if (first && ts.isStringLiteralLike(first) && isApiPath(first.text)) paths.push(first.text);
  }
  return [...new Set(paths)].sort();
}

/** Prefixes covered by `app.use('/api/.../*', auth)`. */
export function authedPrefixes(source: string): string[] {
  const prefixes: string[] = [];
  for (const { receiver, node } of calls(source, 'use')) {
    if (receiver !== ROUTER) continue;
    const [first, second] = node.arguments;
    // Exactly `auth` as the sole middleware — `requireAcquisition`, or a call
    // like `nativeAppCors()`, is not an authentication decision.
    if (!second || !ts.isIdentifier(second) || second.text !== 'auth') continue;
    if (!first || !ts.isStringLiteralLike(first)) continue;
    if (!first.text.endsWith('/*')) continue;
    const prefix = first.text.slice(0, -2);
    if (isApiPath(prefix)) prefixes.push(prefix);
  }
  return [...new Set(prefixes)].sort();
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

  const routeCalls = calls(source, 'route');
  const unknownReceivers = [
    ...new Set(routeCalls.filter((c) => c.receiver !== ROUTER).map((c) => c.receiver)),
  ].sort();
  const ours = routeCalls.filter((c) => c.receiver === ROUTER);
  const unreadableMounts = ours
    .filter((c) => {
      const first = c.node.arguments[0];
      return !first || !ts.isStringLiteralLike(first);
    })
    .map((c) => c.node.getText().split('\n')[0]?.trim() ?? '<unknown>');

  return {
    mounted,
    authed,
    unprotected,
    mountCalls: ours.length,
    routeCallsInSource: (source.match(/\.route\(/g) ?? []).length,
    unknownReceivers,
    unreadableMounts,
  };
}

if (import.meta.main) {
  const source = readFileSync(resolve(ROOT, 'packages/api/src/index.ts'), 'utf8');
  const audit = auditRouteAuth(source);
  const { mounted, unprotected, mountCalls, routeCallsInSource } = audit;

  if (mounted.length === 0) {
    console.error(
      "check:route-auth: found no `app.route('/api/…')` mounts — has index.ts been restructured?",
    );
    process.exit(1);
  }

  // The denominator assertion. A gate that can quietly examine a subset and
  // still print a confident summary is how this one shipped broken for months.
  if (mountCalls + audit.unknownReceivers.length !== routeCallsInSource) {
    console.error(
      `\ncheck:route-auth: accounted for ${mountCalls} of ${routeCallsInSource} \`.route(\` calls.\n\n` +
        `The parser and the file disagree, so some mount is going unaudited.\n` +
        `Fix the walker rather than the count — an undercount here is exactly the\n` +
        `bug this gate exists to prevent.\n`,
    );
    process.exit(1);
  }

  if (audit.unknownReceivers.length > 0) {
    console.error(
      `\ncheck:route-auth: \`.route()\` called on ${audit.unknownReceivers.join(', ')}, ` +
        `but this gate only audits \`${ROUTER}\`.\n\n` +
        `Mounts on another router are invisible to the auth audit. Either mount\n` +
        `them on \`${ROUTER}\`, or teach this script about the new router.\n`,
    );
    process.exit(1);
  }

  if (audit.unreadableMounts.length > 0) {
    console.error(
      `\ncheck:route-auth: ${audit.unreadableMounts.length} mount(s) have a non-literal path:\n`,
    );
    for (const m of audit.unreadableMounts) console.error(`  ? ${m}`);
    console.error(
      `\nA computed path cannot be checked against the auth list. Use a string\n` +
        `literal, or add the resolved route to PUBLIC_ROUTES with a reason.\n`,
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
    `Route auth: ${mounted.length} /api groups (${routeCallsInSource} mount calls) — ` +
      `${mounted.length - PUBLIC_ROUTES.length} behind auth, ` +
      `${PUBLIC_ROUTES.length} deliberately public.`,
  );
}
