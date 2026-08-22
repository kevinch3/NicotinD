/**
 * Fail when something that actually SHIPS has a known vulnerability.
 *
 *   bun run check:audit
 *   bun run check:audit --list   # print every advisory, including the filtered ones
 *
 * WHY NOT JUST `bun audit`: measured on this repo, `bun audit --audit-level=high`
 * reports 27 packages / 47 high+ advisories and exits 1 — and approximately none
 * of them are actionable. Bolting that onto `verify` makes it red on day one with
 * nothing to act on, and a gate that cries wolf gets muted. That is the mirror
 * image of the silently-green failure four gates had in issue #612.
 *
 * Two independent reasons the raw number is meaningless here:
 *
 *   1. It audits the whole lockfile (2,546 packages), not what ships. The
 *      runtime image is 166 packages (issue #612 / #621, `bun install
 *      --production`). Filtering to the production closure: 27 -> 5.
 *
 *   2. It reports per package NAME, not per resolved INSTANCE. A monorepo
 *      lockfile resolves the same package many times: `sharp` is here at both
 *      0.32.6 (vulnerable, pulled by @capacitor/assets, dev-only) and 0.35.3
 *      (safe, what the API ships). `yaml` and `builder-util-runtime` are the
 *      same story. Without semver-matching the RESOLVED version, the gate is
 *      majority false positives even inside the closure.
 *
 * So this gate applies both filters and reports the whole funnel. Neither filter
 * is allowed to drop something silently: a package inside the closure whose
 * version cannot be resolved FAILS the build rather than being skipped, because
 * a quietly shrinking denominator is exactly the bug this repo keeps hitting
 * (#457, #606, #273, and the four gates fixed in #612).
 *
 * UNREACHABLE IS NOT VULNERABLE. `verify` runs offline sometimes. When the audit
 * endpoint cannot be reached this warns and passes. Recording a transient
 * failure as a finding is the same mistake #625 fixed in the MusicBrainz client,
 * pointed the other way.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

/** Severity at which a finding blocks the build. Lower ones are printed only. */
export const FAIL_AT: Severity = 'moderate';

const RANK: Record<Severity, number> = { low: 0, moderate: 1, high: 2, critical: 3 };

export interface Advisory {
  id: number;
  url: string;
  title: string;
  severity: Severity;
  vulnerable_versions: string;
}

/** `bun audit --json` output: package name -> advisories against that name. */
export type AuditReport = Record<string, Advisory[]>;

interface WorkspaceEntry {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface BunLock {
  workspaces: Record<string, WorkspaceEntry>;
  /** key -> ["name@version", registry, meta, hash]. Key may be nested: "a/b". */
  packages: Record<string, unknown[]>;
}

/**
 * Advisories we ship knowingly. Keyed `<name>@<version>` -> reason.
 *
 * Checked in BOTH directions: an entry that no longer matches anything fails the
 * build, the same discipline as check-claude-md's EXTERNAL_SYMBOLS rather than
 * its ALLOWLIST. A one-way list only grows, and grows into a mute button.
 *
 * This ships EMPTY on purpose. The two findings it was written against were
 * fixed by bumping, not excused — so there is no precedent here for excusing one.
 */
export const ACCEPTED: Map<string, string> = new Map([]);

/**
 * bun.lock is JSONC — trailing commas before `}` / `]`. Strip them string-aware
 * rather than with a regex: a blunt `/,(\s*[}\]])/` would also rewrite the inside
 * of a string literal, and this file is parsed to decide what is vulnerable.
 */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

export function parseBunLock(text: string): BunLock {
  const lock = JSON.parse(stripTrailingCommas(text)) as BunLock;
  if (!lock.workspaces || !lock.packages) {
    throw new Error('bun.lock has no workspaces/packages — has the lockfile format changed?');
  }
  return lock;
}

/** The `{ dependencies }` object inside a lock entry, if it has one. */
function metaOf(entry: unknown[] | undefined): { dependencies?: Record<string, string> } | null {
  if (!entry) return null;
  for (const part of entry) {
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      return part as { dependencies?: Record<string, string> };
    }
  }
  return null;
}

/**
 * Ancestor keys of a nested lock key, longest first.
 *
 * Cannot just `split('/')`: a scoped name contains a slash too, so
 * `@angular/cli/listr2` is `@angular/cli` + `listr2`, not three segments. Each
 * candidate prefix is therefore only accepted if it is itself a real package key.
 */
export function ancestorKeys(key: string, packages: Record<string, unknown[]>): string[] {
  const out: string[] = [];
  let cur = key;
  while (cur.includes('/')) {
    cur = cur.slice(0, cur.lastIndexOf('/'));
    if (packages[cur]) out.push(cur);
  }
  return out;
}

/**
 * Which lock entry a dependency resolves to, node-style: the nested copy under
 * the parent wins, then any ancestor's nested copy, then the hoisted one.
 */
export function resolveKey(lock: BunLock, parentKey: string, dep: string): string | null {
  const candidates = parentKey
    ? [
        `${parentKey}/${dep}`,
        ...ancestorKeys(parentKey, lock.packages).map((a) => `${a}/${dep}`),
        dep,
      ]
    : [dep];
  return candidates.find((c) => lock.packages[c]) ?? null;
}

/** `["hono@4.12.31", ...]` -> `4.12.31`. Scoped names keep their leading `@`. */
export function versionOf(entry: unknown[] | undefined): string | null {
  const spec = entry?.[0];
  if (typeof spec !== 'string') return null;
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(at + 1) : null;
}

export interface Shipped {
  /** Lock key, e.g. `hono` or `@modelcontextprotocol/sdk/hono`. */
  key: string;
  name: string;
  version: string | null;
  /** Shortest path from a workspace to this package: what to bump, and where. */
  path: string[];
}

/**
 * Every package reachable from a workspace's PRODUCTION dependencies.
 *
 * devDependencies are never followed — that is the whole point. Validated at 154
 * packages against the 166 the runtime image actually installs (#621); the gap
 * is sharp's platform-specific optional binaries, which no lockfile walk can
 * attribute to one host.
 */
export function productionClosure(lock: BunLock): Map<string, Shipped> {
  const workspaceByName = new Map<string, WorkspaceEntry>();
  for (const w of Object.values(lock.workspaces)) if (w.name) workspaceByName.set(w.name, w);

  const found = new Map<string, Shipped>();
  // Breadth-first, so the path recorded for a package is the SHORTEST route to
  // it. "yaml@2.8.2 is vulnerable" is not actionable on its own; "@nicotind/api
  // > @hono/zod-openapi > openapi3-ts > yaml" tells you what to actually bump.
  const queue: Array<{ parent: string; dep: string; path: string[] }> = [];
  for (const [dir, w] of Object.entries(lock.workspaces)) {
    for (const dep of Object.keys(w.dependencies ?? {})) {
      queue.push({ parent: '', dep, path: [w.name ?? dir] });
    }
  }

  const visited = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const { parent, dep, path } = queue[head++]!;

    // A workspace-to-workspace link: follow its production deps, and note that
    // it is not a registry package so it has no lock entry of its own.
    const asWorkspace = workspaceByName.get(dep);
    if (asWorkspace) {
      if (visited.has(`ws:${dep}`)) continue;
      visited.add(`ws:${dep}`);
      for (const d of Object.keys(asWorkspace.dependencies ?? {})) {
        queue.push({ parent: '', dep: d, path: [...path, dep] });
      }
      continue;
    }

    const key = resolveKey(lock, parent, dep);
    if (!key || visited.has(key)) continue;
    visited.add(key);

    const entry = lock.packages[key];
    found.set(key, { key, name: dep, version: versionOf(entry), path: [...path, dep] });
    for (const d of Object.keys(metaOf(entry)?.dependencies ?? {})) {
      queue.push({ parent: key, dep: d, path: [...path, dep] });
    }
  }
  return found;
}

export interface Finding {
  name: string;
  version: string;
  key: string;
  /** How this package is reached from a workspace — the thing to bump. */
  path: string[];
  advisory: Advisory;
}

export interface AuditAudit {
  /** Distinct package names `bun audit` reported an advisory against. */
  advisoryPackages: number;
  /** Total advisories across all of them. */
  advisoryCount: number;
  /** Size of the production closure. */
  closureSize: number;
  /** Advisory package names that appear anywhere in the closure. */
  inClosure: string[];
  /** Version-matched findings at or above FAIL_AT. */
  blocking: Finding[];
  /** Version-matched but below FAIL_AT. */
  informational: Finding[];
  /** Matched, but explicitly accepted. */
  accepted: Finding[];
  /** In the closure with no resolvable version — never skipped silently. */
  unresolved: string[];
  /** ACCEPTED entries that matched nothing: the list has rotted. */
  staleAccepted: string[];
}

export function auditShipped(
  lock: BunLock,
  report: AuditReport,
  accepted: Map<string, string> = ACCEPTED,
): AuditAudit {
  const closure = productionClosure(lock);

  // name -> every resolved instance of it inside the closure
  const instances = new Map<string, Shipped[]>();
  for (const s of closure.values()) {
    const list = instances.get(s.name);
    if (list) list.push(s);
    else instances.set(s.name, [s]);
  }

  const inClosure: string[] = [];
  const unresolved: string[] = [];
  const blocking: Finding[] = [];
  const informational: Finding[] = [];
  const acceptedFindings: Finding[] = [];
  const usedAcceptances = new Set<string>();

  for (const [name, advisories] of Object.entries(report)) {
    const shipped = instances.get(name);
    if (!shipped) continue;
    inClosure.push(name);

    for (const s of shipped) {
      if (!s.version) {
        unresolved.push(`${name} (lock key ${s.key})`);
        continue;
      }
      for (const advisory of advisories) {
        if (!Bun.semver.satisfies(s.version, advisory.vulnerable_versions)) continue;
        const finding: Finding = { name, version: s.version, key: s.key, path: s.path, advisory };
        const acceptKey = `${name}@${s.version}`;
        if (accepted.has(acceptKey)) {
          usedAcceptances.add(acceptKey);
          acceptedFindings.push(finding);
        } else if (RANK[advisory.severity] >= RANK[FAIL_AT]) {
          blocking.push(finding);
        } else {
          informational.push(finding);
        }
      }
    }
  }

  return {
    advisoryPackages: Object.keys(report).length,
    advisoryCount: Object.values(report).reduce((n, a) => n + a.length, 0),
    closureSize: closure.size,
    inClosure: [...new Set(inClosure)].sort(),
    blocking,
    informational,
    accepted: acceptedFindings,
    unresolved: [...new Set(unresolved)].sort(),
    staleAccepted: [...accepted.keys()].filter((k) => !usedAcceptances.has(k)).sort(),
  };
}

/** `bun audit --json`, or null when the registry could not be reached. */
export function runBunAudit(cwd = ROOT): AuditReport | null {
  const proc = Bun.spawnSync(['bun', 'audit', '--json'], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const raw = proc.stdout.toString().trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuditReport;
  } catch {
    return null;
  }
}

function describe(f: Finding): string {
  return (
    `  ${f.advisory.severity.padEnd(9)} ${f.name}@${f.version}  ${f.advisory.title}\n` +
    `      via ${f.path.join(' > ')}\n` +
    `      ${f.advisory.url}`
  );
}

if (import.meta.main) {
  const lock = parseBunLock(readFileSync(resolve(ROOT, 'bun.lock'), 'utf8'));
  const report = runBunAudit();

  if (!report) {
    // Unreachable is not vulnerable. Warn loudly, exit 0 — a network blip during
    // an offline `verify` must not read as "you shipped a vulnerability".
    console.warn(
      'check:audit: could not reach the advisory registry — skipping.\n' +
        '  This is a warning, not a pass: nothing was checked. Re-run when online.',
    );
    process.exit(0);
  }

  const a = auditShipped(lock, report);
  const listing = process.argv.includes('--list');

  console.log(
    `Supply chain: ${a.advisoryCount} advisories across ${a.advisoryPackages} packages -> ` +
      `${a.inClosure.length} in the ${a.closureSize}-package production closure -> ` +
      `${a.blocking.length + a.informational.length + a.accepted.length} version-matched.`,
  );

  if (listing && a.inClosure.length) {
    console.log(`\nAdvisory packages inside the shipping closure: ${a.inClosure.join(', ')}`);
  }

  if (a.informational.length) {
    console.log(
      `\n${a.informational.length} matched below the ${FAIL_AT} threshold (not blocking):`,
    );
    for (const f of a.informational) console.log(describe(f));
  }
  if (a.accepted.length) {
    console.log(`\n${a.accepted.length} knowingly accepted:`);
    for (const f of a.accepted) {
      console.log(`${describe(f)}\n      accepted: ${ACCEPTED.get(`${f.name}@${f.version}`)}`);
    }
  }

  let failed = false;

  // The denominator assertion. A package that ships but whose version cannot be
  // read is not "fine" — it is unexamined, and unexamined must never look green.
  if (a.unresolved.length) {
    console.error(
      `\ncheck:audit: ${a.unresolved.length} package(s) ship but have no resolvable version:\n`,
    );
    for (const u of a.unresolved) console.error(`  ? ${u}`);
    console.error(
      '\nThese were NOT checked. Fix the lockfile walk rather than the count — a gate\n' +
        'that quietly shrinks its own denominator is the bug this one exists to avoid.',
    );
    failed = true;
  }

  if (a.staleAccepted.length) {
    console.error(
      `\n${a.staleAccepted.length} ACCEPTED entr(y/ies) that match nothing any more:\n`,
    );
    for (const s of a.staleAccepted) console.error(`  x ${s}`);
    console.error(
      '\nDrop them from ACCEPTED in scripts/check-audit.ts. The list holds live\n' +
        'exceptions, not history — one that no longer applies is just a mute button.',
    );
    failed = true;
  }

  if (a.blocking.length) {
    console.error(`\n${a.blocking.length} advisor(y/ies) affect a package that actually ships:\n`);
    for (const f of a.blocking) console.error(describe(f));
    console.error(
      '\nUnlike most of what `bun audit` prints, these are in the production closure\n' +
        'AND match the resolved version. Bump the dependency. Only if the vulnerable\n' +
        'code path genuinely cannot be reached from this app, add it to ACCEPTED in\n' +
        'scripts/check-audit.ts with a reason saying why.',
    );
    failed = true;
  }

  if (failed) process.exit(1);
  console.log('\nNothing that ships is affected.');
}
