# CLAUDE.md compression: measured floor (2026-09-04)

**Question asked:** reduce CLAUDE.md, then at 59,982 bytes — 92% of the 65,000-byte cap.

**Answer: it is already at its floor.** Three passes over the nine index subsections, 55 agents,
every result adversarially reviewed. The best correct outcome was **-0.9%**, and it came from
deleting entries for features that do not exist, not from compressing prose.

Read this before trying again.

## Why the obvious lever fails

The index has 163 entries; 68 of them (42%) link to just four docs — `web-ui.md` (24),
`library-scanner.md` (17), `design-patterns.md` (14), `download-pipeline.md` (13). That looks like
massive duplication: the file's own header says an entry answers *"where does this live"*, and here
is one answer given 68 times.

It is not duplication. **Sharing a doc is not describing the same mechanism.** Merging on that signal
is what caused every high-severity defect below.

## The three passes

| Pass | Shape | Result | Defects found by review |
|---|---|---|---|
| 1 | Merge co-filed entries aggressively | sections 48,258 → 32,883 (**-32%**) | **48 invented claims** (16 high-severity), **90 meaning inversions**; 3 of 9 sections rejected outright |
| 2 | Repair pass 1, correctness ranked above bytes | → 47,192 (**-2%**) | 4 sections restored byte-identical — the agents attempted no compression at all |
| 3 | No merging, entry count frozen, trim within entries | → 46,624 (**-1.1%**) | 5 qualifiers lost across the 6 sections audited before the run hit a session limit |

Pass 3 is the honest measurement of the marginal rate: **~100 bytes per rule destroyed.**

## The two failure signatures

**1. Fusing entries about different mechanisms.** Nearly every high-severity finding was two
unrelated facts welded into one sentence asserting a relationship neither original made:

- pre-migration snapshots inherited the daily backup's "newest N" prune — the original says they land
  *outside* it
- cover-cache eviction (a grace-period orphan sweep) joined to write-time cache invalidation
- the in-core `AcquisitionCandidate` model welded to the external HTTP addon protocol, so "a new
  source is one adapter + a pure mapper" read as though it meant writing one *using*
  `validateAddonManifest` / `RemoteAddonPlugin`

**2. Compression strips qualifiers, and qualifiers are where the rules live.** The sentence survives
and reads fluently; the constraint evaporates. Measured losses:

| Removed | Rule that went with it |
|---|---|
| `deliberately` (no FK cascade) | the absent cascade became a schema *omission* — a reader is free to add `ON DELETE CASCADE`, which wipes every embedding/analysis/lyrics row on each rescan |
| `on a confident match` | watchlist auto-hunt became unconditional |
| `not just failed ones` | retry scope became undefined |
| `album titles never judged` | the exact bug the reserved-path rule exists to prevent |
| `landing outside the daily rotation` | a prune now applies to snapshots it must not touch |
| `the external spotdl addon` | a pinned deployment became ambiguous |
| `every album carries a classification` | an invariant became a description of behaviour |
| `one list` (merged playlists page) | satisfied by the two-section layout the entry forbids |
| `first-class` (Songs tab) | Songs left the denominator when "the Library tabs" get a change |

Nine independent agents each reported 10–20 phrases they were **tempted to cut and kept** on
inspection, against 5–22 entries per section they could find nothing safe to touch in at all.

## Corroborating check

The file's own header forbids "rationale, issue narratives, prod numbers, trade-off discussion"
inside an entry. Grepping the 163 entries for issue refs, dates, percentages and row counts returns
**2 hits — one of which is a doc filename.** The 2026-08 restructure (186 KB → 50 KB) already took
everything the doctrine allows removing.

## What was shipped

Only what survived review: the four **proposed-but-never-built** entries (Peer Share, hardware cast,
WebMCP, OAuth) folded into one `Proposed, NOT built` entry carrying all five of their doc links.
163 → 160 entries, 59,982 → 59,451 bytes. Plus two factual corrections found while rewriting the
entries around them, both verified against code: `origin` restored to the Smart-radio axis list, and
the `GET /api/radio/next` antecedent made explicit in Filter-seeded radio.

`MAX_FILE_BYTES` was **not** lowered — there is no reduction to lock in.

## If the file must actually shrink

Compression is exhausted; only **relocation** remains. Move the index body to a `docs/` page read on
demand, leaving CLAUDE.md as the header, Commands, Architecture and one line per doc (~12 KB). That
deletes nothing — it trades a per-request cost for one file read per task, and gives up having the
grep-able symbol map always in context. That trade is a real architectural decision about how this
repo talks to Claude, and it is the only lever left that does not cost correctness.

## Method

Verification that ran mechanically, not by agent judgement, because an LLM diffing two 9 KB texts for
a missing backtick is not a check:

- **link-set diff** against the pre-edit set. `brokenDocLinks()` only asks whether the links it *sees*
  resolve — a deleted subsection passes it perfectly. The denominator has to be the before-set.
- **symbol-set diff in both directions.** Lost symbols are the obvious risk; *invented* ones are the
  dangerous one.
- `MIN_PLAUSIBLE_ENTRIES` guards the same trap one level up: an edit that changed the `- ` bullet
  convention would make every size check pass on nothing, so the file would look fixed precisely
  because the gate went blind.
