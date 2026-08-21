# Quality gates — the `check:*` scripts, and the rule they all share

`bun run verify` runs every gate the CI gate jobs run. Most of them are small
`scripts/check-*.ts` files. This page is about the discipline they share; the
per-gate detail is below, and the route-auth gate additionally has a section in
[api-routes.md](api-routes.md#why-that-gate-parses-instead-of-greps).

## The rule: a gate must assert its own denominator

Every gate in this repo answers a question of the form *"is anything in set S
wrong?"* The dangerous half is never the check — it is **S**. A gate that
computes a smaller S than it should still answers truthfully about what it
looked at, prints a confident summary, and exits 0.

That is not hypothetical here. As of August 2026, **four** gates were measured
reporting a false denominator:

| Gate | Claimed | Actually examined |
|---|---|---|
| `check:route-auth` | "24 /api groups", exit 0 | **24 of 35** mounts — its regex needed `app.route('` on one line, and Prettier wraps 11 of them |
| `check:claude-md` | "all present", 0 drift | 15 symbols "proven" to exist **by the prose asserting them** |
| `bun run lint` | lints the repo | **482 of 586** non-web files — unquoted `**`, expanded by Bun's script shell as a single level (fixed; see below) |
| `check:ci-parity` | verify ⊇ CI | `isCovered` is a *substring* match, so a CI command **shorter** than its `verify` counterpart passes while the two have drifted |

Same shape as #457 (a `skipped` job read as tolerable), #606 (a hardcoded image
list), and #273/#376 (a CI-only typecheck surface). Each of those produced a new
narrow gate rather than a fix for the class.

So, when writing or changing a `check:*` script:

1. **Derive the denominator independently of the check.** `check:route-auth`
   counts `.route(` occurrences in the raw text and fails if its parsed count
   disagrees. The parser cannot quietly skip something.
2. **Print what you examined, not just what you found.** "35 /api groups (35
   mount calls)" is auditable; "no problems found" is not.
3. **Fail on what you cannot classify** — a computed route path, a mount on an
   unrecognised router. Skipping the hard cases is how S shrinks.
4. **Prefer a real parser to a pattern** when the input is code. Formatting is
   not supposed to change semantics; with a regex it does.
5. **Make allowlists self-invalidating.** See below.

## `check:claude-md` — existence must be proven by code, not prose

`CLAUDE.md` loads into every request and is read as ground truth, so a symbol it
names that does not exist "sends work down a path that was never there"
(issue #255). The gate greps the repo for each backticked camelCase/PascalCase
identifier.

It excluded `CLAUDE.md` itself from that grep — but not `docs/`. So a symbol
could be "proven" to exist by the very documentation page that made the claim.
Measured: **15 of 445** identifiers existed nowhere in code.

Almost all were fallout from the phase-4 addon split, where the slskd hunt
engine moved to its own repo and the index kept describing it in the present
tense. The corpus now excludes all `*.md`, and — a bug found while fixing this —
`scripts/check-claude-md.ts` itself, because `EXTERNAL_SYMBOLS` holds those names
as string literals and would otherwise be its own proof.

Three outcomes, deliberately distinguished:

- **`ALLOWLIST`** — not a repo symbol at all. Includes two *deliberate* mentions
  whose point is the absence: CLAUDE.md says "there is no monolithic
  `ApiService`" and "its former `SpotdlPlugin` was removed". Flagging those would
  be the gate misreading English.
- **`EXTERNAL_SYMBOLS`** — real, verified, but in another repo. Each entry
  records the file and line it was confirmed at in
  `kevinch3/nicotind-slskd-addon`. CLAUDE.md must also *say* the addon owns it,
  so the map and the prose can't disagree.
- **missing** — genuine drift; fix the name.

`EXTERNAL_SYMBOLS` is checked **in both directions**, which is what keeps it from
becoming the mute button a one-way allowlist always becomes: an entry that starts
existing locally fails, and so does one CLAUDE.md no longer names.

### Two known blind spots

- **SCREAMING_CASE is skipped by design** (`NICOTIND_*` env vars dominate and
  live in `.env.example`/compose rather than as symbols). `BLOAT_RATIO` is stale
  and invisible because of it. Accepted: a gate that cries wolf gets muted.
- **A symbol surviving only in a test or a Storybook string still counts as
  present.** `compareCandidates` exists only in `album-hunt-modal.stories.ts`,
  and `CastController` passed for months on one Storybook `description:` string.

## `bun run lint` — the shell was doing the globbing

The script was:

```
eslint --no-warn-ignored packages/*/src/**/*.ts src/**/*.ts packages/web/.storybook/*.ts
```

Unquoted, so **the shell expanded those globs, not eslint** — and `bun run`
executes package.json scripts through **Bun's own shell**, whose `**` is not a
recursive globstar. It matches exactly one directory level, like `*`. Measured
directly: `packages/*/src/**/*.ts` expands to 491 arguments, **all at depth 2** —
zero at depth 1, zero at depth 3 or deeper.

> Worth pinning down, because the obvious guess is wrong twice over. `Bun.$`
> (the embedded API) *does* implement a recursive `**`, expanding the same
> pattern to 1075 paths — so probing the glob that way suggests nothing is
> broken. And bash would also collapse `**` to one level, but only with
> `globstar` off, which is a different mechanism that never applies here since
> `bun run` does not use bash. The only faithful probe is a package.json script.

| Depth below `src/` | Files | Was linted |
|---|---|---|
| 1 — directly in `packages/*/src/` or `src/` | 50 | **no** |
| 2 | 482 | yes |
| 3–5 | 54 | **no** |

**104 of 586 files, and not a random 104.** Depth 1 is `packages/api/src/index.ts`,
`db.ts` and `src/main.ts` — the #1 and #3 most-churned files in the repo. Depth 3+
is all of `services/addons/` and `services/plugins/`, which is where the addon
protocol client and the credential-holding plugins live.

Quoting the globs hands the expansion to eslint, whose `**` is a real globstar
matching zero or more directories, and the count goes 482 → 586. It surfaced 8
errors and 1 stale `eslint-disable`, all of them dead code rather than live bugs:
leftovers from the #250 artist-image extraction, an unused type import, and
`BuiltinPluginDeps.providerRegistry` — dead since the phase-4 cutover, yet still
passed by every caller (the unit test handed it `{}`).

The third argument, `packages/web/.storybook/*.ts`, matched **0 files**: the flat
config ignores `packages/web/` wholesale, and `--no-warn-ignored` made that
silent. It was removed rather than left to imply coverage that doesn't exist.
Prettier does still format those files — its ignore list is separate.

**`packages/web` (82k LOC, 497 files) remains entirely unlinted.** That is a
deliberate follow-up, not an oversight: it needs `@angular-eslint`, and a
`@typescript-eslint/utils` root devDependency because `bunfig.toml` sets
`peer = false` under an isolated linker. Tracked in #612.

## Hardware cast: the drift this uncovered

`CLAUDE.md` described Chromecast/DLNA casting in the present tense as shipped —
a `CastController`, `/api/cast/*`, a `cast_tokens` table, four npm dependencies.
**None of it was ever built.** The gate passed because `CastController` appeared
in `docs/cast-integration.md` and in one Storybook component description.

`docs/cast-integration.md` is now labelled a proposal; the design is kept because
the alternatives it weighs are still the right starting point. Browser-tab
[remote playback](remote-playback.md) is the shipped way to control another
device.
