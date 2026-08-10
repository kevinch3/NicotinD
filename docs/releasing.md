# Releases — how they work and how to run one

One release = one `vX.Y.Z` git tag. Everything ships from that tag: the
production server deploy **and** the app artifacts (Android APK, iOS IPA,
desktop packages) attached to its GitHub Release. You never build a release by
hand — you land commits and the pipeline does the rest.

## The day-to-day flow (this is the whole job)

1. **Land your work on `master` through a PR**, with
   [Conventional Commit](https://www.conventionalcommits.org/) messages
   (commitlint-enforced): `feat` → minor bump, `fix`/`perf` → patch,
   `!`/`BREAKING CHANGE:` → major. `chore`/`docs`/`refactor`/`test`/`ci` don't
   bump and won't appear in the changelog. Full table in
   [CLAUDE.md](../CLAUDE.md#commit-conventions).
2. **Do nothing else.** When `ci.yml` goes green on the master push, its
   `release` job bumps the version from the commit history, regenerates
   `CHANGELOG.md`, commits `chore(release): X.Y.Z`, tags `vX.Y.Z`, and pushes
   the tag.
3. **The tag triggers `deploy.yml`**, which deploys the server and builds only
   the apps whose inputs actually changed since the previous release (a
   `changes` job diffs tag-to-tag) — an API-only release won't rebuild the APK
   or the desktop packages.
4. **Verify** (takes a minute):
   - Actions: `ci.yml` → release job pushed the tag; `deploy.yml` run for the
     tag is green.
   - The tag's **GitHub Release page** carries the expected artifacts.
   - The production server reports the new version (`GET /api/health` →
     `{ ok, version }`, Settings footer, or `GET /api/system/status`), and the
     in-app changelog modal (click the version string) shows the new entry.

If a merge contained only non-bumping types, no release is cut — that's by
design, not a failure. The release job is also **idempotent**: it skips itself
on `chore(release)` pushes and exits early if the computed tag already exists,
so re-runs are always safe.

## What each release ships, and how it reaches people

| Artifact                                  | Built when                | How it reaches users                                                                                                            |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Server image**                          | every tag                 | multi-arch image published to `ghcr.io/kevinch3/nicotind` (`vX.Y.Z` + `vX` + `release` tags); self-hosters `docker compose pull` |
| **Server (production host)**              | every tag                 | auto-deployed over Tailscale SSH: pulls the just-published image — nothing to do                                                 |
| **Android APK** (+ TV flavor)             | mobile/web inputs changed | download from the GitHub Release and sideload (see below); signed when `ANDROID_KEYSTORE_*` secrets are present                  |
| **iOS IPA** (unsigned)                    | mobile/web inputs changed | re-sign + install via AltStore/Sideloadly (see below)                                                                            |
| **Desktop** Linux AppImage/deb + macOS dmg | desktop inputs changed    | GitHub Release download; **existing installs auto-update** via electron-updater — Linux applies updates itself, macOS only notifies (ad-hoc signing) |

### Android app

- CI builds the signed APK on every tag push (uses `ANDROID_KEYSTORE_*` secrets
  when present, otherwise an unsigned APK), plus a second `NicotinD-TV-<v>.apk`
  flavor for Android TV.
- The APK is attached to the **GitHub Release** of the tag — download and
  install directly on Android (you may need to allow "Install from unknown
  sources"). The in-app "Check for updates" button self-updates from GitHub
  Releases afterwards.
- Local build:
  `cd packages/mobile && bunx cap sync android && cd android && ./gradlew assembleRelease`.
- Full detail: [mobile-app.md](mobile-app.md).

### iOS app

- CI builds an **unsigned** `.ipa` on a `macos-14` runner (`ios` job) on every
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
- **Re-deploy the server without a new version** (e.g. after a deploy-host
  hiccup): Actions → `deploy.yml` → _Run workflow_ — a manual dispatch checks
  out the tip of `master` on the host (compose files, scripts) but re-runs the
  current **`release` image** (no image is published from an untagged tip) and
  skips the app builds.
- **A deploy job failed but the tag exists**: fix the cause, then re-run the
  failed `deploy.yml` jobs from the Actions UI — don't re-tag.
- **Never hand-edit** `CHANGELOG.md` or the `package.json` version — both are
  generated; hand edits get overwritten by the next release and can break the
  version detection.

See [deployment.md](deployment.md) for the deploy pipeline's failure modes
(orphan-tag-proof tagging, the green-but-silent deploy shape of issue #457) and
the self-hoster's upgrade/rollback procedure.
