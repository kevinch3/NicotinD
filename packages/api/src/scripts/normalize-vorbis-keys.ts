/**
 * Put spaced Vorbis comment names under their canonical ones, library-wide
 * (#1250, #1231).
 *
 *   bun run packages/api/src/scripts/normalize-vorbis-keys.ts            # dry run
 *   bun run packages/api/src/scripts/normalize-vorbis-keys.ts --apply    # write
 *   bun run packages/api/src/scripts/normalize-vorbis-keys.ts --json     # machine output
 *   … --resolve=decisions.json   # settle disagreeing pairs: [{dir, spaced, keep}] (#1283)
 *
 * Dry run unless `--apply`, like every script here (#1237). Pairs whose values
 * disagree are listed and left alone. Env: NICOTIND_DATA_DIR,
 * NICOTIND_MUSIC_DIR, NICOTIND_CONFIG. → docs/library-processing.md
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { expandHome } from '@nicotind/core';
import { resolveReservedDirs } from '../services/library-paths.js';
import { backfillVorbisKeys, type VorbisKeyResolution } from '../services/vorbis-key-backfill.js';
import { isDryRun } from './normalize-library-args.js';

function loadConfig(): { musicDir: string; reserved: ReadonlySet<string> } {
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
  const musicDirRaw = process.env.NICOTIND_MUSIC_DIR ?? (fileConfig.musicDir as string | undefined);
  if (!musicDirRaw) throw new Error('musicDir not configured');
  return { musicDir: expandHome(musicDirRaw), reserved: resolveReservedDirs(fileConfig, dataDir) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = !isDryRun(argv);
  const { musicDir, reserved } = loadConfig();
  const resolveArg = argv.find((a) => a.startsWith('--resolve='))?.slice('--resolve='.length);
  const resolutions = resolveArg
    ? (JSON.parse(readFileSync(resolveArg, 'utf8')) as VorbisKeyResolution[])
    : [];
  const report = await backfillVorbisKeys({
    musicDir,
    reserved,
    apply,
    resolutions,
    onProgress: (n) => console.error(`… ${n} files`),
  });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — ${report.scanned} Ogg/FLAC files scanned`);
    console.log(`${report.affected} ${apply ? 'normalized' : 'would be normalized'}`);
    for (const [k, n] of Object.entries(report.byKey).sort((a, b) => b[1] - a[1]))
      console.log(`  ${String(n).padStart(6)}  ${k}`);
    console.log(`${report.conflicts.length} disagreeing pairs left for curation`);
    for (const c of report.conflicts) console.log(`  ${c.spaced} ≠ ${c.canonical}  ${c.path}`);
    if (report.unusedResolutions.length > 0)
      console.log(`${report.unusedResolutions.length} resolutions matched nothing`);
    for (const r of report.unusedResolutions) console.log(`  ${r.spaced} → ${r.keep}  ${r.dir}`);
    if (apply) console.log(`${report.failed.length} failed`);
    for (const f of report.failed) console.log(`  ${f}`);
  }
  if (report.failed.length > 0) process.exit(1);
}

await main();
