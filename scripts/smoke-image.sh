#!/usr/bin/env bash
# Boot a built NicotinD image and prove it serves the version we expect.
#
#   smoke-image.sh <image-ref> <expected-version> [container-name]
#
# Shared by ci.yml's `docker` job (the image a PR would ship) and deploy.yml's
# `docker` job (the image a release DOES ship, pulled back by digest before any
# floating tag points at it). The container is left running so the caller's
# `if: failure()` / `if: always()` steps can read its logs and remove it.
#
# SMOKE_POLL_ATTEMPTS / SMOKE_POLL_INTERVAL exist for scripts/smoke-image.test.ts.
set -euo pipefail

image="${1:?usage: smoke-image.sh <image-ref> <expected-version> [container-name]}"
expected="${2:?usage: smoke-image.sh <image-ref> <expected-version> [container-name]}"
name="${3:-nicotind-smoke}"
attempts="${SMOKE_POLL_ATTEMPTS:-90}"
interval="${SMOKE_POLL_INTERVAL:-2}"

docker run -d --name "$name" \
  -e NICOTIND_MODE=external \
  -e NICOTIND_DATA_DIR=/data/nicotind \
  -e NICOTIND_MUSIC_DIR=/data/music \
  -p 8484:8484 \
  "$image" >/dev/null

ok=false
state=unknown
health=unknown
for _ in $(seq 1 "$attempts"); do
  state="$(docker inspect -f '{{.State.Status}}' "$name")"
  # `none` guards the case where the HEALTHCHECK is dropped from the
  # Dockerfile: without it this loop would spin to timeout and report "never
  # became healthy", which is a confusing way to say "there is no healthcheck
  # any more".
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")"
  if [ "$health" = "none" ]; then
    echo "::error::the image has no HEALTHCHECK — this smoke test relies on it"
    exit 1
  fi
  [ "$state" != "running" ] && break
  [ "$health" = "healthy" ] && { ok=true; break; }
  sleep "$interval"
done

if [ "$ok" != true ]; then
  echo "::error::built image never became healthy (state=$state health=$health)"
  docker logs "$name" 2>&1 | tail -60
  exit 1
fi

# Health says "serving"; this says "serving the code we built". A container
# that comes up on a stale layer is the #457 shape.
got="$(curl -fsS --max-time 10 http://localhost:8484/api/health | jq -r .version)"
if [ "$got" != "$expected" ]; then
  echo "::error::/api/health reports version '$got', expected '$expected'"
  docker logs "$name" 2>&1 | tail -60
  exit 1
fi
echo "Container smoke: healthy, serving $got"
