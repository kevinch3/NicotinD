/**
 * Build the prebuilt server tarball for non-Docker installs (#1742).
 *
 *   bun run server-tarball [--max-mb <n>]
 *
 * WHY: without it, the only route on a host with no Docker is the dev workflow
 * (1,487 packages, Node >= 24.19 for `ng build`, a 1.66 GB peak build that
 * would OOM a 2 GB board). The tarball carries what the server needs and
 * nothing else: install Bun, untar, `.env`, `bun run src/main.ts`.
 *
 * It reuses the desktop app's staging (`packages/desktop/scripts/
 * prepare-resources.ts`) rather than a second recipe: the same unbundled
 * backend source, the same production install pinned to the versions the
 * monorepo resolved (#1174), the same SPA build. The desktop extras (bun and
 * ffmpeg binaries, icons) are left out. One recipe, two outputs.
 *
 * Native deps: `sharp` ships per-platform prebuilt binaries, so the production
 * install is per-arch. The release builds each arch on its own native runner
 * (see deploy.yml `server-tarball`), like the Docker image; nothing compiles.
 *
 * Output: `dist-server/nicotind-<ver>-server-linux-<arch>.tar.gz` plus a
 * `.sha256` beside it. `scripts/server-tarball-smoke.ts` is its acceptance test.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { stageBackend, stageWeb } from '../packages/desktop/scripts/prepare-resources';

const repoRoot = path.resolve(import.meta.dir, '..');
const outDir = path.join(repoRoot, 'dist-server');

/**
 * Files outside the staged backend that the server still reads at runtime.
 * Embedded mode (the default) runs `scripts/download-deps.ts` on first start
 * to fetch Lidarr, so it and its relative imports travel too.
 */
export const SERVER_EXTRA_FILES = [
  'scripts/download-deps.ts',
  'scripts/download-progress.ts',
  'scripts/download-deps-paths.ts',
  '.env.example',
  'LICENSE',
] as const;

export type ServerArch = 'x64' | 'arm64';

/** The release ships linux-x64 and linux-arm64 only; macOS hosts have the desktop app. */
export function serverTarballArch(arch: string): ServerArch {
  if (arch === 'x64' || arch === 'arm64') return arch;
  throw new Error(`server tarball builds on x64 or arm64 Linux, not ${arch}`);
}

export function serverTarballName(version: string, arch: ServerArch): string {
  return `nicotind-${version}-server-linux-${arch}.tar.gz`;
}

/** True when a tarball of `bytes` exceeds a ceiling of `maxMb` MiB. */
export function overBudget(bytes: number, maxMb: number): boolean {
  return bytes > maxMb * 1024 * 1024;
}

/**
 * The environment the smoke test starts the unpacked server with: no Lidarr
 * (external mode with no URL, so nothing is downloaded), and a data and music
 * dir of its own under `root` so it never touches the runner's home.
 */
export function smokeEnv(root: string, port: number): Record<string, string> {
  return {
    NICOTIND_MODE: 'external',
    NICOTIND_PORT: String(port),
    NICOTIND_DATA_DIR: path.join(root, 'data'),
    NICOTIND_MUSIC_DIR: path.join(root, 'music'),
  };
}

function maxMbArg(argv: string[]): number | null {
  const i = argv.indexOf('--max-mb');
  if (i < 0) return null;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error('--max-mb needs a positive number');
  return n;
}

function main(): void {
  if (process.platform !== 'linux') {
    throw new Error(`server tarball builds on Linux, not ${process.platform}`);
  }
  const arch = serverTarballArch(process.arch);
  const { version } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  const top = `nicotind-${version}`;
  const stage = path.join(outDir, top);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  stageBackend(stage);
  // Where main.ts looks by default (`../packages/web/dist` from src/), so the
  // unpacked tree needs no NICOTIND_WEB_DIST.
  stageWeb(path.join(stage, 'packages', 'web', 'dist'));
  for (const f of SERVER_EXTRA_FILES) {
    mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    copyFileSync(path.join(repoRoot, f), path.join(stage, f));
  }

  const name = serverTarballName(version, arch);
  const tarball = path.join(outDir, name);
  const tar = spawnSync('tar', ['-czf', tarball, '-C', outDir, top], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error(`tar failed (exit ${tar.status})`);

  const bytes = statSync(tarball).size;
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  writeFileSync(`${tarball}.sha256`, `${digest}  ${name}\n`);
  console.log(`✓ ${name}: ${(bytes / 1024 / 1024).toFixed(1)} MiB, sha256 ${digest}`);

  const maxMb = maxMbArg(process.argv);
  if (maxMb !== null && overBudget(bytes, maxMb)) {
    throw new Error(
      `${name} is ${(bytes / 1024 / 1024).toFixed(1)} MiB, over the ${maxMb} MiB ceiling. ` +
        'A new heavy runtime dependency? Raise the ceiling in deploy.yml only on purpose.',
    );
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`\n✗ server-tarball failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
