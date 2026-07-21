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

## Automating updates — feasibility

**Verdict: feasible and recommended. Renovate is the right tool for this repo; no
automation is configured today.**

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
1. Land a green manual baseline (this sweep).
2. Add `renovate.json` (grouping + major-isolation + weekly schedule, **automerge off**).
3. Let it run 1–2 weeks to build trust in the PR cadence.
4. Enable automerge for patch/minor devDeps once the cadence looks safe.
5. Revisit the held majors when their upstream blockers clear (table above).
