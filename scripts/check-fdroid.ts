/**
 * Fail when the lane that publishes our F-Droid repository stops working.
 *
 *   bun run check:fdroid
 *
 * This gate got much smaller in #1168. It used to guard a separate `fdroid`
 * build flavour — a plugin allowlist, a manifest overlay, an ML Kit exclusion —
 * and every one of those is gone: the single APK carries no proprietary
 * dependency and hides its self-updater at runtime when a store installed it,
 * so the release's own APKs *are* the F-Droid ones. Arms that guarded the
 * flavour were deleted rather than left passing vacuously, which is the dead
 * config this gate exists to reject.
 *
 * What remains are the six things that are still silently breakable:
 *
 *   1. Fastlane metadata outside F-Droid's byte caps, in any locale. The store
 *      rejects an over-long short_description and silently truncates an
 *      over-long changelog; neither is visible from inside the repo.
 *   2. The Pages lane losing its reference to the scripts that build and
 *      publish the repository. Nothing fails — the site keeps publishing, minus
 *      the repository, which every client that added it sees as frozen.
 *   3. The release lane no longer producing the APKs the repository serves, or
 *      naming them differently. The Pages workflow downloads them from the
 *      latest release by name, so a rename stops the repository updating
 *      without anything going red.
 *   4. A release with no changelog for its own versionCode — F-Droid then shows
 *      blank release notes, because it renders only the changelog matching the
 *      versionCode it is offering.
 *   5. The APK build becoming unreproducible — F-Droid rebuilds it from the tag
 *      and compares byte-for-byte, so a stray timestamp costs us our signature.
 *   6. The fdroiddata build recipe drifting from the build it describes. It
 *      pins the toolchain by hand because F-Droid's buildserver never sees our
 *      CI, and a stale pin builds successfully with something we never tested.
 *
 * The numbered sections below follow that list, except (4), which rides along
 * inside (1) because it needs the same per-locale walk.
 *
 * NETWORK-FREE: everything here is read off the repo.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { FDROID_APPS } from '../packages/mobile/src/fdroid-repo.js';
import { androidVersion } from '../packages/mobile/src/version.js';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const errors: string[] = [];

const { versionCode: currentVersionCode, versionName: currentVersionName } = androidVersion(
  (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version,
);

// --- 1. Fastlane metadata is within F-Droid's limits, in every locale --------
{
  const TREES = FDROID_APPS.map((app) => ({
    dir: app.fastlaneDir,
    label: app.applicationId,
  }));
  // Names are F-Droid's; the byte caps are its documented limits.
  const REQUIRED = [
    { file: 'title.txt', max: 50 },
    { file: 'short_description.txt', max: 80 },
    { file: 'full_description.txt', max: 4000 },
  ];
  const CHANGELOG_MAX = 500;

  if (TREES.length === 0) {
    errors.push('FDROID_APPS is empty — this gate would then check nothing.');
  }

  for (const { dir, label } of TREES) {
    const androidDir = join(repoRoot, dir, 'metadata/android');
    if (!existsSync(androidDir)) {
      errors.push(`${dir}/metadata/android is missing — ${label} has no listing metadata.`);
      continue;
    }
    const locales = readdirSync(androidDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    if (locales.length === 0) {
      errors.push(`${dir}/metadata/android has no locale directories.`);
      continue;
    }

    for (const locale of locales) {
      for (const { file, max } of REQUIRED) {
        const path = join(androidDir, locale, file);
        if (!existsSync(path)) {
          errors.push(`${dir}/metadata/android/${locale}/${file} is missing.`);
          continue;
        }
        // Byte length, not characters: the accented Spanish copy is multi-byte,
        // and a cap measured in characters would pass something the store cuts.
        const bytes = Buffer.byteLength(readFileSync(path, 'utf8').trim(), 'utf8');
        if (bytes === 0) {
          errors.push(`${dir}/metadata/android/${locale}/${file} is empty.`);
        } else if (bytes > max) {
          errors.push(
            `${dir}/metadata/android/${locale}/${file} is ${bytes} bytes, over F-Droid's ${max}.`,
          );
        }
      }

      const changelogDir = join(androidDir, locale, 'changelogs');
      // A changelog for the version about to ship. Twice now a release went out
      // with changelogs keyed only to older versionCodes (6056, then 8002 while
      // 0.8.3 shipped), which F-Droid renders as *no* release notes — it shows
      // the changelog for the versionCode it is offering and nothing else. The
      // older arms below check a changelog's name and size, which cannot catch
      // the one that is simply absent.
      if (!existsSync(join(changelogDir, `${currentVersionCode}.txt`))) {
        errors.push(
          `${dir}/metadata/android/${locale}/changelogs/${currentVersionCode}.txt is missing ` +
            `for the current version (${currentVersionName}). F-Droid shows the changelog for ` +
            `the versionCode it offers, so this release would publish with blank release ` +
            `notes. Run \`bun run --filter @nicotind/mobile fdroid:changelog\`.`,
        );
      }
      if (!existsSync(changelogDir)) continue;
      for (const entry of readdirSync(changelogDir)) {
        if (!/^\d+\.txt$/.test(entry)) {
          errors.push(
            `${dir}/metadata/android/${locale}/changelogs/${entry} is not named ` +
              `<versionCode>.txt — F-Droid pairs a changelog with a build by versionCode, ` +
              `so any other name is shown to nobody.`,
          );
          continue;
        }
        const bytes = Buffer.byteLength(
          readFileSync(join(changelogDir, entry), 'utf8').trim(),
          'utf8',
        );
        if (bytes > CHANGELOG_MAX) {
          errors.push(
            `${dir}/metadata/android/${locale}/changelogs/${entry} is ${bytes} bytes, over ` +
              `F-Droid's ${CHANGELOG_MAX} — it would be truncated mid-entry. Regenerate with ` +
              `\`bun run --filter @nicotind/mobile fdroid:changelog\`.`,
          );
        }
      }
    }
  }
}

// --- 2. The Pages lane still reaches the repository builder ------------------
{
  const pages = join(repoRoot, '.github/workflows/pages.yml');
  if (!existsSync(pages)) {
    errors.push(
      '.github/workflows/pages.yml is missing. It owns the Pages site (catalog + ' +
        'F-Droid repository); without it neither is published.',
    );
  } else {
    const source = readFileSync(pages, 'utf8');
    for (const needle of [
      'scripts/build-fdroid-repo.ts',
      'scripts/build-pages-index.ts',
      'FDROID_REPO_KEYSTORE_BASE64',
      'site/storybook',
    ]) {
      if (!source.includes(needle)) {
        errors.push(`.github/workflows/pages.yml no longer mentions "${needle}".`);
      }
    }

    // `workflow_run` has no `types: [succeeded]`; `completed` includes failure
    // and cancellation. A release that failed before attaching its APKs is
    // precisely the run whose artifacts must not be picked up.
    if (
      source.includes('workflow_run:') &&
      !source.includes("workflow_run.conclusion == 'success'")
    ) {
      errors.push(
        `.github/workflows/pages.yml triggers on workflow_run without gating on ` +
          `\`conclusion == 'success'\`, so a FAILED release republishes the site.`,
      );
    }

    // The actively destructive one: a Pages deployment replaces the WHOLE site,
    // so publishing without `fdroid/repo` deletes a live repository rather than
    // leaving it alone — every client that added it 404s, silently.
    if (!source.includes('would remove a live repository')) {
      errors.push(
        `.github/workflows/pages.yml has no guard refusing to publish a site that ` +
          `would remove an already-live F-Droid repository. A Pages deployment ` +
          `replaces the entire site, so a skipped F-Droid build deletes the ` +
          `published repository instead of leaving it in place.`,
      );
    }
  }
}

// --- 3. The release still publishes the APKs the repository serves ----------
// Since #1168 the repository serves the release's own APKs, so their NAMES are
// the contract between the two workflows. The Pages job downloads them by
// pattern from the latest release; a rename in deploy.yml stops the repository
// updating and nothing goes red.
{
  const deploy = readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
  const pages = existsSync(join(repoRoot, '.github/workflows/pages.yml'))
    ? readFileSync(join(repoRoot, '.github/workflows/pages.yml'), 'utf8')
    : '';

  // Derived from FDROID_APPS so the three places cannot drift apart silently.
  for (const app of FDROID_APPS) {
    // 'NicotinD.apk' -> 'NicotinD-', 'NicotinD-TV.apk' -> 'NicotinD-TV-'
    const stem = `${app.apk.replace(/\.apk$/, '')}-`;
    if (!deploy.includes(stem)) {
      errors.push(
        `.github/workflows/deploy.yml never names "${stem}<version>.apk", which ` +
          `${app.applicationId} is published from. The Pages workflow downloads it from ` +
          `the latest release by that name, so the repository would stop updating.`,
      );
    }
    if (!pages.includes(app.apk)) {
      errors.push(
        `.github/workflows/pages.yml does not rename a download to "${app.apk}", which ` +
          `build-fdroid-repo.ts expects for ${app.applicationId}.`,
      );
    }
  }

  // Flavours are gone; the output path must not have grown one back, or the
  // staging steps would look somewhere gradle does not write.
  if (deploy.includes('outputs/apk/standard/')) {
    errors.push(
      `.github/workflows/deploy.yml still reads a flavoured gradle output path ` +
        `(outputs/apk/standard/...). The distribution flavour was removed in #1168, so ` +
        `gradle writes to outputs/apk/<buildType>/ and nothing is there.`,
    );
  }
}

// --- 5. The APK build stays reproducible -------------------------------------
// F-Droid rebuilds our APK from the tag and compares it byte-for-byte to the one
// we publish; a mismatch means it refuses to use our signature. Measured on
// v0.8.5: of 658 APK entries, the service-worker manifest's `Date.now()`
// timestamp was the ONLY difference. Everything below is a wire that, if it came
// loose, would leave the build green and the APK unreproducible — nothing would
// go red until F-Droid's next rebuild.
{
  const webPkgPath = join(repoRoot, 'packages/web/package.json');
  const webPkg = JSON.parse(readFileSync(webPkgPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const PIN = 'scripts/pin-ngsw-timestamp.ts';

  if (!webPkg.scripts?.postbuild?.includes(PIN)) {
    errors.push(
      `packages/web/package.json has no "postbuild" running ${PIN}. Without it every web ` +
        `build stamps a fresh Date.now() into ngsw.json, which cap sync copies into the APK.`,
    );
  }
  if (!existsSync(join(repoRoot, 'packages/web', PIN))) {
    errors.push(`packages/web/${PIN} is missing, but the postbuild hook names it.`);
  }

  // The hook only matters where a service worker is actually emitted. Naming the
  // configurations here keeps the denominator visible: if one stops shipping a
  // service worker, this says so instead of passing vacuously.
  const angular = JSON.parse(readFileSync(join(repoRoot, 'packages/web/angular.json'), 'utf8')) as {
    projects: Record<string, { architect: { build: { configurations: Record<string, object> } } }>;
  };
  const configs = angular.projects['nicotind-web']?.architect.build.configurations ?? {};
  const withSw = Object.entries(configs)
    .filter(([, c]) => 'serviceWorker' in c)
    .map(([name]) => name);
  for (const required of ['production', 'tv']) {
    if (!withSw.includes(required)) {
      errors.push(
        `angular.json's "${required}" configuration no longer sets serviceWorker. If that is ` +
          `deliberate, update this gate to the new truth — do not leave it asserting a ` +
          `configuration that no longer exists.`,
      );
    }
  }

  // The release hook writes build.gradle's version literals; if it is not also
  // committed, the tag carries a stale version and F-Droid offers the old one.
  const versionrc = readFileSync(join(repoRoot, '.versionrc.json'), 'utf8');
  for (const needed of ['android:version', 'packages/mobile/android/app/build.gradle']) {
    if (!versionrc.includes(needed)) {
      errors.push(
        `.versionrc.json's postchangelog hook no longer mentions "${needed}". The Android ` +
          `version literals would then drift from package.json — a build that ships and ` +
          `publishes fine, under the wrong version, forever.`,
      );
    }
  }

  const deploy = readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
  if (!deploy.includes('SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)')) {
    errors.push(
      `.github/workflows/deploy.yml no longer derives SOURCE_DATE_EPOCH from the commit. ` +
        `fdroidserver derives it the same way, which is what makes the two builds agree.`,
    );
  }

  // Any consumer that runs `ng build` directly skips the postbuild hook. Strip
  // comments first: both files *mention* `ng build` in prose explaining why Node
  // is pinned, and a gate that cannot tell a comment from a command cries wolf.
  const uncommented = (src: string): string =>
    src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
  for (const [label, source] of [
    ['deploy.yml', deploy],
    ['Dockerfile', readFileSync(join(repoRoot, 'Dockerfile'), 'utf8')],
  ] as const) {
    if (/\bng build\b/.test(uncommented(source))) {
      errors.push(
        `${label} invokes \`ng build\` directly, bypassing the web package's postbuild hook ` +
          `(and therefore the ngsw timestamp pin). Go through the package script.`,
      );
    }
  }
}

// --- 6. The fdroiddata build recipe still describes THIS build ----------------
// The recipe we submit to fdroiddata pins the toolchain by hand, because
// F-Droid's buildserver runs gradle against a source checkout and never sees
// our CI. Two of those pins can drift away from the repo silently, and the
// symptom is an F-Droid build that succeeds and ships something we never
// tested. Note the version fields are NOT checked: `AutoUpdateMode: Version`
// means F-Droid bumps those itself from our tags, so the committed copy is only
// the seed.
{
  const recipe = join(repoRoot, 'packages/mobile/fdroiddata/ar.kevinroberts.nicotind.yml');
  if (!existsSync(recipe)) {
    errors.push(
      'packages/mobile/fdroiddata/ar.kevinroberts.nicotind.yml is missing — it is the ' +
        'build recipe submitted to fdroiddata, kept here so it is reviewed with the code ' +
        'it builds.',
    );
  } else {
    const source = readFileSync(recipe, 'utf8');

    // deploy.yml's BUN_VERSION is the version we actually test against.
    const deploy = readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
    const ciBun = /BUN_VERSION:\s*'([^']+)'/.exec(deploy)?.[1];
    if (!ciBun) {
      errors.push('.github/workflows/deploy.yml no longer defines BUN_VERSION.');
    } else if (!source.includes(`bun-v${ciBun}/`)) {
      errors.push(
        `packages/mobile/fdroiddata/…yml pins a different bun than CI (BUN_VERSION ` +
          `${ciBun}). F-Droid would build with a toolchain no release was ever built with. ` +
          `Update the download URL and its sha256 together — a stale checksum fails the ` +
          `build loudly, a stale version does not.`,
      );
    }

    // The checksum is the only thing standing between the buildserver and an
    // unverified binary, which is exactly what the inclusion policy is about.
    if (!source.includes('sha256sum -c -')) {
      errors.push(
        'packages/mobile/fdroiddata/…yml downloads the bun toolchain without verifying a ' +
          'sha256. F-Droid reviewers reject unverified binary downloads, and so should we.',
      );
    }

    // `cap sync` rewrites capacitor.settings.gradle, which is COMMITTED with
    // bun's store layout hardcoded. Skip it and gradle resolves paths that do
    // not exist on the buildserver.
    if (!source.includes('cap sync android')) {
      errors.push(
        'packages/mobile/fdroiddata/…yml does not run `cap sync android` before gradle. ' +
          "The tracked capacitor.settings.gradle hardcodes bun's store layout, so gradle " +
          "would resolve plugin paths that do not exist in F-Droid's checkout.",
      );
    }
  }
}

if (errors.length > 0) {
  console.error(`check:fdroid — ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  • ${e}\n`);
  process.exit(1);
}

console.log(
  `check:fdroid — OK (${FDROID_APPS.length} F-Droid entries: ` +
    `${FDROID_APPS.map((a) => a.applicationId).join(', ')})`,
);
