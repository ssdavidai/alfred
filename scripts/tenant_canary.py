#!/usr/bin/env python3
"""Lightweight canary health check for all tenants.

Usage:
    python scripts/tenant_canary.py          # human-readable output
    python scripts/tenant_canary.py --json   # machine-readable JSON output

Designed for cron. Exits 0 if all healthy, 1 if any alerts.
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from tenant_config import ssh_exec, TENANTS, Tenant

# ---------------------------------------------------------------------------
# Single batched check script — executed in one SSH session per tenant
# ---------------------------------------------------------------------------

CHECK_SCRIPT = r"""
set -e
AAS=$(grep '^AAS_API_KEY=' /opt/alfred/compose/.env 2>/dev/null | cut -d= -f2)
results='{'

# 1. Containers running — check all 6 core services
missing=""
for c in compose-temporal-1 compose-ctrl-api-1 compose-openclaw-1 compose-openclaw-workers-1 compose-alfred-1 compose-alfred-learn-1; do
    state=$(docker inspect "$c" --format '{{.State.Status}}' 2>/dev/null || echo "missing")
    if [ "$state" != "running" ]; then
        missing="$missing $c($state)"
    fi
done
if [ -z "$missing" ]; then
    results="$results\"containers\":{\"ok\":true,\"detail\":\"\"},"
else
    results="$results\"containers\":{\"ok\":false,\"detail\":\"not running:$missing\"},"
fi

# 2. Stuck workflows — any RUNNING workflow older than 30 minutes
stuck=$(curl -sf -H "Authorization: Bearer $AAS" http://localhost:3100/api/v1/workflows 2>/dev/null | python3 -c "
import json, sys
from datetime import datetime, timezone, timedelta
try:
    wfs = json.load(sys.stdin)
    if not isinstance(wfs, list):
        wfs = wfs.get('workflows', []) if isinstance(wfs, dict) else []
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=30)
    stuck = []
    for w in wfs:
        status = w.get('status','')
        if status not in ('RUNNING','Running','WORKFLOW_EXECUTION_STATUS_RUNNING'):
            continue
        start = w.get('startTime','') or w.get('start_time','')
        if not start:
            continue
        try:
            st = start.replace('Z','+00:00')
            dt = datetime.fromisoformat(st)
            if dt < cutoff:
                stuck.append(w.get('workflowId','') or w.get('workflow_id','unknown'))
        except Exception:
            pass
    print(json.dumps(stuck))
except Exception:
    print('[]')
" 2>/dev/null || echo '[]')
stuck_count=$(echo "$stuck" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [ "$stuck_count" = "0" ]; then
    results="$results\"workflows\":{\"ok\":true,\"detail\":\"\"},"
else
    results="$results\"workflows\":{\"ok\":false,\"detail\":\"$stuck_count stuck: $stuck\"},"
fi

# 3. Paused schedules
paused=$(curl -sf -H "Authorization: Bearer $AAS" http://localhost:3100/api/v1/schedules 2>/dev/null | python3 -c "
import json, sys
try:
    scheds = json.load(sys.stdin)
    if not isinstance(scheds, list):
        scheds = scheds.get('schedules', []) if isinstance(scheds, dict) else []
    paused = [s.get('scheduleId','') for s in scheds if s.get('paused', False)]
    print(json.dumps(paused))
except Exception:
    print('[]')
" 2>/dev/null || echo '[]')
paused_count=$(echo "$paused" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [ "$paused_count" = "0" ]; then
    results="$results\"schedules\":{\"ok\":true,\"detail\":\"\"},"
else
    results="$results\"schedules\":{\"ok\":false,\"detail\":\"$paused_count paused: $paused\"},"
fi

# 4. Gateway responds — openclaw health
gw_code=$(curl -sf -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo "000")
if [ "$gw_code" = "200" ]; then
    results="$results\"gateway\":{\"ok\":true,\"detail\":\"\"},"
else
    results="$results\"gateway\":{\"ok\":false,\"detail\":\"HTTP $gw_code\"},"
fi

# 5. Learn stable — uptime > 5 minutes (300 seconds)
learn_uptime=$(docker inspect compose-alfred-learn-1 --format '{{.State.StartedAt}}' 2>/dev/null || echo "")
if [ -n "$learn_uptime" ]; then
    uptime_ok=$(python3 -c "
from datetime import datetime, timezone, timedelta
import sys
try:
    start = '$learn_uptime'.replace('Z','+00:00')
    dt = datetime.fromisoformat(start)
    age = (datetime.now(timezone.utc) - dt).total_seconds()
    print('ok' if age > 300 else f'uptime:{int(age)}s')
except Exception as e:
    print(f'parse_error:{e}')
" 2>/dev/null || echo "parse_error")
    if [ "$uptime_ok" = "ok" ]; then
        results="$results\"learn\":{\"ok\":true,\"detail\":\"\"},"
    else
        results="$results\"learn\":{\"ok\":false,\"detail\":\"$uptime_ok\"},"
    fi
else
    results="$results\"learn\":{\"ok\":false,\"detail\":\"container not found\"},"
fi

# 6. Disk OK — usage < 90%
disk_pct=$(df /mnt/encrypted 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%' || echo "0")
if [ -z "$disk_pct" ]; then disk_pct=0; fi
if [ "$disk_pct" -lt 90 ] 2>/dev/null; then
    results="$results\"disk\":{\"ok\":true,\"detail\":\"${disk_pct}%\"}"
else
    results="$results\"disk\":{\"ok\":false,\"detail\":\"${disk_pct}%\"}"
fi

results="$results}"
echo "$results"
"""

CHECK_NAMES = ["reachable", "containers", "workflows", "schedules", "gateway", "learn", "disk"]


def check_tenant(tenant: Tenant) -> dict:
    """Run all canary checks on a single tenant. Returns structured result."""
    result = {
        "name": tenant.name,
        "checks": {},
        "healthy": False,
    }

    # Reachability is implicit — if SSH fails, everything fails
    code, output = ssh_exec(tenant, CHECK_SCRIPT, timeout=15)

    if code == -1 and "SSH_TIMEOUT" in output:
        result["checks"]["reachable"] = {"ok": False, "detail": "timeout"}
        for name in CHECK_NAMES[1:]:
            result["checks"][name] = {"ok": False, "detail": "unreachable"}
        return result

    if code != 0:
        result["checks"]["reachable"] = {"ok": False, "detail": f"exit {code}"}
        for name in CHECK_NAMES[1:]:
            result["checks"][name] = {"ok": False, "detail": "unreachable"}
        return result

    result["checks"]["reachable"] = {"ok": True, "detail": ""}

    # Parse the JSON output
    try:
        # Find JSON blob in output (last line that starts with {)
        json_str = None
        for line in reversed(output.split("\n")):
            line = line.strip()
            if line.startswith("{"):
                json_str = line
                break
        if not json_str:
            raise ValueError("No JSON found")
        parsed = json.loads(json_str)
    except (json.JSONDecodeError, ValueError) as e:
        result["checks"]["reachable"] = {"ok": True, "detail": ""}
        for name in CHECK_NAMES[1:]:
            result["checks"][name] = {"ok": False, "detail": f"parse error: {e}"}
        return result

    for name in CHECK_NAMES[1:]:
        if name in parsed:
            result["checks"][name] = parsed[name]
        else:
            result["checks"][name] = {"ok": False, "detail": "check missing"}

    result["healthy"] = all(c["ok"] for c in result["checks"].values())
    return result


def format_human(results: list[dict], timestamp: str) -> str:
    """Render human-readable canary output."""
    lines = []
    lines.append("")
    lines.append(f"\u2550\u2550\u2550 Canary Check: {timestamp} \u2550\u2550\u2550")
    lines.append("")

    healthy_count = 0
    alert_count = 0

    for r in results:
        name = r["name"]
        lines.append(f"{name}:")

        check_parts = []
        alerts = []
        for cname in CHECK_NAMES:
            c = r["checks"].get(cname, {"ok": False, "detail": "missing"})
            mark = "OK" if c["ok"] else "FAIL"
            check_parts.append(f"  {mark} {cname}")
            if not c["ok"]:
                detail = c.get("detail", "")
                alerts.append(f"{cname}: {detail}" if detail else cname)

        lines.append("  " + "  ".join(
            (f"OK {cname}" if r["checks"].get(cname, {}).get("ok") else f"FAIL {cname}")
            for cname in CHECK_NAMES
        ))

        if r["healthy"]:
            lines.append("  ALL CLEAR")
            healthy_count += 1
        else:
            for a in alerts:
                lines.append(f"  ALERT: {a}")
            alert_count += 1

        lines.append("")

    lines.append(f"Overall: {healthy_count}/{len(results)} healthy, {alert_count}/{len(results)} alerts")
    return "\n".join(lines)


def format_json(results: list[dict], timestamp: str) -> str:
    """Render machine-readable JSON output."""
    return json.dumps({
        "timestamp": timestamp,
        "tenants": results,
        "healthy_count": sum(1 for r in results if r["healthy"]),
        "alert_count": sum(1 for r in results if not r["healthy"]),
        "total": len(results),
    }, indent=2)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    json_mode = "--json" in sys.argv

    tenant_list = list(TENANTS.values())
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    # Run all tenant checks in parallel
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=len(tenant_list)) as pool:
        futures = {pool.submit(check_tenant, t): t.name for t in tenant_list}
        for future in as_completed(futures):
            results.append(future.result())

    # Sort by tenant name for stable output
    results.sort(key=lambda r: r["name"])

    if json_mode:
        print(format_json(results, timestamp))
    else:
        print(format_human(results, timestamp))

    has_alerts = any(not r["healthy"] for r in results)
    sys.exit(1 if has_alerts else 0)


if __name__ == "__main__":
    main()
