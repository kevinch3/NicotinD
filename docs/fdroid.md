# F-Droid distribution

NicotinD is AGPL-3.0-only and self-hosted, which makes F-Droid the natural store for it — and the
only install path for the TV APK that is not "enable unknown sources on your telly". This page
covers how the single build satisfies the inclusion policy, the repository we publish ourselves, and
what is still needed to get the two app entries into the main F-Droid repo. Issue #1168.

## There is no variant any more

F-Droid's [inclusion policy](https://f-droid.org/docs/Inclusion_Policy/) ruled out three things the
GitHub build used to do. All three are now fixed in the **single** build, so the release's own APKs
are the ones our F-Droid repository serves — one APK per form factor, no gradle flavours, no plugin
allowlist, no manifest overlay.

| Policy | How it is satisfied |
| --- | --- |
| Prebuilt binaries are trusted only from Debian, Maven Central, Google Maven, OSS Sonatype, OSS JFrog, JitPack and Clojars | `@capacitor/barcode-scanner`'s native lib came from OutSystems' private Azure Maven feed. #1168 removed the plugin outright rather than working around it — see mobile-app.md "The QR scanner, and why it is gone". |
| An app must not download executable binaries without opt-in consent explaining it bypasses F-Droid's checks | The self-updater is **hidden at runtime** when a store installed the app: `getInstallerPackage` (the apk-update plugin) + `isStoreManagedInstaller` (`lib/apk-update.ts`). A sideload keeps it, because there it is the only update path. |
| "All applications must have their own distinct Android Application ID" | The TV build carries `.tv` on every channel (`androidAppId`), so phone and TV are two entries. |

### Why runtime rather than a build flavour

A flavour would have meant two builds of everything forever, and it was already the reason the
release lane produced **four** APKs. Who installed the app is a fact the system will tell you, so
#1168 asks it instead — and the same binary is then correct in both channels. `REQUIRED_INSTALL_PACKAGES`
stays declared because the sideloaded copy genuinely needs it.

The list in `isStoreManagedInstaller` covers the F-Droid **clients** people use (F-Droid, F-Droid
Basic, Droid-ify, Neo Store), not just the official one. An unlisted client keeps the in-app
updater, which is the safe direction to be wrong in: the opposite error strands a sideloading user on
an old build with no way to move.

### Migration, once

A TV APK sideloaded before 0.7.x carries the old shared `applicationId`, so the suffixed build
installs **alongside** it rather than upgrading it. The stale copy has to be removed by hand. That is
the price of phone and TV finally being separate apps — which also means a TV APK can no longer be
installed over the phone one and silently swap the UI.

## Gates

- **`check:fdroid`** (CI-blocking) got much smaller in #1168: the arms that guarded the build
  flavour were **deleted rather than left passing vacuously**, which is the dead config this gate
  exists to reject. What remains are the three things still silently breakable — fastlane metadata
  outside F-Droid's byte caps in any locale; the Pages lane losing its reference to the scripts that
  build and publish the repository (nothing fails, the repository just stops moving); and the release
  lane renaming or no longer producing the APKs the repository serves, which the Pages job downloads
  from the latest release **by name**.
- **`packages/mobile/src/app-id.test.ts`** covers the `.tv` suffix, and `fdroid-repo.test.ts`
  asserts `FDROID_APPS` agrees with it — two places encode that id, and a drift would advertise an
  id no APK carries.
- **`packages/web/src/app/lib/apk-update.spec.ts`** + `update.service.spec.ts` cover the runtime
  gating, including that an unknown installer keeps the in-app updater and that the check does not
  block the initial render. Both gating tests were confirmed to fail without the fix.
- **deploy.yml** no longer assembles or verifies a separate variant — there isn't one. It publishes
  two APKs, and `check:fdroid` asserts their names still match what the Pages job downloads.

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
| `cap sync android` | plugins resolved |
| `NICOTIND_APP_ID_SUFFIX=.tv ./gradlew assembleDebug` | APK, `package="ar.kevinroberts.nicotind.tv"` |

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
- **`cap sync` also rewrites the tracked `capacitor.build.gradle`**, so an Android build under a
  non-bun install layout dirties two tracked files. Restore them; don't commit those versions.

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

1. **Two merge requests** to `fdroiddata`, one per application id. Simpler than it would have been:
   no flavour to select, and `NICOTIND_APP_ID_SUFFIX=.tv` for the TV entry is the only build-time
   input. The single build is already policy-clean.
2. **Screenshots**, and the TV metadata path question above.

## Our own F-Droid repository

Shipped first, before `fdroiddata` (decided 2026-09-16). Users add:

```
https://kevinch3.github.io/NicotinD/fdroid/repo
```

It serves the release's **own** APKs — the same files attached to the GitHub Release. There is
nothing to keep apart: the self-updater that would otherwise fight the F-Droid client for the same
install hides itself at runtime on a store-managed install (see the policy table above).

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

### Two guards the publishing lane needs, and why

That "skip, not fail" degradation is right while bootstrapping and **destructive once a repository is
live**, because one Pages deployment replaces the *entire* site. A `site/` built without
`fdroid/repo` does not leave the published repository alone — it removes it, and every client that
added the repository then gets 404s on the index and silently stops seeing updates. Nothing fails to
say so.

So the lane distinguishes the two cases by asking the live site, which is the only thing that knows:

- **`Refuse to publish a site that would remove a live repository`** — if this run built no
  repository but one answers 200, the job fails instead of deploying. Verified against the real site
  in all three states: built (passes), none built with one live (fails), neither (passes, bootstrap).
- **A conclusion guard on the trigger.** `workflow_run` has no `types: [succeeded]` — `completed`
  includes failure and cancellation — so the job is gated on
  `github.event.workflow_run.conclusion == 'success'`. A release that failed *before* attaching its
  APKs is exactly the run whose assets must not be picked up.

`check:fdroid` asserts both; removing either is caught.

## Migration note

An F-Droid TV install is package `…nicotind.tv` and lands *alongside* a sideloaded TV APK rather
than upgrading it. That is correct for two distribution channels — the sideload APK keeps the bare
id, so no existing install is disturbed — but it needs saying in the release notes.
