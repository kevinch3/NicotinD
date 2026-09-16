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
  non-free plugin surviving into the resolved allowlist; and a release step pointing at a gradle
  output path the flavor does not produce.
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

## What is still needed for the main repo

1. **Metadata**: fastlane layout under `fastlane/metadata/android/<locale>/` per entry (F-Droid reads
   it straight from the repo), summary/description/changelog, screenshots for both form factors.
2. **Two merge requests** to `fdroiddata`, one per application id, with `prebuild` setting
   `NICOTIND_FDROID=1` (and `NICOTIND_APP_ID_SUFFIX=.tv` for the TV entry) before `cap sync`, and
   `gradle: [fdroid]` to select the flavor.

An **own signed F-Droid repository** ships first (decided 2026-09-16): it serves the `fdroid`-variant
APKs we already build, needs none of the above, and stays available if inclusion stalls in review.
It is blocked on two decisions that are not ours to guess — where it is hosted (GitHub Pages in this
repo is already taken by the Storybook catalog, since Pages serves one site per repo, so this means a
second repo or kpc's public edge) and whether the existing release keystore signs the repo index.

It serves the **`fdroid` variant**, not the `standard` APKs, even though no policy applies to our own
repo: the standard APK's self-updater would otherwise fight the F-Droid client for the same install,
and it is 26 MB larger for a QR screen (#1170).

## Migration note

An F-Droid TV install is package `…nicotind.tv` and lands *alongside* a sideloaded TV APK rather
than upgrading it. That is correct for two distribution channels — the sideload APK keeps the bare
id, so no existing install is disturbed — but it needs saying in the release notes.
