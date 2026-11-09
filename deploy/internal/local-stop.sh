#!/bin/sh
# Stop the local mock review containers and keep their volumes.
set -eu
cd "$(dirname "$0")"
exec docker compose -f docker-compose.local.yml stop "$@"
