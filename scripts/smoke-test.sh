#!/usr/bin/env bash
# smoke-test.sh — Post-deploy tenant verification
# Run on a tenant VPS via SSH to verify all services are operational.
#
# Usage:  ssh tenant-host 'bash -s' < scripts/smoke-test.sh
# Exit:   0 = all checks pass, 1 = one or more failures
set -euo pipefail

PASS=0
FAIL=0

check() {
    local name="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        echo "[OK]   $name"
        PASS=$((PASS + 1))
    else
        echo "[FAIL] $name"
        FAIL=$((FAIL + 1))
    fi
}

# --- 1. Docker containers running ---
for container in temporal openclaw alfred alfred-learn; do
    check "Container '$container' is running" \
        docker compose -f /opt/alfred/compose/docker-compose.yaml ps --status running --format '{{.Name}}' \
        | grep -q "$container"
done

# --- 2. OpenClaw health endpoint ---
check "OpenClaw health (localhost:18789/health)" \
    curl -sf --max-time 5 http://localhost:18789/health

# --- 3. Temporal cluster health ---
check "Temporal cluster is SERVING" \
    docker compose -f /opt/alfred/compose/docker-compose.yaml exec -T temporal \
    temporal operator cluster health

# --- 4. alfred-ctrl API responds ---
# 200 = OK, 401 = auth required (still means service is up)
check "alfred-ctrl API (localhost:3100)" \
    bash -c 'code=$(curl -so /dev/null -w "%{http_code}" --max-time 5 http://localhost:3100/api/v1/vault/list/observation); [ "$code" = "200" ] || [ "$code" = "401" ]'

# --- 5. Disk usage on /mnt/encrypted < 90% ---
check "Disk usage /mnt/encrypted < 90%" \
    bash -c 'usage=$(df /mnt/encrypted --output=pcent | tail -1 | tr -d " %"); [ "$usage" -lt 90 ]'

# --- 6. Memory usage < 95% ---
check "Memory usage < 95%" \
    bash -c 'usage=$(free | awk "/Mem:/ {printf \"%.0f\", \$3/\$2 * 100}"); [ "$usage" -lt 95 ]'

# --- 7. cloudflared service active ---
check "cloudflared systemd service is active" \
    systemctl is-active cloudflared

# --- Summary ---
echo ""
echo "Results: $PASS passed, $FAIL failed ($(( PASS + FAIL )) total)"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
