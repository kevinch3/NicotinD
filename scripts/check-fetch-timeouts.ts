/**
 * Fail when an outbound `fetch` has no abort signal.
 *
 *   bun run check:fetch-timeouts
 *
 * WHY: `LidarrClient.request` had no timeout, and neither did the MusicBrainz
 * client. Both are single choke points — one behind 13 methods and 43 call
 * sites, the other behind every non-tag artist surface — so a hung upstream
 * held them open indefinitely while `/api/health` kept reporting OK. The
 * MusicBrainz one was worse than a hang: its failures were cached, in a cache
 * with no expiry, so a timeout would have recorded "no such entity" forever.
 *
 * Both were fixed. This exists so the next one is caught at the PR rather than
 * in production, because the failure mode is silence: a missing timeout looks
 * exactly like a working call until an upstream stops answering.
 *
 * DENOMINATOR: a gate that greps for `fetch(` would miss most of these. The
 * real call sites appear as an Identifier (`fetch(...)`), a parenthesized
 * expression (`(this.fetchFn ?? fetch)(...)`), and an injected alias
 * (`fetchFn(...)`) — three shapes, and only the first is obvious. So this walks
 * the AST for ANY callee whose text mentions `fetch`, reports how many it
 * examined, and fails on a shape it cannot classify rather than skipping it.
 */
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const ROOT = resolve(import.meta.dir, '..');

/**
 * Callees that mention `fetch` but are not an outbound HTTP call. Each needs a
 * reason — the same discipline as check-route-auth's PUBLIC_ROUTES.
 */
export const NOT_OUTBOUND = new Map<string, string>([
  [
    'this.fetch',
    "MusicBrainzClient's own private wrapper — the global fetch inside it is checked on its own line",
  ],
  ['app.fetch', "Hono's request handler, passed to Bun.serve — inbound, not outbound"],
]);

/**
 * Is this callee the global fetch, or an injected stand-in for it?
 *
 * Tokenised rather than matched with `\bfetch\b`, which does NOT match
 * `fetchFn` — there is no word boundary before `Fn`. That gap hid a real
 * unguarded POST to AcoustID (`this.fetchFn(ACOUSTID_URL, {...})`) until this
 * script's own test caught it.
 *
 * Internal helpers whose names merely start with "fetch" — `fetchMetadata`,
 * `fetchAndStoreArtistInfo` — are deliberately NOT matched: they are not
 * outbound calls themselves, and the real call they eventually make is checked
 * on its own line.
 */
export function isOutboundCallee(callee: string): boolean {
  return callee.split(/[^A-Za-z0-9_$]+/).some((token) => token === 'fetch' || token === 'fetchFn');
}

export interface FetchSite {
  file: string;
  line: number;
  callee: string;
  hasSignal: boolean;
}

/** Does this call pass a `signal` in its RequestInit? */
function passesSignal(node: ts.CallExpression): boolean {
  const init = node.arguments[1];
  if (!init) return false;
  if (!ts.isObjectLiteralExpression(init)) {
    // `fetch(url, init)` where init is a variable — we cannot see inside it, so
    // it counts as unguarded. Inline the signal, or spread it into a literal.
    return false;
  }
  return init.properties.some((p) => {
    if (ts.isSpreadAssignment(p)) return false; // cannot verify a spread's contents
    return p.name !== undefined && p.name.getText() === 'signal';
  });
}

export function findFetchSites(source: string, file: string): FetchSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: FetchSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText().replace(/\s+/g, ' ');
      if (isOutboundCallee(callee) && !NOT_OUTBOUND.has(callee)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        found.push({ file, line: line + 1, callee, hasSignal: passesSignal(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** Backend source only. The browser has its own abort story and its own interceptor. */
function backendSources(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', 'packages/*/src/**/*.ts', 'src/**/*.ts', 'packages/*/src/*.ts', 'src/*.ts'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return [
    ...new Set(
      out
        .split('\n')
        .filter(Boolean)
        .filter((f) => !f.startsWith('packages/web/'))
        .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts')),
    ),
  ].sort();
}

if (import.meta.main) {
  const files = backendSources();
  const sites = files.flatMap((f) =>
    findFetchSites(readFileSync(resolve(ROOT, f), 'utf8'), relative(ROOT, f)),
  );

  if (files.length === 0) {
    console.error('check:fetch-timeouts: found no backend sources — has the layout changed?');
    process.exit(1);
  }

  const unguarded = sites.filter((s) => !s.hasSignal);
  if (unguarded.length > 0) {
    console.error(`\n${unguarded.length} outbound fetch call(s) with no abort signal:\n`);
    for (const s of unguarded) console.error(`  ✗ ${s.file}:${s.line}  ${s.callee}(...)`);
    console.error(
      '\nA fetch with no timeout hangs forever when the upstream stops answering,\n' +
        'and it looks exactly like a working call until then. Pass an\n' +
        '`AbortSignal.timeout(ms)` in the RequestInit — inline, so it is visible here.\n' +
        'If the call genuinely is not outbound HTTP, add its callee to NOT_OUTBOUND\n' +
        'in scripts/check-fetch-timeouts.ts with a reason.\n',
    );
    process.exit(1);
  }

  console.log(
    `Fetch timeouts: ${sites.length} outbound call(s) across ${files.length} backend files — all bounded.`,
  );
}
