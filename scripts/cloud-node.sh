#!/usr/bin/env bash
# SessionStart hook (.claude/settings.json): a cloud Claude Code session runs the
# Node `.nvmrc` pins, not the container's own (#1575). Angular refuses the
# container's v22.22.0, so `bun run verify` died at the web build.
# Local sessions are left alone. Never fails the session: a failed install warns.
# → docs/dependency-management.md
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
want="v$(tr -d '[:space:]v' < "$root/.nvmrc")"
have="$(node --version 2>/dev/null || echo none)"
if [ "$have" = "$want" ]; then
  echo "node: $have (matches .nvmrc)"
  exit 0
fi

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *)
    echo "node: $have; .nvmrc wants $want, but $(uname -m) has no prebuilt Node here" >&2
    exit 0
    ;;
esac

dist="node-$want-linux-$arch"
cache="${NICOTIND_NODE_CACHE:-$HOME/.cache/nicotind-node}/$want"
if [ ! -x "$cache/$dist/bin/node" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  base="https://nodejs.org/dist/$want"
  if curl -fsSL --retry 3 -o "$tmp/$dist.tar.xz" "$base/$dist.tar.xz" \
    && curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt" \
    && (cd "$tmp" && grep " $dist.tar.xz\$" SHASUMS256.txt | sha256sum -c --status -); then
    mkdir -p "$cache" && tar -xJf "$tmp/$dist.tar.xz" -C "$cache"
  else
    echo "node: $have; could not install $want from nodejs.org (verify's web build will fail)" >&2
    exit 0
  fi
fi

bin="$cache/$dist/bin"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
echo "node: $("$bin/node" --version) from .nvmrc (container had $have)"
