# Curator triage: typed decision cases, five per round

**Status**: phase 1 shipped; phases 2-3 pending
**Date**: 2026-09-12

## The problem

Curation decisions that a human must make have nowhere good to land.

`curation_flags` is the durable "a decision is owed here" record, and it works — listener
reports fold into it, re-flagging refreshes rather than duplicates. But a flag carries
only a free-text `reason` written for a human to read. It is machine-unreadable, so no UI
can render the decision as anything but prose plus a single **Resolve** button. Today's
`ReviewFlagsPanelComponent` does exactly that: a table showing the raw `targetId` hash —
not even resolved to a title — with one action.

Meanwhile `libraryHealth` computes eleven dimensions, each already shaped as
`{ metric, worklist, remediation }`, and **no web surface consumes any of it**. The
worklist model exists; nothing renders it.

So the two halves of a triage system are both present and neither is connected: a queue
with no structure, and structure with no queue.

The reporter side already solved its half of this. `TRACK_REPORT_REASONS`
(`packages/core/src/types/track-report.ts`) is a closed vocabulary, and its docstring
states the principle this design extends to the resolver side:

> "'Report' as a single button produces a queue nobody can triage — 'bad' is not an
> actionable finding — while a named reason routes to a specific fix and makes the
> backlog sortable."

## Goals

- A curator can sit down, be shown five concrete decisions, and resolve them — each with
  the evidence needed to decide and the specific actions that decision affords.
- Resolving a case applies the fix, immediately, through the already-tested mutation
  service for that change.
- The queue sustains itself: it does not run dry after one round.
- A case dismissed as "not a real case" stays dismissed.

## Non-goals

- Not a general metadata editor. A case offers the options its kind affords; arbitrary
  field editing stays where it is.
- No multi-user workflow — no assignment, no comments, no review-of-review. Audience is
  the admin/curator, single operator.
- No new auth role. Existing curator/admin gating only.
- Not a replacement for the MCP curation tools. Same mutations, different front door.

## Decisions taken

| Question | Decision |
|---|---|
| Case source | Filed flags **and** cases generated from audit/health predicates |
| Resolution | Apply the fix immediately, not queue a decision for later |
| Audience | Admin/curator only |
| Placement | Entry card in the library view → dedicated route, not a 9th library tab |

## 1. The case model

Five kinds, drawn from the decisions that actually recurred across logged curation
passes — not invented:

| Kind | The question it asks | Affordance |
|---|---|---|
| `identity` | Which real-world artist/recording is this? | Pick 1 of N candidates, or "none of these" |
| `placement` | The data is right — which album/artist should hold it? | Both containers shown, move vs. keep |
| `duplicate` | Same recording? Which copy survives? | A/B side by side, fingerprint verdict, keep/delete |
| `listen` | Only ears can settle it | Inline player + the competing labels |
| `batch` | A staged destructive list needs one yes/no | Count, sampled rows, single confirm |

The five currently-open flags fill four of these five kinds, which is the evidence the
taxonomy is real rather than speculative:

- #19 Secret Cinema B2B Egbert → `identity` (a b2b credit names two acts; no single canonical artist)
- #20 Gwen Stefani / Pharrell → `placement` (the recording is Pharrell ft. Gwen; moving it changes which album shows it)
- #21 Gloria Estefan *Mi tierra* t3 → `listen` (fingerprint says Glenn Miller at 0.98, elimination says "Ayer")
- #23 ABBA *Voyage* strays → `placement`, album level
- #25 Rocky "Band Against the Wall" → `duplicate`, fingerprint inconclusive

### Shape

```ts
type CurationCaseKind = 'identity' | 'placement' | 'duplicate' | 'listen' | 'batch';

interface CurationCase {
  /** 'flag:19' or 'gen:<generator>:<stable key>' */
  id: string;
  kind: CurationCaseKind;
  target: { kind: 'artist' | 'album' | 'song'; id: string; title: string; subtitle: string };
  /** One sentence: the decision owed. */
  question: string;
  evidence: CaseEvidence[];
  options: CaseOption[];
  /** Drives round ordering; also the precision signal. 0..1 */
  confidence: number;
  source: 'flag' | 'generated';
}

interface CaseOption {
  id: string;
  label: string;
  /** Why this option might be right — shown under the label. */
  rationale: string;
  /** What applying it actually runs. See §4. */
  effect: CaseEffect;
  destructive?: boolean;
}
```

The load-bearing change from today: **`options` is typed data carrying its own effect**,
not prose a human must translate into an action.

## 2. Case sources, and the precision gate

This is the opinionated part of the design and the reason the queue will be much smaller
than raw audit counts suggest.

Logged curation passes recorded the same failure nine separate times, summarised there as
*"a PATH- or NAME-shaped test for a CONTENT-shaped question"*: 535 "ghost credits" that
were mostly real featured artists; 161 "duplicate albums" where `Circus` is both a Britney
Spears and a Lenny Kravitz record; `completeness.confirmedIncomplete` recommending hunts
for albums already complete (4 of 6 in one sample, 67% waste).

A queue that serves false positives is worse than no queue, because it spends the one
resource the whole system is short of. Therefore:

> **A predicate may only mint cases if its precision has been measured.**

### Excluded by default — measured as not-a-backlog

| Predicate | Count | Why excluded |
|---|---|---|
| `missing_artwork` | 4,383 | the #952 overcount |
| `missing_year` | 180 | data-absent, not fixable by decision |
| `album_count_mismatch` | 305 | post-delete churn, self-settling (#774) |
| `track_collision` | 132 | blocked on #1077; the proposed theory fit 2 of 110 |
| `fragmented_artist` | 8 | all genuine collaborations; advisory by design |
| `completeness.suspected` | 515 | advisory; explicitly never act without confirmation |
| `orphan_file` | — | 2.73 GB of redundant copies, not missing music (#1079) |

This exclusion list is **code, with the justification attached**, and it is asserted by a
test (§7) so that widening it later is a deliberate act rather than a drift.

### Admitted — measured as real

| Generator | Basis | Supply |
|---|---|---|
| Fingerprinted duplicate pairs | ~90% precision when acoustIds agree (31 verified, 25 acted, 3 rejected) | ongoing |
| `watermark_artist` / `watermark_album` / `watermark_title` | the #705 shape, consistently real | small |
| `djset_artist`, `missplit_album`, `placeholder_single` | small but real | small |
| **Proposed genre for a genre-less song** | agent proposes with evidence, human confirms | ~101 |
| **Low-information genre by artist** (#1115) | 309 `Electronic`-only, 107 `Music` | ~400 |
| **Homonym-mbid suspects** | thin catalogue + mbid + genre/origin outlier (found Rocky, Sebastian) | ongoing |

The last three matter most, and they reframe what a case *is*: the highest-value case is
not "here is a defect, go dig" but **"here is a proposal and its evidence — confirm or
correct."** The agent spends the research; the curator spends only the judgement. That is
also what makes rounds sustainable — the genre proposals alone are ~20 rounds.

## 3. Round mechanics and placement

**Not a library tab.** The eight existing `LibraryMode` values are browse modes over the
collection; this is a task flow, and adding a ninth tab would be a category error.

- **Entry**: a card in `LibraryComponent`, beside the existing "New albums" banner —
  *"7 decisions waiting · Start a round"* — rendered only for curators. This is the
  "offered from the library view" requirement.
- **Route**: `/library/curate`, curator-guarded, registered in `app.routes.ts` inside the
  existing `serverGuard`/`authGuard` shell.
- **A round is up to 5 cases**, one card at a time, with progress dots. `Skip` (defer,
  reappears in a later round) and `Not a case` (durable dismissal, §5) are always
  available. Fewer than five available is a short round, not an error; zero available
  renders an empty state and the library entry card is hidden entirely.
- **Composition rule**: highest confidence first, and **at most two cases of any one kind
  per round** — a round of five identical duplicate pairs is data entry, not judgement. If
  the pool cannot satisfy that, the cap relaxes rather than the round shrinking.
- **`confidence`** is `1.0` for a flag-sourced case (a human already judged it worth
  raising) and generator-supplied for a generated one, where it means the generator's
  own confidence in *this instance*, not its aggregate precision.
- **The existing Admin `ReviewFlagsPanelComponent` becomes a link into this surface**, so
  there remains one queue rather than two. `curation-flags.ts` argues for this explicitly:
  listener reports were folded into the curator queue precisely because "two worklists is
  how a backlog goes unread."

### Card bodies

- `identity` — radio list of candidates, each with its rationale and evidence links; plus "none of these"
- `placement` — the two containers side by side; move vs. keep
- `duplicate` — A/B with fingerprint verdict, bitrate, format, and **containing-album size** (the "prefer the larger album" rule)
- `listen` — inline player seeked to the disputed region, with the competing labels as the options
- `batch` — count, sampled rows, one confirm

## 4. Applying a decision

Every effect dispatches to the **existing tested service**, never a second copy of the
logic — the pattern `routes/mcp.ts` already follows and that
`services/artist-origin-mutate.ts` documents as "the fifth instance of the shape".

| Effect | Service |
|---|---|
| set genre | `mutateSongGenre` (`mode: 'replace'`) |
| retag song artist/title/album | `mutateSongMetadata` |
| merge artist identity | `mutateArtistIdentity` |
| set artist origin | `mutateArtistOrigin` |
| delete a song / album | `deleteOne` / `deleteAlbum` |
| set album cover | `applyAlbumCover` |

### The durability rule, encoded not documented

Logged passes established a predictor: **a fix that writes the file tag survives; a fix
that only writes a DB row survives until something re-derives that value from the file.**
The concrete casualty was `fix_album_metadata`'s artist field against a contradicting file
tag — the IPAUTA album reverted on the next rescan because the files still carried
`album_artist: IPAUTA`.

Therefore: **an option whose apply path is known to revert must not be offered.** A
`placement` case dispatches the per-song file-tag write, never the album-row override. The
dispatch table owns this; it is not left to the caller to remember.

### Destructive gating

`duplicate` (delete) and `batch` options are marked `destructive` and require an in-card
confirm before applying — the same gate `destructive: true` MCP tools enforce via
`checkToolAccess`. Every apply writes a `recordAudit` row.

## 5. The dismissal loop

`Not a case` writes a durable dismissal keyed to the case identity. This is not scope
creep; it closes a gap already logged during a dedupe pass:

> "Rejected pairs keep re-appearing in the decidable list each stretch — nothing records
> that they were disproved. A durable 'not a duplicate' marker is missing."

It doubles as the measuring instrument the §2 gate needs: **dismissal rate per generator
is its measured precision.** A generator whose dismissal rate crosses a threshold is
demoted out of the queue automatically, so a bad predicate degrades gracefully instead of
quietly wasting rounds.

Concretely: a generator is demoted when its dismissal rate exceeds **50%** over a minimum
sample of **20 decided cases**. Both numbers are constants in one place, and the minimum
sample matters as much as the rate — demoting on the first three dismissals would be the
same "conclude from a sample" error §2 exists to prevent. A demoted generator is reported,
not silently dropped, so the demotion is a finding rather than a disappearance.

## 6. Surfaces to build

### Data model (`packages/api/src/db.ts`, idempotent bootstrap + `addColumnIfMissing`)

```sql
ALTER TABLE curation_flags ADD COLUMN case_kind    TEXT;    -- nullable
ALTER TABLE curation_flags ADD COLUMN options_json TEXT;    -- nullable

CREATE TABLE IF NOT EXISTS curation_case_dismissals (
  case_id      TEXT PRIMARY KEY,
  generator    TEXT NOT NULL,
  dismissed_by TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  note         TEXT
);
```

Both flag columns are nullable so existing prose-only flags keep working — they render as
a read-and-resolve card with no typed options, exactly today's behaviour.

Generated cases are **not** persisted; they are derived per request. Only dismissals
persist, which is what keeps a generated case from reappearing.

### API (`packages/api/src/routes/`)

| Route | Purpose |
|---|---|
| `GET /api/library/curation/round` | assemble and return one round (default 5 cases) |
| `POST /api/library/curation/cases/:id/apply` | body `{ optionId, confirm? }` → dispatch + audit |
| `POST /api/library/curation/cases/:id/dismiss` | durable dismissal |
| `GET /api/library/curation/count` | open-case count for the library entry card |

All `requireCurator`. Note the existing gap this also fixes: there is currently **no
curator-accessible GET for flags at all** — listing rides the admin-only `ServiceReview`
snapshot, so a curator who is not an admin cannot list flags over HTTP today.

### Services (`packages/api/src/services/curation/`)

- `case-model.ts` — the types above
- `case-sources.ts` — flag→case adaptation; the generator registry and the precision gate
- `round.ts` — pure round assembly (selection, ordering, kind-mixing)
- `apply.ts` — the pure dispatch table effect → service call

### Web (`packages/web/src/app/`)

- `pages/curate/curate.component.*` — the round shell: progress, skip, dismiss
- `pages/curate/cards/<kind>-card.component.*` — five card bodies
- `services/api/curation-api.service.ts`
- entry card in `pages/library/library.component.html`
- `ReviewFlagsPanelComponent` reduced to a link

## 7. Testing

- **Unit, pure**: round assembly (kind-mixing, ordering, dismissal exclusion) and the
  dispatch table. These are the risky parts and both are pure functions.
- **A gate asserting its own denominator**: a test pinning the §2 exclusion list, so a
  future change that admits `missing_artwork` into the queue fails loudly. This follows
  the repo's stated convention that gates assert their own denominator.
- **Durability test**: assert no offered option dispatches to a known-reverting path
  (the album-row artist override).
- **Web**: component tests on plain vitest, never `ng test`.
- **e2e**: one spec driving a full round end-to-end, with `data-testid` on every
  interactive element. Run `bun run e2e` before declaring done — this adds routes and
  DOM.

## 8. Build order

1. **Spine** — case model, typed flags, round UI, `identity` / `placement` / `listen`
   sourced from **flags only**. Ships against the five real open flags.
2. **Generators + dismissal loop** — genre proposals and fingerprinted duplicates first
   (best supply, best measured precision).
3. **Destructive kinds** — `duplicate` delete and `batch`, behind confirm gates.

Each phase is independently shippable and each is its own PR — PR granularity is
deployment granularity on this project.

**The implementation plan that follows this spec covers phase 1 only.** Phases 2 and 3
get their own plans once phase 1 is in use, because the round interaction is the part
most likely to change once it is actually driven against real flags.

## What shipped in phase 1

The spine from §8: case model, round assembly, apply dispatch, and the round UI — sourced from
flags only (no generators, no dismissal loop, no destructive kinds yet).

- **Endpoints** (`packages/api/src/routes/curation.ts`, all `requireCurator`):
  `GET /api/library/curation/round`, `GET /api/library/curation/count`,
  `POST /api/library/curation/cases/:id/apply`.
- **Components**: `CurateComponent` (`pages/curate/curate.component.ts`, the round shell) +
  `CaseCardComponent` (one case at a time); `CurationApiService`
  (`services/api/curation-api.service.ts`) is the HTTP client both use.
- **Reachability**: the route is `/library/curate`, `curatorGuard`'ed in `app.routes.ts`; an entry
  card on `LibraryComponent` (`auth.canCurate() && openCases() > 0`) links to it, and
  `ReviewFlagsPanelComponent` now links there too instead of hosting a second worklist.

## Risks

- **Generator precision is the whole ballgame.** If phase 2 admits a low-precision
  predicate, rounds become chores and the feature dies of disuse. The dismissal loop is
  the mitigation, and it must land *with* the first generator, not after it.
- **Scope.** This is a subsystem, not a panel. Phase 1 alone is a substantial change.
- **`fragments.duplicateAlbums` blindness** is known (it cannot see a split whose halves
  differ by artist) — the duplicate generator must not rely on it as its only source.
