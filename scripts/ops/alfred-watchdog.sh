#!/usr/bin/env bash
# alfred-watchdog — host-side cron, runs every 5 minutes.
#
# Two jobs, both born from the 2026-08-17 incidents:
#
#   1. SAMPLE. Record pids.current vs live thread count per container. This is
#      the number that actually diagnoses a PID exhaustion, and the number we
#      did NOT have when ctrl-api starved: its cgroup was destroyed with the
#      container at 07:09:52 and took the evidence with it.
#        pids >  threads  -> phantom/accounting leak (the caddy species)
#        pids == threads  -> real processes piling up (unreaped children)
#      Those two have different causes and different fixes, so this one column
#      is what turns the next occurrence from archaeology into a diagnosis.
#
#   2. HEAL. Restart containers Docker has marked unhealthy. Docker detects
#      this perfectly well and then does nothing with it — ctrl-api sat
#      `unhealthy` for 2.5 days (19,482 failed probes) while vault writes
#      silently degraded. A container stop tears down its cgroup scope
#      ("docker-<id>.scope: Deactivated successfully"), which releases a leaked
#      charge, so a restart is a real fix and not just a nudge.
#
# Deliberately boring: no new images, no docker socket exposed to a container,
# no daemon. Root on the host already has docker access.

set -uo pipefail

LOG_DIR=/var/log/alfred
STATE_DIR=/var/lib/alfred-watchdog
RETAIN_DAYS=14
# Only ever touch the managed stack. Anything else on the box (e.g. a
# hand-run sidecar) is not ours to bounce — and at least one such container
# runs healthy-but-unhealthy-flagged, which a blind heal would restart forever.
NAME_PREFIX=alfred-black-
# Don't re-restart the same container inside this window.
COOLDOWN_SECONDS=1800
# Hard stop per container per day. A container that needs more than this is
# broken in a way a restart cannot fix, and hammering it is how you build the
# restart loop we just spent a day removing.
MAX_RESTARTS_PER_DAY=4

mkdir -p "$LOG_DIR" "$STATE_DIR"
today=$(date -u +%F)
SAMPLE_LOG="$LOG_DIR/pids-$today.log"
ACTION_LOG="$LOG_DIR/watchdog-actions.log"
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

command -v docker >/dev/null 2>&1 || exit 0

# ── 1. sample ────────────────────────────────────────────────────────────────
docker ps --format '{{.ID}} {{.Names}}' 2>/dev/null | while read -r cid cname; do
    full=$(docker inspect -f '{{.Id}}' "$cid" 2>/dev/null) || continue
    cg="/sys/fs/cgroup/system.slice/docker-${full}.scope"
    [ -r "$cg/pids.current" ] || continue
    cur=$(cat "$cg/pids.current" 2>/dev/null || echo -1)
    max=$(cat "$cg/pids.max"     2>/dev/null || echo -1)
    thr=$(wc -l < "$cg/cgroup.threads" 2>/dev/null || echo -1)
    den=$(awk '/^max/{print $2}' "$cg/pids.events" 2>/dev/null || echo -1)
    phantom=$(( cur - thr ))
    printf '%s %s pids=%s/%s threads=%s phantom=%s denied=%s\n' \
        "$ts" "$cname" "$cur" "$max" "$thr" "$phantom" "${den:-0}" >> "$SAMPLE_LOG"
done

# ── 2. heal ──────────────────────────────────────────────────────────────────
docker ps --filter health=unhealthy --format '{{.Names}}' 2>/dev/null | while read -r name; do
    [ -n "$name" ] || continue
    case "$name" in
        "$NAME_PREFIX"*) ;;
        *) echo "$ts SKIP $name (not $NAME_PREFIX*)" >> "$ACTION_LOG"; continue ;;
    esac

    stamp="$STATE_DIR/${name}.last"
    now=$(date -u +%s)
    if [ -f "$stamp" ]; then
        last=$(cat "$stamp" 2>/dev/null || echo 0)
        if [ $(( now - last )) -lt "$COOLDOWN_SECONDS" ]; then
            continue   # inside cooldown — stay quiet
        fi
    fi

    todays=$(grep "^$today" "$ACTION_LOG" 2>/dev/null | grep -c "RESTART $name" || echo 0)
    if [ "$todays" -ge "$MAX_RESTARTS_PER_DAY" ]; then
        echo "$ts GIVEUP $name (already restarted ${todays}x today — needs a human)" >> "$ACTION_LOG"
        continue
    fi

    # Capture the pids state at the moment of failure — this is the evidence.
    full=$(docker inspect -f '{{.Id}}' "$name" 2>/dev/null)
    cg="/sys/fs/cgroup/system.slice/docker-${full}.scope"
    pre_cur=$(cat "$cg/pids.current" 2>/dev/null || echo ?)
    pre_max=$(cat "$cg/pids.max" 2>/dev/null || echo ?)
    pre_thr=$(wc -l < "$cg/cgroup.threads" 2>/dev/null || echo ?)
    streak=$(docker inspect -f '{{if .State.Health}}{{.State.Health.FailingStreak}}{{end}}' "$name" 2>/dev/null)

    if docker restart "$name" >/dev/null 2>&1; then
        echo "$ts RESTART $name (unhealthy streak=$streak pids=$pre_cur/$pre_max threads=$pre_thr)" >> "$ACTION_LOG"
        echo "$now" > "$stamp"
    else
        echo "$ts FAILED-RESTART $name" >> "$ACTION_LOG"
    fi
done

# ── 3. prune ─────────────────────────────────────────────────────────────────
find "$LOG_DIR" -name 'pids-*.log' -type f -mtime +$RETAIN_DAYS -delete 2>/dev/null || true
exit 0
