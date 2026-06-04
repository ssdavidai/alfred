#!/usr/bin/env bash
# =============================================================================
# hermes-maintenance.sh — bound Hermes profile session/state growth + disk alert.
#
# Hermes profile gateways persist request/session artifacts under:
#   $HERMES_HOME/profiles/<profile>/sessions/*
#   $HERMES_HOME/profiles/<profile>/state.db
#
# Busy background profiles can grow these indefinitely. This watchdog is a
# conservative runtime guard: prune old session artifacts, checkpoint/VACUUM the
# SQLite state stores, and alert before the shared tenant disk reaches 100%.
# =============================================================================
set -uo pipefail

HERMES_HOME="${HERMES_HOME:-/opt/data}"
PROFILES_DIR="${HERMES_PROFILES_DIR:-${HERMES_HOME}/profiles}"
INTERVAL_SECONDS="${HERMES_MAINTENANCE_INTERVAL_SECONDS:-3600}"
RETENTION_DAYS="${HERMES_SESSION_RETENTION_DAYS:-2}"
VACUUM_INTERVAL_SECONDS="${HERMES_STATE_DB_VACUUM_INTERVAL_SECONDS:-86400}"
DISK_ALERT_THRESHOLD="${HERMES_DISK_ALERT_THRESHOLD:-80}"
DISK_ALERT_COOLDOWN_SECONDS="${HERMES_DISK_ALERT_COOLDOWN_SECONDS:-21600}"
CTRL_API_URL="${CTRL_API_URL:-http://ctrl-api:3100}"
STAMP_DIR="${HERMES_MAINTENANCE_STAMP_DIR:-${HERMES_HOME}/.maintenance}"
ONCE=0

if [[ "${1:-}" == "--once" ]]; then
  ONCE=1
fi

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [hermes-maintenance] $*"; }

_is_non_negative_int() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

_validate_config() {
  for pair in \
    "INTERVAL_SECONDS:${INTERVAL_SECONDS}" \
    "RETENTION_DAYS:${RETENTION_DAYS}" \
    "VACUUM_INTERVAL_SECONDS:${VACUUM_INTERVAL_SECONDS}" \
    "DISK_ALERT_THRESHOLD:${DISK_ALERT_THRESHOLD}" \
    "DISK_ALERT_COOLDOWN_SECONDS:${DISK_ALERT_COOLDOWN_SECONDS}"; do
    local name="${pair%%:*}"
    local value="${pair#*:}"
    if ! _is_non_negative_int "$value"; then
      log "WARN invalid ${name}=${value}; using built-in safe default"
      case "$name" in
        INTERVAL_SECONDS) INTERVAL_SECONDS=3600 ;;
        RETENTION_DAYS) RETENTION_DAYS=2 ;;
        VACUUM_INTERVAL_SECONDS) VACUUM_INTERVAL_SECONDS=86400 ;;
        DISK_ALERT_THRESHOLD) DISK_ALERT_THRESHOLD=80 ;;
        DISK_ALERT_COOLDOWN_SECONDS) DISK_ALERT_COOLDOWN_SECONDS=21600 ;;
      esac
    fi
  done
  if (( INTERVAL_SECONDS < 60 )); then INTERVAL_SECONDS=60; fi
  if (( DISK_ALERT_THRESHOLD < 1 )); then DISK_ALERT_THRESHOLD=80; fi
  if (( DISK_ALERT_THRESHOLD > 100 )); then DISK_ALERT_THRESHOLD=100; fi
}

_prune_sessions() {
  if [[ ! -d "$PROFILES_DIR" ]]; then
    log "profiles dir missing (${PROFILES_DIR}); skipping session prune"
    return 0
  fi

  local session_dir profile pruned_any=0
  while IFS= read -r -d '' session_dir; do
    profile="$(basename "$(dirname "$session_dir")")"
    # Children only. Never remove the sessions/ directory itself.
    if find "$session_dir" -mindepth 1 -maxdepth 1 -mtime +"$RETENTION_DAYS" -print -exec rm -rf -- {} + | grep -q .; then
      pruned_any=1
      log "pruned ${profile}/sessions entries older than ${RETENTION_DAYS}d"
    fi
  done < <(find "$PROFILES_DIR" -mindepth 2 -maxdepth 2 -type d -name sessions -print0 2>/dev/null)

  if (( pruned_any == 0 )); then
    log "session prune complete — no entries older than ${RETENTION_DAYS}d"
  fi
}

_should_vacuum() {
  local stamp="$STAMP_DIR/last-vacuum"
  local now last=0
  now="$(date +%s)"
  [[ -f "$stamp" ]] && last="$(cat "$stamp" 2>/dev/null || echo 0)"
  ! _is_non_negative_int "$last" && last=0
  (( now - last >= VACUUM_INTERVAL_SECONDS ))
}

_record_vacuum() {
  mkdir -p "$STAMP_DIR" 2>/dev/null || true
  date +%s > "$STAMP_DIR/last-vacuum" 2>/dev/null || true
}

_vacuum_state_dbs() {
  if ! _should_vacuum; then
    return 0
  fi
  if [[ ! -d "$PROFILES_DIR" ]]; then
    return 0
  fi

  local db vacuumed=0
  while IFS= read -r -d '' db; do
    DB_PATH="$db" python3 - <<'PY' || true
import os, sqlite3, sys
path = os.environ["DB_PATH"]
try:
    con = sqlite3.connect(path, timeout=5.0)
    try:
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.DatabaseError:
        pass
    con.execute("VACUUM")
    con.close()
except Exception as exc:
    print(f"SKIP {path}: {exc}", file=sys.stderr)
PY
    vacuumed=1
  done < <(find "$PROFILES_DIR" -mindepth 2 -maxdepth 2 -type f -name state.db -print0 2>/dev/null)

  _record_vacuum
  if (( vacuumed == 1 )); then
    log "state.db maintenance complete"
  else
    log "state.db maintenance complete — no state.db files found"
  fi
}

_read_aas_api_key() {
  local env_file="${PROFILES_DIR}/main/.env"
  [[ -f "$env_file" ]] || return 1
  python3 - "$env_file" <<'PY'
import pathlib, sys
for line in pathlib.Path(sys.argv[1]).read_text(errors="ignore").splitlines():
    if not line.startswith("AAS_API_KEY="):
        continue
    val = line.split("=", 1)[1].strip().strip('"').strip("'")
    if val:
        print(val)
        raise SystemExit(0)
raise SystemExit(1)
PY
}

_notify_disk_alert() {
  local pct="$1" avail="$2" used="$3" mount="$4"
  local stamp="$STAMP_DIR/last-disk-alert" now last=0
  now="$(date +%s)"
  mkdir -p "$STAMP_DIR" 2>/dev/null || true
  [[ -f "$stamp" ]] && last="$(cat "$stamp" 2>/dev/null || echo 0)"
  ! _is_non_negative_int "$last" && last=0

  if (( now - last < DISK_ALERT_COOLDOWN_SECONDS )); then
    log "disk ${pct}% >= ${DISK_ALERT_THRESHOLD}% but alert is in cooldown"
    return 0
  fi

  local message="Hermes disk alert: ${mount} is ${pct}% used (${avail} available). Runbook: stop hermes if needed, clear old profiles/*/sessions, then restart."
  log "ALERT ${message}"

  local key payload
  key="$(_read_aas_api_key 2>/dev/null || true)"
  if [[ -n "$key" ]] && command -v curl >/dev/null 2>&1; then
    payload="$(MESSAGE="$message" python3 - <<'PY'
import json, os
print(json.dumps({"message": os.environ["MESSAGE"], "channel": "auto", "urgency": "high"}))
PY
)"
    curl -fsS -m 10 \
      -H "Authorization: Bearer ${key}" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      "${CTRL_API_URL%/}/api/v1/notifications" >/dev/null \
      && log "disk alert delivered via ctrl-api" \
      || log "WARN disk alert ctrl-api delivery failed; log alert emitted"
  else
    log "WARN AAS_API_KEY unavailable; disk alert emitted to logs only"
  fi

  echo "$now" > "$stamp" 2>/dev/null || true
}

_check_disk() {
  local line pct used avail mount
  line="$(df -P "$HERMES_HOME" 2>/dev/null | awk 'NR==2 {print $5, $3, $4, $6}')" || true
  [[ -n "$line" ]] || { log "WARN df failed for ${HERMES_HOME}"; return 0; }
  read -r pct used avail mount <<< "$line"
  pct="${pct%%%}"
  _is_non_negative_int "$pct" || { log "WARN unparsable disk percentage: ${line}"; return 0; }
  if (( pct >= DISK_ALERT_THRESHOLD )); then
    _notify_disk_alert "$pct" "$avail" "$used" "$mount"
  else
    log "disk ${pct}% used (< ${DISK_ALERT_THRESHOLD}% threshold)"
  fi
}

_run_once() {
  _validate_config
  _prune_sessions
  _vacuum_state_dbs
  _check_disk
}

while true; do
  _run_once
  (( ONCE == 1 )) && exit 0
  sleep "$INTERVAL_SECONDS"
done
