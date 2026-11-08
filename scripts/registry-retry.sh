#!/usr/bin/env bash
# usage: registry-retry.sh <command> [args...]
#
# Runs a registry READ (docker pull, imagetools inspect) with a bounded back-off.
# GHCR can answer "manifest unknown" / "not found" for a few seconds after it
# accepted the write, so a read straight after a push failed good master commits
# (#1624). Only reads go through this: a write that failed is retried by rerunning.
#
# REGISTRY_RETRY_ATTEMPTS (default 5) and REGISTRY_RETRY_DELAY (seconds, default 5,
# doubled each attempt: 5+10+20+40 = 75 s worst case) tune it.
set -uo pipefail

attempts=${REGISTRY_RETRY_ATTEMPTS:-5}
delay=${REGISTRY_RETRY_DELAY:-5}

for ((i = 1; i <= attempts; i++)); do
  "$@" && exit 0
  rc=$?
  if ((i == attempts)); then
    echo "::error::registry read failed after ${attempts} attempts: $*" >&2
    exit "$rc"
  fi
  echo "::warning::registry read failed (attempt ${i}/${attempts}, exit ${rc}); retrying in ${delay}s: $*" >&2
  sleep "$delay"
  delay=$((delay * 2))
done
