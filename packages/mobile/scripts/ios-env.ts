// Prints the iOS version env lines derived from the monorepo version, for CI to
// append to $GITHUB_ENV before the Xcode build + Info.plist patch:
//   bun run packages/mobile/scripts/ios-env.ts >> "$GITHUB_ENV"
import pkg from '../../../package.json' with { type: 'json' };
import { iosVersion } from '../src/version.js';

const { shortVersion, bundleVersion } = iosVersion(pkg.version);
console.log(`NICOTIND_IOS_SHORT_VERSION=${shortVersion}`);
console.log(`NICOTIND_IOS_BUILD=${bundleVersion}`);
