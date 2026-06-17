// Prints the Android version env lines derived from the monorepo version, for CI
// to append to $GITHUB_ENV before `gradlew assembleRelease`:
//   bun run packages/mobile/scripts/android-env.ts >> "$GITHUB_ENV"
import pkg from '../../../package.json' with { type: 'json' };
import { androidVersion } from '../src/version.js';

const { versionName, versionCode } = androidVersion(pkg.version);
console.log(`NICOTIND_VERSION_NAME=${versionName}`);
console.log(`NICOTIND_VERSION_CODE=${versionCode}`);
