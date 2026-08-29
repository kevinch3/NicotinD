/**
 * Measure per-feature mean / sd over the stored raw descriptors and print the
 * `DESCRIPTOR_NORM` literal for `services/descriptor-norm.ts` (issue #642).
 *
 *   bun run packages/api/src/scripts/measure-descriptor-stats.ts            # NICOTIND_DATA_DIR
 *   bun run packages/api/src/scripts/measure-descriptor-stats.ts --db /path/to/nicotind.db
 *
 * Read-only by construction: the connection is opened `{ readonly: true }`
 * and the only statement is a SELECT. Deliberately self-contained (no repo
 * imports beyond bun:sqlite) so the same file can be copied into the prod
 * container and run there — the constants are supposed to come from the real
 * library, not a fixture (docs/prod-inspection.md).
 *
 * Population sd (÷ n), nulls skipped per feature: a value the sidecar could
 * not define (no off-beat onsets → no swing) is absent, not zero.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface FeatureStat {
  mean: number;
  sd: number;
  n: number;
}

export interface DescriptorStats {
  /** Rows that parsed as a JSON object. */
  n: number;
  stats: Record<string, FeatureStat>;
}

/** Pure: JSON rows (the `features` column) → per-feature mean / population sd. */
export function descriptorStats(rows: readonly string[]): DescriptorStats {
  const sums = new Map<string, { sum: number; sumSq: number; n: number }>();
  let n = 0;
  for (const raw of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    n++;
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const acc = sums.get(name) ?? { sum: 0, sumSq: 0, n: 0 };
      acc.sum += value;
      acc.sumSq += value * value;
      acc.n++;
      sums.set(name, acc);
    }
  }
  const stats: Record<string, FeatureStat> = {};
  for (const [name, acc] of sums) {
    const mean = acc.sum / acc.n;
    const variance = Math.max(0, acc.sumSq / acc.n - mean * mean);
    stats[name] = { mean, sd: Math.sqrt(variance), n: acc.n };
  }
  return { n, stats };
}

const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

/** The `DESCRIPTOR_NORM_SAMPLE` + `DESCRIPTOR_NORM` literals, names sorted. */
export function renderNormLiteral(stats: DescriptorStats, measuredAt: string): string {
  const names = Object.keys(stats.stats).sort();
  const lines = names.map((name) => {
    const s = stats.stats[name]!;
    return `  ${name}: { mean: ${round4(s.mean)}, sd: ${round4(s.sd)} },`;
  });
  return [
    `export const DESCRIPTOR_NORM_SAMPLE = {`,
    `  n: ${stats.n},`,
    `  measuredAt: '${measuredAt}',`,
    `  library: 'kpc (prod)',`,
    `};`,
    ``,
    `export const DESCRIPTOR_NORM: DescriptorNorm = {`,
    ...lines,
    `};`,
  ].join('\n');
}

async function main(): Promise<void> {
  const { Database } = await import('bun:sqlite');
  const i = process.argv.indexOf('--db');
  const dbPath =
    i >= 0
      ? process.argv[i + 1]!
      : join(process.env.NICOTIND_DATA_DIR ?? `${process.env.HOME}/.nicotind`, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath} (pass --db or set NICOTIND_DATA_DIR).`);
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .query<{ features: string }, []>(
      'SELECT features FROM library_song_descriptors WHERE version = 1',
    )
    .all()
    .map((r) => r.features);
  const stats = descriptorStats(rows);
  console.error(`${stats.n} descriptor rows; ${Object.keys(stats.stats).length} features\n`);
  console.log(renderNormLiteral(stats, new Date().toISOString().slice(0, 10)));
}

if (import.meta.main) {
  await main();
}
