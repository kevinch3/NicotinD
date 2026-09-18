#!/bin/bash
# Renders the slskd settings NicotinD depends on into slskd's config file.
#
# Everything here has to go through the YAML file rather than the environment:
# slskd binds env vars from an explicit [EnvironmentVariable] allowlist, not by
# `__` nesting, and its retention options carry no such attribute.
# → docs/library-path-conventions.md "slskd's own incomplete dir" (#1145)
set -eu

CONFIG="${SLSKD_CONFIG_FILE:-/app/slskd.yml}"
# `-` not `:-`: an UNSET variable takes the default, but an empty one is an
# operator explicitly switching retention off without deleting the compose line.
RETENTION="${SLSKD_INCOMPLETE_RETENTION_MINUTES-43200}"

# Every write below appends, so an unterminated last line would splice our key
# onto theirs. slskd's own writer does not always leave a trailing newline.
if [ -f "$CONFIG" ] && [ -s "$CONFIG" ] && [ -n "$(tail -c 1 "$CONFIG")" ]; then
  printf '\n' >>"$CONFIG"
fi

BEGIN='# >>> nicotind-managed: incomplete retention (#1145) >>>'
END='# <<< nicotind-managed: incomplete retention <<<'

# --- shares -----------------------------------------------------------------
# The library is shared to Soulseek on purpose; staging is excluded by the
# --share-filter flags in docker-compose.yml, not here.
if [ -f "$CONFIG" ]; then
  if grep -Fq 'directories: []' "$CONFIG"; then
    sed -i 's/directories: \[\]/directories:\n    - \/data\/music/g' "$CONFIG"
  fi

  if ! grep -q 'shares:' "$CONFIG"; then
    printf 'shares:\n  directories:\n    - /data/music\n' >>"$CONFIG"
  fi
else
  printf 'shares:\n  directories:\n    - /data/music\n' >"$CONFIG"
fi

# --- incomplete retention ---------------------------------------------------
# Drop any block a previous run wrote before deciding what to write now, so
# re-running is idempotent and a changed window actually takes effect. The
# config file also holds the operator's Soulseek credentials, so this only ever
# removes our own sentinel-delimited block — never rewrites the whole file.
if grep -Fq "$BEGIN" "$CONFIG"; then
  awk -v b="$BEGIN" -v e="$END" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    skip { next }
    { print }
  ' "$CONFIG" >"$CONFIG.tmp"
  mv "$CONFIG.tmp" "$CONFIG"
fi

# An operator who wrote their own `retention:` key outranks us: a second
# top-level key would be a duplicate YAML mapping, and slskd would rather
# refuse to start than merge them.
if grep -qE '^retention:' "$CONFIG"; then
  echo "slskd-configure: an unmanaged 'retention:' key is present in $CONFIG; leaving retention alone" >&2
  exit 0
fi

case "$RETENTION" in
  '' | 0 | off)
    # Explicitly disabled. The block was already removed above, which is what
    # turning it off has to mean.
    echo "slskd-configure: incomplete retention disabled" >&2
    exit 0
    ;;
esac

# slskd validates this as [Range(30, int.MaxValue)] and refuses to start below
# it. Fail here instead, where the message names the variable: a typo that
# silently left retention off is the whole reason #1145 went unnoticed.
if ! printf '%s' "$RETENTION" | grep -qE '^[0-9]+$' || [ "$RETENTION" -lt 30 ]; then
  echo "slskd-configure: SLSKD_INCOMPLETE_RETENTION_MINUTES must be an integer >= 30 (got '$RETENTION')" >&2
  exit 1
fi

# Only `incomplete` is ever set here. `retention.files.complete` prunes
# directories.downloads — the acquisition addon's staging dir, which the addon
# owns and sweeps itself — so setting it would race the addon (#1052).
cat >>"$CONFIG" <<EOF
$BEGIN
# Deletes files under directories.incomplete whose access time is older than
# this many minutes. Managed by scripts/slskd-configure.sh; edits are replaced
# on restart. Set SLSKD_INCOMPLETE_RETENTION_MINUTES in docker-compose.yml.
retention:
  files:
    incomplete: $RETENTION
$END
EOF

echo "slskd-configure: incomplete retention set to $RETENTION minutes" >&2
