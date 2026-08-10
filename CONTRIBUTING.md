# Contributing to NicotinD

Thanks for your interest in improving NicotinD! This guide covers the local
development setup, the project's quality gates, and the conventions every
change must follow. The full development knowledge base lives in
[`docs/`](docs/) — start with the index in the [README](README.md#-documentation)
and [CLAUDE.md](CLAUDE.md) (the always-loaded index of design patterns).

## Local development (without Docker)

### Requirements

- [Bun](https://bun.sh/) >= 1.1
- Node >= 22.22.3 (for `ng build`)

### Setup

```bash
bun install

# Copy and edit config
cp .env.example .env
# Set SOULSEEK_USERNAME and SOULSEEK_PASSWORD (optional — acquisition is opt-in)

# Run (embedded mode — auto-downloads slskd binary on first run)
bun run src/main.ts
```

### Commands

```bash
bun run verify           # EVERY gate the CI `ci` job runs, in one command — run before pushing
bun run typecheck        # TypeScript (tsc --build + Angular templates + e2e + web specs)
bun run lint             # ESLint across all packages
bun run format           # Prettier — safe to run repo-wide
bun run test             # Vitest across packages/ + src/
bun run test:web         # Angular component tests
bun run e2e              # Playwright e2e suite — run before declaring a feature done
bun run dev              # Dev mode (concurrent services)
```

## Quality gates

Every change must satisfy three gates before it's considered done:

1. **Every change is tested.** New features get new tests, bug fixes get
   regression tests, refactors must not reduce coverage. If a change can't
   reasonably be unit-tested, add an integration or e2e test.
2. **Every test runs in CI.** `bun run verify` runs every gate the CI `ci` job
   runs — use it before pushing. `bun run e2e` is its own CI job; run it before
   declaring a feature done.
3. **Documentation is updated in the same change as the code.** Detail goes in
   the relevant `docs/<feature>.md` (or `docs/design-patterns.md`), plus a
   one-line index entry in `CLAUDE.md` pointing at it. Stale docs are treated
   as a bug — CI enforces this partially via `bun run check:claude-md`.

## TDD workflow

1. Write a failing test close to the behavior (`*.test.ts` for
   API/core/packages, `*.spec.ts` for web).
2. Run `bun run test:tdd` and keep the scope focused (`bun run test:api` or
   `bun run test:web` when useful).
3. Implement the smallest change to make the test pass.
4. Refactor with tests still green.
5. Before pushing, run `bun run verify` (and `bun run e2e` for feature work).

Conventions: keep unit tests deterministic (in-memory fakes for
network/process-heavy deps), add a regression test before fixing any reported
bug, and avoid testing build output.

## Commit conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org/),
enforced by a commitlint `commit-msg` hook:

```
<type>(<optional scope>): <description>
```

`feat` → minor bump, `fix`/`perf` → patch, `!` or `BREAKING CHANGE:` → major;
`chore`/`refactor`/`docs`/`test`/`ci`/`style`/`build` don't bump and stay out
of the changelog. The full table is in
[CLAUDE.md](CLAUDE.md#commit-conventions). Releases cut themselves from the
commit history — see [docs/releasing.md](docs/releasing.md); never hand-edit
`CHANGELOG.md` or the `package.json` version.

## Pull requests

- Branch from `master`; CI (`ci.yml`) must be green to merge.
- Use **`Closes #N` in the PR body** to close issues on merge — `(#N)` in a
  commit subject only links, it never closes. For partial work use `Refs #N`.
- Fill in the sections of `.github/PULL_REQUEST_TEMPLATE.md`.
- UI changes: check the e2e suite (`data-testid` selectors are the standard),
  and refresh the README screenshots when a change touches the
  Library/album/Now-Playing screens
  (`bun run --filter @nicotind/e2e screens:readme`).

## Code of conduct

By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

NicotinD is licensed under [AGPL-3.0-only](LICENSE). By contributing, you
agree that your contributions are licensed under the same terms.
