// Patch the generated iOS Info.plist (background audio + version keys). Runs in
// CI on macOS after `cap add ios` / `cap sync ios`, before `xcodebuild`:
//   bun run packages/mobile/scripts/ios-plist.ts
// Version values come from the env lines emitted by scripts/ios-env.ts.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildPlistBuddyCommands } from '../src/ios-plist.js';

const here = dirname(fileURLToPath(import.meta.url));
const plist = resolve(here, '../ios/App/App/Info.plist');
if (!existsSync(plist)) {
  console.error(`Info.plist not found at ${plist} — run \`cap add ios\` first.`);
  process.exit(1);
}

const cmds = buildPlistBuddyCommands({
  shortVersion: process.env.NICOTIND_IOS_SHORT_VERSION,
  build: process.env.NICOTIND_IOS_BUILD,
});

for (const cmd of cmds) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist], { stdio: 'inherit' });
  } catch {
    // `Delete`/`Add` of an existing/absent key is expected to fail; the paired
    // `Set` (or the array re-add) is what guarantees the final state.
    console.warn(`PlistBuddy command did not apply (continuing): ${cmd}`);
  }
}
console.log(`Patched ${plist}`);
