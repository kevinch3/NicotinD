/**
 * Fail when the F-Droid build variant stops being the thing F-Droid can accept.
 *
 *   bun run check:fdroid
 *
 * WHY: F-Droid's inclusion policy forbids proprietary dependencies outright, and
 * our exposure arrives through *transitive* Android deps that `package.json`
 * does not show. `@capacitor/barcode-scanner` looks innocuous; its
 * `android/build.gradle` pulls `com.google.mlkit:barcode-scanning`. The variant
 * that excludes it (packages/mobile/src/fdroid.ts) is correct today, and would
 * keep reporting success after someone adds a plugin with the same problem.
 *
 * So this asserts its own denominator (docs/quality-gates.md) rather than just
 * re-checking the exclusion list. It fails six ways:
 *
 *   1. A Capacitor plugin with Android code that is classified NEITHER free nor
 *      non-free — the moment a proprietary dep can enter, turned into a
 *      decision someone has to make.
 *   2. A classification entry naming a package that is not a dependency — dead
 *      config, which is how a stale rule survives a rename looking like work.
 *   3. A non-free plugin surviving into the variant's resolved allowlist.
 *   4. The release lane referring to a gradle output path the `distribution`
 *      flavor does not produce. v0.6.46 shipped with no APK at all because a
 *      build step broke in the tag-only lane; a flavor rename is the same
 *      hazard, and `fail_on_unmatched_files` only fires after the build is gone.
 *   4b. A verification-only step standing between a built artifact and its
 *      upload. That is how v0.6.55 shipped with no APK: the check failed and
 *      discarded two APKs that had already built.
 *   5. The ML Kit exclusion and the explicit ZXing selection parting company —
 *      either half alone is silently wrong (#1170).
 *   6. Fastlane metadata outside F-Droid's limits, in any locale. The store
 *      rejects an over-long short_description and silently truncates an
 *      over-long changelog; neither is visible from inside the repo.
 *
 * NETWORK-FREE: everything here is read off the installed tree and the repo.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  FREE_ANDROID_PLUGINS,
  NON_FREE_PLUGINS,
  fdroidIncludePlugins,
} from '../packages/mobile/src/fdroid.js';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const mobileRoot = join(repoRoot, 'packages/mobile');
const errors: string[] = [];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  capacitor?: { android?: unknown };
}

const mobilePkg: PackageJson = JSON.parse(readFileSync(join(mobileRoot, 'package.json'), 'utf8'));
const declared = { ...mobilePkg.dependencies, ...mobilePkg.devDependencies };

/**
 * Does this dependency ship Android native code? Capacitor's own test: a
 * `capacitor.android` key in the package manifest. Resolved through the mobile
 * package's `node_modules`, which is where `cap sync` looks too.
 */
function isAndroidPlugin(name: string): boolean {
  const manifest = join(mobileRoot, 'node_modules', name, 'package.json');
  if (!existsSync(manifest)) return false;
  try {
    const meta: PackageJson = JSON.parse(readFileSync(manifest, 'utf8'));
    return meta.capacitor?.android !== undefined;
  } catch {
    return false;
  }
}

// --- 1. Every Android plugin is classified -----------------------------------
const classified = new Set([
  ...Object.keys(NON_FREE_PLUGINS),
  ...Object.keys(FREE_ANDROID_PLUGINS),
]);
const androidPlugins = Object.keys(declared).filter(isAndroidPlugin);

if (androidPlugins.length === 0) {
  errors.push(
    'Found no Capacitor Android plugins at all. Either node_modules is not installed ' +
      '(run scripts/link-worktree.sh) or plugin detection has drifted — an empty ' +
      'denominator would let this gate pass while checking nothing.',
  );
}

for (const name of androidPlugins) {
  if (!classified.has(name)) {
    errors.push(
      `Capacitor Android plugin "${name}" is unclassified for the F-Droid build.\n` +
        `  Read its android/build.gradle. If every dependency is FLOSS, add it to\n` +
        `  FREE_ANDROID_PLUGINS in packages/mobile/src/fdroid.ts with the reason.\n` +
        `  If it pulls anything proprietary (Google Play Services, ML Kit, Firebase),\n` +
        `  add it to NON_FREE_PLUGINS instead — see docs/fdroid.md.`,
    );
  }
}

// --- 2. No dead classifications ----------------------------------------------
for (const name of classified) {
  if (!(name in declared)) {
    errors.push(
      `"${name}" is classified in packages/mobile/src/fdroid.ts but is not a ` +
        `@nicotind/mobile dependency. Remove the entry — a rule that matches ` +
        `nothing reads as protection while protecting nothing.`,
    );
  }
}

// --- 3. The non-free plugins really are excluded ------------------------------
const included = fdroidIncludePlugins(mobilePkg.dependencies, mobilePkg.devDependencies);
for (const name of Object.keys(NON_FREE_PLUGINS)) {
  if (included.includes(name)) {
    errors.push(`"${name}" is non-free but survives into the F-Droid includePlugins allowlist.`);
  }
}
for (const name of Object.keys(FREE_ANDROID_PLUGINS)) {
  if (name in declared && !included.includes(name)) {
    errors.push(
      `"${name}" is cleared as free but is missing from the F-Droid allowlist — ` +
        `the F-Droid build would silently lack a feature the GitHub build has.`,
    );
  }
}

// --- 4. The release lane matches the flavor ----------------------------------
// Both the flavor name and the APK basename gradle derives from it.
const FLAVOR = 'standard';
const releaseLane: { file: string; mustContain: string[] }[] = [
  {
    file: '.github/workflows/deploy.yml',
    mustContain: [
      `assemble${FLAVOR[0].toUpperCase()}${FLAVOR.slice(1)}Release`,
      `outputs/apk/${FLAVOR}/release`,
      `app-${FLAVOR}-release.apk`,
    ],
  },
  {
    file: 'packages/e2e/tv/preflight.ts',
    mustContain: [`outputs/apk/${FLAVOR}/debug`, `app-${FLAVOR}-debug.apk`],
  },
];

for (const { file, mustContain } of releaseLane) {
  const source = readFileSync(join(repoRoot, file), 'utf8');
  for (const needle of mustContain) {
    if (!source.includes(needle)) {
      errors.push(
        `${file} does not mention "${needle}". The \`distribution\` flavor puts ` +
          `gradle's output under apk/<flavor>/<buildType>/app-<flavor>-<buildType>.apk; ` +
          `a step looking anywhere else finds no APK.`,
      );
    }
  }
}

// --- 4b. The shipping artifacts are attached before anything merely checks ----
// v0.6.55 shipped with NO Android APK because the F-Droid verification build sat
// between "Stage TV APK" and "Attach APKs", failed on missing signing env, and
// took two already-built release artifacts down with it. The signing error was
// the trigger; the ORDER was the defect. Nothing else notices: the phone and TV
// APKs built fine, the job went red for an unrelated reason, and the release
// page simply had no APK on it.
//
// Two orderings now matter, for opposite reasons:
//   * the SIDELOAD APKs upload before any F-Droid work, so an F-Droid failure
//     cannot discard them;
//   * the F-Droid APKs upload AFTER the dex assertion, because those are
//     artifacts we would rather not publish at all than publish unchecked.
{
  const deploy = readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
  const steps: Record<string, number> = {
    attachSideload: deploy.indexOf('Attach APKs to the GitHub Release'),
    buildFdroidTv: deploy.indexOf('Build the F-Droid TV APK'),
    assertFdroid: deploy.indexOf('Assert no proprietary dependency in the F-Droid APKs'),
    attachFdroid: deploy.indexOf('Attach the F-Droid APKs to the GitHub Release'),
  };

  for (const [key, at] of Object.entries(steps)) {
    if (at < 0) {
      errors.push(
        `deploy.yml is missing the step this gate anchors "${key}" on. A rename makes ` +
          `the ordering check vacuous, so update scripts/check-fdroid.ts too.`,
      );
    }
  }

  if (Object.values(steps).every((at) => at >= 0)) {
    if (steps.attachSideload > steps.buildFdroidTv) {
      errors.push(
        `deploy.yml builds the F-Droid variant BEFORE attaching the release APKs. A ` +
          `failure there discards the phone and TV APKs that already built — exactly ` +
          `how v0.6.55 shipped with none. Move the attach step first.`,
      );
    }
    if (steps.assertFdroid > steps.attachFdroid) {
      errors.push(
        `deploy.yml attaches the F-Droid APKs BEFORE asserting they carry no ` +
          `proprietary dependency. Those feed our own F-Droid repository; publish them ` +
          `only once checked.`,
      );
    }
  }
}

const gradle = readFileSync(join(mobileRoot, 'android/app/build.gradle'), 'utf8');
if (!gradle.includes(`${FLAVOR} { dimension "distribution" }`)) {
  errors.push(
    `packages/mobile/android/app/build.gradle no longer declares the "${FLAVOR}" ` +
      `flavor the release lane assembles.`,
  );
}

// --- 5. ML Kit exclusion and the ZXing selection travel together -------------
// Two edits, two languages, two packages, one intent (#1170). The plugin's
// current default already IS ZXing — its factory reads
// `if (scanLibrary == "mlkit") MLKitWrapper else ZXingWrapper`, and a missing
// value arrives as "" — so the exclusion alone works *today*. That is exactly
// why this is paired rather than trusted: the exclusion's safety rests on an
// upstream default nothing of ours controls, and the explicit selection is what
// makes it ours. Losing either half is silent — one regrows the APK by 20 MB,
// the other leaves the guarantee resting on a third party's `else`.
const rootGradle = readFileSync(join(mobileRoot, 'android/build.gradle'), 'utf8');
const excludesMlKit = /exclude\s+group:\s*'com\.google\.mlkit'/.test(rootGradle);
const scannerSource = readFileSync(
  join(repoRoot, 'packages/web/src/app/services/native/native-capabilities.ts'),
  'utf8',
);
// The key path Kotlin actually reads: native.android.scanningLibrary. The
// plugin's published types put `android` at the top level, where the native
// side never looks.
const selectsZxing =
  /native:\s*\{[\s\S]{0,300}?android:\s*\{\s*scanningLibrary/.test(scannerSource) &&
  /['"]zxing['"]/.test(scannerSource);

if (excludesMlKit !== selectsZxing) {
  errors.push(
    excludesMlKit
      ? `packages/mobile/android/build.gradle excludes com.google.mlkit, but ` +
          `native-capabilities.ts does not select ZXing via ` +
          `native.android.scanningLibrary. That leaves the scanner working only ` +
          `because the plugin's default happens to be ZXing — an upstream ` +
          `change would reintroduce ML Kit, and with it excluded the scan would ` +
          `throw NoClassDefFoundError on a device. (#1170)`
      : `native-capabilities.ts selects the ZXing scanning library, but ` +
          `packages/mobile/android/build.gradle no longer excludes ` +
          `com.google.mlkit — the proprietary dependency and ~20 MB are back. (#1170)`,
  );
}

// --- 6. The fastlane metadata is within F-Droid's limits, in every locale ----
// These caps are enforced by the store, not by us: an over-long
// short_description is rejected, an over-long changelog is silently truncated,
// and a missing title falls back to the application id. All three are invisible
// from inside the repo, and the metadata is plain text nothing else validates.
{
  const TREES = [
    { dir: 'packages/mobile/fastlane', label: 'phone' },
    { dir: 'packages/mobile/fastlane-tv', label: 'tv' },
  ];
  // Names are F-Droid's; the byte caps are its documented limits.
  const REQUIRED = [
    { file: 'title.txt', max: 50 },
    { file: 'short_description.txt', max: 80 },
    { file: 'full_description.txt', max: 4000 },
  ];
  const CHANGELOG_MAX = 500;

  for (const { dir, label } of TREES) {
    const androidDir = join(repoRoot, dir, 'metadata/android');
    if (!existsSync(androidDir)) {
      errors.push(
        `${dir}/metadata/android is missing — the ${label} F-Droid listing has no metadata.`,
      );
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

// --- 7. The Pages lane still reaches the repository builder ------------------
// The catalog and the repository share one Pages site, and one deploy replaces
// all of it. If pages.yml stops invoking the builder, the site keeps publishing
// — minus the F-Droid repository, which every user who added it then sees as a
// repo frozen at whatever version was live when the reference broke. Nothing
// fails; the URL just stops moving.
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

    // The one that is actively destructive: one Pages deployment replaces the
    // whole site, so publishing without `fdroid/repo` DELETES a live repository
    // rather than leaving it alone — every client that added it 404s, silently.
    if (!source.includes('would remove a live repository')) {
      errors.push(
        `.github/workflows/pages.yml has no guard refusing to publish a site that ` +
          `would remove an already-live F-Droid repository. A Pages deployment ` +
          `replaces the entire site, so a skipped F-Droid build deletes the ` +
          `published repository instead of leaving it in place.`,
      );
    }
  }
  // deploy.yml is where the APKs the repository serves come from.
  const deployForApks = readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
  for (const needle of ['NicotinD-fdroid-', 'NicotinD-TV-fdroid-']) {
    if (!deployForApks.includes(needle)) {
      errors.push(
        `.github/workflows/deploy.yml does not publish "${needle}<version>.apk". The ` +
          `Pages workflow downloads the F-Droid APKs from the latest release, so ` +
          `without them the repository silently stops updating.`,
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
  `check:fdroid — OK (${androidPlugins.length} Android plugins classified, ` +
    `${Object.keys(NON_FREE_PLUGINS).length} excluded from the F-Droid variant)`,
);
