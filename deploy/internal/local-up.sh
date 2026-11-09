#!/bin/sh
# Start the local mock review stack. Does not remove volumes or other projects.
set -eu
cd "$(dirname "$0")"
exec docker compose -f docker-compose.local.yml up -d --build "$@"
