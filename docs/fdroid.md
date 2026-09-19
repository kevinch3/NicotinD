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
#1168 asks it instead — and the same binary is then correct in both channels. `REQUEST_INSTALL_PACKAGES`
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
  exists to reject. What remains are the five things still silently breakable — fastlane metadata
  outside F-Droid's byte caps in any locale; the Pages lane losing its reference to the scripts that
  build and publish the repository (nothing fails, the repository just stops moving); the release
  lane renaming or no longer producing the APKs the repository serves, which the Pages job downloads
  from the latest release **by name**; a release with **no changelog for its own versionCode**, which
  F-Droid renders as blank release notes (it happened twice before the arm existed); and the
  fdroiddata recipe drifting from the build it describes.
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
| phone (`ar.kevinroberts.nicotind`) | `fastlane/metadata/android/<locale>/` — **repo root**, see below |
| TV (`ar.kevinroberts.nicotind.tv`) | `src/tv/fastlane/metadata/android/<locale>/` — **repo root**, see below |

### The phone tree lives at the repo ROOT, and it has to

fdroidserver reads listing metadata from exactly four places (2.4.5, `update.py`,
`insert_localized_app_metadata`). The two that read the app's own checkout are:

```
build/<applicationId>/fastlane/metadata/android/<locale>/
build/<applicationId>/src/<buildFlavour>/fastlane/metadata/android/<locale>/
```

`build/<applicationId>/` is the **checkout root**, and `subdir` does not move that search. Verified
by running the real globs against both layouts: `fastlane/` at the root matches, and
`packages/mobile/fastlane/` matches nothing. While the tree lived there, F-Droid would have found
**no** listing at all — not the wrong one, none — and nothing would have errored.

So `fastlane/` sits at the repo root even though `packages/mobile/` would be tidier. `FDROID_APPS`
carries the path (`fastlaneDir`, repo-root relative) so the builder, the gate and `fdroid:changelog`
all read the one place.

**Do not put descriptions in fdroiddata.** fdroiddata's fourth glob (`metadata/<applicationId>/
<locale>/`) does work, and we tried it first — a reviewer told us to take it out
([MR 49342](https://gitlab.com/fdroid/fdroiddata/-/merge_requests/49342)), and the App Inclusion
template says the same: fdroiddata carries the **build metadata only**, and everything else is
pulled from the upstream fastlane tree so the author can maintain it without opening an MR.

### The TV entry needs a flavour, and that is not what #1168 deleted

Both apps build from this one repository, which creates two problems that share one answer.

**The root tree has no flavour gate.** fdroidserver applies `build/<appid>/fastlane/` to *every*
app checked out from this repo, then overwrites it **file by file** from
`src/<flavour>/fastlane/` (`sorted()` puts `fastlane` before `src`; later reads win). So the TV
entry inherits the phone's listing for every file the TV tree does not also have — silently, with
nothing to read as an error. `check:fdroid` therefore requires the TV tree to be a **superset** of
the root one.

**`src/<flavour>/fastlane` is read only when the recipe's `gradle:` names that flavour** — and that
same name is what fdroidserver passes to `assemble<Flavour>Release`. So the flavour is not optional
packaging; it is the key to the listing.

It also solves a second blocker. The `.tv` suffix used to come from `NICOTIND_APP_ID_SUFFIX`, which
our CI sets and **F-Droid's buildserver has no way to set** — a TV entry there would have built the
phone's application id. `productFlavors { tv { applicationIdSuffix ".tv" } }` supplies it from
gradle instead, verified by building: `assembleTvRelease` with no environment at all badges
`ar.kevinroberts.nicotind.tv`.

The flavours carry **no code, resources or dependencies** — what differs between the two APKs is the
web bundle `cap sync` copied into `assets/`, which no gradle variant can change. That is why this is
not a reversal of #1168: what that removed was a *distribution* flavour with its own plugin list and
manifest overlay. These two are an application-id carrier and a metadata path.

One consequence with teeth: **a bare `./gradlew assembleRelease` now builds both flavours from
whatever bundle is in `assets/`**, so the TV APK would ship the phone UI under the TV id and nothing
would fail. `check:fdroid` forbids it in `deploy.yml`.

Run `fdroid rewritemeta <applicationId>` on the recipe before submitting — it canonicalises key order
and strips comments, so the copy in fdroiddata will not match ours byte-for-byte. That is expected;
ours keeps the comments because they explain the toolchain pins to the next reader.

Both descriptions state plainly that there is no QR pairing, that the in-app updater hides itself on
a store install, and that `REQUEST_INSTALL_PACKAGES` is nonetheless declared. A listing that
contradicts the manifest it ships with is what gets a submission bounced.

**Changelogs** are named by `versionCode`, not semver — that is how F-Droid pairs a changelog with a
build. `bun run --filter @nicotind/mobile fdroid:changelog` derives the name from `androidVersion()`,
the same function CI feeds to gradle, so a changelog cannot be filed under a code no APK was built
with. It reduces the generated `CHANGELOG.md` section to plain bullets inside the 500-byte cap,
dropping whole entries and saying how many rather than cutting mid-URL.

**It runs inside `bun run release`** — `.versionrc.json`'s `postchangelog` hook, which fires after
`CHANGELOG.md` is written and before the release commit, so the changelog lands *in* the bump commit
and every tag is self-consistent. `commitAll: true` is what lets it: without it
commit-and-tag-version commits an explicit path list (`git commit <bumpFiles> <CHANGELOG.md>`) and
anything else staged is dropped on the floor.

This was a manual step until 0.8.4, and the manual step was skipped every time: 0.8.2 shipped with
only a `6056` changelog, 0.8.3 with only `8002`, 0.8.4 with none of its own — all three would have
published blank release notes. `check:fdroid` now fails on a missing changelog for the current
version, which turned the old advice ("run it after `bun run release`") into a gate that reddened
master on every release until someone remembered. Automating the step was the fix; the gate alone
just moved the cost.

One consequence worth knowing: `commitAll` commits the **index**, not the working tree, so unstaged
churn (`packages/web/public/changelog.json`, regenerated by any web build) stays out. Anything you
had *staged* before running `release` would be swept into the release commit.

**Screenshots are deliberately absent**, and both `images/README.md` files say why at the point of
use. The fixture-based Playwright harness has exactly one album — "E2E Test Album", noise cover —
which is right for the README and wrong for a store listing, where it reads as an empty app. A real
capture needs a live library (`playwright.live-screens.config.ts` is the hook) plus a spec that does
not navigate by fixture name; the TV entry additionally needs the `tv` bundle, since that UI is a
build-time route fork. F-Droid does not require screenshots, so this does not block submission.

`check:fdroid` validates every locale's title/short_description/full_description against F-Droid's
byte caps and every changelog's name and size — **byte** length, because the accented Spanish copy is
multi-byte and a character-counted cap would pass text the store cuts.

## Submitting to the main repo

Two merge requests to [`fdroiddata`](https://gitlab.com/fdroid/fdroiddata), one per application id,
**phone first** — a leanback-only second app from the same repository is the unusual half, and it is
worth learning what the reviewer wants from the ordinary one first.

The build recipe lives at **`packages/mobile/fdroiddata/ar.kevinroberts.nicotind.yml`**, in this
repository rather than only in a fork, so it is reviewed alongside the code it builds and
`check:fdroid` can hold it to that code. To submit: fork `fdroiddata`, branch
`ar.kevinroberts.nicotind`, copy the file to `metadata/ar.kevinroberts.nicotind.yml`, commit as
`New App: ar.kevinroberts.nicotind`, open the MR.

A merge request carries the **build metadata only** — one file:

```
metadata/ar.kevinroberts.nicotind.yml          # after `fdroid rewritemeta`
```

Descriptions, changelogs and images are pulled from this repo's root `fastlane/` tree, not committed
to fdroiddata (see "Store metadata"). We got that wrong on the first attempt and were corrected.

`fdroid lint ar.kevinroberts.nicotind` passes clean on fdroidserver 2.4.5 against fdroiddata's own
config — lint it there, not against a stub config, because a stub has no category list and reports a
valid category as invalid.

**The recipe's whole build was run for real** (2026-09-18) from a clean clone with no `node_modules`:
`bun install --frozen-lockfile` → web build → `cap sync android` → `assemblePhoneRelease` with **no
environment set**, producing `versionCode='8001' versionName='0.8.1'` and **0** class definitions
matching ML Kit, GMS, Firebase, osbarcode or OutSystems out of 5226. `fdroid build` itself was not
used: it locks the root account, because it assumes a disposable buildserver VM.

### The buildserver's node is too old for Angular

Found by F-Droid's own CI on the first real `fdroid build` (2026-09-19), not by anything here:

```
Node.js version v24.3.0 detected.
The Angular CLI requires a minimum Node.js version of v22.22.3 or v24.15.0 or v26.0.0.
```

bun installs fine and runs the workspace scripts, but `ng` is executed by the **system node**, so
the bun pin never covered this. The recipe now installs node too — same version as `.nvmrc`,
checksummed against nodejs.org's published `SHASUMS256.txt`, and gated so the pin cannot drift
away from the version we actually build with.

**Use the `.tar.gz`, not the `.tar.xz`.** The next run got as far as `/tmp/node.tar.gz: OK` and then
died on `tar (child): xz: Cannot exec: No such file or directory` — the buildserver has no xz. Both
formats are published with checksums, and gzip is one fewer thing to have to install. The gate
deliberately does not pin the extension: that is packaging, not the thing worth protecting.

Worth generalising: every build input F-Droid supplies is one we do not control and never test
against. The bun and node pins exist for the same reason, and both are gated for the same reason —
a mismatch fails only there.

### `bunx` needs its own symlink

Third failure in the same job, after the web build had already succeeded:

```
bash: line 1: bunx: command not found
```

The bun release **zip contains only the `bun` binary**. `bunx` is a separate name on `PATH` that
bun's own installer creates as a symlink to that same binary — bun dispatches on `argv[0]`. Our
sudo block linked `bun` and not `bunx`, so the prebuild died three commands later, which reads like
a Capacitor problem rather than a `PATH` one. Gated.

### Every one of these was invisible from here

Node too old, no `xz`, no `bunx` — three round-trips, all of them assumptions about a machine we do
not have. Local verification cannot catch them: this repo's own `bun` install ships `bunx`, this
machine has `xz`, and our Node is the version `.nvmrc` pins. The gates exist so the *next* drift is
caught here instead, but the first discovery of each will always be F-Droid's CI. Budget for that
rather than treating a red pipeline there as a surprise.

### `checkupdates` fails on a stale seed, which is not a defect

The job reads our tags and proposes the metadata it thinks is current:

```
-CurrentVersion: 0.8.8
+CurrentVersionCode: 8010
```

It exits non-zero when the committed metadata is behind. Because the seed is deliberately ungated
(F-Droid owns those fields once the app is in), it goes stale with every release while a merge
request is open. Bump it to the current tag when the reviewer next looks; do not add a gate that
would redden master on every release.

### Recipe conventions the reviewer asked for

Both raised on [MR 49342](https://gitlab.com/fdroid/fdroiddata/-/merge_requests/49342), both now
gated by `check:fdroid` — a recipe that breaks either still *builds*, it just stops being
reviewable, which is exactly the kind of thing no local check would otherwise catch.

- **One command per list entry; never `&&` or `;` inside one.** Verified against fdroidserver
  rather than taken on faith: `sudo:` and `prebuild:` are each `'; '.join(…)`-ed and run under
  `bash -e -u -o pipefail`, so separate entries already abort on failure, and a bare `cd` already
  persists into the entries after it. Chaining buys nothing and costs a readable diff.
- **`commit:` is a full 40-character hash, never a tag.** A tag can be moved or deleted after the
  build is reviewed, so it does not identify what was audited. Our `AutoUpdateMode: Version` seed
  therefore carries a hash; F-Droid fills later entries in itself.

### What the recipe has to do that a normal Android app does not

- **Install bun.** Pinned to the same version `deploy.yml` builds with, downloaded from its GitHub
  release and **sha256-verified** — an unverified binary download is the thing the inclusion policy
  is most pointed about. `check:fdroid` fails if the pin drifts from `BUN_VERSION` or the checksum
  step disappears. The bun-free npm path above is the fallback if a reviewer objects; offer it
  rather than arguing.
- **Run `cap sync android` before gradle.** Not optional: the *tracked*
  `capacitor.settings.gradle` hardcodes bun's store layout, so gradle in a fresh checkout resolves
  plugin paths that do not exist. Also gated.
- **Nothing for the version.** `build.gradle` reads the monorepo `package.json` itself, so a
  checkout builds the right `versionCode` with no environment at all. It did not use to — the
  fallback was `versionCode 1`, and an APK that lies about its version cannot be updated by any
  store.

### Two things a reviewer will raise

- **`REQUEST_INSTALL_PACKAGES`.** The single build declares it, and F-Droid will never use it. The
  control that needs it hides itself on a store-managed install (above), but the *permission* is
  still in the manifest, and the store listing now says so in as many words rather than claiming the
  permission was removed. If the reviewer wants it gone, that means a manifest-stripping build step —
  possible, but it re-introduces a variant, which is what #1168 deleted.
- **Signing — decided once, and it cannot be revisited.** The App Inclusion template is explicit:
  "if you don't enable reproducible build then the apk will be signed with our key so you can't
  enable it later." So **reproducible builds are enabled** (owner's call, 2026-09-18, after an
  earlier note here wrongly said this could be deferred). F-Droid verifies its build byte-matches
  ours and publishes **our** signature, which means a GitHub sideloader upgrades in place instead of
  uninstalling and losing app data, and users can move between channels.

  Two fields carry it: `Binaries:` (the release asset URL, `%v`-templated) and
  `AllowedAPKSigningKeys:` (the release keystore's SHA-256 cert digest,
  `5bf701a0…557d6bea`, read off the published `NicotinD-0.8.3.apk` with `apksigner verify
  --print-certs`). If the build is not byte-identical, F-Droid reports it rather than silently
  publishing its own signature — that is the point of the field.

## Auto-update needs a version F-Droid can read

`UpdateCheckMode: Tags` + `AutoUpdateMode: Version` means fdroidserver watches our tags and adds
build entries itself. To do that it **greps `build.gradle`** (`common.py`'s `vcsearch_g`/`vnsearch_g`)
— it never runs gradle. Our file used to compute the version from `package.json` in Groovy, which
those regexes read as *no version*, so F-Droid would have stopped seeing releases with nothing going
red on our side.

So the file carries literals, written by `bun run release`. Two consequences worth knowing:

- **A match inside a comment counts.** fdroidserver greps; it cannot tell code from prose. A stray
  `versionCode 1` in an example would decide our published version. `applyAndroidVersion` and
  `build-gradle.test.ts` both refuse more than one match, comments included.
- **A stale literal is invisible.** The build succeeds and the APK installs; it just claims the
  wrong version. The drift test against `package.json` is the only thing that notices.

## Reproducible builds

Enabling the fields above was a promise the build could not keep. Measured, not assumed.

### What F-Droid actually checks

`fdroid verify` runs `apksigcopier.do_copy(ours, theirs, exclude=exclude_meta)` — grafting our
signature onto their own rebuild — then `apksigner verify`. That passes only when the two archives
are byte-identical apart from the signature. `apksigcopier` is vendored inside fdroidserver with no
CLI, so the exact check is runnable locally:

```bash
~/.local/share/pipx/venvs/fdroidserver/bin/python -c \
  "from fdroidserver import apksigcopier as a; a.do_copy('published.apk','rebuilt-unsigned.apk','out.apk', exclude=a.exclude_meta)"
apksigner verify --verbose out.apk
```

It answers *whether*, never *where*, so `bun run packages/mobile/scripts/apk-diff.ts <published>
<rebuilt>` exists to name the entry — it hashes every zip entry, ignores exactly the files
apksigcopier ignores, and prints the denominator ("658 entries: 658 compared, 0 signature entries
ignored") so a pass cannot be an empty comparison.

Our APKs carry **no** JAR signature files: minSdk 26 means AGP signs with v2/v3 only, so `0 ignored`
is the honest count rather than a bug.

### The one thing that was not deterministic

Measured on `v0.8.5`, published APK vs a clean-clone rebuild: **of 658 entries, exactly one
differed** — `assets/public/ngsw.json`. Angular's service-worker manifest carries
`timestamp: Date.now()`, and `cap sync` copies the whole web bundle into the APK.

`packages/web/scripts/pin-ngsw-timestamp.ts` (`pinManifestTimestamp`) rewrites it, wired as the web
package's **`postbuild`** so every consumer gets it without knowing — CI, Docker, desktop packaging,
both e2e lanes, and F-Droid's recipe, which invokes the same package script. The value comes from
`SOURCE_DATE_EPOCH` when set, else `git log -1 --format=%ct`, else the 1980 zip epoch AGP already
stamps on every entry; `deploy.yml` exports the same `git log -1 --format=%ct` that fdroidserver
uses (`common.py`), so both builds derive it identically without coordinating.

It is behaviour-neutral for the PWA: `ngsw-worker.js` reads `timestamp` only under
`applicationMaxAge`, which `ngsw-config.json` does not set.

`dependenciesInfo { includeInApk false }` is off in `build.gradle` for the same reason — AGP
otherwise embeds an encrypted, Google-readable dependency blob in the signing block, which is the
wrong thing to carry into a byte comparison. `minifyEnabled false` stays: R8 is not deterministic
across versions, so turning it on needs its own rebuild comparison first.

`check:fdroid` guards all of it, because every one of these fails **silently** — the build stays
green and only F-Droid's next rebuild notices.

### CI on a fdroiddata fork

The template says it outright: "F-Droid CI runners are under GitLab's FOSS program, so there's no
need for you to pay for any CI time. If Gitlab starts asking for phone numbers or credit cards don't
submit anything, just leave a note in the MR so we know we need to trigger the CI." Our fork's first
pipeline failed instantly with **zero jobs created** — no runner, not a metadata error. Leave a note;
do not verify a payment method to make the badge green.

Still open: **screenshots**, and the **TV entry's metadata path** (above).

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
