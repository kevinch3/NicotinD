import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { AndroidTarget } from './targets.js';

export const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = resolve(e2eRoot, '../..');

/**
 * Own data dir per lane: a TV run can never poison the phone's DB or the
 * Chromium suite's.
 */
export function dataDir(target: AndroidTarget): string {
  return join(e2eRoot, `.tmp-data-${target.name}`);
}

/**
 * The server scans (and *writes tags into*) whatever music dir it's given, so
 * a lane never points at the checked-in fixtures — it runs against a copy.
 * A harness that requires `git checkout` afterwards is a broken harness.
 */
export function musicDir(target: AndroidTarget): string {
  return join(e2eRoot, `.tmp-music-${target.name}`);
}

/**
 * Android SDK tools, resolved explicitly.
 *
 * why: a distro `/usr/bin/adb` (commonly v20) fights the SDK's adb server and
 * surfaces as "device not found" against a perfectly healthy emulator — an hour
 * of debugging the wrong layer. Always resolve from ANDROID_HOME.
 */
function sdkRoot(): string {
  return process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Android/Sdk');
}

export function adbPath(): string {
  const p = join(sdkRoot(), 'platform-tools/adb');
  if (!existsSync(p)) {
    throw new Error(
      `[e2e:android] no adb at ${p}. Set ANDROID_HOME to your SDK root ` +
        '(the distro /usr/bin/adb is deliberately not used — it breaks the adb server).',
    );
  }
  return p;
}

export function emulatorPath(): string {
  const p = join(sdkRoot(), 'emulator/emulator');
  if (!existsSync(p)) {
    throw new Error(
      `[e2e:android] no emulator binary at ${p}. Install the SDK 'emulator' package.`,
    );
  }
  return p;
}

export function adb(args: string[], opts: { serial?: string; quiet?: boolean } = {}): string {
  const full = opts.serial ? ['-s', opts.serial, ...args] : args;
  const res = spawnSync(adbPath(), full, { encoding: 'utf8' });
  if (res.status !== 0 && !opts.quiet) {
    throw new Error(`[e2e:android] adb ${full.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? '').trim();
}

/** Serial of a booted device running `avd`, or null. */
export function bootedSerial(avd: string): string | null {
  let out: string;
  try {
    out = spawnSync(adbPath(), ['devices'], { encoding: 'utf8' }).stdout ?? '';
  } catch {
    return null;
  }
  for (const line of out.split('\n').slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (!serial || state !== 'device') continue;
    const booted = adb(['shell', 'getprop', 'sys.boot_completed'], { serial, quiet: true });
    if (booted !== '1') continue;
    const name = spawnSync(adbPath(), ['-s', serial, 'emu', 'avd', 'name'], {
      encoding: 'utf8',
    }).stdout;
    // First line only: `emu avd name` prints the name, then `OK`.
    if ((name ?? '').split('\n')[0]?.trim() === avd) return serial;
  }
  return null;
}

export function run(cmd: string, args: string[], cwd: string, label: string): void {
  const started = Date.now();
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(
      `[e2e:android] ${label} failed (exit ${res.status ?? 'signal ' + res.signal}).`,
    );
  }
  console.log(`[e2e:android] ${label} — ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
