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
the reachability probe is the confirmation. (The load probe itself is not yet
built — see "Not yet built" below.)

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
`scripts/kpc-probe.test.ts`, because an alerter's failure modes are quiet ones:

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

## Not yet built

- **The load precursor probe on kpc** — would have fired ~9 minutes earlier, at
  08:41:30Z. Needs a threshold well above the 11.49 eight-day maximum and well
  below the 191.09 spike; 30 is the obvious first choice.
- **Wiring `startLoopBlockMonitor`'s `onBlock` hook.** NicotinD already ships a
  saturation detector that fired at 07:13–07:14Z (`blockedMs` 1242/1723/1054) —
  **1h36m before** the outage — and its output goes nowhere but the log. This is
  the cheapest remaining lead-time win in the system.
