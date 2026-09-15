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
| Proprietary Google libraries are "strictly forbidden"; upstream must provide "a build flavour that does not require these dependencies" | `@capacitor/barcode-scanner` pulls `com.google.mlkit:barcode-scanning` and `com.github.outsystems:osbarcode-android:1.1.+` (a dynamic version, which defeats reproducibility on its own) |
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

The excluded plugins were most of the download:

| Variant | APK |
| --- | --- |
| `standard` (GitHub releases) | 30 MB |
| `fdroid` | 4.4 MB |

ML Kit, Play Services, CameraX and a Compose runtime came in behind one QR-pairing screen. Worth
knowing when deciding what the *standard* APK should keep paying for.

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

## What is still needed for the main repo

1. **The toolchain question.** The policy's allowed prebuilt sources name Debian, the listed Maven
   repos, the Android/Flutter SDKs, PyPI wheels, Nix, Rust, Go and "Node.js (current versions)".
   **Bun is absent**, and `bun.lock` is not consumable by npm. The build recipe likely needs a
   node/npm path to `ng build`. Probe this against a local `fdroidserver` before writing anything
   else — it is the one open feasibility risk.
2. **Metadata**: `metadata/<appid>.yml` per entry, fastlane layout, summary/description/changelog,
   screenshots for both form factors.
3. **Two merge requests** to `fdroiddata`, one per application id, with `prebuild` setting
   `NICOTIND_FDROID=1` (and `NICOTIND_APP_ID_SUFFIX=.tv` for the TV entry) before `cap sync`.

An **own signed F-Droid repository** is the fallback and the faster interim: it works with the APKs
we already build, needs none of the above, and stays available if inclusion stalls on the toolchain
question. It needs two decisions that are not ours to guess — where it is hosted (GitHub Pages is
already taken by the Storybook catalog, so a second repo or kpc's public edge) and whether the
existing release keystore signs the repo index.

## Migration note

An F-Droid TV install is package `…nicotind.tv` and lands *alongside* a sideloaded TV APK rather
than upgrading it. That is correct for two distribution channels — the sideload APK keeps the bare
id, so no existing install is disturbed — but it needs saying in the release notes.
