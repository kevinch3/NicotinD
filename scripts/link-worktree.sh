#!/usr/bin/env bash
# Give a git worktree a working node_modules tree.
#
# `node_modules` is gitignored, so a fresh worktree inherits none of the link
# trees `bun install` built. Two failures follow and the second one lies: every
# typecheck/test fails wholesale, AND — because the `@nicotind/*` workspace links
# are stored *relatively* — a wholesale symlink of node_modules resolves them
# back to the MAIN checkout. The worktree then compiles against another commit's
# core, silently: files that fail to link take their whole test file out of the
# run while the summary still reports "pass".
#
# So: external deps are shared with the main checkout, and the workspace links
# are recreated relatively to resolve inside THIS worktree.
#
# Usage: scripts/link-worktree.sh [worktree-path]   (defaults to the cwd's worktree)
set -euo pipefail

W="${1:-$(git rev-parse --show-toplevel)}"
# --git-common-dir points at the MAIN checkout's .git even from inside a worktree.
MAIN="$(cd "$(dirname "$(cd "$W" && git rev-parse --git-common-dir)")" && pwd)"

if [ "$(cd "$W" && pwd)" = "$MAIN" ]; then
  echo "refusing to link the main checkout into itself: $MAIN" >&2
  exit 1
fi

link_dir() {                      # $1 = dir relative to repo root holding node_modules
  local rel="$1" src="$MAIN/$1/node_modules" dst="$W/$1/node_modules"
  [ -d "$src" ] || return 0
  mkdir -p "$dst"
  # `.bun` and `.bin` are dotfiles a bare `*` glob misses. Without `.bin`,
  # bunx silently fetches a newer compodoc and build:storybook dies on '-e'.
  for entry in "$src"/* "$src"/.bun "$src"/.bin; do
    [ -e "$entry" ] || continue
    local name; name=$(basename "$entry")
    if [ "$name" = "@nicotind" ]; then
      mkdir -p "$dst/@nicotind"
      for pkg in "$entry"/*; do
        [ -e "$pkg" ] || continue
        # copy the RELATIVE target verbatim -> resolves inside this worktree
        ln -sfn "$(readlink "$pkg")" "$dst/@nicotind/$(basename "$pkg")"
      done
    else
      ln -sfn "$entry" "$dst/$name"
    fi
  done
}

link_dir "."
for p in "$MAIN"/packages/*/; do
  [ -d "$p/node_modules" ] && link_dir "packages/$(basename "$p")"
done
echo "linked node_modules into $W"
