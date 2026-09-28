/**
 * Snapshot the database before a deploy replaces the server. Run by
 * `.github/workflows/deploy-host.yml` inside a NicotinD container on the host:
 *
 *   docker compose exec -T nicotind bun packages/api/src/scripts/pre-deploy-snapshot.ts v1.2.3
 *
 * Env: NICOTIND_DATA_DIR (the container sets it), NICOTIND_PREDEPLOY_KEEP.
 * Exits non-zero on failure so the deploy stops. → docs/backup-restore.md
 */
import { expandHome } from '@nicotind/core';
import { runPreDeploySnapshot } from '../services/pre-deploy-snapshot.js';

const dataDir = expandHome(process.env.NICOTIND_DATA_DIR ?? '~/.nicotind');
const target = process.argv[2] ?? 'unknown';
const keepEnv = Number(process.env.NICOTIND_PREDEPLOY_KEEP);

const result = runPreDeploySnapshot({
  dataDir,
  target,
  ...(Number.isInteger(keepEnv) && keepEnv > 0 ? { keep: keepEnv } : {}),
});
console.log(
  result
    ? `pre-deploy snapshot: ${result.dir} (${Math.round(result.sizeBytes / 1e6)} MB)`
    : `pre-deploy snapshot: nothing to snapshot in ${dataDir} (no database yet)`,
);
