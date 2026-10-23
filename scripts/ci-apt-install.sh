#!/usr/bin/env bash
# Install apt packages on a CI runner without letting a stuck mirror or a held
# dpkg lock eat the whole job budget (#1550): each attempt is bounded, and a
# failed or timed-out attempt is retried. `--no-install-recommends` drops ~100
# packages (VA/VDPAU drivers, SDL2, PulseAudio) no decode path reaches.
#
# `update` reads ONLY the Ubuntu archive (the image's other sources are never
# installed from) and runs without apt's update hooks, which CI does not need.
#
# The hang is in `install`, not `update` (#1550): on 2026-10-23 each failed
# attempt died exactly 150 s after update's last line, i.e. at install's bound.
# Install was `-qq` and printed nothing, so it now prints its progress, runs
# debconf non-interactively and suspends needrestart — a prompt nobody can
# answer is the one hang a retry never fixes.
#
# With progress printed, the hang showed itself: every attempt of one run
# stalled on the SAME file (libcodec2-1.2, 9 MB) from azure.archive.ubuntu.com,
# trickling, so `Acquire::http::Timeout` never fired and the mirror list's
# fallback never engaged. A retry against that mirror repeats the stall, so
# each retry reads the archive from a different mirror.
set -euo pipefail

NO_HOOKS=$(mktemp)
printf '#clear APT::Update::Post-Invoke-Success;\n#clear APT::Update::Post-Invoke;\n' >"$NO_HOOKS"

APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=90)

# Attempt 1 keeps the image's own mirror; each retry swaps in the next one.
FALLBACK_MIRRORS=(http://archive.ubuntu.com/ubuntu http://mirrors.edge.kernel.org/ubuntu)

SOURCE_OPTS=()
parts=
if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
  parts=$(mktemp -d)
  cp /etc/apt/sources.list.d/ubuntu.sources "$parts/"
  SOURCE_OPTS=(-o Dir::Etc::SourceList=/dev/null -o "Dir::Etc::SourceParts=$parts")
fi

for attempt in 1 2 3; do
  if [[ -n "$parts" && $attempt -gt 1 ]]; then
    mirror=${FALLBACK_MIRRORS[attempt - 2]}
    sed -E "s#^URIs:.*#URIs: ${mirror}#" /etc/apt/sources.list.d/ubuntu.sources >"$parts/ubuntu.sources"
    echo "apt attempt ${attempt}: reading the archive from ${mirror}" >&2
  fi
  # Install reads the same sources as update, so its lists match the mirror.
  if timeout 150 sudo apt-get -c "$NO_HOOKS" "${APT_OPTS[@]}" "${SOURCE_OPTS[@]}" update -q &&
    timeout 150 sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 \
      apt-get "${APT_OPTS[@]}" "${SOURCE_OPTS[@]}" install -y -q --no-install-recommends "$@"; then
    exit 0
  fi
  echo "apt attempt ${attempt} failed or timed out; retrying" >&2
  sleep $((attempt * 5))
done
echo "apt install of $* failed after 3 attempts" >&2
exit 1
