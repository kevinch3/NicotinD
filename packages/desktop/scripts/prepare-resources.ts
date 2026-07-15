/**
 * Assembles `packages/desktop/resources/` — everything `electron-builder.yml`
 * stages via `extraResources` into the packaged app's `process.resourcesPath`.
 *
 * Layout produced here MUST match `packages/desktop/electron/paths.ts`'s prod
 * resolution exactly:
 *
 *   resources/bin/bun          -> paths.ts `bunBinary()`
 *   resources/bin/ffmpeg       -> paths.ts `ffmpegBinaryPath()`
 *   resources/backend/src/main.ts -> paths.ts `backendEntry()`
 *   resources/web               -> paths.ts `webDistPath()`
 *
 * Variant B (chosen by the Task-9/10 spike — see packages/desktop/spike/README.md):
 * the backend ships as **unbundled source + a bun binary + a production
 * install of its own node_modules**, and the sidecar runs
 * `bun run <resources>/backend/src/main.ts` rather than a `bun build
 * --compile` binary (static bundling breaks on pino-pretty's
 * `require.resolve`).
 *
 * This script is NOT run as part of `bun run build` / `bun run typecheck` —
 * it's invoked by `packages/desktop/package.json`'s `dist` script right
 * before `electron-builder`, and needs network access (`bun install`, and to
 * build the Angular web UI) plus a real filesystem to stage into. It cannot
 * be exercised end-to-end in a sandboxed/offline environment; every stage
 * below is written to fail loudly (thrown Error) rather than silently
 * produce a half-staged `resources/` tree.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const desktopRoot = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const resourcesDir = path.join(desktopRoot, 'resources');

/** The workspace packages the backend entry (`src/main.ts`) transitively imports. */
const BACKEND_WORKSPACE_PACKAGES = ['core', 'slskd-client', 'service-manager', 'lidarr-client', 'api'] as const;

interface WorkspacePackageJson {
  name: string;
  dependencies?: Record<string, string>;
}

/** The synthesized `package.json` staged at `resources/backend/package.json`. */
export interface BackendPackageJson {
  name: string;
  version: string;
  private: true;
  type: 'module';
  workspaces: string[];
  dependencies: Record<string, string>;
}

/**
 * Pure: synthesizes the standalone `package.json` for the staged backend
 * tree from (a) the repo root's own runtime `dependencies` (external
 * packages like `yaml`) and (b) each staged workspace package's own `name`
 * (turned into a `workspace:*` entry).
 *
 * Deliberately NOT a copy of the repo root's `package.json` — that one
 * carries dev-only tooling (e.g. husky's `prepare` script) that would fail
 * to run outside a git checkout, plus a `workspaces` glob covering packages
 * (web/mobile/e2e/desktop/...) this staged tree never contains.
 */
export function buildBackendPackageJson(
  rootDependencies: Record<string, string> | undefined,
  workspacePackageNames: readonly string[],
): BackendPackageJson {
  const externalDeps: Record<string, string> = {};
  for (const [name, version] of Object.entries(rootDependencies ?? {})) {
    if (!name.startsWith('@nicotind/')) {
      externalDeps[name] = version;
    }
  }
  const workspaceDeps: Record<string, string> = {};
  for (const name of workspacePackageNames) {
    workspaceDeps[name] = 'workspace:*';
  }
  return {
    name: 'nicotind-backend',
    version: '0.0.0',
    private: true,
    type: 'module',
    workspaces: ['packages/*'],
    dependencies: { ...externalDeps, ...workspaceDeps },
  };
}

/** Pure: true when `execPath` looks like a `bun` (not `node`/other) binary. */
export function isLikelyBunBinary(execPath: string): boolean {
  return /bun(\.exe)?$/i.test(execPath);
}

function run(label: string, cmd: string, args: string[], cwd: string): void {
  console.log(`\n▶ ${label} (${cwd})`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  if (result.error) {
    throw new Error(`${label} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status})`);
  }
  console.log(`✓ ${label}`);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** 1. Build the Angular SPA and stage its output at `resources/web`. */
function stageWeb(): void {
  run('Build @nicotind/web', 'bun', ['run', '--filter', '@nicotind/web', 'build'], repoRoot);

  const webDist = path.join(repoRoot, 'packages', 'web', 'dist');
  if (!existsSync(webDist)) {
    throw new Error(`Expected web build output at ${webDist} — build did not produce it`);
  }
  const dest = path.join(resourcesDir, 'web');
  rmSync(dest, { recursive: true, force: true });
  cpSync(webDist, dest, { recursive: true });
  console.log(`✓ Staged web dist -> ${dest}`);
}

/**
 * 2. Stage the backend as unbundled source (Variant B): the root `src/`
 * entry, the workspace packages it depends on (their `src/` + own
 * `package.json`), and `config/` — then synthesize a standalone
 * `package.json` for the staged tree and run a production `bun install`
 * inside it so `bun run resources/backend/src/main.ts` resolves every
 * import without the rest of the monorepo present.
 */
function stageBackend(): void {
  const backendDir = path.join(resourcesDir, 'backend');
  rmSync(backendDir, { recursive: true, force: true });
  mkdirSync(backendDir, { recursive: true });

  // Root backend entry.
  cpSync(path.join(repoRoot, 'src'), path.join(backendDir, 'src'), { recursive: true });
  cpSync(path.join(repoRoot, 'config'), path.join(backendDir, 'config'), { recursive: true });

  // Workspace packages the entry imports, source + their own package.json only
  // (no dist/, no tests need to travel — `bun run` executes .ts directly).
  const workspacePackageNames: string[] = [];
  for (const pkg of BACKEND_WORKSPACE_PACKAGES) {
    const pkgSrcRoot = path.join(repoRoot, 'packages', pkg);
    const pkgDestRoot = path.join(backendDir, 'packages', pkg);
    mkdirSync(pkgDestRoot, { recursive: true });
    cpSync(path.join(pkgSrcRoot, 'src'), path.join(pkgDestRoot, 'src'), { recursive: true });
    copyFileSync(path.join(pkgSrcRoot, 'package.json'), path.join(pkgDestRoot, 'package.json'));

    const pkgJson = readJson<WorkspacePackageJson>(path.join(pkgSrcRoot, 'package.json'));
    workspacePackageNames.push(pkgJson.name);
  }

  const rootPkg = readJson<{ dependencies?: Record<string, string> }>(path.join(repoRoot, 'package.json'));
  const backendPkg = buildBackendPackageJson(rootPkg.dependencies, workspacePackageNames);
  writeFileSync(path.join(backendDir, 'package.json'), JSON.stringify(backendPkg, null, 2) + '\n');

  // Production install: resolves the external deps above (hono, zod,
  // music-metadata, sharp, pino, ...) plus wires the workspace: packages via
  // symlinks in node_modules. Not `--frozen-lockfile` — this package.json is
  // synthesized fresh each run and has no matching lockfile to freeze
  // against; bun resolves it from the version ranges directly.
  run('bun install --production (backend)', 'bun', ['install', '--production'], backendDir);

  const entry = path.join(backendDir, 'src', 'main.ts');
  if (!existsSync(entry)) {
    throw new Error(`Backend entry missing after staging: ${entry}`);
  }
  console.log(`✓ Staged backend -> ${backendDir}`);
}

/**
 * 3. Stage a `bun` binary for the current platform at `resources/bin/bun`.
 *
 * Resolved via `process.execPath` — this script itself always runs under
 * `bun` (`bun run scripts/prepare-resources.ts`), so `process.execPath` IS
 * the bun binary for exactly the platform/arch we're packaging for (CI runs
 * one job per target platform — see Task 14).
 */
function stageBun(): void {
  const binDir = path.join(resourcesDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const bunSrc = process.execPath;
  if (!existsSync(bunSrc) || !isLikelyBunBinary(bunSrc)) {
    throw new Error(
      `process.execPath (${bunSrc}) does not look like a bun binary — this script must be run via 'bun run', not node`,
    );
  }
  const dest = path.join(binDir, process.platform === 'win32' ? 'bun.exe' : 'bun');
  copyFileSync(bunSrc, dest);
  chmodSync(dest, 0o755);
  console.log(`✓ Staged bun binary ${bunSrc} -> ${dest}`);
}

/**
 * 4. Stage a static `ffmpeg` for the current platform at
 * `resources/bin/ffmpeg`, sourced from the `ffmpeg-static` npm package (a
 * devDependency of `@nicotind/desktop` — see package.json). `ffmpeg-static`
 * resolves platform/arch at install time, so this only ever needs to copy
 * whatever it downloaded for the current machine — no cross-compilation
 * logic here; CI packages each target platform on its own runner (Task 14).
 */
async function stageFfmpeg(): Promise<void> {
  const binDir = path.join(resourcesDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  let ffmpegSrc: string | null;
  try {
    const mod = (await import('ffmpeg-static')) as { default: string | null };
    ffmpegSrc = mod.default;
  } catch (err) {
    throw new Error(
      "Could not import 'ffmpeg-static'. Run `bun install` in packages/desktop first " +
        `(it's a devDependency there). Original error: ${String(err)}`,
    );
  }
  if (!ffmpegSrc) {
    throw new Error("'ffmpeg-static' resolved to null — no static ffmpeg binary for this platform/arch");
  }
  if (!existsSync(ffmpegSrc)) {
    throw new Error(`'ffmpeg-static' reported ${ffmpegSrc} but that file does not exist`);
  }

  const dest = path.join(binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  copyFileSync(ffmpegSrc, dest);
  chmodSync(dest, 0o755);
  console.log(`✓ Staged ffmpeg ${ffmpegSrc} -> ${dest}`);
}

async function main(): Promise<void> {
  console.log(`Preparing packages/desktop/resources/ (platform=${process.platform}, arch=${process.arch})…`);
  mkdirSync(resourcesDir, { recursive: true });

  stageWeb();
  stageBackend();
  stageBun();
  await stageFfmpeg();

  console.log('\n✅ resources/ staged. Ready for electron-builder.');
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`\n✗ prepare-resources failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { stageWeb, stageBackend, stageBun, stageFfmpeg };
