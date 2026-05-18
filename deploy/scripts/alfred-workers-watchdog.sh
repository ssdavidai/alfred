#!/bin/bash
# alfred-workers-watchdog: detect ctrl-server.mjs proc leak per #682, restart workers.
#
# Background: openclaw-workers occasionally accumulates orphaned ctrl-server.mjs
# child processes (per-subagent MCP servers that don't get reaped). Once the
# count climbs into the hundreds, the workers Node process is CPU-pegged and
# gateway calls start timing out. The fix is a container restart — fresh boot
# clears the process table.
#
# Installed by deploy/scripts/install-watchdogs.sh — runs every 15 min via
# the deploy user's crontab on every tenant VM. Companion to
# alfred-trajectory-cleanup.sh which handles a DIFFERENT openclaw leak
# (session-file accumulation).

set -uo pipefail
COMPOSE=/opt/alfred/compose/docker-compose.yaml
WORKERS=compose-openclaw-workers-1
THRESHOLD=80
LOG=/opt/alfred/alfred-workers-watchdog.log

raw=$(docker exec "$WORKERS" sh -c "pgrep -c ctrl-server.mjs 2>/dev/null" 2>/dev/null || true)
count=$(echo "$raw" | head -n1 | tr -dc '0-9')
count=${count:-0}

if [ "$count" -gt "$THRESHOLD" ]; then
  echo "$(date -Iseconds) ctrl-server.mjs count=$count > $THRESHOLD; restarting $WORKERS" >> "$LOG"
  docker compose -f "$COMPOSE" restart openclaw-workers >> "$LOG" 2>&1
  echo "$(date -Iseconds) restart complete" >> "$LOG"
fi
exit 0
