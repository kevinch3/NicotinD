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
| `bun run lint` | lints the repo | **480 of 586** non-web files — unquoted `**` under a shell with `globstar` off |
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

## Hardware cast: the drift this uncovered

`CLAUDE.md` described Chromecast/DLNA casting in the present tense as shipped —
a `CastController`, `/api/cast/*`, a `cast_tokens` table, four npm dependencies.
**None of it was ever built.** The gate passed because `CastController` appeared
in `docs/cast-integration.md` and in one Storybook component description.

`docs/cast-integration.md` is now labelled a proposal; the design is kept because
the alternatives it weighs are still the right starting point. Browser-tab
[remote playback](remote-playback.md) is the shipped way to control another
device.
