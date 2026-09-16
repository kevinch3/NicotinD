# F-Droid distribution

NicotinD is AGPL-3.0-only and self-hosted, which makes F-Droid the natural store for it — and the
only install path for the TV APK that is not "enable unknown sources on your telly". This page
covers the **F-Droid build variant** that exists today and what is still needed to get the two app
entries published. Issue #1168.

## Why a variant at all

F-Droid's [inclusion policy](https://f-droid.org/docs/Inclusion_Policy/) rules out three things we
ship on GitHub:

| Policy | Ours |
| --- | --- |
| Prebuilt binaries are trusted only from Debian, Maven Central, Google Maven, OSS Sonatype, OSS JFrog, JitPack and Clojars | `@capacitor/barcode-scanner`'s Android implementation is `com.github.outsystems:osbarcode-android`, served **only** by OutSystems' private Azure Maven feed. (Its ML Kit dependency used to be the headline reason; #1170 removed that from every variant — see below.) |
| An app must not download executable binaries without opt-in consent that explains it bypasses F-Droid's checks | `@nicotind/capacitor-apk-update` downloads a release APK and hands it to the system installer. On F-Droid the client *is* the updater, so the honest answer is to drop it, not to explain it |
| "All applications must have their own distinct Android Application ID" | The phone and TV APKs share `ar.kevinroberts.nicotind` — they differ only in the web bundle `cap sync` copied in |

## How the variant is built

`NICOTIND_FDROID=1` plus the `fdroid` gradle flavor. Three levers, no source edits and no prebuild
step that mutates the dependency tree:

```bash
bun run --filter @nicotind/mobile android:assemble:fdroid
# NICOTIND_APP_ID_SUFFIX=.tv for the TV entry
```

1. **`android.includePlugins`** (`capacitor.config.ts` → `fdroidIncludePlugins`). Capacitor's
   allowlist REPLACES its dependency scan, so `fdroidIncludePlugins` reproduces the default list
   minus `NON_FREE_PLUGINS` rather than naming the plugins to keep — a hand-written keep-list would
   silently omit any plugin added later, and the missing feature would appear only on F-Droid.
   `cap sync` then never writes those gradle subprojects into `capacitor.build.gradle`.
2. **`src/fdroid/AndroidManifest.xml`**, a removals-only overlay: `CAMERA`,
   `android.hardware.camera` and `REQUEST_INSTALL_PACKAGES` are dropped with `tools:node="remove"`.
   The merger does the work, so the launcher contract stays in one manifest and one test covers it.
3. **`applicationIdSuffix`** from `NICOTIND_APP_ID_SUFFIX`, so the TV entry is
   `ar.kevinroberts.nicotind.tv`.

The variant needs **no web-code change**. Both excluded plugins are reached through the Capacitor
global — `canScanBarcode()` returns false when `getCapacitorPlugin('CapacitorBarcodeScanner')` is
null and `scanBarcode()` resolves `{status:'unavailable'}`; the update service is
`getCapacitorPlugin('NicotindApkUpdate')?.` throughout. That null-tolerance was written for web and
Electron, which have neither plugin, and it is what makes a plugin-less native build a supported
configuration rather than a crash. QR pairing degrades to the manual pairing code, already the only
option on TV.

### Measured effect

| Variant | APK | `com.google.mlkit` class definitions |
| --- | --- | --- |
| `standard`, before #1170 | 30 MB | 195 |
| `standard`, now | 10.5 MB | 0 |
| `fdroid` | 4.4 MB | 0 |

#1170 excluded `com.google.mlkit` from the whole Android build, so the 20 MB of proprietary Google
code is gone from **every** variant and QR pairing still works on the GitHub builds. The remaining
`standard` / `fdroid` gap is CameraX plus a Compose runtime, which the scanner plugin also drags in.

Worth being exact about why that was safe: the plugin's `OSBARCScanLibraryFactory` is
`if (scanLibrary == "mlkit") MLKitWrapper else ZXingWrapper`, and the scanner activity turns a
missing value into `""`. **ZXing was already what ran** — the 20 MB was a backend the app never
selected. `scanBarcode()` now names ZXing explicitly anyway, so the guarantee stops depending on a
third party's `else`.

Measured with `dexdump -f` on class **definitions**, not a `grep` of the dex: a dex records the
*names* of types it references even when the classes are absent, so a plain grep reports ML Kit
"present" in a build that ships none of it. The CI assertion below greps, which is the stricter
direction — it fires on a reference as well as on real code — and is right for the `fdroid` variant,
which has neither.

## Flavors

`distribution` is the only flavor dimension: `standard` (GitHub releases, everything) and `fdroid`.
Gradle output therefore lives at
`app/build/outputs/apk/<flavor>/<buildType>/app-<flavor>-<buildType>.apk`, and the task is
`assembleStandardRelease`, not `assembleRelease`. The release lane and the TV emulator preflight
both name the flavor; `check:fdroid` asserts they still do, because a release that builds an APK
gradle puts somewhere else is how v0.6.46 shipped with no APK.

## Gates

- **`check:fdroid`** (CI-blocking) asserts its own denominator rather than re-reading the exclusion
  list. It fails on: a Capacitor Android plugin classified neither in `NON_FREE_PLUGINS` nor in
  `FREE_ANDROID_PLUGINS` — which is the moment a proprietary transitive dep can enter, turned into a
  decision; a classification entry naming a package that is not a dependency (dead config); a
  non-free plugin surviving into the resolved allowlist; a release step pointing at a gradle
  output path the flavor does not produce; a verification-only step standing between a built
  artifact and its upload; the ML Kit exclusion and the explicit ZXing selection parting company;
  and fastlane metadata outside F-Droid's byte caps in any locale.
- **`packages/mobile/src/fdroid.test.ts`** covers the pure helpers, including that a plugin added
  later is included without being named.
- **`packages/mobile/src/android-manifest.test.ts`** covers the overlay: the `tools` namespace
  (without it the merger ignores `tools:node` and the APK is silently over-permissioned), that the
  overlay only ever *removes*, and that every removal targets something the main manifest actually
  declares.
- **deploy.yml** assembles the F-Droid variant on every release and greps the dex for
  `com/google/mlkit`, `com/google/android/gms` and `outsystems`. `check:fdroid` is static and proves
  the plugin set is classified; it cannot prove the variant still *compiles* without the excluded
  plugins, which is the break a dropped null-guard would cause. The variant is built, verified and
  **not attached** to the release — it is a different package and a different update channel.

  Two rules that this step learned the hard way, both now asserted by `check:fdroid`:

  **It runs AFTER "Attach APKs".** v0.6.55 shipped with no Android APK at all because the
  verification build sat between staging and attaching, failed, and took two already-built release
  artifacts with it. The phone and TV APKs had compiled fine; the job went red for an unrelated
  reason and the release page simply had nothing on it. A step that merely *checks* something must
  never stand between an artifact and its upload.

  **It builds unsigned.** `ANDROID_KEYSTORE_FILE` lives in `$GITHUB_ENV` from the decode step, so
  `build.gradle` attaches the release `signingConfig` to *every* subsequent assemble — while the
  keystore passwords are per-step env on the shipping builds only. That mismatch is what failed
  (`SigningConfig "release" is missing required property "storePassword"`). The step clears the path
  instead of being handed the release key it has no use for; Groovy reads `""` as false. Gradle then
  emits `app-fdroid-release-unsigned.apk`, which the assertion accepts alongside the signed name.

## The toolchain question — answered

This was filed as the open feasibility risk. It is not a blocker, in either direction.

**Bun is probably allowed.** The policy's prebuilt-binary clause ends: "…and compilers or build
tools **which are not included in Debian can be acceptable**. Whenever possible, Debian-packaged
dependencies should be chosen above other options." Bun is MIT-licensed FLOSS and not in Debian, so
it lands in that sentence — reviewer discretion with a stated preference for Debian-packaged
alternatives, not exclusion. Ask on the merge request rather than assuming either way.

**And the whole build works with no bun at all.** Probed on `d4311f2c` in a throwaway worktree with
its own `node_modules`, npm 10.9.8 / Node 22.23.1, start to finish:

| Step | Result |
| --- | --- |
| `npm install` as-is | **fails** — `EUNSUPPORTEDPROTOCOL: workspace:*`, on npm 10 *and* npm 12 |
| `workspace:*` → `*` in the 9 package.json entries, then `npm install --legacy-peer-deps` | 1918 packages, clean |
| `node scripts/build-changelog.ts` (the `prebuild` hook, which shells out to `bun`) | works — Node ≥ 22.18 strips types natively |
| `ng build` | clean, 8.9 s |
| `NICOTIND_FDROID=1 cap sync android` | 5 plugins, barcode-scanner and apk-update absent |
| `NICOTIND_APP_ID_SUFFIX=.tv ./gradlew assembleFdroidDebug` | APK, `package="ar.kevinroberts.nicotind.tv"`, no mlkit/gms/osbarcode |

Three things that fall out of that, all of which matter to a recipe:

- **`*` is enough**; no `file:` rewriting. npm resolves a bare `*` against the workspace. `--legacy-peer-deps`
  is needed only for a `@storybook/angular` peer range on `@angular/common` — dev tooling F-Droid
  never builds. **Not landed**: it is only needed if bun is refused, and re-verifying the bun install
  and `bun.lock` around it is its own risk. Whether bun still resolves `*` to workspace packages is
  **untested** — deliberately, to avoid drifting the shared bun store (#1088).
- **The recipe must run `cap sync`, not just gradle.** The *tracked* `capacitor.settings.gradle`
  hardcodes bun's store layout
  (`../../../node_modules/.bun/@capacitor+android@6.2.1/node_modules/@capacitor/android/capacitor`)
  plus a fixed `../../../` depth, so it is wrong for any other install layout or checkout depth.
  `cap sync` rewrote it to `../../../node_modules/@capacitor/android/capacitor` under npm. This is
  the same file that must never be committed after a local `cap update`.
- **`cap sync` also rewrites the tracked `capacitor.build.gradle`**, so building the F-Droid variant
  locally dirties two tracked files. Restore them; don't commit the variant's versions.

## Store metadata

Fastlane layout, one tree per entry, both `en-US` and `es-ES` (the two locales the app itself ships):

| Entry | Tree |
| --- | --- |
| phone (`ar.kevinroberts.nicotind`) | `packages/mobile/fastlane/metadata/android/<locale>/` |
| TV (`ar.kevinroberts.nicotind.tv`) | `packages/mobile/fastlane-tv/metadata/android/<locale>/` |

The TV tree's name is ours, not a convention. fdroidserver finds fastlane metadata relative to a
build's `subdir` or the repo root, and both entries share one `subdir` — so auto-detection would hand
the *same* metadata to both. **Which path the TV entry's recipe has to name is unverified**; settle it
against a local `fdroidserver` when writing the merge request rather than assuming.

Both descriptions are explicit that the F-Droid build has no QR pairing and no self-updater, and why.
A listing that promises a camera scanner the build cannot provide is a bug report waiting to happen.

**Changelogs** are named by `versionCode`, not semver — that is how F-Droid pairs a changelog with a
build. `bun run --filter @nicotind/mobile fdroid:changelog` derives the name from `androidVersion()`,
the same function CI feeds to gradle, so a changelog cannot be filed under a code no APK was built
with. It reduces the generated `CHANGELOG.md` section to plain bullets inside the 500-byte cap,
dropping whole entries and saying how many rather than cutting mid-URL. Run it after
`bun run release`, not during: the release script makes its own commit, so a file written inside it
lands in the following one.

**Screenshots are deliberately absent**, and both `images/README.md` files say why at the point of
use. The fixture-based Playwright harness has exactly one album — "E2E Test Album", noise cover —
which is right for the README and wrong for a store listing, where it reads as an empty app. A real
capture needs a live library (`playwright.live-screens.config.ts` is the hook) plus a spec that does
not navigate by fixture name; the TV entry additionally needs the `tv` bundle, since that UI is a
build-time route fork. F-Droid does not require screenshots, so this does not block submission.

`check:fdroid` validates every locale's title/short_description/full_description against F-Droid's
byte caps and every changelog's name and size — **byte** length, because the accented Spanish copy is
multi-byte and a character-counted cap would pass text the store cuts.

## What is still needed for the main repo

1. **Two merge requests** to `fdroiddata`, one per application id, with `prebuild` setting
   `NICOTIND_FDROID=1` (and `NICOTIND_APP_ID_SUFFIX=.tv` for the TV entry) before `cap sync`, and
   `gradle: [fdroid]` to select the flavor.
2. **Screenshots**, and the TV metadata path question above.

## Our own F-Droid repository

Shipped first, before `fdroiddata` (decided 2026-09-16). Users add:

```
https://kevinch3.github.io/NicotinD/fdroid/repo
```

It serves the **`fdroid` variant**, not the `standard` APKs, even though no policy applies to our own
repo: the standard APK's self-updater would otherwise fight the F-Droid client for the same install.

### How it is built

`scripts/build-fdroid-repo.ts` assembles a directory `fdroid update` (fdroidserver) can sign, from
the release's F-Droid APKs; `.github/workflows/pages.yml` publishes it. `config.yml` and each
`metadata/<applicationId>.yml` are **generated** (`fdroid-repo.ts`) rather than committed — the repo
URL, app ids and current version all come from things the repo already knows.

It publishes **only the current release**, which is what keeps it stateless: an F-Droid repository is
valid with one version per app, so there is no history to carry between runs and re-running a release
reproduces the same repository. The trade-off is no downgrades.

### Four things that cost time, so they are written down

- **`fdroid update --create-metadata` breaks the two entries.** It invents a metadata file whose
  `Name` — the APK's own label, `NicotinD` for both — **outranks** the fastlane `title.txt`. Verified:
  the TV entry came out named "NicotinD", with `Categories: [fdtest]` taken from the working
  directory's name. Generating the `.yml` ourselves is what keeps the entries distinguishable.
- **`repo_icon` is a path relative to fdroid's working directory**, and fdroid copies it into
  `repo/icons/` itself. The warning misleads: it says `repo_icon "repo/icons/icon.png" does not
  exist` while the check is on the *source* (`update.py`'s `if os.path.exists(repo_icon)`). Putting
  a PNG in `repo/` instead gets it published as an app file with no metadata.
- **Per-version changelogs do not appear in a binary-only repo.** `whatsNew` is attached to a
  `Builds` entry (`update.py` matches `build["versionCode"] == versionCode`), and only apps
  fdroidserver builds from source have those. The `<versionCode>.txt` files stay correct for the
  fdroiddata submission; do not chase this in our own repo.
- **`fdroid update` exits 0 after skipping an APK it could not read.** The builder therefore parses
  the generated `index-v2.json` and fails unless *both* application ids are present — the index is
  the only honest confirmation that both entries published.

### The signing key

A **dedicated** keystore, not the app release key, so app-signing identity and repository identity
stay independent: `FDROID_REPO_KEYSTORE_BASE64`, `FDROID_REPO_KEYSTORE_PASSWORD`,
`FDROID_REPO_KEY_ALIAS`. RSA 4096, PKCS12, generated 2026-09-16.

**Losing it changes the repository's identity**, and every user who added the repo has to remove and
re-add it — so it belongs in durable backup, not only in Actions secrets. The workflow decodes it to
`$RUNNER_TEMP`, `chmod 600`, and `shred -u`s it afterwards; the builder deletes both the keystore
copy and the password-bearing `config.yml` from its output directory before anything is published.

Absent the secret the F-Droid half is **skipped, not failed** — the catalog still publishes, the same
shape as deploy.yml's keystore handling. The landing page then omits the repository section rather
than advertising one that is not there.

## Migration note

An F-Droid TV install is package `…nicotind.tv` and lands *alongside* a sideloaded TV APK rather
than upgrading it. That is correct for two distribution channels — the sideload APK keeps the bare
id, so no existing install is disturbed — but it needs saying in the release notes.
