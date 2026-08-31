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

## Security floors (`overrides`)

Two entries in the root `overrides` block are **security floors**, not pins — a minimum
version required by an advisory, left as a caret so Renovate can still move them forward:

| Override | Why | Reached through |
| --- | --- | --- |
| `js-yaml` `^4.3.1` | Quadratic CPU in merge-key chains and `!!omap` resolution (2 high). `electron-updater` asks for `^4.1.0`, so it accepts the fix with no parent bump. | `@nicotind/desktop > electron-updater` |
| `yaml` `^2.9.0` | Stack overflow on deeply nested collections. Bumping `@hono/zod-openapi` was not enough: it asks for `openapi3-ts ^4.5.0` and bun kept the hoisted `4.5.0`, whose yaml range is `^2.8.0`. | `@nicotind/api > @hono/zod-openapi > openapi3-ts` |

(`@types/node` in the same block is an exact pin for a different reason — toolchain
consistency, not security.)

Both were surfaced by `bun run check:audit`; see
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
| `@capacitor/*` 6 → 8 | 8.x | `@jofr/capacitor-media-session` (Android lock-screen / background audio) latest (4.0.0) still peers `@capacitor/core@^6.0.0`; no release supports Cap 7/8. Bumping breaks background playback + needs a native android/ios project migration (gradle/pods/minSDK). | The media-session plugin (or a replacement) supports Capacitor 7/8. Treat as its own focused migration, not a routine bump. |

## Python sidecar (`packages/analysis/pyproject.toml`)

Runtime deps are **floor-pinned** (`fastapi>=0.110`, `uvicorn>=0.29`, dev `pytest>=8` /
`httpx>=0.27` / `ruff>=0.4`), so `pip install` already resolves the latest compatible —
there is nothing to "bump". The `essentia-tensorflow`, `numpy<2`, and `nvidia-*-cu11==`
pins are **deliberate ABI locks** (the CUDA-11 ABI TensorFlow 2.5 dlopens) — do not bump
them casually; they move only together with a tested Essentia/TF upgrade.

## Automating updates — configured

**Renovate is configured** in [`renovate.json`](../renovate.json) and **run** by
[`.github/workflows/renovate.yml`](../.github/workflows/renovate.yml), following the plan below.
It is at **step 3**: grouping, major-isolation, weekly PR schedule, **automerge off**. Steps 4–5
(build trust in the cadence, then enable automerge for patch/minor devDeps) are deliberate
follow-ups, not oversights.

> **One manual step remains.** The workflow needs a `RENOVATE_TOKEN` repository secret — a
> fine-grained PAT scoped to this repo with **Contents: read & write**, **Pull requests: read &
> write** and **Issues: read & write** (the Dependency Dashboard is an issue). Without it the
> workflow *skips* with an explanatory job summary rather than failing, so an unconfigured repo
> does not go red every morning — but Renovate is not running until the secret exists.

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
- **Grouped** PRs: all `@angular/*` together, all `@capacitor/*` together, `@sentry/*`,
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
   **Add the `RENOVATE_TOKEN` secret** to actually start it.
4. Let it run 1–2 weeks to build trust in the PR cadence.
5. Enable automerge for patch/minor devDeps once the cadence looks safe.
6. Revisit the held majors when their upstream blockers clear (table above).

### Why the workflow runs daily when the PRs are weekly

`renovate.json`'s own `schedule` (`before 6am on monday`) is what batches routine PR noise; the cron
only decides how often Renovate gets to *look*. Weekly on both would mean one missed run costs a
week, and it would defeat the deliberately unscheduled `vulnerabilityAlerts` block
(`"schedule": ["at any time"]`, `"prCreation": "immediate"`) — an advisory against something that
ships now fails `bun run check:audit`, so waiting for Monday would block `verify` in the meantime.

### What the custom managers cover

Three version pins live outside any package manifest, so nothing else would ever bump them.
Each is annotated with a `# renovate:` comment next to the pin:

| Pin | File | Why it matters |
| --- | --- | --- |
| `actionlint` | `.github/workflows/ci.yml` | A stale workflow linter is a gate quietly running an old ruleset |
| `gitleaks` | `.github/workflows/ci.yml` | Same, for the secret scanner — an old ruleset misses newer credential formats |
| `BGUTIL_VERSION` | `packages/pot-provider/Dockerfile` | Issue #551: the PO-token provider pin is the one that can actually break a download |

The Docker base images (`oven/bun`, `imbios/bun-node`, `python:3.11-slim`, `node:25-bookworm-slim`)
are covered by Renovate's native `dockerfile` manager, no annotation needed.
