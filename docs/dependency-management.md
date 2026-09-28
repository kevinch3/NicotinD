# Dependency management

How dependencies are kept current in this Bun workspace monorepo, which major jumps are
**deliberately held** (and why), and the feasibility of automating updates going forward.

Updates are driven by editing the semver ranges in each package's `package.json` and
re-resolving `bun.lock` (`bun install`). The safety net is CI: `typecheck`, `lint`, the
Bun unit suites, the web `vitest` suite + `ng build`, `e2e`, `docker`, and the
best-effort `desktop-smoke` job. A dependency change is "done" only when CI is green.

## Checking what's behind

```bash
bun outdated --filter '*'   # every workspace, not just the root
```

The `Update` column = latest **within** the current range (safe patch/minor). `Latest` =
absolute latest; when `Latest > Update` it's a major/out-of-range jump that needs review.

## Worktrees install their own node_modules

`scripts/link-worktree.sh` runs `bun install --frozen-lockfile` in the worktree (#1314). It
used to **symlink** the main checkout's tree instead, which made every worktree compile against
whatever the main checkout last installed: a stale version beside the locked one (#1088) or a
package `bun install` never pruned (#1266) failed typecheck wholesale in a way that looked like
the branch's fault, and needed a 233-line drift check to refuse up front. An install from the
worktree's own `bun.lock` has no second tree to drift from, so the check was deleted with it.

Measured 2026-09-23 on a fresh worktree of `437dcae9`, warm bun cache:

| | |
|---|---|
| wall time | **1.8 s** (2,960 packages) |
| new bytes | **~80 MB** — `ffmpeg-static`'s postinstall copies its binary out of its own download cache; everything else (805 MB) is hardlinked from `~/.bun/install/cache` |
| Electron / Playwright | not re-downloaded: Electron's postinstall is untrusted (no `dist/` in any tree), and Playwright browsers live in `~/.cache/ms-playwright` |

`bun run typecheck` and `bun run test` (5,721 pass) ran green on that tree with no other setup.
The script still accepts an old symlinked tree and deletes its links first, because an install
on top of them would write through into the main checkout's store.

## One Bun everywhere (#1409)

CI, the desktop package and the prod image run the **same** Bun: every workflow's `BUN_VERSION` must
equal the `oven/bun` / `imbios/bun-node` version in the `Dockerfile`, enforced by
`scripts/bun-version-parity.test.ts`. The workflows had pinned **1.3.11** while the image shipped
**1.3.14**, and 1.3.11 segfaults inside its own Worker startup (`web_worker.start`). Once key/tempo
analysis spawned a worker per call (#1395), e2e shards lost their server mid-run (6 CI crashes in 3
days, one blocking a release). The desktop app ships the packaging job's own `bun`
(`prepare-resources.ts`), so its users ran 1.3.11 too. Reproduced locally with the real analysis
worker (1,500 spawn→analyse→terminate cycles, 6 concurrent): **1.3.11 crashed 3 of 6 runs, 1.3.14
0 of 12, 1.4.2 0 of 4.** Bump the image, the workflows and the F-Droid recipes' `bun` download + sha256 together: the parity test and `check:fdroid` fail on any one alone.

## Security floors (`overrides`)

Three entries in the root `overrides` block are **security floors**, not pins — a minimum
version required by an advisory, left as a caret so Renovate can still move them forward:

| Override | Why | Reached through |
| --- | --- | --- |
| `js-yaml` `^5` | Quadratic CPU in merge-key chains and `!!omap` resolution (2 high). Every consumer asks for `^4.1.0`, so `^5` forces them across a major: v5's `load` drops `<<` merges and YAML 1.1 tags by default and throws on empty or comment-only input. None of their real inputs use those (`latest.yml`, `app-update.yml`, `electron-builder.yml`, the bundled NSIS/snap templates parse identically), and a v4 updater reads a v5-dumped `latest.yml` unchanged. Re-check that before letting it move again. | `@nicotind/desktop > electron-updater`, `electron-builder` (`app-builder-lib`, `builder-util`, `dmg-builder`), `cosmiconfig` (commitlint, postcss-loader, Storybook) |
| `yaml` `^2.9.0` | Stack overflow on deeply nested collections. Bumping `@hono/zod-openapi` was not enough: it asks for `openapi3-ts ^4.5.0` and bun kept the hoisted `4.5.0`, whose yaml range is `^2.8.0`. | `@nicotind/api > @hono/zod-openapi > openapi3-ts` |
| `browserslist` `^4.28.7` | Unbounded memory growth and a prototype write via custom stats (2 high). Sentry v11's `@sentry/node` depends on `@sentry/bundler-plugins`, which brought `@babel/core` into the production closure, and bun reused the hoisted dev-only `4.28.1`. The override re-resolves it and its `baseline-browser-mapping` (fixed ≥ 2.11.0). | `@nicotind/api > @sentry/bun > @sentry/node > @sentry/bundler-plugins > @babel/core` |

Direct dependencies take the floor in their own range instead: `@nicotind/web` declares every
`@angular/*` package at `^22.1.6` (GHSA-p297-fm68-3q8c needs `@angular/common` ≥ 22.1.1,
GHSA-hh8m-fm6v-7cvg needs `core`/`compiler` ≥ 22.1.0; the rest move in lockstep, since the
framework packages are released and peered as one version).

The same Sentry v11 closure pulled the hoisted `brace-expansion@5.0.4` (via `glob > minimatch`)
into production; a lockfile bump to `5.0.12` fixed it with no override, because every `^5` consumer
accepts it and an override would also force the `1.x`/`2.x` copies other packages need.

(`@types/node` in the same block is an exact pin for a different reason — toolchain
consistency, not security. It tracks the `.nvmrc` Node version, so its major moves only with a
Node runtime upgrade.)

All were surfaced by `bun run check:audit`; see
[quality-gates.md](quality-gates.md) for why that gate exists rather than a plain
`bun audit`. **Do not reach for `bun update <transitive>`** to fix one of these: for a
package that is not a direct dependency it *adds* it as one. Doing that for `js-yaml` put it
in the root's **production** dependencies at `5.3.0`, which would have shipped a package
nothing imports into the runtime image.

## Deliberately held majors

These are **not** oversights — each is blocked by a hard constraint. Re-evaluate only when
the noted upstream condition changes.

| Held | Latest | Blocker | Re-check when |
| --- | --- | --- | --- |
| `typescript` 6 → 7 | 7.x | `@angular/compiler-cli` (Angular 22) peers `typescript@6.x`. TS 7 is the Go rewrite; adopting it breaks the web build. | Angular ships a release peering `typescript@>=7`. |
| AGP / Gradle 8 → 9 | 9.x | Capacitor 8 builds on AGP 8.13 / Gradle 8.14.3: its migration guide, `@capacitor/android` and every plugin's `build.gradle` pin AGP 8.13, and `capacitor-toolchain.test.ts` pins ours to the installed `@capacitor/android`. | A Capacitor major adopts AGP 9. |
| `java-jdk` 21 → 25 | 25 | fdroiddata builds every app on JDK 21, and the JDK that runs gradle decides `classes.dex`, so any other major fails F-Droid's reproducible-build check ([fdroid.md](fdroid.md)). Capacitor 8 requires 21; JDK 25 would also need Gradle ≥ 9.1. | fdroiddata's buildserver moves off 21. |
| `linuxserver/lidarr` 3 → "8" | — | Not a real major: the image still carries 0.8-era tags (`8.1.2135`) that sort above the current 3.x line. | Never — the hold is a versioning artefact. |

## Python sidecar (`packages/analysis/pyproject.toml`)

Runtime deps are **floor-pinned** (`fastapi>=0.110`, `uvicorn>=0.29`, dev `pytest>=8` /
`httpx>=0.27` / `ruff>=0.4`), so `pip install` already resolves the latest compatible —
there is nothing to "bump". The `essentia-tensorflow`, `numpy<2`, and `nvidia-*-cu11==`
pins are **deliberate ABI locks** (the CUDA-11 ABI TensorFlow 2.5 dlopens) — do not bump
them casually; they move only together with a tested Essentia/TF upgrade. `renovate.json` disables
them by **package name, for every manager** — Renovate reads this file with its `poetry` manager, so a
hold scoped to the pip managers never matched (it proposed `numpy<3` on its first run).

## Automating updates — configured

**Renovate is configured** in [`renovate.json`](../renovate.json) and **run** by
[`.github/workflows/renovate.yml`](../.github/workflows/renovate.yml), following the plan below.
It is at **step 3**: grouping, major-isolation, weekly PR schedule, **automerge off**. Steps 4–5
(build trust in the cadence, then enable automerge for patch/minor devDeps) are deliberate
follow-ups, not oversights.

> **The token.** The workflow reads a `RENOVATE_TOKEN` repository secret — a fine-grained PAT scoped
> to this repo with **Contents**, **Pull requests**, **Issues** (the Dependency Dashboard is an
> issue) and **Workflows** (it bumps `.github/workflows/*`) read & write, plus **Dependabot alerts**
> read. Without it the workflow *skips* with an explanatory job summary rather than failing. Added
> 2026-09-27; the first real run opened the Dependency Dashboard (#1419).

### What "configured but not running" cost (#848)

Step 3 sat undone long enough to matter, and the gap was invisible because the config *looked*
complete. `github-actions` is one of the managers `config:recommended` enables, so nothing was
bumping GitHub Actions at all: **14 of 17** pinned actions had drifted onto the retired Node 20
runtime across **67 call sites**, some four majors behind.

It surfaced as a deprecation warning in a deploy log — not as a failure. The lesson is in
[quality-gates.md](quality-gates.md): the fix was both *enabling* Renovate and adding
`check:action-runtimes`, because enabling an updater fixes drift while only a gate makes drift
**fail**. Config that nothing enforces is how this sat inert in the first place.

The evidence that it was inert, rather than merely quiet: zero Renovate PRs had ever been opened on
the repo, and no Dependency Dashboard issue existed — `:dependencyDashboard` creates one on the very
first run.

### Why Renovate over Dependabot
- First-class **Bun lockfile** support (Dependabot's Bun support lags).
- Monorepo-aware **grouping** across the `packages/*` workspaces.
- `customManagers` (regex) can also cover the non-npm version pins this repo carries that
  Dependabot can't reach: the **actionlint** binary version in `.github/workflows/ci.yml`
  (`version=1.7.12`), the Python `pyproject.toml` floors, and Dockerfile base images.

Dependabot remains the zero-infra fallback (native to GitHub) if third-party app access is
undesirable, at the cost of weaker grouping/auto-merge and no reach into the custom pins.

### Proposed `renovate.json` shape (to add when enabling)
- `extends: ["config:recommended", ":dependencyDashboard"]`
- **Grouped** PRs: all `@angular/*` together, all `@capacitor/*` together (plus `@capgo/capacitor-media-session`), `@sentry/*`,
  `@typescript-eslint/*`, `tailwindcss` + `@tailwindcss/postcss` — one PR each.
- `separateMajorMinor: true`; **major** updates land as their own non-automerge PR, so a
  repeat of the TS7 / Capacitor8 / Electron situations is always a reviewable PR.
- **Auto-merge patch + minor devDeps** after the required CI checks pass (the repo already
  runs typecheck/lint/test/e2e/web-build as required checks — a green PR is trustworthy).
- `schedule`: weekly (e.g. "before 6am on monday") to batch noise.
- `customManagers` for the actionlint pin and `pyproject.toml` floors.

### Release-loop interaction (important)
Merges to `master` trigger `ci.yml`'s `release` job. Renovate commits are `chore(deps): …`;
under Conventional Commits / `commit-and-tag-version`, `chore` does **not** bump the
version — so auto-merged dependency PRs won't spuriously cut a release (the job runs,
finds no version-bumping commit, no-ops).

### Enablement options
1. Install the **Renovate GitHub App** on `kevinch3/NicotinD` (least infra), or
2. **Self-host** via a scheduled `renovate.yml` GitHub Actions workflow using a PAT
   (mirrors the existing `RELEASE_TOKEN` secret pattern).

### Steps forward (ordered)
1. ~~Land a green manual baseline (this sweep).~~ Done.
2. ~~Add `renovate.json` (grouping + major-isolation + weekly schedule, **automerge off**).~~
   Done — plus `customManagers` for the three non-npm pins, and a `vulnerabilityAlerts` block
   that is deliberately **unscheduled**: an advisory against something that ships now fails
   `bun run check:audit`, so waiting for Monday would block `verify` in the meantime.
3. ~~Install the Renovate GitHub App (or a self-hosted workflow) — the config does nothing
   until something runs it.~~ Done — self-hosted via `.github/workflows/renovate.yml` (#848),
   chosen over the App so the schedule lives in the repo and no third-party app access is needed.
   Running since the `RENOVATE_TOKEN` secret was added on 2026-09-27.
4. Let it run 1–2 weeks to build trust in the PR cadence.
5. Enable automerge for patch/minor devDeps once the cadence looks safe.
6. Revisit the held majors when their upstream blockers clear (table above).

### Why the workflow runs daily when the PRs are weekly

`renovate.json`'s own `schedule` (`before 6am on monday`) is what batches routine PR noise; the cron
only decides how often Renovate gets to *look*. Weekly on both would mean one missed run costs a
week, and it would defeat the deliberately unscheduled `vulnerabilityAlerts` block
(`"schedule": ["at any time"]`, `"prCreation": "immediate"`) — an advisory against something that
ships now fails `bun run check:audit`, so waiting for Monday would block `verify` in the meantime.

### GitHub Actions are pinned by commit SHA

Every action **not published by GitHub itself** (`docker/*`, `softprops/action-gh-release`,
`tailscale/github-action`, `aquasecurity/trivy-action`, `android-actions/setup-android`,
`oven-sh/setup-bun`, `renovatebot/github-action`) is pinned as `owner/action@<40-hex sha> # vX`.
A tag is mutable: whoever controls the action's repository can move `v4` to any commit, and the
next run executes it with this repo's token and, in `deploy.yml`, the deploy host's Tailscale and
SSH access. That is how `tj-actions/changed-files` was used against thousands of repositories.
A SHA cannot be moved.

The first pins were checked before they were written: each SHA is the commit its tag resolved to
**and** an ancestor of the action's own default branch — a hijacked tag points at a commit outside
it, and pinning that would freeze the compromise in place.

Renovate keeps them current: `helpers:pinGitHubActionDigests` (in `renovate.json`) proposes digest
bumps with the `# vX` comment updated alongside, and will also propose pinning the `actions/*` ones.
`check:action-runtimes` reads the comment to classify a SHA pin, and `check:fdroid` reads the JDK
through one (`scripts/fdroid-jdk.ts`), so either PR stays green.

### Secrets live in environments

A **repository** secret is handed to any workflow on any branch: a branch that adds a
`push`-triggered workflow can print it, and this repo has hundreds of branches, many pushed by
automated sessions. An **environment** secret is only handed to a job that names the environment,
and only on the refs that environment's deployment rule allows.

| Environment | Secrets | Deployable from | Job |
| --- | --- | --- | --- |
| `production` | `DEPLOY_HOST`, `DEPLOY_USER`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` | tags `v*`, branch `master` | `deploy.yml` › `deploy` |
| `release-signing` | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | tags `v*` | `deploy.yml` › `android` |
| `release` | `RELEASE_TOKEN` | branch `master` | `ci.yml` › `release` |
| `github-pages` | `FDROID_REPO_KEYSTORE_BASE64`, `FDROID_REPO_KEYSTORE_PASSWORD`, `FDROID_REPO_KEY_ALIAS` | branch `master` | `pages.yml` › `publish` |
| `renovate` | `RENOVATE_TOKEN` | branch `master` | `renovate.yml` › `renovate` |

The workflows bind each job to its environment, and
`scripts/workflow-secret-environments.test.ts` fails a job that reads one of these secrets without
it. The **rules and the secrets themselves live in repository settings**, which no test can read, so
this is the checklist (Settings → Environments):

1. Open each environment (GitHub created them on first use) and set *Deployment branches and tags*
   to *Selected* with the refs in the table.
2. Add each secret to its environment, run one release to confirm it deploys, then **delete the
   repository-level copy** — until then the old copy is still readable from any branch.
3. No required reviewers: this is a single-maintainer repo and the gate is the ref rule, not a
   person.

Replacing the `RELEASE_TOKEN` personal access token with a GitHub App installation token (scoped to
`contents: write` on this repository, and added as the `Protect master` ruleset's bypass actor) is
the remaining step: a PAT carries its owner's access to every repository they can push to.

### What the custom managers cover

Two version pins live outside any package manifest, so nothing else would ever bump them.
Each is annotated with a `# renovate:` comment next to the pin:

| Pin | File | Why it matters |
| --- | --- | --- |
| `actionlint` | `.github/workflows/ci.yml` | A stale workflow linter is a gate quietly running an old ruleset |
| `gitleaks` | `.github/workflows/ci.yml` | Same, for the secret scanner — an old ruleset misses newer credential formats |

The Docker base images (`oven/bun`, `imbios/bun-node`, `python:3.11-slim`)
are covered by Renovate's native `dockerfile` manager, no annotation needed.
