#!/bin/sh
# Rebuild from a fresh base image and fresh packages, restart, and put the
# previous image back if the new one does not come up. Run it from this
# directory on the host, from cron or by hand:
#
#   0 5 * * 1  cd /path/to/sportio-live && ./update.sh >> update.log 2>&1
#
# The restart drops any stream being watched, hence a quiet hour.
set -eu

SERVICE=sportio-live
IMAGE=sportio-live-sportio-live

git pull --ff-only

# Kept so a build that succeeds but does not run can be undone. Absent on
# the very first run, which is fine: there is nothing to go back to.
docker tag "$IMAGE:latest" "$IMAGE:prev" 2>/dev/null || true

# --pull refreshes node:24-alpine, --no-cache refreshes ffmpeg and the
# npm packages; without it every layer comes from cache and nothing moves.
docker compose build --pull --no-cache "$SERVICE"
docker compose up -d "$SERVICE"

# The app has no healthcheck, so "up" is judged by answering on its own
# port from inside the container, which is independent of HOST_PORT.
for _ in 1 2 3 4 5 6; do
  sleep 10
  if docker exec "$SERVICE" wget -q -O /dev/null http://127.0.0.1:2323/; then
    echo "[update] $(date -u +%FT%TZ) new image is up"
    docker image prune -f >/dev/null
    exit 0
  fi
done

echo "[update] $(date -u +%FT%TZ) new image did not answer, rolling back" >&2
docker tag "$IMAGE:prev" "$IMAGE:latest"
docker compose up -d --no-build "$SERVICE"
exit 1
