/**
 * Move Lidarr's artists off a root folder that overlaps the music library onto
 * the empty metadata root, then unregister the overlapping root (issue #1580) —
 * the one-time migration for a Lidarr provisioned before NicotinD stopped
 * registering `musicDir`. New adds already land on the metadata root; this
 * relocates the existing ones so Lidarr's daily rescan stops import-evaluating
 * the library.
 *
 *   bun run packages/api/src/scripts/lidarr-isolate-root.ts           # dry run
 *   bun run packages/api/src/scripts/lidarr-isolate-root.ts --apply   # write
 *
 * Bookkeeping only: `isolateLidarrRoot` reassigns with `moveFiles: false`, which
 * rewrites Lidarr's stored paths and moves nothing on disk, and unregisters a root
 * only after a re-read shows no artist left under it. Unmount the library from the
 * Lidarr container first (docs/deployment.md) and Lidarr cannot touch it at all.
 *
 * Env: NICOTIND_LIDARR_URL (or LIDARR_URL), LIDARR_API_KEY, NICOTIND_MUSIC_DIR,
 * NICOTIND_LIDARR_ROOT_FOLDER (default: the external-mode metadata root).
 */
import { expandHome } from '@nicotind/core';
import { Lidarr } from '../lidarr/index.js';
import { LIDARR_METADATA_ROOT_DEFAULT, isolateLidarrRoot } from '../services/lidarr-root.js';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const url = process.env.NICOTIND_LIDARR_URL ?? process.env.LIDARR_URL ?? 'http://localhost:8686';
  const apiKey = process.env.LIDARR_API_KEY ?? '';
  const musicDir = process.env.NICOTIND_MUSIC_DIR;
  if (!apiKey || !musicDir) {
    console.error(
      'Set LIDARR_API_KEY and NICOTIND_MUSIC_DIR (the library path as Lidarr sees it).',
    );
    process.exit(2);
  }
  const policy = {
    metadataRoot: process.env.NICOTIND_LIDARR_ROOT_FOLDER ?? LIDARR_METADATA_ROOT_DEFAULT,
    musicDir: expandHome(musicDir),
  };

  const report = await isolateLidarrRoot(new Lidarr({ baseUrl: url, apiKey }), policy, { apply });
  console.log(JSON.stringify(report, null, 2));
  if (!apply && report.artistsToMove > 0) {
    console.log(`\nDry run — re-run with --apply to move ${report.artistsToMove} artists.`);
  }
  if (apply && report.remaining > 0) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
