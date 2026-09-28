# Releases — how they work and how to run one

Two things ship, on two clocks (see [Edge and releases](#edge-and-releases)):

- **Every green master commit** becomes the `:edge` image and is deployed to
  the production host within minutes.
- **A release** — one `vX.Y.Z` git tag, cut once a day or on demand — publishes
  the `release`/`vX` images self-hosters pull and the app artifacts (Android
  APK, iOS IPA, desktop packages) attached to its GitHub Release.

You never build either by hand — you land commits and the pipeline does the rest.

## The day-to-day flow (this is the whole job)

1. **Land your work on `master` through a PR**, with
   [Conventional Commit](https://www.conventionalcommits.org/) messages
   (commitlint-enforced). While the version is `0.x`, `feat`, `fix` and `perf`
   all bump the **patch** and `!`/`BREAKING CHANGE:` bumps the **minor** —
   `commit-and-tag-version`'s pre-1.0 rule, which is why a `feat` took v0.8.95 to
   v0.8.96. From 1.0 it becomes `feat` → minor, `fix`/`perf` → patch, breaking →
   major. `chore`/`docs`/`refactor`/`test`/`ci` don't bump and won't appear in
   the changelog. Full table in [CLAUDE.md](../CLAUDE.md#commit-conventions).
2. **Do nothing else.** When `ci.yml` goes green on the master push, its
   `edge-image` and `edge` jobs publish `:edge` and dispatch **Deploy host**,
   which puts that exact commit on the production host.
3. **Once a day** (13:17 UTC) `release.yml` releases master's tip if it holds a
   bumping commit and its `edge` run succeeded: it bumps the version from the
   commit history, regenerates `CHANGELOG.md`, commits `chore(release): X.Y.Z`,
   tags `vX.Y.Z`, and pushes the tag. **Need it now?** Actions → **Release** →
   *Run workflow* (tick `force` only if `edge` is red for a host-side reason:
   see [Forcing a release](#forcing-a-release)).
4. **The tag triggers `deploy.yml`**, which publishes the images and builds
   **every** app artifact — an API-only release still rebuilds the APKs, the IPA
   and the desktop packages. That is deliberate: the in-app APK updater,
   electron-updater and the F-Droid repo all read the *latest* release and
   expect its assets (see [Why every release builds every app](#why-every-release-builds-every-app)).
   It does **not** deploy the host, which already runs that code as `edge`.
5. **Verify** (takes a minute):
   - Actions: `ci.yml` → `edge` green and a **Deploy host** run for the commit;
     after a release, `release.yml` pushed the tag and the `deploy.yml` run for
     the tag is green.
   - The tag's **GitHub Release page** carries the expected artifacts. A
     release that is still a **draft** means `publish-release` did not run:
     see [A release is published only once its artifacts are attached](#a-release-is-published-only-once-its-artifacts-are-attached).
   - The production server reports the new **commit** (`GET /api/health` →
     `{ ok, version }`, Settings footer, or `GET /api/system/status`), and the
     in-app changelog modal (click the version string) shows the new entry.

### The PR title is the commit message that decides (#1263)

Merges here are **squashes**, so the PR title becomes the subject on master —
and `release-needed.ts` reads subjects, only subjects, on purpose. A PR titled
without a conventional-commit type therefore lands a commit that bumps nothing,
whatever it contains.

That froze releases once. PR #1263 squash-merged five `feat:` commits under the
title *"Radio queue depth: replace batch refill with target-based top-up"*. No
type, no bump, no tag, no deploy — v0.8.40 stayed the latest release while the
features sat on master, and **every check was green**, because nothing was
broken: the release genuinely was not needed, from a subject that had lost the
only evidence it should have been.

The husky `commit-msg` hook cannot catch this — it runs on commits made on your
machine, and a squash merge is performed by GitHub from a title nothing
validated. Two things close it:

- **`check:pr-title`** (`.github/workflows/pr-title.yml`) fails a PR whose title
  is not a conventional commit, *and* a PR whose title does not bump while its
  commits do. It re-runs on every title edit — a retitle pushes no commit — which
  is why its trigger lists `edited`, and why it is a separate workflow: `edited`
  fires on body edits too, and `ci.yml` must not rebuild everything because
  someone fixed a typo in a description.
- **`release-needed.ts`** prints a `::warning::` when it skips a commit whose
  *body* lists bumping commits its subject lost. The decision is unchanged —
  only a subject may bump — but the skip stops being silent.

**If it happens anyway**: nothing on master can be retyped without rewriting
history, so land the next bumping commit normally. The tree ships in full
(a deploy carries the whole tree, not a diff), but the stranded work will not
appear in `CHANGELOG.md` — note it in the follow-up PR so the record exists.

If a merge contained only non-bumping types, no release is cut — that's by
design, not a failure. The release job is also **idempotent**: it exits early if
the computed tag already exists, and releases nothing while master's tip has no
successful `edge` run (CI still running, or red — it says so in a warning), so
re-runs are always safe.

### The release commit is checked before it is pushed

The `chore(release)` commit only adds generated files: the version in
`package.json` and `build.gradle`, the `CHANGELOG.md` section, and the
per-versionCode F-Droid changelogs. The release job runs `check:fdroid` on it
**after** `bun run release` cuts it and **before** `git push`; a failure removes
the local tag and fails the job, so nothing is published.

That is why **no CI job runs on a `chore(release)` push** — every job in
`ci.yml` carries
`if: "!startsWith(github.event.head_commit.message || '', 'chore(release):')"`.
Re-running all fourteen jobs there checked the generated files only after the tag
had already started `deploy.yml`, and nothing waited for the result.
`scripts/ci-release-skip.test.ts` keeps both halves in place: a skip without the
in-job check would leave those changelogs checked by nothing.

## What each release ships, and how it reaches people

| Artifact                                  | Built when                | How it reaches users                                                                                                            |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Server image**                          | every tag                 | multi-arch image published to `ghcr.io/kevinch3/nicotind` (`vX.Y.Z` + `vX` + `release` tags); self-hosters `docker compose pull` |
| **Server (production host)**              | every green master commit | runs `:edge`, deployed by **Deploy host** (exact commit, snapshot first) — nothing to do                                          |
| **Android APK** (+ a separate TV APK)     | every tag                 | download from the GitHub Release and sideload (see below); signed when `ANDROID_KEYSTORE_*` secrets are present                  |
| **iOS IPA** (unsigned)                    | every tag                 | re-sign + install via AltStore/Sideloadly (see below)                                                                            |
| **Desktop** Linux AppImage/deb + macOS dmg | every tag                 | GitHub Release download; **existing installs auto-update** via electron-updater — Linux applies updates itself, macOS only notifies (ad-hoc signing) |

### Edge and releases

Every merge used to be a public release: 685 tags in 140 days, 65 % of them a
single commit, each one an update prompt in every installed app, a new
`release` image for every self-hoster, and a CI run on the bump commit. The
pipeline now separates the two things a merge was doing:

- **`edge` — every green master commit, to the production host.** `ci.yml`'s
  `edge-image` job (which `needs` every gate job, so `check:ci-parity` holds
  it to them) builds both arches with `NICOTIND_BUILD_COMMIT`, boots the pushed
  image (`smoke-image.sh`), and `edge` merges them into
  `ghcr.io/kevinch3/nicotind:edge`. The analysis sidecar gets an `:edge` too:
  rebuilt only if `packages/analysis` changed since the last release, otherwise
  the last release's image. "The last release" is the newest `v*` tag whose
  analysis image exists: a tag whose build never ran has none (v0.8.104), and
  retagging from it failed the first edge deploy. Both images are Trivy-scanned
  with the release scan's pin and policy (each arch's pushed digest in
  `edge-image`, the analysis image — rebuilt or the release's — in `edge`), and
  both `:edge` tags move only after both scans pass. Then it dispatches **Deploy host** with
  `version=edge` and the commit, which `/api/health` must report. Nothing about
  it is public except the tag, which any self-hoster can opt into with
  `NICOTIND_VERSION=edge`.
- **Releases — daily, or on demand.** `release.yml` runs the same idempotent,
  orphan-tag-proof release step the per-merge job used to, and releases **only
  a tip whose `edge` run succeeded** — it no longer runs inside the CI run of
  the commit it releases, so that check is its proof the gates passed.

Consequences worth knowing:

- **The host is ahead of the latest release** between releases. `/api/health`
  keeps reporting the last release's `version` until the next one (an edge
  build carries the version in `package.json`); `commit` says which build it is.
- **Releases never deploy the host.** It already runs that code, and deploying
  the tag would move it *backward* onto an older commit, over a schema the
  newer one already migrated.
- **A burst of merges** queues host deploys; the newest pending one replaces
  older pending ones (one pending run per concurrency group), so the host skips
  straight to the newest commit.
- **A Trivy finding stops edge.** A base-image CVE with a published fix fails
  `edge-image` (or `edge`, for the analysis image): the host keeps running the
  previous `:edge`, and releases hold, until the base image is bumped. The
  analysis image is scanned even when it is the last release's, so a fix
  published since that release blocks too.
- **The `edge` job's success is what releases require.** A failed dispatch of
  Deploy host fails `edge` and holds the release until a later commit is green;
  the host being unreachable does not (the dispatch succeeds, the Deploy host
  run fails on its own). A manual release can [force](#forcing-a-release) past it.
- `:edge` pushes accumulate untagged versions in GHCR; the
  [retention workflow](#ghcr-retention) prunes them.

### Forcing a release

**Release**'s *Run workflow* has a `force` checkbox (off by default). It skips
the one check that the tip has a successful `edge` run — for when `edge` is red
for a reason that is not the code, e.g. Deploy host could not be dispatched —
and nothing else: `release-needed.ts`, the orphan-tag handling, `check:fdroid`
and the atomic push all still apply. A forced release writes a **Forced
release** block to the job summary naming the tip and who forced it. The
scheduled run never forces (`inputs` is honoured only on `workflow_dispatch`).

Before forcing, confirm the tip's gate jobs passed: the `edge` check is the
release's only proof of them.

### GHCR retention

Every green master commit pushes per-arch images by digest and re-points
`:edge`, leaving the previous edge's versions untagged. A generic "delete
untagged versions" cannot clean them: a multi-arch tag is an image index whose
per-platform manifests and buildx attestation manifests are **separate,
untagged package versions**, so it would delete what `:edge`, `release` and
every `vX.Y.Z` point to.

`.github/workflows/ghcr-retention.yml` runs `scripts/ghcr-retention.ts` over
`nicotind` and `nicotind-analysis`. It reads every tagged version's manifest
from the registry, follows indexes (nested ones too) to the digests they
reference, and deletes only an untagged version that no tag reaches **and**
that is older than the age floor (`min_age_days`, default 14; an in-flight edge
build's digests are untagged for minutes). A tagged manifest it cannot read
aborts the run before anything is deleted.

It is a **dry run** unless told otherwise — it lists what it would delete in the
log and a count per package in the job summary:

- Weekly (Mondays 05:43 UTC): dry run, unless the repository variable
  `GHCR_RETENTION_DELETE` is `true`.
- Actions → **GHCR retention** → *Run workflow* with `delete` ticked: deletes.
- Off master, it never deletes.

Locally (needs a token with `read:packages`, and `delete:packages` for
`--delete`):

```sh
GH_TOKEN=… bun run scripts/ghcr-retention.ts --owner kevinch3 \
  --package nicotind --package nicotind-analysis [--min-age-days 14] [--delete]
```

### Why every release builds every app

`deploy.yml` once had a `changes` job that diffed tag-to-tag and skipped the app
builds whose inputs had not changed. It never skipped anything: the
`chore(release)` commit bumps the root `package.json` and
`packages/mobile/android/app/build.gradle`, which its own path regexes matched,
so every release built every app — v0.8.97, a backend-only change, still shipped
APKs, an IPA and both desktop packages. It was removed rather than fixed,
because a working version would have broken every consumer of the latest
release:

- the in-app APK updater builds `…/download/v<latest>/NicotinD-<v>.apk` from
  `releases/latest` and does not check the asset exists (`lib/apk-update.ts`);
- electron-updater reads `latest-*.yml` from the latest release;
- `pages.yml` refuses to publish when the latest release has no APKs and a
  repository is already live;
- fdroiddata's `Binaries:` points at every tag's APK for the reproducible-build
  check.

Skipping app builds safely would need all four to look further back than the
latest release first.

### A release is published only once its artifacts are attached

The tag's GitHub Release starts as a **draft**. `deploy.yml`'s `create-draft`
job makes it (or reuses it on a re-run) and hands every other job its id;
`release-notes`, `android`, `ios` and both desktop jobs write into that draft by
id (`scripts/github-release.ts`, and `verify-published-assets.ts --release-id`).
Nothing looks the draft up by tag: the API reports a draft's tag as
`untagged-…`, so a tag lookup misses it. electron-builder's own publisher did
exactly that on v0.8.103, published a second, desktop-only release, and made it
`latest` without the APKs; the desktop jobs now build with `--publish never` and
upload by id (docs/desktop-app.md "Publishing to the GitHub Release").
`publish-release` publishes it once `release-notes`, `android` and both desktop
jobs have succeeded **and** the four assets updaters read are on it — both APKs,
`latest-linux.yml` and `latest-mac.yml`.

Before, `release-notes` published the release within seconds of the tag and the
artifacts arrived minutes later. For that window `releases/latest` pointed at a
release with nothing on it — the in-app APK updater would offer a download that
404s — and a failed artifact job left it published without its files for good
(v0.8.65's `desktop-mac`).

- **The unsigned IPA does not block publishing.** It is sideload-only, and a
  flaky macOS runner there must not hold the APK back from Android users. The
  `ios` job uploads by id, so it lands whether the release is still a draft or
  already published. It still fails loud.
- **A failed required job leaves the release a draft.** Fix the cause and
  re-run the failed jobs; `publish-release` runs again and publishes. It uses
  `make_latest: legacy`, so a release published late cannot take `latest` from
  a newer one.
- **More than one release for a tag** (a stray draft, the v0.6.37 shape) makes
  `create-draft` fail rather than guess; delete the stray one by hand.
- `pages.yml` lists releases with `--exclude-drafts`, so the F-Droid repo never
  reads a draft.
- softprops/action-gh-release is no longer used: it publishes an existing draft
  at the end of any step that does not pass `draft: true`.

### Android app

- CI builds the signed APK on every tag push (uses `ANDROID_KEYSTORE_*` secrets
  when present, otherwise an unsigned APK), plus a second `NicotinD-TV-<v>.apk`
  for Android TV — a separate app (`…nicotind.tv`), not a variant of the phone one.
- The APK is attached to the **GitHub Release** of the tag — download and
  install directly on Android (you may need to allow "Install from unknown
  sources"). The in-app "Check for updates" button self-updates from GitHub
  Releases afterwards.
- Local build:
  `cd packages/mobile && bunx cap sync android && cd android && ./gradlew assemblePhoneRelease`
  (or `assembleTvRelease` after a `--configuration tv` web build — never bare `assembleRelease`,
  which builds both flavours from one bundle).
- Full detail: [mobile-app.md](mobile-app.md).

### iOS app

- CI builds an **unsigned** `.ipa` on a `macos-26` runner (`ios` job) on every
  tag push.
- The unsigned IPA is attached to the GitHub Release — install via **AltStore**
  or **Sideloadly** (re-signs with your own Apple ID; 7-day expiry on a free
  ID, 1 year on a paid developer account).
- Future: when an Apple Developer Program is acquired, flip the CI to a signed
  build by adding signing secrets.
- Full detail: [ios-app.md](ios-app.md).

## When you need more than the default

- **Force a bigger bump** (e.g. a milestone minor with only fixes landed): on a
  clean, up-to-date `master` checkout run `bun run release:minor` (or
  `release:major`), then `git push --follow-tags origin master`. This is the
  same tool CI runs (`bun run release` = auto-detected bump), so the tag flows
  through `deploy.yml` identically.
- **Re-deploy or roll back the server**: Actions → **Deploy host** → _Run
  workflow_ with the exact `vX.Y.Z` (both inputs). It snapshots the database
  first and verifies the version; `deploy.yml` has no manual trigger any more.
  Holding the host on a version is the `DEPLOY_HOLD` repository variable — see
  [deployment.md](deployment.md#rollback).
- **A deploy job failed but the tag exists**: fix the cause, then re-run the
  failed `deploy.yml` jobs from the Actions UI — don't re-tag.
- **The credentials a release uses** (`RELEASE_TOKEN`, the deploy host's, the Android signing
  keys) live in GitHub environments that only `master` and `v*` tags can use — see
  [dependency-management.md](dependency-management.md#secrets-live-in-environments). A
  `workflow_dispatch` from any other branch will not get them.
- **Never hand-edit** `CHANGELOG.md` or the `package.json` version — both are
  generated; hand edits get overwritten by the next release and can break the
  version detection.

See [deployment.md](deployment.md) for the deploy pipeline's failure modes
(orphan-tag-proof tagging, the green-but-silent deploy shape of issue #457) and
the self-hoster's upgrade/rollback procedure.
