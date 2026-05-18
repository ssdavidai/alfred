#!/bin/bash
# alfred-trajectory-cleanup: prune leaked openclaw-workers trajectory-path
# pointer files. Companion to alfred-workers-watchdog.sh which handles a
# different leak (ctrl-server.mjs processes).
#
# Background: openclaw-workers' `cleanup: auto` is supposed to delete a
# session's .trajectory-path.json after the subagent completes. It
# doesn't reliably — on 2026-05-11 david accumulated 14k+ leaked pointer
# files in learn-clerk/sessions/ and the gateway wedged (O(N) dir scans
# pinned Node at 105% CPU, clerk calls timed out at 300s). Cleared
# manually then; this cron prevents recurrence.
#
# Policy: any .trajectory-path.json older than 60 MINUTES is a leak. An
# in-flight session's pointer is touched on every gateway pass (multiple
# times per minute on a busy queue), so anything stale for an hour is
# definitely orphaned by the cleanup-after-dispatch path.
#
# Cadence: this script runs every 15 minutes (see deploy/scripts/
# install-watchdogs.sh). The aggressive threshold + frequent run is the
# real-time janitor that self-heals an active wedge cascade — during a
# clerk-failure burst (rapali 2026-05-17) the directory accumulated
# ~500 files in 30 minutes; without rapid cleanup the gateway pegged CPU
# scanning the dir and clerk calls timed out. The earlier daily +7-day
# policy was too slow to catch this; it's a preventative-only tool, not
# a janitor.
#
# Preserved: sessions.json (the agent index) is NOT named
# .trajectory-path.json so the -name filter skips it.

set -uo pipefail
SESSIONS_GLOB=/mnt/encrypted/openclaw-workers/agents/*/sessions
THRESHOLD_MIN=60
LOG=/opt/alfred/alfred-trajectory-cleanup.log

stamp=$(date -Iseconds)
total_deleted=0

for sessdir in $SESSIONS_GLOB; do
  [ -d "$sessdir" ] || continue
  agent=$(basename "$(dirname "$sessdir")")
  before=$(find "$sessdir" -maxdepth 1 -name '*.trajectory-path.json' 2>/dev/null | wc -l)
  deleted=$(find "$sessdir" -maxdepth 1 -name '*.trajectory-path.json' -mmin +${THRESHOLD_MIN} -delete -print 2>/dev/null | wc -l)
  after=$(find "$sessdir" -maxdepth 1 -name '*.trajectory-path.json' 2>/dev/null | wc -l)
  if [ "$deleted" -gt 0 ] || [ "$before" -gt 500 ]; then
    echo "$stamp agent=$agent before=$before deleted=$deleted after=$after" >> "$LOG"
  fi
  total_deleted=$((total_deleted + deleted))
done

# Only log a summary line if we actually did something (keeps the log
# quiet on the common "nothing to clean" case).
if [ "$total_deleted" -gt 0 ]; then
  echo "$stamp total_deleted=$total_deleted" >> "$LOG"
fi
exit 0
