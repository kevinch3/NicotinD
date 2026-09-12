/**
 * Genre-affinity diagnostic (developer tool) — inspect the learned genre
 * affinity before it is allowed to score radio (docs/genre-affinity.md).
 *
 *   # rebuild the centroids now (the one write this script does), then print
 *   # the coherence ranking + the vocab-wide cosine percentiles (calibration input)
 *   bun run packages/api/src/scripts/genre-affinity.ts --refresh
 *   # one pair, with the breakdown
 *   bun run packages/api/src/scripts/genre-affinity.ts --pair "Tech House" "Tango"
 *   # what radio would drift into from here
 *   bun run packages/api/src/scripts/genre-affinity.ts --neighbours "Tech House" --limit 20
 *   # which tags read as umbrellas (lowest coherence first)
 *   bun run packages/api/src/scripts/genre-affinity.ts --breadth
 *
 * Everything but `--refresh` opens the DB read-only. The A/B against real
 * radio output is `dump-radio.ts --seed <id> --genre-affinity`.
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { expandHome } from '@nicotind/core';
import { cosineSim } from '../services/radio.service.js';
import {
  BREADTH_DISCOUNT,
  COHERENCE_HIGH,
  COHERENCE_LOW,
  COS_FLOOR,
  MIN_MEMBERS,
  breadthCredit,
  explainGenrePair,
  isUsableCentroid,
  rankNeighbours,
  type GenreCentroid,
  type GenrePairExplanation,
} from '../services/genre-affinity.js';
import { computeGenreCentroids, listGenreCentroids } from '../services/genre-centroids.js';

function loadConfig(): { dataDir: string } {
  let fileConfig: Record<string, unknown> = {};
  const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
  try {
    fileConfig = (parse(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch {
    /* no config file */
  }
  const dataDir = expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
  return { dataDir };
}

/** Minimal `--flag value [value]` / `--flag` parser (values collected until the next flag). */
export function parseArgs(argv: string[]): Record<string, string[] | true> {
  const out: Record<string, string[] | true> = {};
  let key: string | null = null;
  for (const a of argv) {
    if (a.startsWith('--')) {
      key = a.slice(2);
      out[key] = true;
      continue;
    }
    if (key === null) continue;
    const cur = out[key];
    out[key] = Array.isArray(cur) ? [...cur, a] : [a];
  }
  return out;
}

function fmt(n: number | null, digits = 3): string {
  return n === null ? '   -' : n.toFixed(digits).padStart(6);
}

/** p-th percentile (0..100) of a sorted ascending array, linear interpolation. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const pos = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Pairwise cosine percentiles across every usable centroid — the `COS_FLOOR` input. */
export function cosinePercentiles(centroids: ReadonlyMap<string, GenreCentroid>): {
  pairs: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
} {
  const usable = [...centroids.values()].filter(isUsableCentroid);
  const cos: number[] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      if (usable[i]!.model !== usable[j]!.model) continue;
      const c = cosineSim(usable[i]!.vec, usable[j]!.vec);
      if (c !== null) cos.push(c);
    }
  }
  cos.sort((a, b) => a - b);
  return {
    pairs: cos.length,
    p10: percentile(cos, 10),
    p50: percentile(cos, 50),
    p90: percentile(cos, 90),
  };
}

/** The coherence ranking, lowest (most umbrella-like) first. */
export function breadthLines(
  centroids: ReadonlyMap<string, GenreCentroid>,
  limit: number,
): string[] {
  const rows = [...centroids.values()]
    .filter(isUsableCentroid)
    .sort((a, b) => a.coherence - b.coherence)
    .slice(0, limit);
  const lines = [`genre                          members  coherence  credit`];
  for (const c of rows) {
    lines.push(
      `${c.genre.padEnd(30)} ${String(c.members).padStart(7)}  ${fmt(c.coherence)}  ${fmt(breadthCredit(c))}`,
    );
  }
  return lines;
}

export function pairLines(ex: GenrePairExplanation): string[] {
  return [
    `${ex.a}  ↔  ${ex.b}`,
    `  affinity   ${fmt(ex.affinity)}   (${ex.source}${ex.affinity === null ? ' → lexical fallback' : ''})`,
    `  cosine     ${fmt(ex.cosine)}   floor ${COS_FLOOR}`,
    `  credit     ${fmt(ex.credit)}   (min breadth credit of both sides)`,
    `  members    ${String(ex.members[0] ?? '-').padStart(6)}  ${String(ex.members[1] ?? '-').padStart(6)}   (usable ≥ ${MIN_MEMBERS})`,
    `  coherence  ${fmt(ex.coherence[0])}  ${fmt(ex.coherence[1])}   (umbrella band ${COHERENCE_LOW}..${COHERENCE_HIGH}, discount ${BREADTH_DISCOUNT})`,
  ];
}

export function neighbourLines(
  genre: string,
  centroids: ReadonlyMap<string, GenreCentroid>,
  limit: number,
): string[] {
  const vocab = [...centroids.values()].map((c) => c.genre);
  const ranked = rankNeighbours(genre, vocab, centroids, limit);
  if (ranked.length === 0)
    return [`No usable neighbours for "${genre}" (unknown, or < ${MIN_MEMBERS} members).`];
  const lines = [`neighbours of ${genre}`, `affinity  cosine  credit  members  genre`];
  for (const r of ranked) {
    const e = r.explanation;
    lines.push(
      `${fmt(e.affinity)}  ${fmt(e.cosine)}  ${fmt(e.credit)}  ${String(e.members[1] ?? '-').padStart(7)}  ${r.genre}`,
    );
  }
  return lines;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { dataDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(1);
  }
  const refresh = args['refresh'] === true;
  const db = new Database(dbPath, { readonly: !refresh });
  db.run('PRAGMA busy_timeout = 5000');
  const limit = Math.max(1, Number((args['limit'] as string[] | undefined)?.[0] ?? 20));

  if (refresh) {
    const res = computeGenreCentroids(db);
    console.log(
      `rebuilt: model=${res.model ?? '(none)'} members=${res.members} genres=${res.genres}`,
    );
  }
  const centroids = listGenreCentroids(db);
  if (centroids.size === 0) {
    console.error('No genre centroids stored yet — run with --refresh (needs analysed tracks).');
    process.exit(refresh ? 0 : 1);
  }

  const pair = args['pair'];
  const neighbours = args['neighbours'] ?? args['neighbors'];
  if (Array.isArray(pair) && pair.length >= 2) {
    console.log(pairLines(explainGenrePair(pair[0]!, pair[1]!, centroids)).join('\n'));
    return;
  }
  if (Array.isArray(neighbours) && neighbours.length >= 1) {
    console.log(neighbourLines(neighbours.join(' '), centroids, limit).join('\n'));
    return;
  }
  if (args['breadth'] === true || refresh) {
    const usable = [...centroids.values()].filter(isUsableCentroid).length;
    console.log(`centroids: ${centroids.size} (${usable} usable at ≥ ${MIN_MEMBERS} members)`);
    const p = cosinePercentiles(centroids);
    console.log(
      `pairwise cosine over ${p.pairs} pairs: p10 ${fmt(p.p10)}  p50 ${fmt(p.p50)}  p90 ${fmt(p.p90)}   (COS_FLOOR ${COS_FLOOR})`,
    );
    console.log('');
    console.log(breadthLines(centroids, limit).join('\n'));
    return;
  }
  console.error('Provide --refresh, --pair A B, --neighbours G, or --breadth.');
  process.exit(1);
}

if (import.meta.main) main();
