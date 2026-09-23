#!/usr/bin/env bash
# Give a git worktree its own node_modules, installed from ITS OWN bun.lock.
#
# Worktrees used to borrow the main checkout's tree by symlink, which compiled
# them against whatever main last installed (#1088, #1266). bun installs from
# its global cache by hardlink, so a real install costs ~2 s and ~80 MB of new
# bytes (ffmpeg-static's binary is copied, not linked). See
# docs/dependency-management.md#worktrees-install-their-own-node_modules.
#
# The name is kept so the habit survives; nothing is linked any more.
#
# Usage: scripts/link-worktree.sh [worktree-path]   (defaults to the cwd's worktree)
set -euo pipefail

W="$(cd "${1:-$(git rev-parse --show-toplevel)}" && pwd)"

# A tree from the old link pass is symlinks into the main checkout's store; an
# install on top of it would write through them. rm -rf removes the links, not
# their targets.
if [ -L "$W/node_modules/.bun" ]; then
  echo "removing symlinked node_modules left by the old link pass"
  rm -rf "$W/node_modules" "$W"/packages/*/node_modules
fi

cd "$W"
bun install --frozen-lockfile
