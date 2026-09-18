#!/bin/bash
set -e

# Config rendering lives in its own script so it can be run — and tested —
# without starting slskd. → scripts/slskd-configure.test.ts
/slskd-configure.sh

# Pass execution to the original slskd entrypoint/command
exec /usr/bin/tini -- /entrypoint.sh /slskd/slskd "$@"
