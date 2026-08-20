# Genre stations — prod measurement (formula v3 → v4)

Companion to [../radio.md](../radio.md) "Stations (filter-seeded radio)". v3's
station grading shipped argued **from mechanism**, not from data. This file is
where the data went: the protocol below was run against the real library, it
confirmed two of v3's three claims, **falsified one of its constants**, and the
resulting one-constant change is v4. Every "not yet measured" row that used to
be here now carries a number or an explicit "unfalsifiable on this library".

## Status

Run **2026-08-20** against the prod deploy host (`kpc`), on the nightly
`VACUUM INTO` snapshot (`backups/nicotind-20260820-040057`, 15,162 landed songs,
16,121 embeddings, one model). Every figure below comes from replaying the
**real** `buildFilterRadio` / `explainSimilarity` / `stationAffinity` against
that snapshot — no re-implementation, per the repo's replay habit
(`album-hunter.replay.test.ts`). The eight chips are `getGenres()` top-8, which
is what the landing page renders.

| Claim (as v3 shipped it)                                             | Verdict                            |
| -------------------------------------------------------------------- | ---------------------------------- |
| The genre axis is a constant on a genre station                       | **Confirmed on prod** — 300/300 of an Electronic pool would score 1.00 on the plain axis |
| `buildFilterRadio` never loaded embeddings                            | **Confirmed** — and now that it does, it changes 0–2 of the served 10 |
| The centroid's modal primary genre can differ from the requested one   | **Not reproduced on prod** — the centroid agreed with the chip on 8 of 8. Still a real inversion (reproduced synthetically); this library does not trigger it |
| The grading orders a real station better                              | **Half true.** It orders the *pool* (widest-spread axis on 6 of 8 chips) but **not the served window**: sd 0.000 across the top 10 on 5 of 8 chips |
| `DEPTH_CREDIT` is right                                               | **Unfalsifiable here** — five curves move the served top-10 by 0–2 of 10 |
| `SHARE_REFERENCE` (0.5) is right                                      | **Wrong, and the cause of the defect above** — fixed in v4 |
| `DEPTH_WEIGHT` (0.5) is right                                         | **Unfalsifiable here** — 0.25–0.75 are identical on the served list |
| `ANCHOR_FRACTION` (0.4) is right                                      | **Inert** — 0.2–1.0 all within cos 0.987, served list unchanged on 8 of 8 |

## Results

### Pool composition (the eight chips)

| Chip | eligible | primary tag | 2nd | 3rd+ | artist share <10% | share ≥50% | corr(depth, share) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pop | 2,970 | 60% | 11% | 29% | 2.4% | 75% | 0.23 |
| Rock | 2,659 | 59% | 12% | 29% | 1.8% | 77% | 0.15 |
| Latin | 2,136 | 61% | 26% | 13% | 3.2% | 64% | 0.13 |
| Electronic | 1,301 | 55% | 15% | 30% | 2.7% | 63% | 0.27 |
| Reggae | 668 | 78% | 10% | 12% | 2.7% | 74% | 0.58 |
| Alternative Rock | 701 | 56% | 15% | 29% | 2.5% | 50% | 0.06 |
| Hip Hop | 654 | 57% | 11% | 33% | 2.5% | 74% | 0.38 |
| Cumbia | 486 | 78% | 13% | 9% | 1.0% | 86% | 0.51 |

The protocol below calls the `<10%` bucket "the headline number for the reported
complaint" and pre-registers what a near-zero reading means: the artist-share
half is not earning its keep. It reads **1.0%–3.2%**. Share is kept anyway — its
correlation with depth is 0.06–0.58, so it is not a redundant copy of the other
half — but it must not be the half that decides the list.

### Where the axis acts (the v4 defect)

| Chip | pool tied at affinity ≥0.99 | station-axis sd across the SERVED top-10 | what actually orders the served top-30 |
| --- | --- | --- | --- |
| Pop | 50.7% | **0.000** | key 2.24, bpm 1.42, origin 1.35 |
| Rock | 45.7% | **0.000** | key 1.75, bpm 1.37, station 0.88 |
| Latin | 43.0% | **0.000** | origin 1.63, key 1.55, bpm 1.21 |
| Electronic | 38.3% | 0.060 | origin 3.02, key 2.34, station 1.27 |
| Reggae | 65.3% | 0.055 | origin 2.44, key 1.80, station 1.67 |
| Alternative Rock | 23.0% | 0.049 | origin 2.89, station 2.39, key 1.72 |
| Hip Hop | 45.0% | **0.000** | key 2.48, bpm 1.42, origin 1.21 |
| Cumbia | 74.7% | **0.000** | key 2.44, origin 1.79, bpm 1.07 |

`spread` = axis weight × sd of its value over the tracks in question — the axis's
*usable* discrimination, not its nominal range. Five chips serve ten tracks that
all score exactly 1.00 on the axis introduced to order them.

### After v4 (artist share used raw)

| Chip | tied ≥0.99 | served-top-10 sd | station in the served top-3 forces |
| --- | --- | --- | --- |
| Pop | 50.7% → **27.7%** | 0.000 → 0.004 | no |
| Rock | 45.7% → **11.7%** | 0.000 → 0.035 | **yes** (1.89, #1) |
| Latin | 43.0% → **23.0%** | 0.000 → 0.084 | **yes** (2.42, #1) |
| Electronic | 38.3% → **24.0%** | 0.060 → 0.008 | **yes** (2.50, #2) |
| Reggae | 65.3% → **19.3%** | 0.055 → 0.075 | **yes** (2.44, #2) |
| Alternative Rock | 23.0% → **8.3%** | 0.049 → 0.099 | **yes** (2.64, #2) |
| Hip Hop | 45.0% → **24.7%** | 0.000 → 0.035 | no |
| Cumbia | 74.7% → **22.3%** | 0.000 → 0.038 | **yes** (1.64, #3) |

Honest caveats: Pop (0.004) and Electronic (0.008) are still close to a tie — the
two broadest tags, where most of the pool really is primary-tagged by dedicated
artists, so there may be little left to order. And these are single draws of a
random 300-row sample; the direction is consistent across all eight, the
per-chip second decimal is not.

Design intent, re-checked on the real pool (mean affinity by archetype):

| Archetype | v3 | v4 |
| --- | --- | --- |
| primary tag, artist ≥80% of the genre | 1.00 | 0.96–0.99 |
| primary tag, artist 20–40% ("the Madonna case") | 0.79–0.82 | 0.64–0.66 |
| 3rd+ tag, artist <10% ("the Queen case") | 0.30–0.31 | 0.26–0.27 |

### Constants that were measured and left alone

| Constant | Sweep | Effect on the served top-10 |
| --- | --- | --- |
| `DEPTH_CREDIT` | `[1,.8,.6,.5]` · `[1,.7,.45]` · `[1,.6,.3]` · `[1,.7,.45,.3,.2,.15]` · `[1,.5,.2,.1]` | 0–2 of 10 |
| `DEPTH_WEIGHT` | 0 / 0.25 / 0.5 / 0.75 / 1 | 0 of 10 within 0.25–0.75; 1–2 at the extremes |
| `ANCHOR_FRACTION` | 0.2 / 0.4 / 0.7 / 1.0 | 0 of 10; anchors within cos 0.987 |
| anchor trim pass | on / off | 0–1 of 10; anchor moves cos 0.97–0.99 |
| `embedding` weight | 8 / 0 | 0–2 of 10 |

The served window is drawn almost entirely from primary-tagged tracks, so every
constant that only shapes the tail is invisible to a listener on this library.
Changing them would have been a version bump that moved no music.

### Station churn and stability

- v2 → v3 ordering: **3–8 of 10** top-10 survivors, Kendall τ **0.57–0.80** over
  the pool. The grading is not cosmetic.
- Two consecutive taps of the same chip share **0.02–0.25** of their top 10
  (Jaccard) — the pool is `ORDER BY RANDOM() LIMIT 300` out of up to 2,970
  eligible tracks. The *sound target* is stable across those draws (anchor cos
  0.99), the tracklist is not. That is variety by construction, but it also means
  a station's ranking quality is bounded by a sampler nobody has evaluated — and
  that the sampler's churn is the same order of magnitude as every formula change
  measured here, so the two are hard to tell apart without many repeats. Filed as
  **#598**.

### Unexplained, and larger than anything above

**Artist origin (weight 8) is the #1 or #2 ordering force inside the served
window of every chip** (spread 1.21–3.21, versus the station axis's 0.88–2.64
pre-v4). `DEFAULT_WEIGHTS` describes origin as "a starting point pending a
dump-radio A/B" — this is that A/B, and it says a genre station is substantially
ordered by how close a candidate's artist nationality is to the pool's. Whether
that is a feature (a Cumbia station leaning Colombian/Argentine) or a bug (an
Electronic station leaning by passport) is a product decision, not a measurement,
and it is left open deliberately — filed as **#597**. Camelot key (weight 6,
spread 1.53–2.48) is the same question in a different key: harmonic mixing is a
DJ-set property, and a station is not a DJ set. Both axes are shared with seed
radio, which *is* vote-calibrated (v2, 70 votes), so neither can be retuned on a
station measurement alone.

## Protocol — run this on the deploy host

The landing page's chips are `getGenres()` top-8 by `song_count`, so measure
exactly those. Read-only; opens `<dataDir>/nicotind.db` directly.

```bash
# per chip
bun run packages/api/src/scripts/dump-radio.ts --genre "Electronic" --count 20 \
  --out /tmp/station-electronic.md
```

Read the **Station health** block. What each line decides:

- `station affinity across the SERVED n` — **the first line to read.** Under
  0.01 and the axis is gating the pool without ordering it (the v4 defect).
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

## Reproducing this

The harness is not in the repo (it is a read-only replay of shipped functions,
not a shipped tool). To redo it: stage the nightly backup, then for each chip
call `buildFilterRadio` once and re-score the returned pool under each variant —
one process, one pool, many scorings, because `ORDER BY RANDOM() LIMIT 300`
makes N separate CLI runs incomparable. The shipped `dump-radio.ts --genre <G>`
now prints the single number that catches the v4 defect on its own:

```
station affinity across the SERVED 20: mean 0.928 sd 0.095
```

An `sd` under 0.01 prints `GATING, NOT ORDERING` — the axis decided who is in
the pool and nothing about who gets played.

## Then calibrate against humans

v3/v4 remain the station formula that **no human has voted on**. Prod holds four
polls, all seed-radio, all v2; `eval-radio-poll.ts` groups by `formula_version`
so they can never be pooled with a station vote. Creating a station poll (Admin →
Radio polls → "Station scenarios": `Electronic, Rock, Cumbia, …`) is the next
step, and it is the only thing that can settle the two open questions above.
