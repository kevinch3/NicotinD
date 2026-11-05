# Acquisition errors — 2026-11

Why does **Complete album** / **Get album** still fail, and why does "waiting a while and retrying"
help? This page is the baseline the fixes are measured against: #1625 (hunt queue), addon #24
(abandoned hunts), addon #26 (reason-blind retries). Re-measure after each deploy, using the same
method.

**Short answer (2026-11-05, v0.8.121):** there are two different failures with two different
mechanisms.

1. **Click-time failures (37% of hunts) are a queue, not the network.** Every one of them was core's
   55 s budget running out while the hunt was still *waiting its turn*. A cool-down helped because
   it let the queue drain. The fix is to stop billing queue wait to the hunt, not to pick a better
   delay.
2. **Download-time failures are mostly retries that cannot succeed.** Of retried transfers, 91% gave
   up after 3 same-peer retries. The largest reason, `File not shared`, never succeeds on the same
   peer. Choosing a retry delay from data needs the failure reason recorded per attempt, which
   nothing records today.

## Method

All read-only, on kpc. `docker logs -t --since 48h` was captured for `nicotind-nicotind-1` (13 h
since its restart at 08:58 UTC), `nicotind-slskd-addon-1` and `nicotind-slskd-1`. Both NicotinD
containers printed pino-pretty multi-line text (`NODE_ENV` unset), so a parser regrouped each record
from its header line and its 5-space-indented field lines before counting. After #1626 and addon
#24 the logs are JSON lines, and this becomes `jq`.

A hunt's start = its end timestamp − `durationMs` (`addon hunt completed` / `addon hunt failed`).
"Hunts ahead" = other hunts whose [start, end) interval contains this hunt's start.

## 1. Click-time: hunt failures by queue depth

70 hunts in 13 h; **26 failed, all with `addon at http://slskd-addon:8585 timed out: POST
/addon/v1/albums/search` at 55.0–55.3 s** (`INTERACTIVE_HUNT_TIMEOUT_MS`).

| hunts already in flight at start | n | failed |
| --- | --- | --- |
| 0 | 23 | **0 (0%)** |
| 1 | 14 | 6 (43%) |
| 2 | 10 | 4 (40%) |
| 3 | 8 | 5 (62%) |
| 4 | 7 | 5 (71%) |
| 5–8 | 8 | 6 (75%) |

Successful hunts: p10 10.5 s, p50 22.6 s, p90 46.6 s. 4 of the 44 returned 0 candidates.

They came in bursts (a "burst" here is starts less than 120 s apart; `X` = failed):

```
15:18:40  n=14  .XXXXXXXXXX...      21:43:46  n=14  ..XXXXXXXXXXXX
15:48:45  n=10  .....XXX.X          (15:23 n=16, 15:45 n=5, 20:44 n=4, 21:40 n=7: no failures)
```

**Live reproduction, 22:06–22:09 UTC.** All on La Vela Puerca's artist page:

- 2 Complete album clicks, back to back: 12.4 s, then 24.3 s → both 200 and enqueued.
- Then 7 Get album clicks in a burst. `hunt/base` (browser resource timing):

| hunt # in burst | duration | status |
| --- | --- | --- |
| 1 | 12.4 s | 200 |
| 2 | 22.3 s | 200 |
| 3 | 34.5 s | 200 |
| 4 | 45.5 s | 200 |
| 5, 6, 7 | 55.1 s | **504** — "Search failed for …", no reason, no retry |

A base-only hunt holds the source's two search lanes ~11 s, and the addon's `SearchLanes` runs one
hunt at a time. So hunt *k* ends at ~11·*k* s, and the 5th missed the budget by about a second.
slskd's own log shows *El impulso*'s searches completing at 22:08:01, the second core gave up. The
results existed and were thrown away. *La Vela Puerca* and *Deskarado* then searched at 22:08:18 and
22:08:34, for callers that had already gone (addon #24).

**The redundant base query (addon #25).** The base wave sends `"A B"` and `"A - B"`. Over 48 h,
108 of 110 such pairs returned response counts within 10% of each other (86 identical). If the
second query adds no folders, one query per hunt would let two hunts share the two lanes. Equal
counts are not equal folders, so per-query candidate attribution comes first.

## 2. Download-time: same-peer retries

Addon, 48 h. A transfer that failed at least once was re-enqueued on the **same** peer, up to 3
times, 60 s apart.

| outcome of a failed transfer | n |
| --- | --- |
| completed after 1 / 2 / 3 retries | 2 / 5 / 1 (**8, 7%**) |
| gave up after 3 retries | **111 (91%)** |
| unknown (window edge) | 3 |

- 44 of the 111 give-ups were within ±5 min of a `Soulseek source offline` warning, so outages spent
  the attempts. The addon logged 104 offline warnings; slskd logged 87 `Disconnected … wait timed
  out after 5000 ms`.
- All-time `transfer_retries`: 783 of 798 rows have `gave_up = 1`. Rows are deleted on success, so
  this table alone cannot measure whether retrying works.
- slskd's failure reasons (`Download of … failed: <reason>`): `File not shared` 564, `The wait
  timed out` 118, `Overwhelmed with requests; try again later` 66, `Too many files` 64,
  `Verification required` 14, `operation was canceled` 13.
- For the 8 that recovered, the last re-enqueue → completion took 94 s at p50 and 259 s at p90.

## 3. What could not be measured, and why

These gaps are #1626 / addon #24 / addon #26:

- A failed tile hunt left no DB row, no audit row, and a log line with no album id.
- No log line carried the hunt's queue wait or wave count, so the "hunts ahead" column above had to
  be reconstructed from overlapping intervals.
- The download-failure *reason* lives only in slskd's own log, unjoined to the retry that followed
  it. So "success vs retry delay, by reason" (the curve a cool-down should be chosen from) is not
  computable from anything the system keeps.

## Re-measure

After #1625 deploys: in the same core logs, "failed with ≥ 1 hunt ahead" should go from ~55% to ~0,
and a failure that remains should be a real timeout of a *running* hunt (`Queued album hunt
failed`, with its `queuedMs`/`searchMs`). After addon #24: no `hunt summary` with `aborted: true`
should be followed by searches for that album.
