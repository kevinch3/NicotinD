// Prints the Android version env lines derived from the monorepo version, for CI
// to append to $GITHUB_ENV:
//   bun run packages/mobile/scripts/android-env.ts >> "$GITHUB_ENV"
//
// Used ONLY to name the release assets (NicotinD-<version>.apk). Gradle reads
// literals from build.gradle instead, written by `bun run release` — F-Droid
// greps that file to decide what a tag contains, and cannot evaluate Groovy.
import pkg from '../../../package.json' with { type: 'json' };
import { androidVersion } from '../src/version.js';

const { versionName, versionCode } = androidVersion(pkg.version);
console.log(`NICOTIND_VERSION_NAME=${versionName}`);
console.log(`NICOTIND_VERSION_CODE=${versionCode}`);
