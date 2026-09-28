import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Every release builds every app artifact (docs/releasing.md "Why every release
 * builds every app").
 *
 * A `changes` job once gated these on a tag-to-tag diff. It never skipped
 * anything — the `chore(release)` commit bumps the root package.json and
 * build.gradle, which its own regexes matched — and a working version would
 * have broken every consumer of the latest release: the in-app APK updater,
 * electron-updater, pages.yml's F-Droid repo and fdroiddata's `Binaries:` all
 * expect the latest release to carry its assets. This keeps a path filter from
 * coming back without those consumers changing first.
 *
 * Parsed, not grepped, so a comment mentioning `needs` cannot satisfy it.
 */
const repoRoot = join(import.meta.dir, '..');
const deploy = parse(readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8')) as {
  jobs: Record<string, { if?: string; needs?: string | string[] }>;
};

const APP_JOBS = ['android', 'ios', 'desktop-linux', 'desktop-mac'];

describe('every release builds every app artifact', () => {
  for (const name of APP_JOBS) {
    it(`${name} runs on every tag, gated on nothing else`, () => {
      const job = deploy.jobs[name];
      expect(job).toBeDefined();
      expect(job?.if).toBe("github.ref_type == 'tag'");
      expect(job?.needs).toBeUndefined();
    });
  }
});
