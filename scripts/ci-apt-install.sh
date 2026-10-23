#!/usr/bin/env bash
# Install apt packages on a CI runner without letting a stuck mirror or a held
# dpkg lock eat the whole job budget (#1550): each attempt is bounded, and a
# failed or timed-out attempt is retried. `--no-install-recommends` drops ~100
# packages (VA/VDPAU drivers, SDL2, PulseAudio) no decode path reaches.
#
# `update` reads ONLY the Ubuntu archive (the image's other sources are never
# installed from) and runs WITHOUT apt's update hooks. The hooks were the hang:
# with progress printed, every attempt fetched 11 MB in 1 s and then sat after
# "Reading package lists..." until the bound (2026-10-23, #1550) — that is where
# APT::Update::Post-Invoke runs appstream's cache refresh and command-not-found's
# database rebuild, neither of which CI needs. `#clear` empties those lists;
# a `::=` override would only append an empty hook.
set -euo pipefail

NO_HOOKS=$(mktemp)
printf '#clear APT::Update::Post-Invoke-Success;\n#clear APT::Update::Post-Invoke;\n' >"$NO_HOOKS"

APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=90)

UPDATE_OPTS=()
if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
  parts=$(mktemp -d)
  cp /etc/apt/sources.list.d/ubuntu.sources "$parts/"
  UPDATE_OPTS=(-o Dir::Etc::SourceList=/dev/null -o "Dir::Etc::SourceParts=$parts")
fi

for attempt in 1 2 3; do
  if timeout 150 sudo apt-get -c "$NO_HOOKS" "${APT_OPTS[@]}" "${UPDATE_OPTS[@]}" update -q &&
    timeout 150 sudo apt-get "${APT_OPTS[@]}" install -y -qq --no-install-recommends "$@"; then
    exit 0
  fi
  echo "apt attempt ${attempt} failed or timed out; retrying" >&2
  sleep $((attempt * 5))
done
echo "apt install of $* failed after 3 attempts" >&2
exit 1
