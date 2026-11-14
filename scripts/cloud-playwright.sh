#!/usr/bin/env bash
# SessionStart hook (.claude/settings.json): a cloud Claude Code session gets the
# Chromium build the repo's Playwright expects (#1534). The container ships an
# older build under PLAYWRIGHT_BROWSERS_PATH, so gates:storybook and the e2e
# suite died at launch with "Executable doesn't exist".
# Local sessions are left alone. Never fails the session: a failed install warns
# and names what will not run.
# → docs/dependency-management.md
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
# The version bun.lock resolved, not package.json's range: that is what runs.
version="$(sed -n 's/^ *"playwright": \["playwright@\([0-9][^"]*\)".*/\1/p' "$root/bun.lock" | head -n1)"
if [ -z "$version" ]; then
  echo "playwright: no version in bun.lock; gates:storybook and e2e not checked" >&2
  exit 0
fi

# Idempotent: an already-installed build costs one registry lookup, no download.
if npx -y "playwright@$version" install chromium > /dev/null 2>&1; then
  echo "playwright: chromium for $version ready"
else
  echo "playwright: could not install chromium for $version (gates:storybook and e2e will not launch)" >&2
fi
exit 0
