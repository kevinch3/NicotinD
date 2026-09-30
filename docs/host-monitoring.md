# Host monitoring — the kpc reachability probe

On 2026-09-14 the prod host was unreachable for **3h42m** and the first anyone knew
of it was a user seeing an offline banner in the app. Nothing watched either box:
no cron job, no systemd timer, no monitoring container, no alerting integration of
any kind. This page is what now exists, and — more usefully — what was *measured*
about which signals are worth alerting on.

## Where it runs, and why not on kpc

`scripts/kpc-probe.sh` runs **on the edge droplet**, from a user crontab, and
probes kpc across the tailnet every minute.

On-host monitoring would not have caught this. kpc never went down: `uptime` showed
5 days, `tailscaled` had `NRestarts=0`, and the deploy an hour earlier had
self-verified `/api/health`. The host was fine and *unreachable* — its WireGuard
session died and was never re-established. Only an observer outside the box,
crossing the same path a user crosses, can tell those apart.

There is a second benefit. The session recovered only when repeated pings forced a
fresh handshake. A probe every minute keeps that path warm, so the dead-session
state has much less opportunity to persist unnoticed. **The probe is partly its own
remedy.**

## What NOT to alert on (measured, not assumed)

The intuitive alarms are useless on this box, and the numbers say so plainly:

| Candidate signal | Why it fails here |
| --- | --- |
| **Swap utilisation** | `%swpused` was 99.9–100.00 at **every one of the 98 sar samples** on the incident day, and hit 100.00 on every retained day before it. Swap is *always* full. Zero discriminating power. |
| **Memory percent** | During the outage window the max `%memused` was **85.51** — *lower* than the same day's pre-outage peak (89.20) and inside the routine daily range (83.74–89.37). It would not have fired. |
| **`/api/health` alone** | Necessary but not sufficient as an on-host check: the API container stayed healthy with `restarts=0` throughout. It is only meaningful probed **from outside**, which is what this does. |

This is the part worth remembering: the failure looked like memory exhaustion, and
memory-shaped alarms would have missed it entirely. An alarm has to be chosen
against the *distribution*, not against the story.

**Load is the signal that discriminates.** Across ~1,150 samples over eight clean
days the maximum 1-minute load was **11.49**, and nothing exceeded 20. On the
incident day exactly two samples exceeded 20: **ldavg-1 191.09 at 08:41:30Z — nine
minutes before the tailnet went silent at 08:50Z** — and a second spike at
12:11:37Z, exactly the analysis-container restart. A load probe is the precursor;
the reachability probe is the confirmation. The load probe is the same script —
see [Precursors](#precursors-load-and-event-loop-blocks).

### A correction worth recording

The first diagnosis of this incident, including earlier revisions of this repo's
own incident notes, said the host spent 3h42m **thrashing**. `sar -u`, `sar -B` and
`sar -W` refute that: through the whole 08:50Z–12:32Z window the box was **77–83%
idle**, `majflt/s` under 5, `pgscand/s` at zero and `pswpin/s` ~0. The thrash was
confined to two roughly one-minute reclaim storms that *bracket* the outage rather
than fill it.

So the mechanism was not "too busy to answer" but "session died during a brief
storm, and nothing re-established it." That distinction is exactly why the fix is a
continuous external probe rather than a resource alarm.

## The state machine

`decide` is a pure function (`scripts/kpc-probe.sh decide …`), gated by
`scripts/kpc-probe.test.ts`, because an alerter's failure modes are quiet ones.
Every check the probe runs — reachability and the two
[precursors](#precursors-load-and-event-loop-blocks) — goes through this one
function via `run_check`, with its own state file (`state`, `state.load`,
`state.blocks`) and the one `notify`:

| Action | When |
| --- | --- |
| `ok` | target answered |
| `wait` | failing, but under the threshold (default 3 probes ≈ 3 min) |
| `alert` | threshold reached — notify once |
| `wait` | still down, already notified — **no repeat storm** |
| `renotify` | still down and `KPC_RENOTIFY_MINS` (default 30) has elapsed |
| `recovered` | answered again, *and* we had actually alerted |
| `path-fault` | target **and** control host both unreachable |

`path-fault` is the important one. Before blaming kpc, the probe checks a control
host (Home Assistant on the same tailnet). If it cannot reach *anything*, the fault
is local — the droplet's network, its `tailscaled`, DNS — and saying "kpc is down"
would be precisely the error a human made during this incident. Unreachable-from-here
is a property of the path, not the target.

## Precursors: load and event-loop blocks

On the same per-minute pass, once kpc has answered, the probe reads
`GET /api/health/signals` — the host's load average and the durations of the
API's event-loop blocks in the last 15 minutes — and runs two more checks
through the same state machine. Threshold is 1 for both (a precursor that waits
for a second breach lets a one-minute storm decay under the trigger), so each
pages on the first breach, then waits, reminds every `KPC_RENOTIFY_MINS`, and
sends one "back to normal" when it clears.

### Why the droplet reads them, rather than kpc paging itself

- **An on-kpc alerter would deliver across the path that fails.** Home
  Assistant's address is a tailnet IP; on 09-14 the tailnet session is what
  died. A job on kpc could page only in the window *before* the path fails —
  the same window in which the droplet can read kpc. It buys nothing and costs
  a second cron, a second copy of the HA token, a second log and a second
  alerting implementation to keep alive.
- **No host agent is needed.** A container reads the host's `/proc/loadavg`
  (measured on kpc: host `0.57 0.50 0.54`, container `0.57 0.50 0.54`), so the
  API can serve the host's load itself.
- **Not SSH:** kpc's SSH is Tailscale SSH in check mode, which hangs a
  non-interactive session until someone approves it in a browser — and it would
  put a shell key to prod on the internet-facing box.
- **Not the API paging on its own blocks:** that is a second alerting
  implementation in TypeScript with a second token in the app's environment. The
  API exposes numbers; the policy lives in one place, `kpc-probe.sh`.

The cost: readings arrive only while the path works. That is what a precursor
is — on 09-14 the load spike came nine minutes before the tailnet went silent —
and once the path fails, the reachability alert takes over. A minute whose
read times out (the storm itself can do that) or answers malformed, or an API
too old to serve `/signals`, leaves that check's state untouched: an unknown
reading is never scored as "clear". Every reading is appended to the `ok` log
line (`ok (0s) load=0.57/0.50/0.54 blocks15m=[]`), so thresholds can be
re-derived from `probe.log` later.

`/signals` is as public as `/api/health` (the droplet's nginx proxies all of
`:8484`), so it returns numbers only — never the in-flight request paths
`loop_blocks` stores.

### Load: trips at 1-min ≥ 30 or 5-min ≥ 20, clears under 5-min 12

| Data | 1-min max | 5-min max |
| --- | --- | --- |
| 8 clean days before 09-14 (~1,150 sar samples) | 11.49 | — |
| 2026-09-21..30 (1,204 sar samples, including the full-library Opus transcode — the heaviest legitimate work kpc has run) | 9.78 | 9.38 |
| 09-14 precursor, 08:41:30Z | **191.09** | — |

- **1-min ≥ 30**: 2.6× the highest clean reading, 6× under the precursor. sar
  samples one minute in ten, so the per-minute probe *will* see peaks sar never
  did; the margin is for those.
- **5-min ≥ 20**: 2.1× the highest clean 5-min reading. A one-minute storm at
  ~190 lifts the 5-min average to roughly 190·(1−e^(−1/5)) ≈ 35 and holds it
  there for minutes, so a probe that misses the peak minute (or times out
  during it) still catches it.
- **Clear under 5-min 12 (hysteresis)**: above the 9.38 normal maximum, so it
  clears under heavy legitimate work, and under the trigger, so a load
  hovering near 20 cannot flap alert/recovered every minute.

### Event-loop blocks: any ≥ 10 s, or ≥ 3 of ≥ 5 s, in 15 minutes

Derived from everything `loop_blocks` held on 2026-09-30 (recording since
2026-09-28T10:31Z, read with `prod-probe.ts --loop-blocks`):

| Population | Blocks |
| --- | --- |
| All recorded (~45 h, three deploys) | 23, every one 1.1–2.9 s; **zero ≥ 5 s** |
| A boot | a pair ~2 s apart: 1531/1704, 1588/1727, 1424/1700 ms |
| Busiest 15 min (09-29 11:12–11:18Z, an MCP curation session) | 4, max 2256 ms |
| Longest single (09-30 00:01Z, midnight jobs) | 2898 ms |

- **Any block ≥ 10 s** — the probe's own request timeout: a block that long
  makes the API time out for a client. 3.4× the longest recorded.
- **≥ 3 blocks ≥ 5 s in the window** — sustained multi-second stalls. None has
  ever been recorded; a boot's pair is both under 5 s and only two.

**What this does not catch, measured:** the 09-14 block precursor (three blocks
of 1054–1723 ms in two minutes) would *not* page. At the ≥ 1 s level it is
indistinguishable from an ordinary curation session — four blocks, up to
2256 ms, in six minutes — so any rule that paged on it would page on normal
use. The load probe is the precursor; block alerts page on stalls a user would
feel. Nor is request attribution a paging signal: 11 of the 17 attributed
blocks name only `GET /api/health` — this probe — because attribution names
what was in flight, not what blocked.

## Install (edge droplet)

No root required: the droplet has no passwordless sudo, and `Linger=no` means a
`systemctl --user` unit would not survive logout. Cron does.

```bash
# 1. Put the script on the droplet
mkdir -p ~/bin && install -m 755 kpc-probe.sh ~/bin/kpc-probe.sh

# 2. Credentials — this file, never the repo (chmod 600)
mkdir -p ~/.config/kpc-probe
cat > ~/.config/kpc-probe/env <<'EOF'
HA_URL=http://100.83.63.110:8123
HA_NOTIFY_SERVICE=mobile_app_<your_device>
HA_TOKEN=<long-lived access token>
EOF
chmod 600 ~/.config/kpc-probe/env

# 3. Every minute, with an overlap guard
( crontab -l 2>/dev/null; \
  echo '* * * * * /usr/bin/flock -n /tmp/kpc-probe.lock /home/kevinch3/bin/kpc-probe.sh' \
) | crontab -
```

Create the HA token in Home Assistant under **Profile → Security → Long-lived
access tokens**. Find your notify service name under **Developer Tools → Actions**,
filtered to `notify.` — the config value is the part *after* `notify.`.

Without `HA_TOKEN`/`HA_NOTIFY_SERVICE` the probe still runs and still logs; it
records `NOTIFY-SKIPPED` rather than pretending to have delivered. A notification
that fails to send logs `NOTIFY-FAILED` for the same reason: a failed alert must
never look like a delivered one.

### Knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `KPC_TARGET_URL` | `http://100.123.114.28:8484/api/health` | what is being watched |
| `KPC_CONTROL_URL` | `http://100.83.63.110:8123/` | proves the observer's own path works |
| `KPC_FAIL_THRESHOLD` | `3` | consecutive failures before alerting |
| `KPC_RENOTIFY_MINS` | `30` | repeat interval while still down |
| `KPC_TIMEOUT` | `10` | per-probe curl timeout, seconds |
| `KPC_STATE_DIR` | `~/.local/state/kpc-probe` | state + `probe.log` |
| `KPC_SIGNALS_URL` | `$KPC_TARGET_URL/signals` | load + block readings |
| `KPC_LOAD1_TRIGGER` | `30` | 1-min load that trips the load alert |
| `KPC_LOAD5_TRIGGER` | `20` | 5-min load that trips it |
| `KPC_LOAD5_CLEAR` | `12` | 5-min load under which an alerted spike is over |
| `KPC_BLOCK_SEVERE_MS` | `10000` | one block this long pages |
| `KPC_BLOCK_MIN_MS` | `5000` | a block this long counts toward… |
| `KPC_BLOCK_MIN_COUNT` | `3` | …this many in 15 min, which pages |
| `KPC_TITLE_PREFIX` | *(empty)* | prepended to every notification title (test fires) |

Upgrading an install from before the precursors is only step 1 — copy the new
script over the old one. No env change; the state file carries over.

## Verify it works

Point it at a dead port and watch it walk the state machine — do this once at
install, because an alerter nobody has ever seen fire is an assumption:

```bash
KPC_TARGET_URL=http://100.123.114.28:9/ ~/bin/kpc-probe.sh   # x3
tail ~/.local/state/kpc-probe/probe.log
```

Three runs should log two `fail n/3` lines then a `NOTIFIED:` (or
`NOTIFY-SKIPPED:`) line. Remove the state file afterwards:
`rm ~/.local/state/kpc-probe/state`.

Test-fire the precursors the same way, in a throwaway state dir so the real
probe's state is untouched. Forcing the thresholds to zero makes the first run
page both, and a second run on the defaults pages both recoveries:

```bash
T=$(mktemp -d)
KPC_STATE_DIR=$T KPC_TITLE_PREFIX='[TEST] ' KPC_LOAD1_TRIGGER=0 KPC_BLOCK_MIN_COUNT=0 ~/bin/kpc-probe.sh
KPC_STATE_DIR=$T KPC_TITLE_PREFIX='[TEST] ' ~/bin/kpc-probe.sh
cat $T/probe.log; rm -r $T
```

Expect `NOTIFIED: [TEST] kpc load spike`, `NOTIFIED: [TEST] kpc API stalling`,
then `NOTIFIED: [TEST] kpc load back to normal` and `… stalls cleared`. An `ok`
line ending `signals=unavailable` means the running API predates
`/api/health/signals` — deploy first.

## Event-loop blocks are persisted

NicotinD ships an in-process saturation detector, `startLoopBlockMonitor`, which
fired at 07:13–07:14Z on the incident day (`blockedMs` 1242/1723/1054) — **1h36m
before** the outage. Its output used to go only to the container log, and prod's
container logs use Docker's default `json-file` driver, so they die with every
deploy: the 2026-09-28 #1058 re-measure could only say "no stalls" for the 29
minutes since the last one.

`createApp` now starts it through `startLoopBlockRecorder`
(`packages/api/src/services/loop-block-store.ts`), which writes every reported
block to the **`loop_blocks`** table in the app's SQLite DB under
`NICOTIND_DATA_DIR` — the volume that survives redeploys:

| column | meaning |
| --- | --- |
| `at` | epoch ms when the loop came back |
| `blocked_ms` | how late the monitor's timer ran (the block) |
| `in_flight` | JSON array of the requests active since the last on-time tick, as `METHOD /path?paramNames (Nms)` |

**What counts as a block** is unchanged: timer lateness ≥ 1 s
(`LOOP_BLOCK_BUDGET_MS`). **In-flight attribution** includes requests that
*finished* since the last on-time tick, not only ones still in a handler — a
synchronous blocker has already returned by the time the monitor's timer runs,
so before #1443 it was never the one named and every block logged `inFlight: []`.

**Retention: 90 days or 10,000 rows, whichever is smaller**, pruned on each write
by two index range deletes (`at`, then rowid) that almost always match nothing.
90 days spans many deploys and a quarterly re-measure; blocks ≥ 1 s are rare (two
per boot, from the curator's full sync, is the normal count), so the row cap only
matters in a pathological storm — at most ~1 row/s, bounded to ~1 MB. Measured
cost of one write at the cap, file DB in WAL: **median 0.04 ms, p99 0.11 ms** (the
rare ~20 ms outlier is a WAL auto-checkpoint). A failed write logs and is dropped;
it never throws.

`startLoopBlockRecorder` also stamps `library_sync_state`
`loop_blocks_recording_since` once, so **zero rows** can be read as "none since
then" rather than "nothing was recording".

### Reading it

```bash
ssh kpc 'docker exec -i nicotind-nicotind-1 sh -lc "cat > /tmp/probe.ts && bun /tmp/probe.ts --loop-blocks"' \
  < packages/api/src/scripts/prod-probe.ts
```

`--loop-blocks` prints a summary — `window_start` (the later of the recording
stamp, the 90-day cutoff and, if the cap was hit, the oldest kept row: the instant
from which "no blocks" holds), `blocks`, `blocks_ge_5s`, `max_ms`,
`request_attributed`, and `library_attributed` (a block with an `/api/library`
request in flight — **#1058's reopen trigger**) — then the 50 most recent rows.
Add `--json` for machine-readable output. See
[prod-inspection.md](prod-inspection.md).

The droplet probe pages on the last 15 minutes of this table, through
`GET /api/health/signals` (`recentLoopBlockDurations`) — see
[Precursors](#precursors-load-and-event-loop-blocks).

## Known limits

- **A precursor needs a working path.** If the tailnet dies with no load spike
  first, the reachability alert (~3 minutes) is the first page.
- **The 09-14 block pattern does not page** — see the block thresholds above.
- **Thresholds come from ~17 days of load and ~45 hours of blocks.** Re-derive
  them from `probe.log`'s `load=` / `blocks15m=` fields once it has a few weeks.
