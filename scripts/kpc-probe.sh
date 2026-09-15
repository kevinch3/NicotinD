#!/usr/bin/env bash
#
# Dead-man reachability probe for the prod host, run FROM THE EDGE DROPLET.
#
# On 2026-09-14 kpc was unreachable for 3h42m and the first anyone knew of it was
# a user seeing an offline banner in the app. Nothing watched the host: no cron,
# no timer, no monitoring container, on either box.
#
# Why it probes from the droplet rather than on kpc: the failure was not the host
# dying (it stayed up 5 days, 77-83% idle through the whole window) but its
# WireGuard session dying and never being re-established. Only something OUTSIDE
# kpc, crossing the same path real users cross, can see that. An on-host check
# would have reported perfect health throughout — as every on-host signal did.
#
# A useful side effect: this probe is also a partial REMEDY. The session recovered
# on 09-14 only because repeated pings forced a fresh handshake; a probe every
# minute keeps that path warm, so the dead-session state has far less chance to
# persist unnoticed.
#
# Install: see docs/host-monitoring.md. Runs from a user crontab (no root needed;
# the droplet has no passwordless sudo and Linger=no, so a --user systemd unit
# would not survive logout).
#
# `decide` subcommand exposes the alerting state machine as a pure function so it
# can be tested without a network — see scripts/kpc-probe.test.ts.

set -uo pipefail # deliberately NOT -e: a failing probe is the measurement

# ---------------------------------------------------------------------------
# decide: the whole alerting state machine, as a pure function.
#
#   $1 target_ok   1 = kpc answered
#   $2 control_ok  1 = the control host answered (proves OUR path works)
#   $3 fails       consecutive failures INCLUDING this one
#   $4 notified    1 = we already alerted for this incident
#   $5 mins_since  minutes since the last notification
#   $6 threshold   consecutive failures required to alert
#   $7 renotify    minutes between repeat alerts while still down
#
# Prints exactly one action: ok | recovered | path-fault | alert | renotify | wait
# ---------------------------------------------------------------------------
decide() {
  local target_ok=$1 control_ok=$2 fails=$3 notified=$4 mins_since=$5 threshold=$6 renotify=$7

  if [ "$target_ok" -eq 1 ]; then
    # Only claim a recovery if we actually told someone it was broken.
    [ "$notified" -eq 1 ] && echo "recovered" || echo "ok"
    return
  fi

  # The lesson of the incident this exists for: unreachability is a property of
  # the PATH, not the target. If our own control host is also unreachable, the
  # fault is local (droplet network, tailscaled, DNS) and blaming kpc would be
  # exactly the wrong call — as it was for a human on 09-14. We also almost
  # certainly cannot deliver a notification in that state.
  if [ "$control_ok" -ne 1 ]; then
    echo "path-fault"
    return
  fi

  if [ "$notified" -eq 1 ]; then
    [ "$mins_since" -ge "$renotify" ] && echo "renotify" || echo "wait"
    return
  fi

  [ "$fails" -ge "$threshold" ] && echo "alert" || echo "wait"
}

if [ "${1:-}" = "decide" ]; then
  shift
  decide "$@"
  exit 0
fi

# ---------------------------------------------------------------------------
# Configuration. Secrets live in the env file, never in this script or the repo.
# ---------------------------------------------------------------------------
CONF="${KPC_PROBE_ENV:-$HOME/.config/kpc-probe/env}"
# shellcheck source=/dev/null
[ -r "$CONF" ] && . "$CONF"

TARGET_URL="${KPC_TARGET_URL:-http://100.123.114.28:8484/api/health}"
CONTROL_URL="${KPC_CONTROL_URL:-http://100.83.63.110:8123/}"
STATE_DIR="${KPC_STATE_DIR:-$HOME/.local/state/kpc-probe}"
LOG_FILE="${KPC_LOG_FILE:-$STATE_DIR/probe.log}"
THRESHOLD="${KPC_FAIL_THRESHOLD:-3}"
RENOTIFY_MINS="${KPC_RENOTIFY_MINS:-30}"
TIMEOUT="${KPC_TIMEOUT:-10}"
HA_URL="${HA_URL:-http://100.83.63.110:8123}"
HA_NOTIFY_SERVICE="${HA_NOTIFY_SERVICE:-}"
HA_TOKEN="${HA_TOKEN:-}"

mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/state"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"; }

# Read prior state: consecutive failures, notified flag, epoch of last notify.
fails=0 notified=0 last_notify=0
if [ -r "$STATE_FILE" ]; then
  read -r fails notified last_notify <"$STATE_FILE" 2>/dev/null || true
  # A truncated or hand-edited state file must not wedge the probe forever.
  [[ "$fails" =~ ^[0-9]+$ ]] || fails=0
  [[ "$notified" =~ ^[01]$ ]] || notified=0
  [[ "$last_notify" =~ ^[0-9]+$ ]] || last_notify=0
fi

probe() { curl -fsS -o /dev/null --max-time "$TIMEOUT" "$1" 2>/dev/null; }

started=$(date +%s)
if probe "$TARGET_URL"; then target_ok=1; else target_ok=0; fi
elapsed=$(($(date +%s) - started))

# Only pay for the control probe when the target failed.
control_ok=1
[ "$target_ok" -eq 0 ] && { probe "$CONTROL_URL" && control_ok=1 || control_ok=0; }

[ "$target_ok" -eq 0 ] && fails=$((fails + 1))
now=$(date +%s)
mins_since=$(((now - last_notify) / 60))
[ "$last_notify" -eq 0 ] && mins_since=999999

action=$(decide "$target_ok" "$control_ok" "$fails" "$notified" "$mins_since" "$THRESHOLD" "$RENOTIFY_MINS")

notify() {
  local title=$1 message=$2
  if [ -z "$HA_TOKEN" ] || [ -z "$HA_NOTIFY_SERVICE" ]; then
    log "NOTIFY-SKIPPED (no HA_TOKEN/HA_NOTIFY_SERVICE in $CONF): $title — $message"
    return 1
  fi
  if curl -fsS -o /dev/null --max-time 15 -X POST \
    -H "Authorization: Bearer $HA_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg t "$title" --arg m "$message" '{title:$t, message:$m}')" \
    "$HA_URL/api/services/notify/$HA_NOTIFY_SERVICE"; then
    log "NOTIFIED: $title — $message"
    return 0
  fi
  # A failed notification must never look like a delivered one.
  log "NOTIFY-FAILED: $title — $message"
  return 1
}

case "$action" in
ok)
  fails=0
  log "ok (${elapsed}s)"
  ;;
recovered)
  notify "kpc is back" "Reachable again after ${fails} failed probes. $(date -u +%H:%MZ)"
  fails=0 notified=0 last_notify=0
  ;;
path-fault)
  # Not kpc's fault as far as we can tell — say so plainly rather than alerting.
  log "PATH-FAULT: target and control both unreachable from this host; not blaming kpc (fails=$fails)"
  ;;
alert)
  notify "kpc unreachable" "No answer from $TARGET_URL for $fails consecutive probes (~$((fails * 1))m). Control host is reachable, so this is kpc, not the path."
  notified=1 last_notify=$now
  ;;
renotify)
  notify "kpc still unreachable" "Still down after $fails probes (~$((fails * 1))m)."
  last_notify=$now
  ;;
wait)
  log "fail $fails/$THRESHOLD (not yet alerting)"
  ;;
esac

printf '%s %s %s\n' "$fails" "$notified" "$last_notify" >"$STATE_FILE"
