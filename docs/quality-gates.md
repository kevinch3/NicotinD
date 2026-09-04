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

| Cap | Value | Set from |
|---|---|---|
| `MAX_ENTRY_CHARS` | 440 | measured max **prose** 371 after the restructure |
| `MAX_FILE_BYTES` | 65,000 | measured 50 KB at the restructure (cap 60,000); raised 2026-08-29 at 55.3 KB / 151 entries — growth was new entries, not narrative |
| `MIN_PLAUSIBLE_ENTRIES` | 60 | the gate's own denominator (160 parse today) |

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

The sidecar images kept a filter, because the separator's is a ~3 GB GPU build that
should stay rare — and that filter repeated the same mistake in miniature (issue #880). It
enumerated each image's build inputs by hand and omitted `app/`, the directory both
Dockerfiles `COPY`. The separator's Dockerfile *executes* that source at build time (an
arch guard and a strict checkpoint load), so an `app/**`-only edit skipped the very check
that guards it — and then failed at tag time inside `docker-separator`, which the deploy
job has in both its `needs:` and its `if:`, blocking the release *after* the version bump
and tag are already pushed. A filter that lists build inputs by hand needs a test that
runs it: `scripts/ci-concurrency.test.ts` extracts the patterns out of `ci.yml` and
asserts their behaviour on real paths, because asserting the regex *text* only proves
someone typed the path.

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

## `check:audit` — a supply-chain gate that measures what ships

There was no dependency scanning at all. The obvious fix — append
`bun audit --audit-level=high` to `verify` — was measured before being written, and it is
wrong. On this repo `bun audit` reports **95 advisories across 27 packages** and exits 1,
and approximately none of them are actionable. A gate that starts red with 47 findings you
cannot act on gets muted inside a week; that is this document's rule failing in the other
direction, loudly-false instead of silently-green.

Two independent reasons the raw number means nothing here.

**It audits the lockfile, not the artifact.** `bun audit` reads all 2,546 entries in
`bun.lock`. The runtime image installs 166 of them (`bun install --production`, see
[deployment.md](deployment.md)). Angular, Storybook, Playwright, `electron-builder` and
`lint-staged` build the app; they never run in it. Filtering to the production closure takes
27 advisory packages down to **3**.

**It reports per package name, not per resolved instance.** A monorepo lockfile resolves the
same package many times, and `bun audit` groups by name. `sharp` is here at both `0.32.6`
(vulnerable, via `@capacitor/assets`, dev-only) and `0.35.3` (safe, what the API ships);
`yaml` and `builder-util-runtime` are the same story. Without matching the *resolved*
version, the gate is majority false positives even after the closure filter.

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
