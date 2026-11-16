# Deployment pipeline, as built (2026-11)

What happens between a merge and each place NicotinD runs, read from `.github/workflows/*` on
master at `3d8adc23` (2026-11-16) and checked against run history. Written for #1671. The second
half proposes a beta channel; **nothing in this document changes pipeline behaviour**.

The reasons behind individual steps stay in the docs that own them:
[releasing.md](releasing.md), [deployment.md](deployment.md), [fdroid.md](fdroid.md),
[mobile-app.md](mobile-app.md), [ios-app.md](ios-app.md), [desktop-app.md](desktop-app.md). This
page is the map; where it and one of those disagree, the workflow file decides and the doc is the
bug.

## End to end

```
PR ──▶ ci.yml (pull_request)          gate jobs only; nothing is published
        │  squash-merge, title checked by pr-title.yml
        ▼
master commit ──▶ ci.yml (push)
        │   ci · web-test · storybook · analysis · e2e-shard → e2e · desktop-package
        │   desktop-smoke · docker
        ▼   (all gate jobs green)
   edge-image ──▶ edge ──▶ ghcr.io/kevinch3/nicotind:edge  (+ analysis :edge)
                    └────▶ deploy-host.yml (version=edge, expect_commit=<sha>)  ──▶ kpc
                                                                                 CLOCK 1: per commit

release.yml  (daily 13:17 UTC, or by hand)
        │   master tip has a bumping commit AND a successful edge run (or force)
        ▼
   chore(release): X.Y.Z + tag vX.Y.Z  (atomic push, RELEASE_TOKEN)
        ▼
deploy.yml  (push of tag v*)                                                     CLOCK 2: per release
        ├─ create-draft ─┬─ release-notes
        │                ├─ android         phone + TV APK, signed (release-signing)
        │                ├─ ios             unsigned IPA, macos-26
        │                ├─ desktop-linux   AppImage + deb
        │                ├─ desktop-mac     macos-15
        │                └─ server-tarball  x64 + arm64
        │                        ▼
        │                 publish-release   draft → published, only with every artifact attached
        └─ docker (amd64, arm64) ─ docker-merge ─┐
           docker-analysis ──────────────────────┴─ promote   :vX.Y.Z → :vX and :release
        ▼
pages.yml  (workflow_run: "Build & Deploy" completed)
        └─ publish   our F-Droid repo + site on GitHub Pages, from the newest published release
```

Releases never deploy the host. The host runs `edge`, so it is always at or ahead of the newest
release.

## Workflows

| Workflow | Trigger | Jobs | Environment | Secrets it reads | Concurrency group |
| --- | --- | --- | --- | --- | --- |
| `ci.yml` "CI & Edge" | push and PR to `master` | `ci`, `web-test`, `storybook`, `analysis`, `e2e-shard`, `e2e`, `desktop-package`, `desktop-smoke`, `docker`, `edge-image`, `edge` | none | `GITHUB_TOKEN` | one per master commit |
| `deploy-host.yml` "Deploy host" | `workflow_dispatch` (from `edge`, or by hand) | `hold`, `deploy` | `production` | `DEPLOY_HOST`, `DEPLOY_USER`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` | `host-deploy` |
| `release.yml` "Release" | cron `17 13 * * *`, or by hand with `force` | `release` | `release` | `RELEASE_TOKEN` | `ci-release-master` |
| `deploy.yml` "Build & Deploy" | push of a tag `v*` | `create-draft`, `release-notes`, `android`, `ios`, `desktop-linux`, `desktop-mac`, `server-tarball`, `publish-release`, `docker`, `docker-merge`, `docker-analysis`, `promote` | `release-signing` (the `android` job) | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | `deploy-host` |
| `pages.yml` "Pages" | `workflow_run` of "Build & Deploy", or by hand | `publish`, `notify` | `github-pages` | `FDROID_REPO_KEYSTORE_BASE64`, `FDROID_REPO_KEYSTORE_PASSWORD`, `FDROID_REPO_KEY_ALIAS` | `pages` |
| `pr-title.yml` | PR opened, edited, reopened, synchronized | `pr-title` | none | none | per PR |
| `renovate.yml` | cron `0 5 * * *`, or by hand | `renovate` | `renovate` | `RENOVATE_TOKEN` | `renovate` |
| `ghcr-retention.yml` | cron `43 5 * * 1`, or by hand | `prune` | none | none | `ghcr-retention` |
| `ios-simulator.yml` | by hand | `ios-simulator` | none | none | per ref |

Five environments exist on the repository: `production`, `release`, `release-signing`, `renovate`,
`github-pages`. The jobs are bound to them, but the secrets themselves are still repository-level
(#1459), so the binding does not yet restrict which ref can read them.

## Gates and human steps

| Gate | Where | What it stops |
| --- | --- | --- |
| Every gate job | `edge-image` `needs` `ci`, `web-test`, `storybook`, `e2e`, `e2e-shard`, `analysis`, `docker`, `desktop-package` | an image built from a commit that failed a check (`check:ci-parity` keeps the list honest) |
| PR title | `pr-title.yml` | a squash subject with no type, which freezes releases (#1263) |
| `chore(release):` skip | every `ci.yml` job's `if` | CI and a second edge deploy on the bump commit |
| Edge success | `release.yml` | releasing a master tip whose edge run did not pass, unless a person ticks `force` |
| Draft until complete | `publish-release` | a public release missing an artifact (`check:desktop-publish`) |
| Commit on `/api/health` | `deploy-host.yml` with `expect_commit` | calling a deploy done when the host runs something else |
| `DEPLOY_HOLD` | repository variable, `deploy-host.yml` `hold` | automatic deploys while the host is pinned after a rollback |

Human steps, none of them in a workflow:

- Merge requests to `fdroiddata` (the F-Droid main repo), and anything its maintainers ask for.
- Setting or clearing `DEPLOY_HOLD`; a manual `Deploy host` run for a rollback.
- `force` on `release.yml`.
- Every secret and signing key, and their backups.
- Privileged commands on the host.

## Where a version number is born, and who reads it

`release.yml` runs `bun run release`: it bumps `package.json`, writes `CHANGELOG.md`, and writes the
**literal** Android `versionCode` and `versionName` into `build.gradle`, then commits and tags.

| Reader | What it reads | Notes |
| --- | --- | --- |
| Server image | the tag, as `:vX.Y.Z`; `promote` then moves `:vX` and `:release` | `:edge` is separate and moves per commit |
| Android | `versionCode = major × 1,000,000 + minor × 1,000 + patch` (`packages/mobile/src/version.ts`) | `parseVersion` reads only the leading `X.Y.Z` |
| F-Droid main | tags matching `^v[0-9.]+$`, and the literals in `build.gradle` | `UpdateCheckMode: Tags`, `AutoUpdateMode: Version` (`docs/fdroid.md`) |
| Our F-Droid repo | the newest non-draft release (`gh release list --exclude-drafts --limit 1`) | single version, rebuilt each time |
| In-app APK updater | `api.github.com/…/releases/latest` (`lib/apk-update.ts`) | hides itself on a store-managed install |
| Desktop | `electron-updater`, provider `github` (`electron-builder.yml`) | reads the latest release's updater metadata |
| Host | `/api/health` reports version and commit | checked by `deploy-host.yml` |

## How each audience gets an update

| Audience | Channel | Mechanism | Delay after a merge |
| --- | --- | --- | --- |
| Production host | `edge` | `Deploy host`, dispatched by `edge` | one CI run |
| Self-hosters | `:release`, `:vX`, `:vX.Y.Z`; opt-in `:edge` | `docker compose pull` | up to a day, then when they pull |
| Android, sideloaded | latest release | in-app APK updater | up to a day |
| F-Droid, our repo | latest release only | `pages.yml` | the release, plus Pages (minutes) |
| F-Droid, main repo | every tag | fdroidserver's own checker and build farm | theirs to decide; **not verified here** |
| Desktop | latest release | `electron-updater` | up to a day |
| iOS | latest release | unsigned `.ipa`, installed by hand (AltStore, Sideloadly) | manual |

## Measured (run history, 2026-11-16)

| Workflow | Runs | Outcomes | Median, successful | Longest |
| --- | --- | --- | --- | --- |
| `deploy.yml` | last 30 (2026-09-28 to 11-15) | 27 success, 1 failure, 1 cancelled, 1 startup failure | 5.4 min | 8.7 min |
| `release.yml` | last 30 (10-23 to 11-15) | 30 success | 0.5 min | 18.6 min |
| `pages.yml` | last 30 (11-08 to 11-15) | 27 success, 1 failure, 2 cancelled | 2.4 min | 26.0 min |
| `deploy-host.yml` | last 28 (11-15 to 11-16) | 27 success, 1 failure | 2.2 min | 10.2 min |

One `deploy.yml` run, job by job (run `43752033945`): `desktop-linux` 3.7 min, `ios` 3.2,
`docker` arm64 3.0, `docker` amd64 2.7, `docker-analysis` 2.7, `desktop-mac` 2.3, `android` 2.2,
`server-tarball` 0.9 and 0.8, everything else under a minute. No job dominates; the release takes
as long as its slowest parallel job plus `publish-release`. The two macOS jobs are the expensive
ones by runner price, not by time.

`release.yml`'s 0.5 min median is the no-op day: most scheduled runs find nothing to release.

## Findings

Ordered by what they would cost a beta channel first.

1. **A pre-release tag would be treated as a stable release in four places.** The first two are
   now closed off (#1671); the other two stand.
   - `deploy.yml` has no notion of a pre-release. `promote` would move `:release` and `:vX` to a
     beta image, and `publish-release` would publish it as the newest release. **Guarded:** its
     trigger excludes `v*-*`, so a pre-release tag does not run the pipeline at all. A beta
     channel has to replace that line with real pre-release handling.
   - `pages.yml` took the newest non-draft release, and `gh release list` includes pre-releases,
     so our F-Droid repo would have served the beta as the only version. **Guarded:** it now
     passes `--exclude-pre-releases`.
   - `check:fdroid` fails if either guard is removed.
   - `parseVersion` reads only `X.Y.Z`, so `0.9.0-beta.1` and `0.9.0` get the **same**
     `versionCode`. Android will not install the stable over the beta as an update.
   - `electron-updater` with provider `github` skips pre-releases by default. That is library
     behaviour, **not verified against this app**; `electron/updater.ts` sets neither
     `allowPrerelease` nor a channel.
2. **Two things already ignore a pre-release, by accident of how they were written.** The in-app
   APK updater reads `/releases/latest`, which GitHub defines as the newest release that is not a
   draft or a pre-release. The F-Droid main recipe's `^v[0-9.]+$` does not match `v0.9.0-beta.1`.
   Both are properties to keep, and both are pinned: `update.service.spec.ts` asserts the
   `/releases/latest` URL, and `check:fdroid` asserts the recipe's tag pattern.
3. **The concurrency group names are crossed.** `deploy.yml` (which builds a release and never
   deploys the host) is in group `deploy-host`; `deploy-host.yml` is in `host-deploy`. They do not
   collide, but the name says the opposite of what the workflow does.
4. **A release is all or nothing.** Every tag rebuilds every app, by design
   (releasing.md "Why every release builds every app"). There is no way to ship a fix to one
   platform, and a failure in one build job holds the whole release as a draft.
5. **Rollback exists only for the server** (deployment.md "Rollback"). Our F-Droid repo holds one
   version; a sideloaded APK cannot be downgraded; nothing pulls back a desktop build.
6. **No stated compatibility contract between app and server.** The host runs ahead of every
   release; a self-hoster on `:release` can be behind an app, and nothing checks.
7. **Secrets are repository-level** (#1459): any workflow on any branch can read the deploy and
   signing secrets today.
8. **Unverified from here:** the `fdroiddata` side (their checker cadence, their build results),
   Apple signing (no account exists), and whether `electron-updater` on this app honours a
   `channel` setting.

## Beta channel: proposal

Not built. It needs the answers below first.

**What a beta is.** A tag `vX.Y.Z-beta.N`, published as a GitHub **pre-release**. One pipeline,
with the tag pattern deciding what each job does. Not a branch: a branch would need its own gates.

| Platform | Beta artifact | How someone opts in | What must change |
| --- | --- | --- | --- |
| Server | `:beta` image tag | `NICOTIND_VERSION=beta` | `promote` moves `:beta` for a pre-release tag and leaves `:release` and `:vX` alone |
| Android, sideloaded | APK on the pre-release | "Receive beta builds" in Settings | the updater reads the release list when the setting is on, `/releases/latest` otherwise |
| F-Droid, our repo | a second repo at `/fdroid/beta/repo` | add that repo URL | `pages.yml` builds two repos: stable from the newest full release, beta from the newest of either |
| F-Droid, main | none | n/a | nothing: `^v[0-9.]+$` already skips beta tags; add a test that pins it |
| Desktop | pre-release assets | a setting that turns on `allowPrerelease` | verify the library's behaviour first |
| iOS | TestFlight | TestFlight invite | an Apple Developer account, signing secrets, a signed build job |

**Version numbers.** `versionCode` gains two digits for the pre-release ordinal:
`major × 100,000,000 + minor × 100,000 + patch × 100 + n`, with `n = 99` for a stable release and
`1…98` for `beta.N`. So `0.9.0-beta.3` sorts below `0.9.0`, and both sort above `0.8.x`. This is a
one-way change to every `versionCode`: the new numbers are all larger than today's, so existing
installs still upgrade, but it cannot be undone. The F-Droid main recipe reads the literal in
`build.gradle`, so the change needs a note to its maintainers.

**Same application id.** A beta upgrades in place and returns to stable at the next full release.
A `.beta` suffix would let both live side by side, at the cost of a second F-Droid listing and a
separate data directory.

**Promotion.** Today a stable release rebuilds everything. Promoting the tested beta artifact
instead is possible for the server image (re-tag by digest, which `promote` already does) and not
for the Android APK, whose `versionCode` and `versionName` are compiled in. So: promote the image,
rebuild the apps. What was tested and what ships then differ only by the version literals.

**Cadence.** Betas by hand (`release.yml` with a `prerelease` input), stable on the existing daily
clock. A beta does not need a new clock.

**Gates.** `check:desktop-publish` and `check:ci-parity` are unaffected. `check:pr-title` is
unaffected. A new check should pin the two accidental properties from finding 2.

**Cost.** One extra `deploy.yml` run per beta: about 5 minutes of wall time, two macOS jobs.

### Closed questions (each with the default I would take)

1. Is a beta the same app id that upgrades in place, or a side-by-side `.beta` app?
   Default: same id.
2. Who cuts a beta: a person, or a schedule? Default: a person.
3. Should the F-Droid main repo ever see betas? Default: no.
4. Is TestFlight the iOS beta path, and will you open an Apple Developer account (99 USD a year)?
   Default: not yet; iOS stays on the unsigned IPA.
5. Is a `:beta` image wanted for self-hosters, or is `:edge` enough? Default: `:edge` is enough,
   so the server needs no beta at all.
6. May a stable fix ship to one platform without rebuilding the others? Default: no; keep one
   release, one set of artifacts.
7. Accept the one-way `versionCode` change? There is no default: without it Android has no beta.

### Order of work, once answered

1. Pin what already works: tests for the updater's `/releases/latest` and the recipe's tag pattern.
2. Make `deploy.yml` and `pages.yml` pre-release aware, with the stable path unchanged.
3. The `versionCode` scheme, with a note to `fdroiddata`.
4. The updater setting and the second F-Droid repo.
5. Desktop, after verifying the library.
6. iOS, only with an account.
