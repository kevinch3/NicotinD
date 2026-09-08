# Acquisition pipeline timings — 2026-09

Evidence for the acquisition → landing optimization pass. The log lines this reads are defined in
[observability.md](../observability.md) "Acquisition pipeline timings"; they landed in 0.6.14
(`chore`, no bump) and reached prod on the 0.6.15 tag.

Read this before acting on any number here: **the only prod measurement is the curator's.** Prod has
had no acquisition traffic since the deploy, so every fetch/organize/scan number below comes from the
e2e fixture run and carries that run's distortions.

## Prod — full-library reclassify (kpc, 0.6.15, boot sweep)

```
Curator reclassified library   reason=full-sync
  albumsScanned 7454   songsScanned 20504   durationMs 179
  singles 4740 · albums 2174 · eps 271 · compilations 259 · hidden 1
```

Library size at the time: 7,454 albums / 20,530 songs / 2,596 release-meta rows / 8 acquisition jobs.

**179 ms is the whole-library cost**, and before this pass it was paid *once per ingest batch* at the
download seam. A 12-track album arriving in four batches spent ~0.7 s re-deciding 7,454 verdicts that
could not have changed, and the URL-acquire lane paid it twice per job. Worth stating plainly: 179 ms
is comparable to a *single* file's ffmpeg transcode, so this is not the pipeline's dominant cost — it
is unbounded-growth work at a per-file seam, which is why it is worth removing regardless of its
current size. The scoped path reads on the order of 14 rows for a 12-track album.

The second half of the win is not in this number: the unscoped pass also issued up to 7,454 `UPDATE`s,
almost all writing the value already in the row. `updated` in the new log line reports how many rows
actually changed.

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

## Decision gates

The gates were written into the instrumentation PR before any number existed, and are answered here.

| Item | Gate | Status |
| --- | --- | --- |
| parallel fetch within a job | `fetchSumMs / totalMs > 0.25` **and** `fetchSumMs / fetchMaxMs > 3` at the p90 job | **not met, not refuted** |
| cross-job fetch pipeline | p95 `queueWaitMs > 20 s` **and** jobs actually overlap | **not met** |

Neither gate is met by the evidence that exists. The fetch gate is missed by roughly 9× on share, and
the second half of it (`fetchSumMs / fetchMaxMs > 3`) is structurally unreachable in a single-file
job — it asks whether serial fetches of *several* files add up, and the fixture jobs have one file
each. That is a limitation of the sample, not an answer.

What is *not* a limitation of the sample: `docs/acquisition-addon-protocol.md` defines `fileReady` as
the bytes already being on the addon's disk, so core's fetch is a LAN `GET` against a sibling
container and peer slowness is absorbed addon-side. The original motivation for parallel fetch — "one
slow peer blocks every other addon" — was wrong on protocol grounds before any measurement, and no
measurement can revive it.

**Neither is scheduled.** Re-measure after real acquisition traffic reaches a 0.6.15+ prod: pull
`addon job ingest complete` from `docker logs` and append the rows here.

## What shipped from this pass

| Change | Type | Release |
| --- | --- | --- |
| the log lines above | `chore` | rode 0.6.15 |
| serialize the shared `LibraryOrganizer` (#1026) | `fix` | 0.6.15 |
| reclassify only the albums a scan touched | `perf` | this PR |
