#!/bin/bash
set -e

# If slskd.yml exists, ensure the shares are configured
if [ -f /app/slskd.yml ]; then
  # If shares are empty array, replace with our target
  if grep -Fq 'directories: []' /app/slskd.yml; then
    sed -i 's/directories: \[\]/directories:\n    - \/data\/music/g' /app/slskd.yml
  fi
  
  # If there is no shares section at all, append it
  if ! grep -q 'shares:' /app/slskd.yml; then
    echo -e "shares:\n  directories:\n    - /data/music" >> /app/slskd.yml
  fi
else
  # Initialize fresh slskd.yml
  echo -e "shares:\n  directories:\n    - /data/music" > /app/slskd.yml
fi

# Pass execution to the original slskd entrypoint/command
exec /usr/bin/tini -- ./start.sh "$@"
