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

// --- 1b. A non-root tree is a SUPERSET of the root one -----------------------
// fdroidserver reads the checkout's root `fastlane/` for EVERY app built from
// this repo — that glob has no flavour gate — and only then overwrites it, file
// by file, from `src/<flavour>/fastlane`. So any file the root tree has and a
// flavour tree lacks silently publishes the PHONE's text under the other entry.
// Nothing errors; the listing just reads wrong.
{
  const root = FDROID_APPS.find((a) => !a.fastlaneDir.includes('/'));
  if (!root) {
    errors.push('No FDROID_APPS entry uses the repo-root fastlane tree — this arm cannot run.');
  } else {
    const relFiles = (dir: string): string[] => {
      const base = join(repoRoot, dir, 'metadata/android');
      if (!existsSync(base)) return [];
      const out: string[] = [];
      const walk = (rel: string): void => {
        for (const e of readdirSync(join(base, rel), { withFileTypes: true })) {
          const next = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(next);
          // README.md documents the tree for humans; it is not published.
          else if (e.name !== 'README.md') out.push(next);
        }
      };
      walk('');
      return out;
    };

    const rootFiles = relFiles(root.fastlaneDir);
    for (const app of FDROID_APPS) {
      if (app === root) continue;
      const own = new Set(relFiles(app.fastlaneDir));
      // Changelogs are per-versionCode and arm 4 already requires the current
      // one in every tree; an older code missing here is not a leak risk.
      const missing = rootFiles.filter((f) => !own.has(f) && !f.includes('/changelogs/'));
      if (missing.length > 0) {
        errors.push(
          `${app.fastlaneDir} is missing ${missing.length} file(s) the root tree has ` +
            `(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}). ` +
            `fdroidserver applies the root tree to EVERY app from this repo and overwrites ` +
            `per file, so ${app.applicationId} would publish ${root.applicationId}'s text for ` +
            `each of them.`,
        );
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

  // Each app builds from its own gradle flavour, so its task and output path
  // are flavoured too. A bare `assembleRelease` is the dangerous one: it builds
  // EVERY flavour from whatever bundle happens to be in assets/, so the TV APK
  // would ship the phone UI under the TV id and nothing would fail.
  const gradleSource = readFileSync(
    join(repoRoot, 'packages/mobile/android/app/build.gradle'),
    'utf8',
  );
  for (const app of FDROID_APPS) {
    const Flavour = app.flavour[0].toUpperCase() + app.flavour.slice(1);
    for (const needle of [
      `assemble${Flavour}Release`,
      `outputs/apk/${app.flavour}/release`,
      `app-${app.flavour}-release.apk`,
    ]) {
      if (!deploy.includes(needle)) {
        errors.push(
          `.github/workflows/deploy.yml does not mention "${needle}", which ` +
            `${app.applicationId} is built and staged from.`,
        );
      }
    }
    if (!new RegExp(`\\b${app.flavour}\\s*\\{`).test(gradleSource)) {
      errors.push(
        `packages/mobile/android/app/build.gradle declares no "${app.flavour}" product flavour, ` +
          `but FDROID_APPS and the fdroiddata recipe both name it. fdroidserver would run ` +
          `assemble${Flavour}Release and find no such task.`,
      );
    }
  }
  if (/\.\/gradlew assembleRelease\b/.test(deploy)) {
    errors.push(
      `.github/workflows/deploy.yml runs a bare \`./gradlew assembleRelease\`. With product ` +
        `flavours that builds all of them from one web bundle, so the TV APK would carry the ` +
        `phone UI under the TV id — silently. Use the flavour-specific task.`,
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

// --- 6. The fdroiddata build recipes still describe THIS build ---------------
// One recipe per app, each pinning the toolchain by hand because F-Droid's
// buildserver runs gradle against a source checkout and never sees our CI. The
// symptom of drift is an F-Droid build that succeeds and ships something we
// never tested. The version fields are NOT checked: `AutoUpdateMode: Version`
// means F-Droid bumps those itself from our tags, so our copy is only a seed.
{
  const deploy = readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
  const ciBun = /BUN_VERSION:\s*'([^']+)'/.exec(deploy)?.[1];
  if (!ciBun) errors.push('.github/workflows/deploy.yml no longer defines BUN_VERSION.');

  const digests = new Set<string>();

  for (const app of FDROID_APPS) {
    const rel = `packages/mobile/fdroiddata/${app.applicationId}.yml`;
    const recipe = join(repoRoot, rel);
    if (!existsSync(recipe)) {
      errors.push(
        `${rel} is missing — every FDROID_APPS entry needs the build recipe submitted to ` +
          `fdroiddata, kept here so it is reviewed with the code it builds.`,
      );
      continue;
    }
    const source = readFileSync(recipe, 'utf8');

    if (ciBun && !source.includes(`bun-v${ciBun}/`)) {
      errors.push(
        `${rel} pins a different bun than CI (BUN_VERSION ${ciBun}). F-Droid would build with ` +
          `a toolchain no release was ever built with. Update the download URL and its sha256 ` +
          `together — a stale checksum fails the build loudly, a stale version does not.`,
      );
    }
    // bun shells out to the system node for `ng`, and F-Droid's buildserver
    // ships an older one than Angular's CLI accepts — `fdroid build` failed on
    // exactly this. The recipe pins node itself, and the pin has to track the
    // version we actually build with.
    const nvmrc = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim();
    if (!source.includes(`node-v${nvmrc}-linux-x64.tar.xz`)) {
      errors.push(
        `${rel} does not pin node ${nvmrc} (the .nvmrc version). F-Droid's buildserver ships ` +
          `its own node, and Angular's CLI refuses an older one — the build fails there while ` +
          `passing everywhere we test.`,
      );
    }

    if (!source.includes('sha256sum -c -')) {
      errors.push(
        `${rel} downloads the bun toolchain without verifying a sha256. F-Droid reviewers ` +
          `reject unverified binary downloads, and so should we.`,
      );
    }
    // Both raised by an F-Droid reviewer on MR 49342, and both are invisible
    // from here: the recipe still builds, it is just not reviewable.
    //
    // A tag can be moved or deleted after review, so it does not identify what
    // was audited. Only a full hash does.
    const commits = [...source.matchAll(/^\s*commit:\s*(\S+)/gm)].map((m) => m[1]);
    for (const c of commits) {
      if (!/^[0-9a-f]{40}$/.test(c)) {
        errors.push(
          `${rel} has \`commit: ${c}\` — F-Droid requires a full 40-character hash, not a tag ` +
            `or branch, because those can move after the build is reviewed.`,
        );
      }
    }

    // fdroidserver joins each list with `; ` and runs it under `bash -e`, so a
    // failure already stops the build and a `cd` already persists. Chaining
    // inside one entry just makes the recipe harder to read and to diff.
    for (const key of ['sudo', 'prebuild'] as const) {
      const block = new RegExp(`^\\s*${key}:\\n((?:\\s+- .*\\n|\\s{8,}.*\\n)+)`, 'm').exec(source);
      for (const line of block?.[1].split('\n') ?? []) {
        if (/\s&&\s|;\s*$|;\s+\S/.test(line)) {
          errors.push(
            `${rel}'s \`${key}:\` chains commands inside one entry (${line.trim()}). Use one ` +
              `entry per command — fdroidserver joins them under \`bash -e\`, so this changes ` +
              `nothing except reviewability.`,
          );
        }
      }
    }

    if (!source.includes('cap sync android')) {
      errors.push(
        `${rel} does not run \`cap sync android\` before gradle. The tracked ` +
          `capacitor.settings.gradle hardcodes bun's store layout, so gradle would resolve ` +
          `plugin paths that do not exist in F-Droid's checkout.`,
      );
    }

    // `gradle:` selects BOTH the assemble task and the src/<flavour>/fastlane
    // tree fdroidserver reads this app's listing from. A wrong name silently
    // builds the other app, or publishes the other app's description.
    const gradleList = /gradle:\s*\n\s*-\s*(\S+)/.exec(source)?.[1];
    if (gradleList !== app.flavour) {
      errors.push(
        `${rel} has \`gradle: [${gradleList ?? 'missing'}]\`, but ${app.applicationId} builds ` +
          `from the "${app.flavour}" flavour. fdroidserver uses that name for BOTH ` +
          `assemble<Flavour>Release and the src/<flavour>/fastlane listing, so a mismatch ` +
          `builds or describes the wrong app.`,
      );
    }

    // The TV APK is the tv WEB bundle plus the tv flavour. The flavour alone
    // gives the right id with the phone UI inside it — and F-Droid's build
    // would succeed, so only a user would notice.
    const wantsTvBundle = app.flavour === 'tv';
    if (source.includes('--configuration tv') !== wantsTvBundle) {
      errors.push(
        wantsTvBundle
          ? `${rel} does not build the web bundle with \`--configuration tv\`. The flavour sets ` +
              `the application id; only the web build makes it the TV UI, so this would publish ` +
              `the phone interface under the TV entry.`
          : `${rel} builds the web bundle with \`--configuration tv\`, which would publish the ` +
              `TV interface under the phone entry.`,
      );
    }

    // Reproducible builds: F-Droid publishes OUR signature only if its rebuild
    // matches, and only if it knows which key to expect.
    const stem = app.apk.replace(/\.apk$/, '');
    if (!source.includes(`/${stem}-%v.apk`)) {
      errors.push(
        `${rel} has no \`Binaries:\` pointing at ${stem}-%v.apk. Without it F-Droid cannot ` +
          `compare its rebuild to what we publish, and reproducible builds silently do nothing.`,
      );
    }
    const digest = /AllowedAPKSigningKeys:\s*([0-9a-f]{64})\b/.exec(source)?.[1];
    if (!digest) {
      errors.push(
        `${rel} has no valid \`AllowedAPKSigningKeys:\` (64 hex chars). That field is what ` +
          `makes F-Droid reject a mismatched rebuild instead of publishing its own signature.`,
      );
    } else {
      digests.add(digest);
    }
  }

  // Both apps are signed by one keystore; two digests means one recipe is stale
  // and that app's updates would stop installing.
  if (digests.size > 1) {
    errors.push(
      `The fdroiddata recipes name ${digests.size} different AllowedAPKSigningKeys, but every ` +
        `release APK is signed with one keystore. One of them is stale.`,
    );
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
