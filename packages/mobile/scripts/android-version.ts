/**
 * Writes the literal `versionCode` / `versionName` into `android/app/build.gradle`
 * from the monorepo version.
 *
 *   bun run packages/mobile/scripts/android-version.ts
 *
 * Runs inside `bun run release` (`.versionrc.json`'s `postchangelog` hook, next
 * to `fdroid:changelog`), so the literals land in the version-bump commit and
 * every tag is self-consistent. Run it by hand only to repair a drift.
 *
 * Why literals rather than deriving them in Groovy: F-Droid's `checkupdates`
 * greps this file with its own regex to decide what a tag contains. A computed
 * expression matches nothing, so `AutoUpdateMode: Version` would quietly stop
 * seeing our releases — the app would sit at whatever version F-Droid last
 * managed to parse, with nothing going red anywhere. See docs/fdroid.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyAndroidVersion } from '../src/android-version.js';

const repoRoot = resolve(import.meta.dir, '../../..');
const gradlePath = join(repoRoot, 'packages/mobile/android/app/build.gradle');

const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
};

const before = readFileSync(gradlePath, 'utf8');
const after = applyAndroidVersion(before, version);

if (before === after) {
  console.log(`build.gradle: already at ${version} — unchanged.`);
} else {
  writeFileSync(gradlePath, after);
  console.log(`build.gradle: version set to ${version}.`);
}
