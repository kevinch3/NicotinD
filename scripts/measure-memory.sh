#!/usr/bin/env bash
# Peak memory of a command and everything it starts (#1906).
#
#   scripts/measure-memory.sh bun run build:storybook
#
# Sums the RSS of the command's whole process group every half second, so a
# step that fans out (vitest workers, Playwright's servers and browser) counts
# in full. Prints the peak and passes the command's exit code through. To prove
# a step fits a budget rather than measure it, run it under a hard limit:
#   systemd-run --user --scope -p MemoryMax=3G -p MemorySwapMax=0 <cmd>
set -u
[ $# -gt 0 ] || { echo "usage: $0 <command...>" >&2; exit 2; }

setsid "$@" &
pid=$!
peak=0
while kill -0 "$pid" 2>/dev/null; do
  kb=$(ps -o rss= -g "$pid" 2>/dev/null | awk '{s += $1} END {print s + 0}')
  [ "$kb" -gt "$peak" ] && peak=$kb
  sleep 0.5
done
wait "$pid"
rc=$?
echo "[measure-memory] peak $((peak / 1024)) MB, exit $rc: $*" >&2
exit "$rc"
