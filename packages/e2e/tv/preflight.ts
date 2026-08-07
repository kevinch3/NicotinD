/**
 * `bun run e2e:tv` entry point — the whole lifecycle, then Playwright, then teardown.
 *
 * Orchestrating here rather than through Playwright's `webServer` + `globalSetup`
 * is deliberate: the ordering constraint is real (the server must be up *and*
 * `adb reverse` wired *before* the app launches, or the WebView boots pointing at
 * nothing), and expressing it as plain sequential code is far easier to follow
 * than splitting it across Playwright's lifecycle hooks.
 *
 * **No build caching, by measurement.** gradle's incremental no-op is ~10s and
 * the web build ~8s, so skipping them would save ~18s and reintroduce issue
 * #253's failure mode — a suite silently serving the previous bundle and
 * reporting pre-fix behaviour as the actual value. Rebuilding every run is the
 * cheaper mistake. See docs/e2e-tv-emulator.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_ID,
  AVD,
  TV_PORT,
  adb,
  adbPath,
  bootedTvSerial,
  e2eRoot,
  emulatorPath,
  repoRoot,
  run,
  tvDataDir,
  tvMusicDir,
} from './env.js';

const APK = join(repoRoot, 'packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk');

/** Boot the AVD headless and wait for `sys.boot_completed`. Measured ~26s. */
async function ensureEmulator(): Promise<string> {
  const existing = bootedTvSerial();
  if (existing) {
    console.log(`[e2e:tv] reusing booted ${AVD} (${existing})`);
    return existing;
  }
  console.log(`[e2e:tv] booting ${AVD} headless…`);
  const proc = spawn(
    emulatorPath(),
    ['-avd', AVD, '-no-snapshot', '-no-audio', '-no-window', '-gpu', 'swiftshader_indirect'],
    { detached: true, stdio: 'ignore' },
  );
  proc.unref();

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const serial = bootedTvSerial();
    if (serial) return serial;
    await Bun.sleep(3000);
  }
  throw new Error(
    `[e2e:tv] ${AVD} did not boot within 180s. If the AVD does not exist, create it with:\n` +
      `  avdmanager create avd -n ${AVD} -k "system-images;android-36;google-tv;x86_64" -d tv_1080p`,
  );
}

/** Build web (tv configuration) → cap sync → assembleDebug → install. */
function buildAndInstall(serial: string): void {
  run(
    'bun',
    ['run', '--filter', '@nicotind/web', 'build', '--', '--configuration', 'tv'],
    repoRoot,
    'web build (tv)',
  );
  run('bunx', ['cap', 'sync', 'android'], join(repoRoot, 'packages/mobile'), 'cap sync');
  run(
    './gradlew',
    ['assembleDebug', '-q'],
    join(repoRoot, 'packages/mobile/android'),
    'assembleDebug',
  );
  if (!existsSync(APK)) throw new Error(`[e2e:tv] APK missing after build: ${APK}`);
  run(adbPath(), ['-s', serial, 'install', '-r', '-d', APK], repoRoot, 'install');
}

/** Fresh throwaway DB + a *copy* of the music fixtures the server may retag. */
function prepareServerState(): void {
  rmSync(tvDataDir, { recursive: true, force: true });
  rmSync(tvMusicDir, { recursive: true, force: true });
  cpSync(join(e2eRoot, 'fixtures/music'), tvMusicDir, { recursive: true });
}

async function startServer(): Promise<() => void> {
  const proc = spawn('bun', ['run', 'src/main.ts'], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      NICOTIND_PORT: TV_PORT,
      NICOTIND_MODE: 'external',
      NICOTIND_SLSKD_URL: 'http://127.0.0.1:1',
      NICOTIND_LIDARR_URL: 'http://127.0.0.1:1',
      NICOTIND_DATA_DIR: tvDataDir,
      NICOTIND_MUSIC_DIR: tvMusicDir,
      NICOTIND_DISABLE_LANDING_GATE: '1',
    },
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${TV_PORT}/api/health`);
      if (res.ok) {
        console.log(`[e2e:tv] server ready on :${TV_PORT}`);
        return () => proc.kill();
      }
    } catch {
      // not up yet
    }
    await Bun.sleep(1000);
  }
  proc.kill();
  throw new Error(`[e2e:tv] server did not answer /api/health on :${TV_PORT} within 90s.`);
}

/**
 * Launch the app and wait for its WebView devtools socket. A crash on launch
 * otherwise surfaces as an opaque fixture timeout, so the failure path tails
 * logcat — that is the difference between a five-minute and a fifty-minute
 * diagnosis.
 */
async function launchApp(serial: string): Promise<void> {
  adb(['shell', 'am', 'force-stop', APP_ID], { serial });
  adb(['shell', 'monkey', '-p', APP_ID, '-c', 'android.intent.category.LEANBACK_LAUNCHER', '1'], {
    serial,
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const socks = adb(['shell', 'cat', '/proc/net/unix'], { serial, quiet: true });
    if (socks.includes('webview_devtools_remote_')) {
      console.log('[e2e:tv] app up, WebView attached');
      return;
    }
    await Bun.sleep(2000);
  }
  const logcat = adb(['logcat', '-d', '-t', '40'], { serial, quiet: true });
  throw new Error(
    `[e2e:tv] app launched but exposed no WebView within 60s — it likely crashed.\n` +
      `--- last 40 logcat lines ---\n${logcat}`,
  );
}

/**
 * The web build regenerates `changelog.json` on every run. Leaving it modified
 * makes the harness look like it edited your tree; restore it when it was clean
 * before we started (and only then — never clobber a real edit).
 */
function changelogGuard(): () => void {
  const rel = 'packages/web/public/changelog.json';
  const dirty = spawnSync('git', ['status', '--porcelain', '--', rel], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout.trim();
  if (dirty) return () => {};
  return () => spawnSync('git', ['checkout', '--', rel], { cwd: repoRoot });
}

const restoreChangelog = changelogGuard();
let stopServer: (() => void) | undefined;
let exitCode = 0;

try {
  const serial = await ensureEmulator();
  process.env.E2E_TV_SERIAL = serial;
  buildAndInstall(serial);
  prepareServerState();
  stopServer = await startServer();
  adb(['reverse', `tcp:${TV_PORT}`, `tcp:${TV_PORT}`], { serial });
  await launchApp(serial);

  const args = ['playwright', 'test', '--config=playwright.tv.config.ts', ...process.argv.slice(2)];
  const res = spawnSync('bunx', args, {
    cwd: e2eRoot,
    stdio: 'inherit',
    env: { ...process.env, E2E_TV_SERIAL: serial, E2E_TV_PORT: TV_PORT },
  });
  exitCode = res.status ?? 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  stopServer?.();
  restoreChangelog();
  rmSync(tvMusicDir, { recursive: true, force: true });
}

process.exit(exitCode);
