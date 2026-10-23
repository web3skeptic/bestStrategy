#!/bin/sh
# Restart game-upgradable.service WITHOUT killing the caller.
#
# The in-game chat agent runs inside that unit, so a direct
# `systemctl restart game-upgradable.service` would SIGTERM the very process
# handling the request — the answer never reaches the browser. Instead we hand
# the restart to a detached transient systemd timer, which lives outside our
# cgroup and fires a few seconds later, after the response has been flushed.
set -eu

DELAY="${1:-4}"
UNIT="gu-restart-$(date +%s)"

systemd-run --quiet --collect \
  --unit="$UNIT" \
  --on-active="${DELAY}s" \
  /bin/systemctl restart game-upgradable.service

echo "Restart of game-upgradable.service scheduled in ${DELAY}s (timer: ${UNIT}.timer)."
echo "The web UI will drop its connection briefly and reconnect on its own."
