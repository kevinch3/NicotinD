/**
 * Writes the current release's F-Droid changelog into both metadata trees:
 *
 *   <fastlaneDir>/metadata/android/<locale>/changelogs/<versionCode>.txt
 *
 *   bun run packages/mobile/scripts/fdroid-changelog.ts
 *
 * The file name is the Android `versionCode`, which is how F-Droid pairs a
 * changelog with a build — not the semver. That mapping is `androidVersion()`,
 * the same function CI feeds to gradle, so the changelog cannot end up filed
 * under a code no APK was ever built with.
 *
 * `bun run release` runs this for you, from `.versionrc.json`'s `postchangelog`
 * hook — after CHANGELOG.md is written, before the release commit, so the
 * output lands IN the bump commit and the tag F-Droid reads is complete. It
 * used to be a manual follow-up step, and three releases in a row shipped
 * without one (see docs/fdroid.md). Run it by hand only to regenerate.
 *
 * Only the current version is written. Backfilling every release would add ~50
 * files F-Droid shows no one — it displays the changelog for the version it is
 * offering.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { changelogSection, toFdroidChangelog } from '../src/fdroid-changelog.js';
import { FDROID_APPS } from '../src/fdroid-repo.js';
import { androidVersion } from '../src/version.js';

const mobileRoot = resolve(import.meta.dir, '..');
const repoRoot = resolve(mobileRoot, '..', '..');

const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
};
const { versionCode, versionName } = androidVersion(version);

const section = changelogSection(readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'), versionName);
if (section === '') {
  // A release of only chore/docs commits has no section. Writing an empty file
  // would make F-Droid show a blank changelog, which reads worse than none.
  console.log(`No CHANGELOG.md section for ${versionName} — nothing written.`);
  process.exit(0);
}

const body = toFdroidChangelog(section);
if (body === '') {
  console.log(`CHANGELOG.md section for ${versionName} has no entries — nothing written.`);
  process.exit(0);
}

// Derived from FDROID_APPS so a tree that moves cannot be missed here — the
// phone tree had to move to the repo root for fdroidserver to see it at all.
const targets = FDROID_APPS.flatMap((app) =>
  ['en-US', 'es-ES'].map(
    (l) => `${app.fastlaneDir}/metadata/android/${l}/changelogs/${versionCode}.txt`,
  ),
);

for (const rel of targets) {
  const file = join(repoRoot, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body + '\n');
  console.log(`  ${rel}`);
}

console.log(
  `\nWrote ${versionName} (versionCode ${versionCode}) — ${body.length} chars:\n\n${body}\n\n` +
    'The Spanish trees get the English text: CHANGELOG.md is generated from commit ' +
    'subjects, which are English. Translate in place if that matters.',
);
