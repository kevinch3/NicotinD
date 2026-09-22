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
| `check:claude-md` (again) | every *name* is real | said nothing about *size* — the file it calls "deliberately small" reached **186 KB / 2,038 lines** |
| `bun run lint` | lints the repo | **482 of 586** non-web files — unquoted `**`, expanded by Bun's script shell as a single level (fixed; see below) |
| `check:ci-parity` | verify ⊇ CI | `isCovered` matched substrings, so the **root** `test` script vouched for `--filter @nicotind/e2e test` — a different command that never ran locally (fixed; see below) |

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

## `check:claude-md` — the size budget

The symbol check above proved every *name* in CLAUDE.md was real while the file
quietly became the detail store `docs/` already was. Its own header called it
"an index, kept deliberately small because it loads into every request", and
nothing measured that clause — so it grew to **186 KB / 2,038 lines**, with a
median index entry of ~1,340 characters and the largest at 7,287.

That is this page's own rule turned on the file that states it: the gate
answered truthfully about the set it happened to measure (names) and was silent
about the one that actually broke (bytes).

### What the audit found before the restructure

Deletion was safe, and measurably so. Of the **1,350** backticked facts in the
index, **1,316 already appeared in `docs/`**; of 66 distinctive rationale
phrases sampled from the largest entries, **63** were in the doc that entry
already linked. Only three lived nowhere else, and they were moved before the
prose around them was cut. The index was not carrying knowledge — it was
carrying a second copy.

### The caps

| Cap | Value | Applies to | Set from |
|---|---|---|---|
| `MAX_ENTRY_CHARS` | 440 | entries in **either** file | measured max **prose** 371 after the restructure |
| `MAX_CLAUDE_MD_BYTES` | 20,000 | `CLAUDE.md` | the per-request cost. 12.4 KB after #934 relocated the index |
| `MAX_INDEX_SECTION_BYTES` | 24,000 | **each** `docs/index/<section>.md` | replaced a single 70,000 total in #1240 — see "A cap on a number that must grow" below |
| `MIN_PLAUSIBLE_ENTRIES` | 60 | the index, **summed** across sections | the gate's own denominator (208 parse today) |

`MIN_PLAUSIBLE_ENTRIES` is asserted against the index, not `CLAUDE.md`. Pointing
it at CLAUDE.md after the relocation would make it pass vacuously: that file now
parses a handful of Surfaces entries and is no longer an index. It is summed
rather than per-file because a small section legitimately holds 8 entries, and
the sum is what goes red if the section walk ever stops finding files.

The index's **total** is reported on every run and enforced nowhere. That is
deliberate (#1240) and it is the one number a reader should not be asked to pay:
what you actually pay is the section you open.

### When a cap is the thing that is wrong

On 2026-09-07 master went red on the headroom test, and the story is worth
keeping because neither half of it is the obvious one.

**It was not the budget that failed.** `docs/index.md` was 55,186 bytes against
a 60,000 cap — `check:claude-md` itself was green. What went red was the test
asserting the cap keeps **>5,000 bytes of headroom**, a check on the *threshold*
rather than on the file. That is the gate working as designed: it fires while
there is still room, so that the fix is a decision instead of an emergency.

**No single PR did it.** #1004 and #1005 each added an index entry, each trimmed
until it fit, and each went green on its own branch. A branch measures itself
against a master that does not yet contain the other branch's line, so a
per-branch budget gate is structurally blind to the sum; master is the first
place that sum exists. The 5,000-byte floor *is* the slack that absorbs this,
which is why spending it down is not a fix.

**Trimming further was the wrong answer, and that was already measured.** #1006
reopened master by squeezing the index to 95 bytes inside the floor — a flush cap
under a different name, one entry away from red. Meanwhile
[claude-md-compression-2026-09.md](measurements/claude-md-compression-2026-09.md)
had already put 55 agents over three passes on exactly this question: the best
**correct** compression was -0.9%, and the aggressive merging that reached -32%
invented 48 claims. At 178 entries averaging ~308 bytes against a 440-char entry
cap, the index is at its shape, not padded. Its size is the number of mechanisms
this repo has, and that number legitimately grows.

So the cap moved to 70,000 — ~15 KB, about 48 entries of runway — in a commit
that says why, which is exactly what the header of `check-claude-md.ts` asks for.
`MAX_CLAUDE_MD_BYTES` was left alone: that is the per-request cost, and it is
still the number to defend.

### A cap on a number that must grow (#1240)

That runway lasted **fourteen days**. Measured 2026-09-05 → 2026-09-22, the index
went 47,278 → 64,995 bytes and 155 → 205 entries: about **1,040 bytes and 3
entries per day**. The whole 10,000-byte raise was spent, and the headroom test
was one entry from red again — the third time the same argument had come round,
after #1006 and `fa06da6d`.

At that growth rate neither answer works. Raising the total again buys ~10 days.
Trimming buys less than one: the measured best **correct** compression, -0.9%, is
585 bytes — thirteen hours. The pattern is the tell. **A cap on the index's total
is a cap on how many mechanisms the repo may have**, and a docs gate should not
be the thing deciding that.

**What the budget was always really about is what a reader pays to locate ONE
mechanism**, and nothing forced that to be the whole file. So the index became
one file per section, the cap became per section, and the meaning of exceeding it
changed: **a section over budget has earned a split, not a trim and not a bigger
number.** Growth is absorbed by subdivision, which has no ceiling, and each split
halves the read cost again — the property a single total never had. Median read
went from 65 KB to ~7 KB.

It also defuses the 2026-09-07 merge break above: two PRs adding an entry each
now collide only if they land in the **same** section, near **that** section's
cap.

Two things the split had to keep. The **total is still reported** on every run,
because "nobody pays for it" is precisely how `CLAUDE.md` reached 186 KB — it is
simply no longer enforced. And because a section is now reachable only through
the contents table in `docs/index.md`, the gate checks that table against the
directory **both ways**: a file nothing links is a section no reader ever opens,
while every other arm of the gate still passes on it happily.

The two byte budgets are deliberately different sizes, and the split is the
point of the gate rather than an accident of it. `CLAUDE.md` is paid on every
request including the majority that never open the index, so it is the number to
defend; `docs/index.md` is read only when a mechanism needs locating. A test
asserts CLAUDE.md stays under **half** the index's size — if the two ever
converge, the index has drifted back into the file that costs on every task and
the relocation has quietly been undone.

Entry length is measured with **whitespace collapsed**, so re-wrapping a line
can never change the verdict — the budget is about how much a reader takes in,
not where the newlines fall.

It also **excludes the trailing `→ [doc](docs/doc.md)` handoffs** (`entryProse`).
A link costs ~55 characters, so charging them to the budget taxes an entry for
citing its sources, and one that legitimately spans two docs gets ~110 fewer
characters to say anything than one that spans one. This was not theoretical:
measured the other way, the single over-cap entry's binding pressure was to
**drop a correct second link** — the exact opposite of what the index is for.

Neither cap sits flush against the current file, and a test asserts that
(`> 5,000` bytes and `> 20` chars of headroom). A gate that fires on the next
honest addition gets raised reflexively, and a threshold nobody believes is a
threshold nobody enforces. Raising one is fine — it should just be a commit that
says why, which is exactly what the un-measured prose rule never forced.

### The relocation (#934)

Compression could not deliver, so the index moved instead. `CLAUDE.md` went
**59.5 KB → 12.4 KB** by relocating its ~155 entries to `docs/index.md`, which
is read on demand. Nothing was deleted and no entry was reworded; the two files
are checked as one corpus, because a symbol is a claim wherever it is written.

Two things the move broke that the gate caught, both the same bug in different
clothes — a `docs/`-prefixed pattern meeting links that no longer carry the
prefix. `brokenDocLinks` now resolves each link against its own file's
directory, and `entryProse` strips **any** `.md` link, not just a rooted one.
The second was live for about a minute and immediately charged a correct entry
515/440 characters for citing its own sources — the exact failure `entryProse`
was written to prevent.

### The floor, measured

A 2026-09 attempt to cut the file further found it is already at its compression floor: three passes
over the index produced a best correct result of -0.9%, and aggressive merging produced 48 invented
claims. → [measurements/claude-md-compression-2026-09.md](measurements/claude-md-compression-2026-09.md)

### The denominator, again

`MIN_PLAUSIBLE_ENTRIES` is the part that matters most. If the entry format
changes and `indexEntries()` silently parses nothing, every size check passes
vacuously and the gate reports green — the exact shape this page exists to
document. So the gate fails when it parses fewer entries than a real index could
have, and its message says to fix the parser, never the threshold. Verified red
against all three failure modes (an over-long entry, an over-budget file, and a
format change that blinds the parser), not just green on the current file.

## `bun run lint` covers `scripts/` too (#639)

The glob was `packages/*/src` + `src` only, so **the directory holding every quality gate was
itself unlinted** — `check-audit.ts`, `check-route-auth.ts`, `check-fetch-timeouts.ts` and the
rest. `tsc --build` and their own tests covered correctness, so this was style and dead-code
drift rather than a bug; it was a blind spot in exactly the directory whose job is to have
none, which is why it is written down here rather than quietly widened.

Widening it surfaced one finding: a stale `eslint-disable-next-line no-constant-condition` in
`download-deps.ts` that no longer suppressed anything. A disable comment for a rule that has
stopped firing is the lint equivalent of an allowlist entry nobody re-checks — the reason the
config reports unused directives as problems rather than ignoring them.

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

## `check:ci-parity` — matching by substring, excluding by job

Two defects, both of which made the gate report more coverage than it had.

### 1. The root `test` script vouched for another package's

`isCovered` pulled the script name out of a `bun run` command and asked
`chain.includes(name)` — a substring test over the whole `verify` chain. So
`bun run --filter @nicotind/e2e test` reduced to `test`, which appears in
`verify` because the **root** `test` script is there. Two entirely different
commands, one of which `verify` never runs, reported as covered.

The failure is one-directional, and the silent direction is the dangerous one: a
CI command that is a **prefix** of its `verify` counterpart passes green while
the two have drifted. `bun audit` in CI would have been "covered" by
`bun audit --audit-level=high` locally.

An invocation is now identified exactly, as `<workspace>:<script>` —
`:test` and `@nicotind/e2e:test` are different things — resolved transitively
through root scripts (`verify` → `typecheck` → `--filter @nicotind/web
typecheck:spec`). Anything that isn't a `bun run` call must match a `verify`
command exactly after whitespace normalisation.

**One proxy is kept on purpose.** `bun test <paths>` still matches loosely,
because CI enumerates the paths that the root `test` script covers with a glob;
comparing path sets would fail for reasons that are not bugs. That is a
deliberate, documented exception rather than an accident.

### 2. Whole jobs were excluded, and the note explained the wrong one

`GATE_JOBS` was `['ci', 'web-test', 'storybook']`, and the docstring said `e2e`,
`desktop-smoke`, `analysis` and `docker` were "deliberately absent".

`desktop-smoke` is **not in `release.needs`** and is `continue-on-error: true` —
it gates nothing, so excluding it is meaningless. The job actually missing was
**`desktop-package`**, which *does* gate the release and runs
`bun run --filter @nicotind/desktop prepare-resources`, a command `verify` never
runs. The reasoning named one half of a similarly-named pair and the hole was in
the other half.

`GATE_JOBS` is now every job in `release.needs`, checked **both ways**:

- `gateJobsNotBlockingRelease` — a gate job that stops blocking the release is
  advisory (the #457 shape).
- `releaseJobsNotGated` — a job that gates the release but isn't a gate job has
  nothing checking its commands.

Neither list can drift from the other. Exclusions moved from whole jobs to
**named commands** in `ALLOWLIST`, so the unit of the decision is the thing that
genuinely can't run locally, not the job that happens to contain it. Two entries
resulted: `prepare-resources` (minutes long, only meaningful on a packaging
runner) and `--filter @nicotind/e2e test` (quality gate 2 keeps `bun run e2e`
out of `verify` on purpose — it was previously covered *by accident*).

`analysis` and `docker` add nothing either way: neither runs a `bun` command.

### Three blind spots that remain

The gate reads `run:` steps in `ci.yml`. It cannot see:

- **`uses:` actions** — `gitleaks-action`, `trivy-action` and friends are
  invisible to it. Usually fine (they aren't `verify`-able locally), but it means
  the *form* a step is written in decides whether parity applies.
- **Local composite actions** — `./.github/actions/playwright-deps` runs inside
  the `storybook` gate job and shells out to a bun script the gate never parses.
- **Other workflow files** — the path is hardcoded to `ci.yml`, so a new
  `security.yml` escapes both halves entirely.

Not fixed here; recorded so the next person picks the invocation form knowingly.

## Artifact verification — CI now boots what it ships, and the deploy checks it landed

Two gaps, both of the "green means nothing happened" kind.

### CI never started the image

The `e2e` job runs `bun run src/main.ts` from the **working tree**. The `docker`
job built an image with `push: false` and no `load:`, so the result existed only
in the build cache and was thrown away. Nothing in CI had ever *started* the
artifact that ships, so a broken runtime stage — a file missing from the `COPY`
set, a bad `CMD`, a dependency pruned out of the production install — reached the
deploy host before anyone found out.

The build is now **unconditional** and `load: true`, and a smoke step runs it.

Unconditional matters: the old `build=true` filter fired only on `Dockerfile`,
`.dockerignore`, `docker-compose*.yml` and the workflow files — i.e. exactly not
on the source changes that make up almost every PR. Measured cost with a warm GHA
cache is ~3 min, against an `e2e` job of ~5 min running in parallel, so the
workflow's critical path does not move.

The sidecar image kept a filter, because a GPU build should stay rare — and that filter
repeated the same mistake in miniature (issue #880). It enumerated the image's build inputs
by hand and omitted `app/`, the directory the Dockerfile `COPY`s and, in the case that
caught it, *executes* at build time. So an `app/**`-only edit skipped the very smoke build
meant to guard it, and then failed at tag time inside the deploy job that sits in both the
release's `needs:` and its `if:` — blocking the release *after* the version bump and tag
were already pushed. A filter that lists build inputs by hand needs a test that runs it:
`scripts/ci-concurrency.test.ts` extracts the patterns out of `ci.yml` and asserts their
behaviour on real paths, because asserting the regex *text* only proves someone typed the
path.

The step waits on the image's **own `HEALTHCHECK`** rather than a hand-rolled
poll, so it exercises the same mechanism compose and the deploy host rely on, and
then asserts `/api/health` reports `package.json`'s version — health says
"serving", the version says "serving *this* build".

Verified red against three shapes before shipping:

| Injected | Reported |
|---|---|
| image serves an older version | `/api/health reports version '0.3.44', expected '0.3.45'` |
| container exits immediately | `never became healthy (state=exited health=unhealthy)` |
| `HEALTHCHECK` removed from the Dockerfile | `the image has no HEALTHCHECK — this smoke test relies on it` |

That last case earns its own branch: without it the loop would spin to timeout
and report "never became healthy", which is a confusing way to say "there is no
healthcheck any more".

### Both arches, on master

The job is matrixed over `linux/amd64` and `linux/arm64`, mirroring `deploy.yml`.
Building amd64 only meant an **arm64-only break surfaced at release time**, after
the tag was cut — the same gap as above, one level up, and arm64 self-hosters
(Pi, Apple Silicon, Ampere) are a real audience for a public image.

Two constraints shape it:

- **Native runners, never QEMU.** `deploy.yml` records the reason: Bun's JIT is
  unreliable under emulation. A QEMU-based check would be flaky, and a flaky gate
  is worse than no gate.
- **`load: true` cannot take a multi-platform build** — the docker exporter
  cannot export a manifest list. So this is a matrix over single-platform builds,
  not a `platforms:` list on one step. Each leg builds, loads, *and* smokes, so
  arm64 is started rather than merely compiled.

`fail-fast: false`, so one arch failing does not hide the other's result.
`release.needs` lists `docker` by **job id** and a matrix requires every leg to
pass, so the gate stays wired with no `needs` change. The cache scopes
(`docker-linux-amd64` / `docker-linux-arm64`) are the ones release builds already
populate, so both legs start warm.

### The deploy never checked the deploy

`deploy.yml` ended at `docker compose up --build -d`. **That returns when the
container is created, not when it is serving.** A container that crash-looped, or
one that came up still running the previous image, was indistinguishable from a
good deploy.

This is the #457 shape, and #457 actually happened: a failed GHCR push produced a
green deploy that silently redeployed the previous version. Every other part of
that step now guards against shipping the wrong bytes — the images are derived
from `compose config` rather than hardcoded (#606), an empty list aborts rather
than no-ops. None of it confirmed the right bytes were *running*.

The deploy now polls `/api/health` on the host for up to 5 minutes and requires
the version to match the tag being deployed, dumping `docker compose logs` on
failure. On a manual `workflow_dispatch` it asserts health only — the host
redeploys whatever `release` currently points at, so there is no version to
expect and inventing one would be a check that cannot fail honestly.

This is also what makes the documented rollback actionable: pinning
`NICOTIND_VERSION` and redeploying only helps if you know the release is bad, and
until now the way you found out was a user telling you.

## `check:pr-title` — the commit message GitHub writes for you (#1263)

Every other commit message in this repo goes through the husky + commitlint
`commit-msg` hook. Exactly one does not: the subject of a **squash merge**,
which GitHub composes from the PR title, on GitHub, where no hook runs.

That subject is the one that decides releases. `release-needed.ts` reads
subjects and only subjects — deliberately, because a body can quote a commit
message and a release cut from prose is worse than a release not cut. So a PR
titled without a type lands a commit that bumps nothing, whatever it carries.

**The incident.** PR #1263 squash-merged five `feat:` commits under *"Radio
queue depth: replace batch refill with target-based top-up"*. Every check was
green on that PR and on the master push after it, because nothing was broken:
the release guard correctly answered "not needed" to a subject that had lost
the evidence. v0.8.40 stayed the latest release; the features sat on master,
built and deployed nowhere. The freeze was found by a human noticing prod had
not changed.

**The gate.** Two rules, because the first alone leaves the more subtle half
open:

1. the title parses as a conventional commit with a known type — this is what
   #1263's title failed;
2. if the branch's own commits bump and the title does not, it fails — a
   `chore:` title over a branch of `feat:` commits is valid *and* still throws
   the release away.

It imports `parseConventionalSubject` and `isBumping` from `release-needed.ts`
rather than re-deriving them. A gate that disagrees with the guard it protects
is worth nothing, and the disagreement would be invisible until releases
stopped again — which is the same argument `check:shared-helpers` makes
generally.

**Its denominator.** Rule 2's input is `FETCH_HEAD..HEAD`, so the job checks out
with `fetch-depth: 0`. A shallow clone would make that range empty, and empty
reads as "nothing on this branch bumps" — a pass. The silent direction is the
dangerous one, so the fetch is explicit rather than inherited.

**Why it re-runs on `edited`, in a workflow of its own.** The fix for a bad
title is editing the title, which pushes no commit. The default `pull_request`
trigger set would judge the title once and never look again: red forever on a
corrected title, and green forever on a good title edited into a bad one. So the
trigger lists `[opened, edited, reopened, synchronize]`.

It lives in `.github/workflows/pr-title.yml` rather than on `ci.yml`'s trigger
because **`edited` fires on body edits too**. Attached to `ci.yml` it re-ran all
thirteen jobs — both Docker arches, four e2e shards, the desktop package — every
time anyone touched a PR description; measured on this gate's own PR, editing
the body cancelled a full run and started another. A trigger that expensive
attached to an editorial action is one people learn to route around, so the
cheap check got its own workflow and `ci.yml` keeps the default trigger set.

**Not a `check:ci-parity` gate job, on purpose.** It only exists on a pull
request and `verify` has no title to check, so it is neither in `release.needs`
nor in `GATE_JOBS`. Branch protection is what makes it blocking — the same
arrangement `desktop-smoke` already has.

**The second layer.** `release-needed.ts` now prints a `::warning::` when it
skips a commit whose body lists bumping commits its subject lost
(`lostBumpsIn`). The decision is unchanged; what changes is that the skip says
why. The orphan-tag incident in `ci.yml` froze releases for a day by exiting 0
silently, and this is the same failure shape one layer up.

## `check:fetch-timeouts` — an outbound call with no deadline

A `fetch` with no `AbortSignal` hangs for as long as the upstream stays silent,
and **looks exactly like a working call until then**. `LidarrClient.request` and
the MusicBrainz client both shipped that way; the MusicBrainz one was worse than
a hang, because its failures were cached in a cache with no expiry.

### The gate exists because the obvious count was wrong

The architecture review reported "only 4 direct `fetch(` sites exist in the
backend". The real number is **19** — an almost 5× undercount, because every
house client calls its **injected** fetch:

| Shape | Example | Caught by `grep fetch(`? |
|---|---|---|
| identifier | `fetch(url, init)` | yes |
| injected member | `this.fetchFn(url, init)` | **no** |
| bare alias | `fetchFn(url, init)` | **no** |
| parenthesised | `(this.fetchFn ?? fetch)(url, init)` | **no** |

Of those 19, **seven had no timeout at all**, including a POST to AcoustID and
both archive.org calls. None was visible to the review's method.

So the check walks the AST and matches on any callee that **tokenises** to
`fetch` or `fetchFn`. Tokenising matters: `\bfetch\b` does not match `fetchFn`
— there is no word boundary before `Fn` — and that exact gap hid the AcoustID
call until this script's own test caught it. Helpers whose names merely start
with "fetch" (`fetchMetadata`, `fetchAndStoreArtistInfo`) are deliberately not
matched; they are not outbound calls, and the real call they eventually make is
checked on its own line.

### What counts as bounded

An explicit `signal` in an **object literal** at the call site. Two things
deliberately fail:

- `fetch(url, opts)` where `opts` is a variable — its contents cannot be seen
  here, and that is precisely how a missing timeout hides. `spotify-search`
  looked like this; it now spreads (`{ ...init, signal }`).
- a spread-only init (`{ ...init }`) — same reason.

### Where the signal goes

**Inline, and after any rate limiter.** Several of these clients `await
this.throttle()` or `await this.rateLimit()` immediately before the call, and a
signal created above that line spends its budget waiting for our own limiter
rather than for the upstream. `AbortSignal.timeout()` starts counting when it is
constructed, not when the request begins.

Budgets are per client, each with a stated reason rather than one blanket
number — 10s for Spotify (token + search, should be quick), 15s for AcoustID and
Discogs, 20s for ListenBrainz (one POST batches every pending MBID) and
archive.org (full-text search is genuinely slow). Lidarr's three tiers and
MusicBrainz's 15s are documented in
[design-patterns.md](design-patterns.md).

## `check:action-runtimes` — the warning nothing reads (#848)

Every action that ships JavaScript declares its runtime in its own `action.yml` as
`runs.using: node20` / `node24`. GitHub retires those runtimes on its own schedule, and it
announces the retirement as a **warning in the run log** — a channel this repo has no reader for.

So the drift accumulated in the open. #848 measured **14 of 17** pinned actions still on `node20`
across **67 call sites**, several two to four majors behind (`checkout` v4 against v7,
`download-artifact` v4 against v8). It was found because a human happened to scroll a deploy log,
which is not a control.

The warning is also the *gentle* phase. While it lasts, the runner force-upgrades the action to a
newer Node and the step still works. When the fallback is removed the step simply stops — and for
the `deploy.yml` pins, that failure lands in the release lane, **after the tag is cut**.

### The cause was a manager with no updater

The bumps were the symptom. `renovate.json` had been in the repo since the dependency-management
sweep, but step 3 of that plan — *install the App, or a self-hosted workflow* — was never done, so
the config was inert. `github-actions` was an entire dependency manager with nothing behind it.

Confirmed rather than assumed: **zero** Renovate PRs had ever opened, and no Dependency Dashboard
issue existed, though `:dependencyDashboard` is enabled and creates one on the first run.

`.github/workflows/renovate.yml` now runs it. But enabling Renovate fixes the *drift*; it does not
make the drift **fail**. An unenforced convention is exactly how `renovate.json` sat inert for
months, so the gate is the part that asserts.

### Network-free, because a gate that cannot run stops being run

Resolving `runs.using` live would mean an outbound call per action inside `verify` —
offline-hostile and rate-limited. Instead `RUNTIME_FLOORS` records, per action, the minimum major
known to carry a current runtime. That is a fact that changes only when someone deliberately bumps
an action, so a table is the right shape for it.

The floor is the **lowest** major with a current runtime, not the newest release. Pinning the newest
would turn every upstream major into a red gate — proposing those is Renovate's job and reviewing
them is a human's, not this gate's to force.

### The denominator, both ways

A floor table quietly covering fewer actions than the workflows use would still exit 0 truthfully.
So it fails three ways:

| Failure | What it catches |
| --- | --- |
| Pin below its floor | the regression itself |
| Action with **no** floor entry | a new action whose runtime nobody classified |
| Floor entry **no workflow uses** | dead config — a rule that guards nothing while reading as though it does |

It also fails when the scan matches **nothing at all**. That is not paranoia: the first run returned
zero files, because Bun's `Glob` skips dot-directories by default and every path here is under
`.github`. Without that assertion the gate would have passed, silently, forever — the exact shape
this document opens with.

Composite actions (`trivy-action`, `upload-pages-artifact`) are recorded in the table **explicitly**
rather than skipped, so "no Node runtime" is a classification someone made rather than a gap. A SHA
pin is reported as unclassifiable, because its runtime genuinely is not derivable offline.

### Two couplings the table carries as notes

- **`upload-artifact` and `download-artifact` must move together.** `deploy.yml` uploads in one job
  and downloads in another; a producer/consumer major mismatch breaks inside the release lane.
- **`actions/cache` v5+ crosses the cache-service v2 migration.** A cache miss degrades to a slow
  build, it does not fail — so a bump is verified by cache **hits** in the log, not a green step.

## `check:search-matching` — asserting the invariant, not the symbol

`check:shared-helpers` exists to stop a shared helper being **re-declared**
locally. It cannot see a call site that **bypasses** one, and that is how the
same bug shipped three more times.

The MCP agent surface matched artists with `name LIKE ? COLLATE NOCASE`
(#706). There was no local copy of `matchesAllTokens` to find, so the gate
printed *"12 shared helpers checked, no local re-implementations found"* and
exited 0 — truthfully, about a set that never contained the defect. The Library
Songs tab did the same thing (#719), in the same file as a find bar that had
been folding correctly for months. The real invariant — *every search surface
matches the same way* — was unmeasured by any gate.

So this gate asserts the invariant. A `LIKE` against a library **name** column
(`name`, `title`, `artist`, `album_name`, `artist_name`) must live in
`services/search-tokens.ts` or carry a reasoned `ALLOWED` entry.

The separating signal is deliberately **not** the column, because the legitimate
uses share it: `enrichment/tasks.ts` matches `name LIKE '% & %'` to detect
compound artists. It is what the `LIKE` is compared against — a **bound
parameter** carries text a user typed and must be folded; a **quoted literal**
is a pattern the author already knows the exact contents of and has nothing to
fold. `isNameSearch` is exported and unit-tested against the verbatim strings
from both shipped bugs, so the gate is proven to catch what it exists for.

Applying the rules above:

- **Denominator printed:** *"25 SQL fragments containing LIKE examined"*, not
  "no problems found".
- **Fails on what it cannot classify** (rule 3). An interpolated
  `` `${col} LIKE ${bind}` `` hides its column from a text scan, so it is
  flagged rather than skipped.
- **Reads the whole operand**, not its first token. `LIKE '%' || ? || '%'` puts
  a literal directly after `LIKE` with the user's text behind it; stopping at
  the literal would have waved through exactly this bug. That hole was found by
  a test, not by review.
- **Known limit:** it is a pattern over source text, not a parser (rule 4). SQL
  assembled across lines is only caught by the unclassified branch. A real
  parser is the upgrade if this ever cries wolf.

## `check:feed-eligibility` — one answer to "may this song be recommended"

Every recommendation feed used to decide on its own which songs it could
propose: radio's five pool passes, `/api/library/random`, `/songs/:id/similar`,
the weekly recipe shelves and the poll generator each carried their own
`s.hidden = 0 AND s.landed_at IS NOT NULL`. Five copies of a predicate drift,
and this one had: radio checked the **song's** hidden flag and never the
**album's**, so an album a curator hid vanished from every listing and kept
playing on radio. `check:shared-helpers` could not see it — nothing was
re-declared, the question was simply answered five different ways.

`services/recommendation/eligibility.ts` is now the one answer
(`feedEligibilitySql`, `isFeedEligible`; see [radio.md](radio.md) "Feed
eligibility"), and this gate asserts that every feed asks it.

What counts as a feed is the part worth getting right, because a listing must
**not** use the predicate: the Songs tab shows what the library has, and hiding
an un-analysed song there would make a fresh download look lost. The separating
signal is sampling — `ORDER BY RANDOM()` proposes, a listing pages — plus a short
`FEED_MODULES` list of files whose whole purpose is recommendation
(`routes/radio.ts`, the poll generator, the recipe shelves,
`services/recommendation/`), inside which every song select is a feed.

Applying the rules above:

- **Denominator printed:** *"119 library_songs selects examined, 17 classified
  as feeds"*. A run that classifies zero feeds fails — the gate would be
  measuring nothing.
- **Fails on what it cannot vouch for:** a feed literal that does not
  interpolate the helper is a bypass, whatever its WHERE says. Two lookups
  inside `routes/radio.ts` carry reasoned `ALLOWED` entries (the seed by id is
  what the listener is already playing; the recording-key lookup removes songs
  rather than proposing one), and an allowlist entry that stops matching fails
  the gate so it cannot outlive its reason.
- **Judges the query, not the constant:** `RADIO_SONG_SELECT` and friends are
  `SELECT … FROM` prefixes with correlated subselects of their own; `topLevel`
  hollows the parentheses out before looking for a WHERE, so the prefix is a
  fragment and the predicate is checked where the prefix is used.
- **Known limit:** template literals are found by a small scanner, not a TS
  parser (rule 4). SQL assembled from plain strings is invisible to it; every
  feed in the repo is a template literal today, and `classify` is unit-tested
  against the verbatim shipped fragments.

## `check:library-queries` — the plan is the gate, because nothing can pre-empt

`bun:sqlite` is synchronous inside a synchronous Hono handler, so a quadratic
list query is not a slow page — it is an outage. `/artists?country=CL,AR` held
the single Bun event loop for ~3 minutes and took cover art, the Songs tab and
the container health check down with it (#1055).

The detection half shipped with that fix (`startLoopBlockMonitor` +
`trackInFlight`, see [library-filters.md](library-filters.md)), and it is honest
about what it is: it *names* the query that stopped the process, after the fact.
It cannot stop one, and neither can anything else in this process — the
rejections and their evidence are recorded in
[library-filters.md](library-filters.md) "Why nothing here pre-empts". That
leaves the shape, judged before it ships.

`scripts/check-library-queries.ts` builds every library list query through the
**real** fragment builders (`artistFilterWheres` / `albumFilterWheres`) across
every dimension the filter grammar can express, runs `EXPLAIN QUERY PLAN`
against a schema-only in-memory DB, and fails when a `library_songs` scan is not
evaluated once. Asserted on the plan rather than the clock: a wall-clock
threshold flakes on a loaded box and says nothing about *why*.

The plan's `id`/`parent` columns give the real tree, which turns both bad
spellings into one rule (`judgeSongScans`): a song scan under a `CORRELATED …`
ancestor is re-derived per entity row, and one SQLite tagged ` EXISTS` is driven
by the outer loop. The required shape puts it under a plain `LIST SUBQUERY`.

Applying the rules above:

- **Three denominators, each derived independently of the check** (rule 1).
  The routes come from the `*FilterWheres(` call sites in `routes/library.ts`
  (`discoverListRoutes`), so a new list route fails the gate until it is
  modeled; the dimensions come from `LIBRARY_FILTER_PARAM_KEYS`, so a new filter
  property fails it until a case covers one; and a case whose SQL reads
  `library_songs` but whose plan shows no song scan fails as unclassified
  rather than passing (rule 3).
- **Printed:** *"72 query plans over 4 list routes x 18 filter cases, 85
  library_songs scans judged"*. A run that judges zero scans fails.
- **A case the grammar drops is not a case.** `vacuousCases` round-trips each
  one through `parseLibraryFilter` + `serializeLibraryFilter`, so a renamed
  param cannot leave its dimension silently unmeasured; the `licence` tombstone
  is the one exemption and carries its reason.
- **Proven able to fail** — `--fixture correlated` appends the pre-#1055
  correlated `EXISTS`, and the gate's own test asserts that run exits 1 while
  the real one exits 0.
- **Known limit:** it asserts the *shape*, not a time. A future query that is
  slow for some other reason (a missing index, an unbounded row count) is
  invisible to it; row ceilings are the separate answer, and the one list route
  that had none now has one.

## `check:audit` — a supply-chain gate that measures what ships

There was no dependency scanning at all. The obvious fix — append
`bun audit --audit-level=high` to `verify` — was measured before being written, and it is
wrong. On this repo `bun audit` reports **95 advisories across 27 packages** and exits 1,
and approximately none of them are actionable. A gate that starts red with 47 findings you
cannot act on gets muted inside a week; that is this document's rule failing in the other
direction, loudly-false instead of silently-green.

Two independent reasons the raw number means nothing here.

**It audits the lockfile, not the artifact.** `bun audit` reads every entry in `bun.lock`
(1,886 packages as bun counts them). The runtime image installs 158 of them (`bun install --production`, see
[deployment.md](deployment.md)). Angular, Storybook, Playwright, `electron-builder` and
`lint-staged` build the app; they never run in it. Filtering to the production closure takes
28 advisory packages down to **4**.

**It reports per package name, not per resolved instance.** A monorepo lockfile resolves the
same package many times, and `bun audit` groups by name. `builder-util-runtime` is here at
both `9.2.10` and `9.7.0`. Without matching the *resolved* version, the gate is majority
false positives even after the closure filter. The example this used to give was `sharp`,
dev-only at a vulnerable `0.32.6` beside the safe copy the API ships — that second
resolution arrived through `@capacitor/assets` and left with it (#1183). The rule is
unchanged; only the instance that illustrated it is gone.

So `check:audit` applies both filters and prints the whole funnel:

```
Supply chain: 91 advisories across 25 packages -> 3 in the 160-package
production closure -> 0 version-matched.
```

### The version filter is not theoretical

Its first run found `yaml@2.8.2` shipping through
`@nicotind/api > @hono/zod-openapi > openapi3-ts > yaml`. A name-level read says yaml is
fine, because the root's own direct dependency is a safe `2.9.0` — the vulnerable copy is a
second resolution three levels down. Nothing but resolved-version matching finds that.

Findings therefore carry their dependency path. "`yaml@2.8.2` is vulnerable" is not
actionable on its own; you need to know that the thing to bump is `openapi3-ts`.

### Neither filter may drop anything silently

Per the rule at the top of this file: a package inside the closure whose version cannot be
read **fails** the build instead of being skipped. A filter that quietly narrows its own
input is the #457/#606/#273 shape, and two of these filters exist precisely to narrow the
input.

`ACCEPTED` is checked in **both** directions — an entry matching nothing fails too, the
`EXTERNAL_SYMBOLS` discipline rather than the `ALLOWLIST` one. It ships **empty**: the three
findings it was written against were fixed by bumping, not excused, so there is no precedent
in it for excusing one.

Both filters are red-proofed. Disabling the closure filter fails 2 tests; disabling the
semver match fails 1.

### Unreachable is not vulnerable

`verify` runs offline sometimes. When the advisory registry cannot be reached the gate warns
and exits 0, saying plainly that nothing was checked. Recording a transient failure as a
finding is the mistake [#625](https://github.com/kevinch3/NicotinD/issues/625) fixed in the
MusicBrainz client, pointed the other way.

### Scope

`check:audit` owns npm dependencies. The base image's OS packages are Trivy's job in
`deploy.yml` — `bun audit` structurally cannot see them, and keeping the two
non-overlapping means a failure in either is unambiguous about what to fix.

## Secret scanning — history, not the working tree

The `ci` job runs gitleaks over **every commit**, not over the files on disk. A secret
committed and then deleted inside the same pull request is still published forever, and a
tree scan cannot see it. This is affordable: **1,968 commits in ~1.3s**, because gitleaks
walks diffs rather than files. The job's checkout therefore needs `fetch-depth: 0` — a
shallow clone would silently shrink the scan to one commit, which is this document's rule
being broken by an unrelated default.

The binary is downloaded pinned rather than run through `gitleaks-action`, matching the
`actionlint` step directly above it in the same job; it also sidesteps that action's
licensing terms. Both carry a `check:ci-parity` ALLOWLIST entry, since neither runs locally.

### A finding is not necessarily yours (#1160)

`fetch-depth: 0` fetches **every remote branch**, and the scan walks all of them. One
unmerged branch carrying a high-entropy fixture therefore reds the gate on every other
pull request and on `master`, for content the author of the failing run has never seen.
That is the intended reach — a secret is published the moment it is pushed anywhere — but
it makes attribution the first question a red gate has to answer.

So the step runs with `-v`, which prints the rule, file, line and **commit** of each
finding. `--redact` stays on beside it, so the matched value itself is still never printed.
Without `-v` the log says only `leaks found: 1` and names nothing, which cost a full triage
to attribute to a sibling branch.

To confirm your own range is clean before blaming it:

```bash
gitleaks git . --redact --no-banner --config .gitleaks.toml -v --log-opts="origin/master..HEAD"
```

### What the first scan found

Run before any config was written, because a gate you have not measured is a guess:

| Count | What | Verdict |
|---|---|---|
| 4 | `const SECRET = 'test-secret-at-least-32-chars-long-xx'` in four route tests | False positive — `generic-api-key` is an entropy heuristic, firing on a constant that says what it is |
| 4 | `.auth/admin.json` (Playwright `storageState`), committed 2026-07-26 | Already fixed: untracked and gitignored in `6448ea8e`/`3207b67e`. The JWT was an e2e session token signed with the test secret, against a throwaway database |

**No real secret has ever been committed to this repo.** Worth having verified rather than
assumed — it is public, so a leak would already be exposed.

The other 72 findings a naive `gitleaks dir .` reports are all under `.claude/worktrees/`,
which is untracked via `.git/info/exclude`. Not repo content, and absent in CI.

### The allowlist is scoped as tightly as the evidence allows

Same failure mode as `check:audit`: those four test-secret hits would make the gate red on
day one with nothing real in it. The fix is a reasoned allowlist, never a lowered threshold.

`.gitleaks.toml` allowlists the test secret **by its exact string**, not by the four files —
scoping to the files would also hide a real secret added beside it. The `.auth/` history is
allowlisted **by its four commit SHAs**, not by path, for the same reason: a path allowlist
would hide a real secret added there tomorrow, and four SHAs cannot. Verified in both
directions — planting a GitHub PAT under `.auth/` is still caught.

## The apt layer must actually re-execute (#730)

Trivy below is only as good as the image it scans, and for two releases it scanned an image
whose security updates had never been fetched. The production stage runs `apt-get upgrade`
precisely to pick up Debian updates published since the base image was built — but the build
uses `--cache-from type=gha`, and buildx invalidates a layer only when its **command string**
changes. The string never changed, so the layer was served from cache on every release:
v0.5.13 and v0.5.14 both shipped apt blobs dating to July, and Trivy blocked both deploys on
a `libssl3t64` CVE whose fix had been in the archive for days. Prod stayed on 0.5.12.

This is the "gate asserts its own denominator" failure in a different costume: the mechanism
was present, visible in the Dockerfile, commented as doing exactly what it was supposed to —
and measured nothing.

The fix is an `ARG APT_REFRESH` interpolated **inside that RUN**, with `deploy.yml` passing
`${{ github.run_id }}`. Per-run rather than a daily date stamp on purpose: a date stamp leaves
a window where Trivy scans an archive state newer than the image's, and Trivy is the thing
that blocks the deploy, so the two must agree.

`scripts/dockerfile-apt-refresh.test.ts` asserts the pairing, because each half fails
**silently** on its own: an `ARG` declared but never interpolated is a no-op that reads as a
fix, and a workflow that stops passing the value lets the Dockerfile's own default take over
without breaking the build. It also rejects a constant value, which would satisfy both halves
and restore the bug on the second build.

## An install must not depend on a third-party download (#1087)

`ffmpeg-static` (a devDependency of `@nicotind/desktop`, trusted by Bun's default list) runs an
install script that downloads its binary from a GitHub release. Every CI job's `bun install` ran
it, so a transient failure of that download failed `web-test` on the v0.6.33 release commit, with
nothing wrong in the code.

Only `desktop-package` (`prepare-resources` → `stageFfmpeg`) uses the binary. `ci.yml` sets
`FFMPEG_BIN: /bin/false` workflow-wide: the package's `index.js` returns that path, and its
installer exits early ("installed already") when the path is an existing file. `desktop-package`
sets `FFMPEG_BIN: ''` to get the real download. `/bin/false` rather than `/bin/true` so any stray
use fails loudly. `--ignore-scripts` would be too broad: `esbuild` needs its install script to
validate the platform binary the lockfile pins, and `lmdb` / `msgpackr-extract` need theirs to
resolve a prebuilt `.node`. `deploy.yml` is untouched, because its desktop jobs need the binary.

`scripts/ci-ffmpeg-static.test.ts` checks the pairing: the sentinel is set, every job that stages
ffmpeg clears it, no other job does, and the installed script really skips the network when
`FFMPEG_BIN` is set.

### The second instance, and why this became a gate (#1183)

The sentinel fixed one package. On 2026-09-21 a second arrived: **`sharp@0.32.6`**, pulled in
transitively by `@capacitor/assets`, whose install script downloads libvips from a GitHub release
and falls back to compiling from source when that fails. A 504 from the release CDN failed
`web-test`, both `e2e-shard` legs and `desktop-package` **in the same minute**, on a four-file
artwork fix that reaches none of them — four attempts, 15.5 minutes, the last blocked by an
unrelated 504 on ffmpeg-static's own download.

It was removable for exactly the reason ffmpeg-static's was — nothing in CI used it. Both call
sites already write `bunx @capacitor/assets@3`, which pins the major itself, so the declared
devDependency bought nothing and cost every job a libvips download. Deleting it also removed the
dev-only vulnerable `sharp` resolution that `check:audit`'s note used as its worked example, and
restored an intent `packages/mobile/scripts/generate-native-icons.ts` had already written down:
the 1024² sources are committed so CI needs "no native `sharp` build in the mobile CI jobs".

Two instances of one class is where a gate earns its place, so the rule in this section's title
is now enforced rather than remembered. **`check:install-scripts`** walks the installed tree and
fails on any package running a `preinstall`/`install`/`postinstall` hook that is not on a
reviewed allowlist — keyed on the **hook command text**, not the version, so a patch bump that
changes what the script does re-opens the decision while routine bumps do not. Both directions,
per the rule at the top of this page: an entry matching nothing also fails, so the allowlist
cannot rot into a check over an empty set.

The denominator is the subtle part, and the first draft got it wrong. Scanning
`node_modules/.bun` — bun's store — reported four packages that `bun install` would never run:
the store is a cache bun does not prune, and it holds versions no workspace links to any more.
The gate walks **reachability from the workspace roots** instead, following symlinks and
deduplicating by realpath, because what runs an install script is what bun links into the tree.
Bun's isolated layout is why that walk is not a one-liner: a package's dependencies are siblings
inside `<store-entry>/node_modules/`, not in a nested `node_modules`, and a walk that checked only
the nested case found one package out of seven.

After the removal exactly one allowlisted package still fetches from a vendor host —
`ffmpeg-static` — and only `desktop-package` runs it, because that job genuinely needs the binary.
Removal is unavailable there, so that one `bun install` is wrapped in a **bounded** retry: three
attempts, backoff, then the job fails. A vendor CDN's uptime is not a signal about the diff, but a
retry that could never fail would be the hidden-retry shape this page warns about elsewhere — so
it is bounded, it is loud, and `check:install-scripts` is what stops it widening to a second
package by making one appear as a build failure instead of a withheld release.

## A publisher that uploads nothing can still exit 0 (#1261)

The desktop packaging jobs were written fail-loud on purpose: not `continue-on-error`, so a broken
AppImage turns the release run red instead of shipping a tag with no artifacts. That covers a
failing build. It does not cover a **succeeding** build that publishes nothing, and for two months
that is what ran.

electron-builder's GitHub publisher refuses to upload into a release whose type does not match its
own `releaseType`. The refusal is one `skipped publishing` line per file in the log — and exit
code **0**. `deploy.yml`'s `release-notes` job is ungated and has no `needs`, so it creates the
tag's release as *published* within seconds of the tag push, while the publisher sat on its default
`draft`. From **v0.1.232 to v0.8.39** — ~40 releases — both desktop jobs built the AppImage, the deb
and the dmg, uploaded none of them, and reported success. The `latest-*.yml` feeds went with them,
so every installed desktop app silently lost auto-update at the same time.

Nothing in the pipeline was in a position to notice. The jobs were green; the release page had
assets on it (the APKs and the ipa, from other jobs); the changed area gate said `desktop=true` and
the jobs genuinely ran. The one physical trace was v0.6.37, where the desktop job happened to reach
`publish` *first* and electron-builder created its own draft — leaving a second release sharing the
tag name, holding exactly the five missing files, invisible on the releases page.

The root-cause fix is one line, `publish.releaseType: release`, asserted by a unit test beside the
config. The gate is the other half, and it is aimed at the class rather than the instance: **a step
that produces artifacts and publishes none must be red**. `verify-published-assets.ts` runs after
the upload in each packaging job, lists what electron-builder actually wrote to `release/`, and
fails unless every one of those names is on the tag's *published* release —
`/releases/tags/{tag}` resolves no drafts, which is the assertion we want given how v0.6.37 failed.

Two denominator decisions, per the rule at the top of this page. The expectation is read from the
build's own output rather than a hardcoded asset list, so a target someone adds is covered without
anyone remembering to extend the check; and an **empty** artifact set fails rather than passing,
because a build that produced nothing is the vacuous pass this whole section is about.

`check:desktop-publish` is what keeps that step wired. A safety step nobody wired is off, so the
gate checks the *wiring*, not the mechanism: it fails a packaging job whose verification was
deleted, renamed, reordered before the upload, or neutered with `continue-on-error`, and it fails
when it stops finding the packaging jobs at all rather than passing over an empty set.

## A release is only cut when something releasable landed (#755)

`commit-and-tag-version` patch-bumps **even when nothing since the last tag bumps anything**,
which contradicts this repo's own documented contract (CLAUDE.md: `chore` `refactor` `style`
`docs` `test` `ci` `build` do not bump). Merging #750, #752 and #753 within a minute exposed
it: run A published `v0.5.21` covering all three, and run B — queued behind it — cut an empty
`v0.5.22` moments later, triggering a full multi-arch build and deploy for an identical tree.

The `if:` guard on the release job cannot catch this. It reads `github.event.head_commit`, the
commit that was *pushed*; the step then does `git reset --hard FETCH_HEAD`, which for run B
lands it on run A's `chore(release)` commit. The guard's premise and the step's actual HEAD
are two different commits.

`scripts/release-needed.ts` answers the question the workflow was assuming: is there a
`feat`/`fix`/`perf` — or any breaking marker — since the latest tag, and is the tip already
that tag? It is a tested module rather than more inline bash deliberately: the release step
froze releases for a day once (the orphan-tag incident in `ci.yml`), and shell that can
silently `exit 0` is exactly how that stayed invisible.

One implementation note worth keeping, because it is the same defect class as everything else
on this page: `--match v*` must be **interpolated** into Bun's `$`, not written inline. Bun's
shell glob-expands a bare `v*` against the working directory, so `git describe` never receives
the pattern, reports no tag, and the guard answers "release" unconditionally — a gate that
always passes, caught only by running it against the real repo.

## Image scanning — the base layer `bun audit` cannot see

Trivy runs in `deploy.yml`'s `docker-merge` job, scoped to **OS packages only**
(`vuln-type: os`). That scoping is the point: [`check:audit`](#checkaudit--a-supply-chain-gate-that-measures-what-ships)
owns npm dependencies and structurally cannot see a Debian package in the `oven/bun` layer,
so keeping the two disjoint means a failure in either is unambiguous about what to fix.

`ignore-unfixed: true`, because an OS CVE with no available patch is not actionable and
blocking a release on one would only train us to bypass the gate. A finding here therefore
always means: **a fixed version exists, bump or patch the base image.**

It runs as a step inside `docker-merge` rather than as its own job. The image is already
pushed by then, so a failure does not un-publish it — it stops `deploy` from putting it on a
host, through the existing `needs: [docker-merge]`. A separate job would have meant editing
`deploy`'s `if:` expression, and that expression is precisely the #457 shape.

### What the first scan found

**37 HIGH findings in the published image**, every one with a fix already in the Debian
archive — 5 distinct CVEs (four in `util-linux`, one in `libcap2`) counted once per affected
binary package. The image had been shipping whatever `oven/bun:1.3.14` froze.

The fix was one line: `apt-get upgrade -y` in the production stage, verified to land exactly
the versions Trivy named (`util-linux` `2.41-5` → `2.41.5-0+deb13u1`, `libcap2`
`1:2.75-10+b8` → `1:2.75-10+deb13u1+b1`). It costs byte-reproducibility of that layer, which
was never there anyway — none of the packages beside it are version-pinned.

## Hardware cast: the drift this uncovered

`CLAUDE.md` described Chromecast/DLNA casting in the present tense as shipped —
a `CastController`, `/api/cast/*`, a `cast_tokens` table, four npm dependencies.
**None of it was ever built.** The gate passed because `CastController` appeared
in `docs/cast-integration.md` and in one Storybook component description.

`docs/cast-integration.md` is now labelled a proposal; the design is kept because
the alternatives it weighs are still the right starting point. Browser-tab
[remote playback](remote-playback.md) is the shipped way to control another
device.
