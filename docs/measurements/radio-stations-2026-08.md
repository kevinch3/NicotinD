# Genre stations — measurement protocol and status (formula v3)

Companion to [../radio.md](../radio.md) "Stations (filter-seeded radio)". The
station grading shipped in v3 is argued **from mechanism**, not from data — this
file is where the data goes, and it is deliberately honest about which numbers
exist today.

## Status

| Claim                                                              | Evidence today                     |
| ------------------------------------------------------------------ | ---------------------------------- |
| The genre axis is a constant on a genre station                     | **Proven from the code** — pool membership is the genre test; verified on a synthetic pool (17/17 scored 1.00) |
| `buildFilterRadio` never loaded embeddings                          | **Proven** — `loadEmbeddings` had two call sites, neither on this path |
| The centroid's modal primary genre can differ from the requested one | **Reproduced synthetically** (a 4:1 Pop-primary pool tagged Electronic yields a `Pop` centroid); **not yet measured on the real library** |
| The grading orders a real station better                            | **Not yet measured on the real library.** Synthetic only |
| The chosen constants (`DEPTH_CREDIT`, `SHARE_REFERENCE`, `DEPTH_WEIGHT`, `ANCHOR_FRACTION`) are right | **Not measured.** No station vote existed to tune against — the poll harness could not generate one until v3 |

Nothing in this table is a reason not to have shipped the three defects' fixes:
a constant axis, a never-loaded axis and an inverted seed genre are wrong
independent of any tuning. The *constants* are the part awaiting evidence.

## Protocol — run this on the deploy host

The landing page's chips are `getGenres()` top-8 by `song_count`, so measure
exactly those. Read-only; opens `<dataDir>/nicotind.db` directly.

```bash
# per chip
bun run packages/api/src/scripts/dump-radio.ts --genre "Electronic" --count 20 \
  --out /tmp/station-electronic.md
```

Read the **Station health** block. What each line decides:

- `centroid modal primary genre` — if it prints `← NOT the requested genre`, the
  pre-v3 inversion was live for that chip, and the seed-genre fix alone changed
  that station's ranking.
- `plain genre axis would score 1.00 for: N/M` — the constant-axis proof. Near
  100% means the whole genre weight was idle on that station before v3.
- `tag depth` — how much of the pool is primary-tagged. A chip that is ~all
  primary needs little from depth; one with a long secondary/deeper tail is
  where the grading does its work.
- `artist catalogue share` — the **headline number for the reported complaint**:
  the "under 10%" bucket is the Queen-on-an-Electronic-station population. If it
  is near zero on every chip, the artist-share half of the blend is not earning
  its keep and `DEPTH_WEIGHT` should move toward depth.
- `embedding coverage` — how much of the newly-live axis has data. Low coverage
  means the anchor is built from a thin slice and the audio half of v3 is mostly
  inert until the enrichment backfill catches up.

Then compare the ranked top-20 before and after by re-running with the axis
neutralised:

```bash
# "before" ≈ the pre-v3 ordering: genre weight idle, no anchor
bun run packages/api/src/scripts/dump-radio.ts --genre "Electronic" --weights genre=0
```

Compare the **ranked output**, not the pool-coherence percentage —
[../radio.md](../radio.md) records why that metric inverts across a
genre-specificity change.

## Then calibrate against humans

v3 is the first formula whose station half can be voted on. Create a poll whose
station scenarios are the landing chips (Admin → Radio polls → "Station
scenarios": `Electronic, Rock, Cumbia, …`), collect votes, then:

```bash
bun run packages/api/src/scripts/eval-radio-poll.ts
bun run packages/api/src/scripts/eval-radio-poll.ts --weights genre=24
```

Results group by `formula_version`, so station votes (v3) can never pool with
the 70 seed-radio votes that produced v2.

## Synthetic validation (what has actually been run)

A 36-track fixture — a 100%-Electronic producer, a rock band with one
third-position Electronic tag, and a pop artist with three genuine
Electronic-primary records — through the real `buildFilterRadio`:

| Track                                    | Depth | Artist share | Affinity | Score |
| ---------------------------------------- | ----- | ------------ | -------- | ----- |
| Calvin-analogue (Electronic primary)      | 1.00  | 1.00         | 1.00     | 0.979 |
| Madonna-analogue (Electronic primary)     | 1.00  | 0.30         | 0.80     | 0.871 |
| Queen-analogue (Electronic 3rd, rock act) | 0.45  | 0.14         | 0.37     | 0.562 |

The middle row is the design intent, not a compromise: a genuinely electronic
record by a mostly-pop artist places, and the footnote-tagged rock track is
demoted rather than excluded.
