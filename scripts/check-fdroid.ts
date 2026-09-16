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
 * re-checking the exclusion list. It fails four ways:
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
 *
 * NETWORK-FREE: everything here is read off the installed tree and the repo.
 */
import { existsSync, readFileSync } from 'node:fs';
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
const classified = new Set([...Object.keys(NON_FREE_PLUGINS), ...Object.keys(FREE_ANDROID_PLUGINS)]);
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
// the trigger; the ORDER was the defect — a verification step must never stand
// between a built artifact and its upload. Nothing else notices: the phone and
// TV APKs built fine, the job went red for an unrelated reason, and the release
// page simply had no APK on it.
{
  const deploy = readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
  const attachAt = deploy.indexOf('Attach APKs to the GitHub Release');
  const verifyAt = deploy.indexOf('Build the F-Droid TV variant (verification only)');
  const assertAt = deploy.indexOf('Assert no proprietary dependency in the F-Droid APK');

  for (const [label, at] of [
    ['Attach APKs to the GitHub Release', attachAt],
    ['Build the F-Droid TV variant (verification only)', verifyAt],
    ['Assert no proprietary dependency in the F-Droid APK', assertAt],
  ] as const) {
    if (at < 0) {
      errors.push(
        `deploy.yml has no step named "${label}". This gate anchors on the step ` +
          `names; a rename makes the ordering check vacuous, so fix the name here too.`,
      );
    }
  }

  if (attachAt >= 0 && verifyAt >= 0 && attachAt > verifyAt) {
    errors.push(
      `deploy.yml builds the F-Droid verification variant BEFORE attaching the ` +
        `release APKs. A failure there discards the phone and TV APKs that already ` +
        `built — exactly how v0.6.55 shipped with none. Move the attach step first.`,
    );
  }
  if (attachAt >= 0 && assertAt >= 0 && attachAt > assertAt) {
    errors.push(
      `deploy.yml asserts the F-Droid APK's contents BEFORE attaching the release ` +
        `APKs. Verification must run after the artifacts are uploaded.`,
    );
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

if (errors.length > 0) {
  console.error(`check:fdroid — ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  • ${e}\n`);
  process.exit(1);
}

console.log(
  `check:fdroid — OK (${androidPlugins.length} Android plugins classified, ` +
    `${Object.keys(NON_FREE_PLUGINS).length} excluded from the F-Droid variant)`,
);
