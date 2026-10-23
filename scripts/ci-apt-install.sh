#!/usr/bin/env bash
# Install apt packages on a CI runner without letting a stuck mirror or a held
# dpkg lock eat the whole job budget (#1550): each attempt is bounded, and a
# failed or timed-out attempt is retried. `--no-install-recommends` drops ~100
# packages (VA/VDPAU drivers, SDL2, PulseAudio) no decode path reaches.
#
# `update` reads ONLY the Ubuntu archive. The runner image ships extra sources
# (Microsoft, PPAs) whose lists we never install from, and one stalled host
# among them hung every bounded attempt on master (2026-10-23). Not `-qq`, so
# the next stall names the host it is waiting on.
set -euo pipefail

APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=90)

UPDATE_OPTS=()
if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
  parts=$(mktemp -d)
  cp /etc/apt/sources.list.d/ubuntu.sources "$parts/"
  UPDATE_OPTS=(-o Dir::Etc::SourceList=/dev/null -o "Dir::Etc::SourceParts=$parts")
fi

for attempt in 1 2 3; do
  if timeout 150 sudo apt-get "${APT_OPTS[@]}" "${UPDATE_OPTS[@]}" update -q &&
    timeout 150 sudo apt-get "${APT_OPTS[@]}" install -y -qq --no-install-recommends "$@"; then
    exit 0
  fi
  echo "apt attempt ${attempt} failed or timed out; retrying" >&2
  sleep $((attempt * 5))
done
echo "apt install of $* failed after 3 attempts" >&2
exit 1
