# Acquisition pipeline timings — 2026-09

Evidence for the acquisition → landing optimization pass. The log lines this reads are defined in
[observability.md](../observability.md) "Acquisition pipeline timings"; they landed in 0.6.14
(`chore`, no bump) and reached prod on the 0.6.15 tag.

**Settled on 2026-09-08 at 0.6.17.** Real acquisition traffic finally reached an instrumented prod and
produced 18 ingest receipts on 13-93 MB jobs. Both throughput gates are now answered from production,
and both are refuted. The fixture section below is kept because it was the evidence at the time, and
because it turned out to predict the prod ratio almost exactly.

## Prod — full-library reclassify (kpc, 0.6.15, boot sweep)

```
Curator reclassified library   reason=full-sync
  albumsScanned 7454   songsScanned 20504   durationMs 179
  singles 4740 · albums 2174 · eps 271 · compilations 259 · hidden 1
```

Library size at the time: 7,454 albums / 20,530 songs / 2,596 release-meta rows / 8 acquisition jobs.

The same sweep on 0.6.16, after the scoping PR landed:

```
Curator reclassified library   reason=full-sync  scope=all  updated=0
  albumsScanned 7454   songsScanned 20502   durationMs 75
```

| full-sync boot sweep | albums | songs | `updated` | durationMs |
| --- | --- | --- | --- | --- |
| 0.6.15 | 7,454 | 20,504 | n/a (field did not exist) | 179 |
| 0.6.16 | 7,454 | 20,502 | **0** | **75** |

One sample each, same host and same library, so read ~2.4x as approximate. The read work is identical
between the two rows and the only work removed is the no-op writes, so the ~104 ms belongs to them.

**`updated: 0` is the finding.** Every one of the 7,454 rows already held the verdict the classifier
re-derived for it, which is what the steady state should look like and what the guard was written
for. Before it, that sweep issued 7,454 `UPDATE`s into the WAL to write values that were already
there. `scope: "all"` confirms the boot sweep correctly stays unscoped.

**179 ms was the whole-library cost**, and before this pass it was paid *once per ingest batch* at the
download seam. A 12-track album arriving in four batches spent ~0.7 s re-deciding 7,454 verdicts that
could not have changed, and the URL-acquire lane paid it twice per job. Worth stating plainly: 179 ms
is comparable to a *single* file's ffmpeg transcode, so this is not the pipeline's dominant cost — it
is unbounded-growth work at a per-file seam, which is why it is worth removing regardless of its
current size. The scoped path reads on the order of 14 rows for a 12-track album.

The second half of the win is not in that number, and turned out to be the larger half — see the
0.6.16 row above.

## Local (e2e fixtures) — per-job split

Three single-file jobs from one `bun run e2e` run. Fixtures are 8–13 KB silent FLAC fetched over
loopback, so **the fetch share here is a floor, not an estimate** — real acquisitions move 30–50 MB
per track over the container LAN.

| addon | files | totalMs | fetchSumMs | organizeMs | scanMs | fetch share |
| --- | --- | --- | --- | --- | --- | --- |
| `fixture-addon` | 1 | 180 | 5 | 159 | 9 | 2.8% |
| `fixture-hunt-addon` | 1 | 133 | 2 | 124 | 4 | 1.5% |
| `fixture-discard-addon` | 1 | 145 | 4 | 133 | 6 | 2.8% |

`queueWaitMs` and `queueDepth` were `0` on every job — no ingest ever waited behind another.

Inside `organizeBatch`, the transcode is nearly all of it:

| files | ms | transcoded | transcodeSumMs | share of organize |
| --- | --- | --- | --- | --- |
| 1 | 159 | 1 | 146 | 92% |
| 1 | 123 | 1 | 80 | 65% |
| 1 | 133 | 1 | 83 | 62% |
| 2 | 348 | 2 | 327 | 94% |

## Prod — per-job split (0.6.17, 18 receipts, slskd)

The measurement the whole pass was waiting on. Real album downloads, 13-93 MB of audio per job.

| totalMs | fetchSumMs | fetchMaxMs | organizeMs | scanMs | MB | fetch share | sum/max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4555 | 876 | 876 | 3210 | 465 | 21.8 | 19.2% | 1.00 |
| 2539 | 55 | 55 | 2049 | 432 | 13.8 | 2.2% | 1.00 |
| 6348 | 139 | 70 | 5636 | 570 | 45.4 | 2.2% | 1.99 |
| 8280 | 151 | 77 | 7673 | 454 | 59.3 | 1.8% | 1.96 |
| 8709 | 146 | 68 | 8099 | 463 | 53.2 | 1.7% | 2.15 |
| 10162 | 176 | 68 | 9542 | 440 | 62.5 | 1.7% | 2.59 |
| 9890 | 162 | 67 | 9293 | 431 | 66.7 | 1.6% | 2.42 |
| 11650 | 196 | 109 | 10998 | 444 | 77.1 | 1.7% | 1.80 |
| 10368 | 237 | 99 | 9720 | 409 | 93.4 | 2.3% | 2.39 |
| 10662 | 235 | 96 | 10066 | 359 | 91.7 | 2.2% | 2.45 |

(10 of 18 shown; the rest sit inside the same range.)

- **fetch share**: min 1.6%, **median 2.2%**, p90 3.5%, max 19.2%
- **`fetchSumMs / fetchMaxMs`**: median 1.96, p90 2.45
- **`queueWaitMs` and `queueDepth` were 0 on all 18** — no ingest ever waited behind another
- **organize is 90-95% of every job**

The single 19.2% outlier is a single-file fetch (`sum == max`), so it carries no evidence about serial
fetches accumulating.

Worth noting against the fixture section above: the loopback fixtures measured 1.5-2.8% fetch and were
called "a floor, not an estimate" because real acquisitions move 30-50 MB per track. They do — and at
93 MB the fetch is still 2.3%. The fixture number was not a floor; it was simply right, because
`fileReady` means the transfer already happened addon-side and core only does a LAN read.

## Decision gates

The gates were written into the instrumentation PR before any number existed, and are answered here.

| Item | Gate | Status on prod (0.6.17, n=18) |
| --- | --- | --- |
| parallel fetch within a job | `fetchSumMs / totalMs > 0.25` **and** `fetchSumMs / fetchMaxMs > 3` at the p90 job | **REFUTED** — p90 share 3.5% (needs >25%), p90 sum/max 2.45 (needs >3) |
| cross-job fetch pipeline | p95 `queueWaitMs > 20 s` **and** jobs actually overlap | **REFUTED** — `queueWaitMs` 0 on every receipt |

Both halves of the fetch gate fail on real multi-file jobs, and this time the sample can speak to the
second half: `sum/max` near 2 means a multi-file job's serial fetches add up to about twice the slowest
one, nowhere near the 3× that would make pooling them worth the concurrency. The share gate is missed
by roughly 7× at p90.

**PR 4 is cancelled, on evidence rather than on argument.** Its original motivation had already died on
protocol grounds; this is the number that would have been needed to revive it, and it does not.

What is *not* a limitation of the sample: `docs/acquisition-addon-protocol.md` defines `fileReady` as
the bytes already being on the addon's disk, so core's fetch is a LAN `GET` against a sibling
container and peer slowness is absorbed addon-side. The original motivation for parallel fetch — "one
slow peer blocks every other addon" — was wrong on protocol grounds before any measurement, and no
measurement can revive it.

**Neither is scheduled, and neither should be revisited without a change to the pipeline's shape.**
The place to spend effort is `organizeMs` — 90-95% of every job, dominated by the inline
`transcodeToOpus` ffmpeg encode.

## What shipped from this pass

| Change | Type | Release |
| --- | --- | --- |
| the log lines above | `chore` | rode 0.6.15 |
| serialize the shared `LibraryOrganizer` (#1026) | `fix` | 0.6.15 |
| reclassify only the albums a scan touched | `perf` | 0.6.16 |
| record the surviving copy when dedupe collapses a file (#1032) | `fix` | 0.6.17 |
