# genre-audio confidence threshold — prod measurement

Companion to [../library-processing.md](../library-processing.md) and
[../audio-ml-enrichment.md](../audio-ml-enrichment.md). `GENRE_AUDIO_CONFIDENCE_THRESHOLD`
(`packages/api/src/services/enrichment/tasks.ts`, env `NICOTIND_GENRE_AUDIO_CONFIDENCE`,
default `0.5`) shipped with its own comment admitting the number was a guess:

> the right value is genuinely an open question this PR can't fully settle until real
> confidence data comes in from a deployed sidecar. 0.5 is a conservative starting default
> for a 400-way classifier.

The data has now come in. **Conclusion: keep 0.5** (issue #780).

## Status

Run **2026-08-28** against the prod host (`kpc`), read-only via
`prod-probe.ts --sql`. The confidence of every rejected inference is parsed out of
`library_song_analysis_failures.last_error` for `task = 'genre-audio'`
(`genre confidence 0.NN below threshold`), so this is the classifier's **own** score
on this library's own long tail, not a benchmark corpus.

n = **2,140** rejected inferences with a recorded confidence. Mean **0.252**.

## The distribution

| Confidence | Rejections | Cumulative ≥ |
| ---------- | ---------- | ------------ |
| 0.50       | 10         | —            |
| 0.40–0.49  | 283        | ≥0.45: 135   |
| 0.30–0.39  | 453        | ≥0.40: 293   |
| 0.20–0.29  | 614        | ≥0.35: 497   |
| 0.10–0.19  | 674        | —            |
| 0.03–0.09  | 106        | —            |

A smooth low hump peaking at **0.10–0.29** (1,288 of 2,140 rejections, 60%), thinning
monotonically toward the cutoff. **There is no cluster of nearly-confident predictions
piled up just under 0.5** — the shape a badly-placed threshold produces.

## Why 0.5 stays

Relaxing the cutoff buys little and costs durably:

- 0.45 admits ~135 songs, 0.40 ~293 — against **378** songs still genre-less on prod.
  Even the aggressive move clears well under half the backlog.
- Those are top-1 softmax scores from a **400-way** classifier. At 0.4 the model is
  saying "this is my best of four hundred, and I am 40% sure" — close to noise.
- A `genre-audio` write is **durable**: it writes a `library_genre_overrides` row the
  scanner re-applies on every rescan. A wrong genre admitted here does not wash out on
  the next scan; a curator has to find and replace it.

The classifier is not being gated out by a bad threshold. It is confidently unsure about
this material.

## What this number is a property of

The **model**, not the codebase. Re-measure — do not re-argue — if the Essentia sidecar's
genre model is ever changed. The query that produced the table above:

```sql
SELECT CAST(CAST(SUBSTR(last_error, 18, 4) AS REAL) * 10 AS INT) AS decile, COUNT(*) n
  FROM library_song_analysis_failures
 WHERE task = 'genre-audio' AND last_error LIKE 'genre confidence%'
 GROUP BY decile ORDER BY decile;
```

## The backlog this came out of

The threshold was questioned while asking why ~400 songs remain genre-less. They are the
**residue after all three automated lanes ran to their `fail_count` cap of 3** — `genre`
(Lidarr) 2,632 ledger rows, `genre-audio` 2,142, `genre-discogs` 1,324. The backlog is
not neglect and no threshold tweak meaningfully clears it; the remaining wins are
curator judgment, one artist at a time.
→ [curation-pass-2026-08.md](curation-pass-2026-08.md)
