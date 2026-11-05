/**
 * Fail when bun.lock lists a platform binary as an optional dependency but has no
 * entry for it.
 *
 *   bun run check:lockfile-platforms
 *
 * WHY: `bun add` once rewrote this lockfile with every non-linux-x64 optional
 * binary missing (#1533). Linux x64 CI stays green on such a file, because the one
 * binary it needs is still there. It breaks macOS, the arm64 Docker image and the
 * desktop packaging jobs instead, after the merge.
 *
 * WHAT IT ASSERTS: every `optionalDependencies` name in every lock entry resolves,
 * the way bun itself resolves it (nearest entry up the parent chain), to an entry
 * whose version satisfies the requested range. The parent keeps listing what its
 * binaries are after they are dropped, so this needs no previous lockfile to
 * compare against. A real prune removes the parent too.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBunLock, resolveKey, versionOf, type BunLock } from './check-audit.js';

const ROOT = resolve(import.meta.dir, '..');

export interface OptionalDepReport {
  /** Lock entries that declare at least one optional dependency. */
  parents: number;
  /** Declared optional dependencies, across all parents. */
  edges: number;
  /** One line per declared dependency the lockfile cannot satisfy. */
  problems: string[];
}

function optionalDepsOf(entry: unknown[]): Record<string, string> {
  for (const part of entry) {
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const opt = (part as { optionalDependencies?: Record<string, string> }).optionalDependencies;
      if (opt) return opt;
    }
  }
  return {};
}

export function checkOptionalDeps(lock: BunLock): OptionalDepReport {
  const report: OptionalDepReport = { parents: 0, edges: 0, problems: [] };
  for (const [key, entry] of Object.entries(lock.packages)) {
    const deps = Object.entries(optionalDepsOf(entry as unknown[]));
    if (deps.length === 0) continue;
    report.parents++;
    for (const [name, range] of deps) {
      report.edges++;
      const found = resolveKey(lock, key, name);
      if (!found) {
        report.problems.push(`${key} lists ${name}@${range}, which has no lock entry`);
        continue;
      }
      const version = versionOf(lock.packages[found]!);
      if (version && !Bun.semver.satisfies(version, range)) {
        report.problems.push(`${key} wants ${name}@${range}, but ${found} is ${version}`);
      }
    }
  }
  return report;
}

function main(): void {
  const report = checkOptionalDeps(parseBunLock(readFileSync(resolve(ROOT, 'bun.lock'), 'utf8')));
  console.log(
    `Lockfile platforms: ${report.edges} optional dependencies across ${report.parents} packages.`,
  );
  // A parser that stopped seeing them would otherwise pass over an empty set.
  if (report.edges === 0) {
    console.error('Found no optional dependencies at all — has the lockfile format changed?');
    process.exit(1);
  }
  if (report.problems.length > 0) {
    console.error(`\n${report.problems.length} problem(s):\n`);
    for (const p of report.problems.slice(0, 40)) console.error(`  - ${p}`);
    console.error(
      '\nDid `bun add` rewrite the lockfile? Restore bun.lock and bump by hand: ' +
        'docs/dependency-management.md#bumping-one-dependency-safely',
    );
    process.exit(1);
  }
}

if (import.meta.main) main();
