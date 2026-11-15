/**
 * `bun run e2e:tv` / `bun run e2e:phone` entry point — the whole lifecycle, then
 * Playwright, then teardown. `--target=tv|phone` picks the lane (targets.ts);
 * every other argument passes through to Playwright.
 *
 * Orchestrating here rather than through Playwright's `webServer` + `globalSetup`
 * is deliberate: the ordering constraint is real (the server must be up *and*
 * `adb reverse` wired *before* the app launches, or the WebView boots pointing at
 * nothing), and expressing it as plain sequential code is far easier to follow
 * than splitting it across Playwright's lifecycle hooks.
 *
 * **Build before boot.** The web build and gradle peak at ~1.5 GB each and a
 * booted AVD holds ~2.5 GB; on a 16 GB machine with a browser open, doing both at
 * once was measured leaving 1.7 GB free. Nothing in the build needs the device.
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
  adb,
  adbPath,
  bootedSerial,
  dataDir,
  e2eRoot,
  emulatorPath,
  musicDir,
  repoRoot,
  run,
} from './env.js';
import { MAIN_ACTIVITY, parseTarget, targetFor, type AndroidTarget } from './targets.js';

const { target: targetName, rest: playwrightArgs } = parseTarget(process.argv.slice(2));
const target = targetFor(targetName);
const tag = `[e2e:${target.name}]`;

/** Gradle writes per flavour: `apk/<flavour>/debug/app-<flavour>-debug.apk`. */
function apkPath(t: AndroidTarget): string {
  const f = t.flavour.toLowerCase();
  return join(
    repoRoot,
    `packages/mobile/android/app/build/outputs/apk/${f}/debug/app-${f}-debug.apk`,
  );
}

/** Web build (the lane's configuration) → cap sync → assemble<Flavour>Debug. */
function build(): void {
  const config = target.webConfiguration ? ['--', '--configuration', target.webConfiguration] : [];
  run(
    'bun',
    ['run', '--filter', '@nicotind/web', 'build', ...config],
    repoRoot,
    `web build (${target.webConfiguration ?? 'default'})`,
  );
  run('bunx', ['cap', 'sync', 'android'], join(repoRoot, 'packages/mobile'), 'cap sync');
  run(
    './gradlew',
    [`assemble${target.flavour}Debug`, '-q'],
    join(repoRoot, 'packages/mobile/android'),
    `assemble${target.flavour}Debug`,
  );
  if (!existsSync(apkPath(target)))
    throw new Error(`${tag} APK missing after build: ${apkPath(target)}`);
}

/** Boot the AVD headless and wait for `sys.boot_completed`. Measured ~26s. */
async function ensureEmulator(): Promise<string> {
  if (target.serial) return target.serial;
  const existing = bootedSerial(target.avd);
  if (existing) {
    console.log(`${tag} reusing booted ${target.avd} (${existing})`);
    return existing;
  }
  console.log(`${tag} booting ${target.avd} headless…`);
  const proc = spawn(
    emulatorPath(),
    ['-avd', target.avd, '-no-snapshot', '-no-audio', '-no-window', '-gpu', 'swiftshader_indirect'],
    { detached: true, stdio: 'ignore' },
  );
  proc.unref();

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const serial = bootedSerial(target.avd);
    if (serial) return serial;
    await Bun.sleep(3000);
  }
  throw new Error(
    `${tag} ${target.avd} did not boot within 180s. If the AVD does not exist, create it with:\n` +
      `  avdmanager create avd -n ${target.avd} -k "${target.systemImage}" -d ${target.avdDevice}`,
  );
}

/** Fresh throwaway DB + a *copy* of the music fixtures the server may retag. */
function prepareServerState(): void {
  rmSync(dataDir(target), { recursive: true, force: true });
  rmSync(musicDir(target), { recursive: true, force: true });
  cpSync(join(e2eRoot, 'fixtures/music'), musicDir(target), { recursive: true });
}

async function startServer(): Promise<() => void> {
  const proc = spawn('bun', ['run', 'src/main.ts'], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      NICOTIND_PORT: target.port,
      NICOTIND_MODE: 'external',
      NICOTIND_SLSKD_URL: 'http://127.0.0.1:1',
      NICOTIND_LIDARR_URL: 'http://127.0.0.1:1',
      NICOTIND_DATA_DIR: dataDir(target),
      NICOTIND_MUSIC_DIR: musicDir(target),
    },
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${target.port}/api/health`);
      if (res.ok) {
        console.log(`${tag} server ready on :${target.port}`);
        return () => proc.kill();
      }
    } catch {
      // not up yet
    }
    await Bun.sleep(1000);
  }
  proc.kill();
  throw new Error(`${tag} server did not answer /api/health on :${target.port} within 90s.`);
}

/**
 * Launch the app and wait for its WebView devtools socket. A crash on launch
 * otherwise surfaces as an opaque fixture timeout, so the failure path tails
 * logcat — that is the difference between a five-minute and a fifty-minute
 * diagnosis.
 */
async function launchApp(serial: string): Promise<void> {
  adb(['shell', 'am', 'force-stop', target.appId], { serial });
  // A package that can take the foreground (targets.ts says which). If it holds
  // it, Playwright still attaches to OUR WebView over devtools while input goes
  // to ITS window — so the DOM reads fine and nothing moves. Observed on TV as
  // "reached 0 of 3 declared focusables"; the top-activity assertion below is
  // what turns that into a legible failure.
  for (const pkg of target.forceStop)
    adb(['shell', 'am', 'force-stop', pkg], { serial, quiet: true });
  // Wipe app state every run. Two reasons, both learned the hard way:
  //  - a stale `nicotind_server_url` from a previous session points at a port
  //    this run does not tunnel, and the restored track's cover URL then kills
  //    the app outright through the media-session plugin;
  //  - a suite that inherits state is a suite whose results depend on what you
  //    ran yesterday.
  adb(['shell', 'pm', 'clear', target.appId], { serial });
  // Wake first: a long build lets the screensaver take the foreground, and a
  // launch into a sleeping/occluded display starts the process without ever
  // resuming the activity — no WebView, no devtools socket, opaque timeout.
  adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { serial, quiet: true });
  // A phone AVD boots to the lock screen; a TV has none, so this is a no-op there.
  adb(['shell', 'wm', 'dismiss-keyguard'], { serial, quiet: true });
  // `am start` on the explicit component, not `monkey`: monkey's category
  // launch was observed starting the process while the launcher kept the top
  // activity, which produces the same no-WebView symptom.
  adb(['shell', 'am', 'start', '-W', '-n', `${target.appId}/${MAIN_ACTIVITY}`], { serial });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const socks = adb(['shell', 'cat', '/proc/net/unix'], { serial, quiet: true });
    if (socks.includes('webview_devtools_remote_')) {
      const top = adb(['shell', 'dumpsys', 'activity', 'activities'], { serial, quiet: true })
        .split('\n')
        .find((l) => l.includes('topResumedActivity'));
      // `includes` would let the phone id match the `.tv` package's activity.
      if (top && !top.includes(`${target.appId}/`)) {
        throw new Error(
          `${tag} ${target.appId} exposes a WebView but is NOT the foreground app — input ` +
            `would go elsewhere and every interaction would silently do nothing.\n` +
            `  ${top.trim()}`,
        );
      }
      console.log(`${tag} app up, WebView attached`);
      return;
    }
    await Bun.sleep(2000);
  }
  // Filter to crashes and our own package: an unfiltered `-t 40` is 40 lines of
  // system chatter that says nothing about why the app died (observed).
  const crash = adb(['logcat', '-d', '-b', 'crash', '-t', '60'], { serial, quiet: true });
  const app = adb(['logcat', '-d', '-t', '400'], { serial, quiet: true })
    .split('\n')
    .filter((l) => /nicotind|Capacitor|AndroidRuntime|chromium/i.test(l))
    .slice(-30)
    .join('\n');
  throw new Error(
    `${tag} app launched but exposed no WebView within 60s — it likely crashed.\n` +
      `--- crash buffer ---\n${crash}\n--- app logcat ---\n${app}`,
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
  build();
  const serial = await ensureEmulator();
  run(adbPath(), ['-s', serial, 'install', '-r', '-d', apkPath(target)], repoRoot, 'install');
  prepareServerState();
  stopServer = await startServer();
  adb(['reverse', `tcp:${target.port}`, `tcp:${target.port}`], { serial });
  await launchApp(serial);

  const res = spawnSync(
    'bunx',
    ['playwright', 'test', `--config=${target.config}`, ...playwrightArgs],
    {
      cwd: e2eRoot,
      stdio: 'inherit',
      env: { ...process.env, E2E_ANDROID_SERIAL: serial },
    },
  );
  exitCode = res.status ?? 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  stopServer?.();
  restoreChangelog();
  rmSync(musicDir(target), { recursive: true, force: true });
}

process.exit(exitCode);
