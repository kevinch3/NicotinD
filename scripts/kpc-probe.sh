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
# It also pages on two PRECURSORS read from kpc's /api/health/signals on the same
# per-minute pass (#1143): a host load spike (09-14's came 9 minutes before the
# tailnet went silent) and event-loop blocks severe enough to be felt. Every check
# runs through the one `decide` state machine and the one `notify` below; each
# keeps its own state file. Why the droplet reads them rather than kpc paging
# itself: docs/host-monitoring.md.
#
# `decide`, `load-breach` and `blocks-breach` subcommands expose the policy as pure
# functions so it can be tested without a network — see scripts/kpc-probe.test.ts.

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

# ---------------------------------------------------------------------------
# load_breach: is kpc's load average a precursor? With hysteresis — trips on the
# 1-min OR 5-min average, clears only once the 5-min average is back under the
# clear level, so a load hovering at the trigger does not flap alert/recovered.
#
#   $1 notified  1 = already alerted (use the clear level)
#   $2 load1  $3 load5      current averages (floats)
#   $4 trig1  $5 trig5      trigger levels
#   $6 clear5               5-min level below which an alerted spike is over
#
# Prints: breach | clear
# ---------------------------------------------------------------------------
load_breach() {
  awk -v n="$1" -v l1="$2" -v l5="$3" -v t1="$4" -v t5="$5" -v c5="$6" 'BEGIN {
    if (n == 1) b = (l1 >= t1 || l5 >= c5); else b = (l1 >= t1 || l5 >= t5)
    print (b ? "breach" : "clear")
  }'
}

# ---------------------------------------------------------------------------
# blocks_breach: do the recent event-loop blocks warrant a page?
#
#   $1 severe_ms   any single block this long pages on its own
#   $2 min_ms      a block at least this long counts toward...
#   $3 min_count   ...this many of them in the window
#   $4…            durations (ms) of the blocks in the window
#
# Prints: "breach|clear <blocks >= min_ms> <longest ms>"
# ---------------------------------------------------------------------------
blocks_breach() {
  local severe=$1 min_ms=$2 min_count=$3
  shift 3
  local n=0 max=0 ms
  for ms in "$@"; do
    [[ "$ms" =~ ^[0-9]+$ ]] || continue
    [ "$ms" -ge "$min_ms" ] && n=$((n + 1))
    [ "$ms" -gt "$max" ] && max=$ms
  done
  if [ "$max" -ge "$severe" ] || [ "$n" -ge "$min_count" ]; then
    echo "breach $n $max"
  else
    echo "clear $n $max"
  fi
}

case "${1:-}" in
decide | load-breach | blocks-breach)
  fn=${1//-/_}
  shift
  "$fn" "$@"
  exit 0
  ;;
esac

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
SIGNALS_URL="${KPC_SIGNALS_URL:-${TARGET_URL%/}/signals}"
LOAD1_TRIGGER="${KPC_LOAD1_TRIGGER:-30}"
LOAD5_TRIGGER="${KPC_LOAD5_TRIGGER:-20}"
LOAD5_CLEAR="${KPC_LOAD5_CLEAR:-12}"
BLOCK_SEVERE_MS="${KPC_BLOCK_SEVERE_MS:-10000}"
BLOCK_MIN_MS="${KPC_BLOCK_MIN_MS:-5000}"
BLOCK_MIN_COUNT="${KPC_BLOCK_MIN_COUNT:-3}"
TITLE_PREFIX="${KPC_TITLE_PREFIX:-}"
HA_URL="${HA_URL:-http://100.83.63.110:8123}"
HA_NOTIFY_SERVICE="${HA_NOTIFY_SERVICE:-}"
HA_TOKEN="${HA_TOKEN:-}"

mkdir -p "$STATE_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"; }

notify() {
  local title="$TITLE_PREFIX$1" message=$2
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

# ---------------------------------------------------------------------------
# Per-check state: consecutive failures, notified flag, epoch of last notify.
# Reachability keeps the original `state` file so an upgrade mid-incident does
# not forget it already alerted; the precursor checks get `state.<name>`.
# ---------------------------------------------------------------------------
state_file() { [ "$1" = reach ] && echo "$STATE_DIR/state" || echo "$STATE_DIR/state.$1"; }

state_read() {
  local f
  f=$(state_file "$1")
  fails=0 notified=0 last_notify=0
  if [ -r "$f" ]; then
    read -r fails notified last_notify <"$f" 2>/dev/null || true
    # A truncated or hand-edited state file must not wedge the probe forever.
    [[ "$fails" =~ ^[0-9]+$ ]] || fails=0
    [[ "$notified" =~ ^[01]$ ]] || notified=0
    [[ "$last_notify" =~ ^[0-9]+$ ]] || last_notify=0
  fi
}

# ---------------------------------------------------------------------------
# run_check: one pass of the shared state machine for one check, whose state
# state_read has already loaded. Messages may use {fails}.
#
#   $1 name  $2 ok  $3 control_ok  $4 threshold
#   $5 alert title  $6 alert message  $7 recovered title  $8 recovered message
# ---------------------------------------------------------------------------
run_check() {
  local name=$1 ok=$2 control_ok=$3 threshold=$4
  local a_title=$5 a_msg=$6 r_title=$7 r_msg=$8
  local tag="" now mins_since action
  [ "$name" = reach ] || tag="[$name] "

  [ "$ok" -eq 0 ] && fails=$((fails + 1))
  now=$(date +%s)
  mins_since=$(((now - last_notify) / 60))
  [ "$last_notify" -eq 0 ] && mins_since=999999
  a_msg=${a_msg//\{fails\}/$fails}
  r_msg=${r_msg//\{fails\}/$fails}

  action=$(decide "$ok" "$control_ok" "$fails" "$notified" "$mins_since" "$threshold" "$RENOTIFY_MINS")
  case "$action" in
  ok)
    fails=0
    ;;
  recovered)
    notify "$r_title" "$r_msg"
    fails=0 notified=0 last_notify=0
    ;;
  path-fault)
    # Not kpc's fault as far as we can tell — say so plainly rather than alerting.
    log "${tag}PATH-FAULT: target and control both unreachable from this host; not blaming kpc (fails=$fails)"
    ;;
  alert)
    notify "$a_title" "$a_msg"
    notified=1 last_notify=$now
    ;;
  renotify)
    notify "$a_title (still)" "$a_msg"
    last_notify=$now
    ;;
  wait)
    if [ "$notified" -eq 1 ]; then
      log "${tag}still failing ($fails), alerted; reminder every ${RENOTIFY_MINS}m"
    else
      log "${tag}fail $fails/$threshold (not yet alerting)"
    fi
    ;;
  esac
  printf '%s %s %s\n' "$fails" "$notified" "$last_notify" >"$(state_file "$name")"
}

is_num() { [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]; }

probe() { curl -fsS -o /dev/null --max-time "$TIMEOUT" "$1" 2>/dev/null; }

# ---------------------------------------------------------------------------
# 1. Reachability.
# ---------------------------------------------------------------------------
started=$(date +%s)
if probe "$TARGET_URL"; then target_ok=1; else target_ok=0; fi
elapsed=$(($(date +%s) - started))

# Only pay for the control probe when the target failed.
control_ok=1
[ "$target_ok" -eq 0 ] && { probe "$CONTROL_URL" && control_ok=1 || control_ok=0; }

# The precursor readings, fetched only while kpc answers: if it does not, the
# reachability alert is the one that matters and the readings are unknowable.
# An API too old to serve them, or a malformed answer, leaves their state alone.
l1="" l5="" l15="" cpus="" blocks="" signals_note=""
if [ "$target_ok" -eq 1 ] && signals=$(curl -fsS --max-time "$TIMEOUT" "$SIGNALS_URL" 2>/dev/null); then
  read -r l1 l5 l15 cpus <<<"$(jq -r '[.load[0], .load[1], .load[2], .cpus] | map(tostring) | join(" ")' <<<"$signals" 2>/dev/null)"
  blocks=$(jq -r 'if (.loopBlocks.blockedMs | type) == "array"
                  then "ms:" + (.loopBlocks.blockedMs | map(tostring) | join(" "))
                  else "unknown" end' <<<"$signals" 2>/dev/null)
  if is_num "$l1" && is_num "$l5"; then
    signals_note=" load=$l1/$l5/$l15"
  else
    l1="" signals_note=" load=?"
  fi
  case "$blocks" in
  ms:*) signals_note="$signals_note blocks15m=[${blocks#ms:}]" ;;
  *) blocks="" signals_note="$signals_note blocks15m=?" ;;
  esac
elif [ "$target_ok" -eq 1 ]; then
  signals_note=" signals=unavailable"
fi

state_read reach
run_check reach "$target_ok" "$control_ok" "$THRESHOLD" \
  "kpc unreachable" \
  "No answer from $TARGET_URL for {fails} consecutive probes (~{fails}m). Control host is reachable, so this is kpc, not the path." \
  "kpc is back" \
  "Reachable again after {fails} failed probes. $(date -u +%H:%MZ)"
[ "$target_ok" -eq 1 ] && log "ok (${elapsed}s)$signals_note"

# ---------------------------------------------------------------------------
# 2. Load precursor. Threshold 1: the spike it exists for is a one-minute storm
#    (1-min load decays by ~e each minute), so waiting for a second breach would
#    let the 1-min average fall under the trigger; the 5-min average carries it.
# ---------------------------------------------------------------------------
if [ -n "$l1" ]; then
  state_read load
  verdict=$(load_breach "$notified" "$l1" "$l5" "$LOAD1_TRIGGER" "$LOAD5_TRIGGER" "$LOAD5_CLEAR")
  [ "$verdict" = clear ] && ok=1 || ok=0
  run_check load "$ok" 1 1 \
    "kpc load spike" \
    "Load $l1 / $l5 / $l15 (1/5/15-min) on $cpus CPUs; normal peaks stay under 12. On 09-14 a spike like this came 9 minutes before kpc went unreachable." \
    "kpc load back to normal" \
    "5-min load is $l5, under $LOAD5_CLEAR."
fi

# ---------------------------------------------------------------------------
# 3. Event-loop blocks in the API's last 15 minutes.
# ---------------------------------------------------------------------------
if [ -n "$blocks" ]; then
  state_read blocks
  # shellcheck disable=SC2086 # word-splitting the duration list is the point
  read -r verdict n_long longest <<<"$(blocks_breach "$BLOCK_SEVERE_MS" "$BLOCK_MIN_MS" "$BLOCK_MIN_COUNT" ${blocks#ms:})"
  [ "$verdict" = clear ] && ok=1 || ok=0
  run_check blocks "$ok" 1 1 \
    "kpc API stalling" \
    "Event-loop blocks in the last 15 min: $n_long of at least $((BLOCK_MIN_MS / 1000))s, longest ${longest}ms. Detail: prod-probe.ts --loop-blocks (docs/host-monitoring.md)." \
    "kpc API stalls cleared" \
    "No qualifying event-loop blocks in the last 15 min."
fi
