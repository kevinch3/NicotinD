/**
 * Refreshes the 3 locally-capturable README screenshots (library, album, Now
 * Playing) from the existing fixture-based Playwright harness — one command
 * instead of a manual "run the flow, hand-copy the right PNGs" routine. The
 * 4th README image (docs/images/search.png) is NOT covered here: it's
 * captured from a live flow (screens:live) because the Acquire page needs a
 * real Lidarr/slskd to show anything worth screenshotting, which this
 * fixture-based harness deliberately doesn't have — see docs/e2e.md
 * "Screenshot flows" for the full picture.
 *
 * Usage: bun run scripts/update-readme-screenshots.ts
 * (invoked via the "screens:readme" package.json script from packages/e2e)
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const e2eRoot = resolve(__dirname, '..');
const repoRoot = resolve(e2eRoot, '..', '..');

// Raw Playwright output (mobile-screenshots.screens.ts's OUT constant) ->
// the curated docs/images/*.png filename the README actually references.
const MAPPING: Array<{ raw: string; curated: string }> = [
  { raw: '01-library-list.png', curated: 'library.png' },
  { raw: '02-library-album.png', curated: 'album.png' },
  { raw: '04-player-now-playing.png', curated: 'now-playing.png' },
];

function run(): void {
  console.log('Running the mobile screenshot flow (fixture-based, no live dependency)...');
  const result = spawnSync(
    'bunx',
    ['playwright', 'test', '--config=playwright.screenshots.config.ts'],
    { cwd: e2eRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    console.error('\nScreenshot capture failed — docs/images/*.png left untouched.');
    process.exit(result.status ?? 1);
  }

  console.log('\nCopying captured screens into docs/images/...');
  const rawDir = resolve(e2eRoot, 'screenshots/mobile');
  let changed = 0;
  for (const { raw, curated } of MAPPING) {
    const src = resolve(rawDir, raw);
    const dest = resolve(repoRoot, 'docs/images', curated);
    if (!existsSync(src)) {
      console.error(`  missing expected capture: ${raw} (flow may have changed shot names)`);
      process.exit(1);
    }
    const isUnchanged = existsSync(dest) && readFileSync(src).equals(readFileSync(dest));
    copyFileSync(src, dest);
    if (isUnchanged) {
      console.log(`  docs/images/${curated}  <-  ${raw}  (unchanged)`);
    } else {
      console.log(`  docs/images/${curated}  <-  ${raw}`);
      changed++;
    }
  }

  console.log(
    `\nUpdated ${changed} image(s). Run "git diff --stat docs/images" to see if anything ` +
      'visually changed, then commit the ones that did.\n' +
      'Note: docs/images/search.png is NOT covered by this script — see docs/e2e.md ' +
      '"Screenshot flows" for how to refresh it (live-flow only).',
  );
}

run();
