#!/usr/bin/env python3
"""Smoke tests that verify actual user journeys on Alfred Black tenants.

Usage:
    python scripts/tenant_smoke.py david
    python scripts/tenant_smoke.py all
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone

from tenant_config import TENANTS, Tenant, get_tenant, ssh_exec

# -- ANSI colours ---------------------------------------------------------- #

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
BOLD = "\033[1m"
RESET = "\033[0m"


# -- Result type ----------------------------------------------------------- #

class TestResult:
    __slots__ = ("passed", "skipped", "name", "detail")

    def __init__(self, *, passed: bool, name: str, detail: str, skipped: bool = False):
        self.passed = passed
        self.skipped = skipped
        self.name = name
        self.detail = detail


def skip(name: str, detail: str) -> TestResult:
    return TestResult(passed=False, skipped=True, name=name, detail=detail)


# -- Helpers --------------------------------------------------------------- #

AAS_CMD = "grep ^AAS_API_KEY /opt/alfred/compose/.env | cut -d= -f2"


def _curl_api(endpoint: str, *, method: str = "GET", data: str | None = None,
              extra: str = "") -> str:
    """Build a curl command string against the ctrl-api."""
    parts = [
        f'AAS=$(grep ^AAS_API_KEY /opt/alfred/compose/.env | cut -d= -f2);',
        f'curl -s -w "\\n%{{http_code}}"',
        f'-X {method}',
        '-H "Authorization: Bearer $AAS"',
    ]
    if data is not None:
        parts.append('-H "Content-Type: application/json"')
        parts.append(f"-d '{data}'")
    if extra:
        parts.append(extra)
    parts.append(f'http://localhost:3100{endpoint}')
    return " ".join(parts)


def _parse_curl(output: str) -> tuple[str, int]:
    """Split curl output (body + status code on last line) into (body, code)."""
    lines = output.strip().rsplit("\n", 1)
    if len(lines) == 2:
        body, code_str = lines
        try:
            return body, int(code_str)
        except ValueError:
            pass
    return output, 0


# -- Tests ----------------------------------------------------------------- #

def test_vault_crud(tenant: Tenant) -> TestResult:
    name = "vault_crud"
    t0 = time.monotonic()

    # Create
    create_data = json.dumps({
        "type": "note",
        "name": "_smoke_test_probe",
        "content": (
            "---\ntype: note\nname: _smoke_test_probe\nstatus: active\n"
            "created: 2026-01-01\n---\n# Smoke Test\nThis is an automated probe."
        ),
    })
    rc, out = ssh_exec(tenant, _curl_api(
        "/api/v1/vault/records", method="POST", data=create_data,
    ), timeout=20)
    _, create_code = _parse_curl(out)
    if rc != 0 or create_code not in (200, 201):
        return TestResult(passed=False, name=name,
                          detail=f"create failed: HTTP {create_code}, rc={rc}")

    # Read
    rc, out = ssh_exec(tenant, _curl_api(
        "/api/v1/vault/records/note/_smoke_test_probe.md",
    ), timeout=15)
    body, read_code = _parse_curl(out)
    if rc != 0 or read_code != 200:
        # Try to clean up even on failure
        ssh_exec(tenant, _curl_api(
            "/api/v1/vault/records/note/_smoke_test_probe.md", method="DELETE",
        ), timeout=10)
        return TestResult(passed=False, name=name,
                          detail=f"read failed: HTTP {read_code}, rc={rc}")

    if "_smoke_test_probe" not in body:
        ssh_exec(tenant, _curl_api(
            "/api/v1/vault/records/note/_smoke_test_probe.md", method="DELETE",
        ), timeout=10)
        return TestResult(passed=False, name=name,
                          detail="read succeeded but content mismatch")

    # Delete
    rc, out = ssh_exec(tenant, _curl_api(
        "/api/v1/vault/records/note/_smoke_test_probe.md", method="DELETE",
    ), timeout=15)
    _, del_code = _parse_curl(out)
    if rc != 0 or del_code not in (200, 204):
        return TestResult(passed=False, name=name,
                          detail=f"delete failed: HTTP {del_code}, rc={rc}")

    elapsed = time.monotonic() - t0
    return TestResult(passed=True, name=name,
                      detail=f"create/read/delete cycle: {elapsed:.1f}s")


def test_mcp_ctrl_tool(tenant: Tenant) -> TestResult:
    name = "mcp_ctrl_tool"

    # Build the MCP JSON-RPC sequence
    init_msg = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1.0"},
        },
    })
    notif_msg = json.dumps({
        "jsonrpc": "2.0", "method": "notifications/initialized",
    })
    call_msg = json.dumps({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {
            "name": "ctrl",
            "arguments": {"endpoint": "/api/v1/admin/health"},
        },
    })

    # Write JSON messages to a temp file on the remote, then pipe to MCP server.
    # This avoids nested quote escaping issues with bash -s + docker exec.
    cmd = (
        f'AAS=$(grep ^AAS_API_KEY /opt/alfred/compose/.env | cut -d= -f2)\n'
        f'TMPFILE=$(mktemp)\n'
        f'cat > "$TMPFILE" << \'MCPEOF\'\n'
        f'{init_msg}\n'
        f'{notif_msg}\n'
        f'{call_msg}\n'
        f'MCPEOF\n'
        f'docker exec compose-openclaw-1 mkdir -p /alfred-data/tmp-xfer\n'
        f'docker cp "$TMPFILE" compose-openclaw-1:/alfred-data/tmp-xfer/_mcp_test.json\n'
        f'rm -f "$TMPFILE"\n'
        f'docker exec '
        f'-e CTRL_API_URL=http://ctrl-api:3100 '
        f'-e AAS_API_KEY=$AAS '
        f'-e NODE_PATH=/app/node_modules '
        f'compose-openclaw-1 bash -c '
        f'"timeout 10 node /home/node/.openclaw/mcp/ctrl-server.mjs < /alfred-data/tmp-xfer/_mcp_test.json 2>/dev/null; rm -f /alfred-data/tmp-xfer/_mcp_test.json"'
    )

    rc, out = ssh_exec(tenant, cmd, timeout=30)
    if rc != 0 and "SSH_TIMEOUT" in out:
        return TestResult(passed=False, name=name, detail="SSH timeout")

    if '"jsonrpc"' not in out:
        return TestResult(passed=False, name=name,
                          detail=f"no JSON-RPC in response (rc={rc})")

    if '"isError":true' in out or '"isError": true' in out:
        return TestResult(passed=False, name=name,
                          detail="MCP response contains isError:true")

    return TestResult(passed=True, name=name,
                      detail="MCP initialize + ctrl call")


def test_vault_context(tenant: Tenant) -> TestResult:
    name = "vault_context"

    rc, out = ssh_exec(tenant, _curl_api("/api/v1/vault/context"), timeout=20)
    body, code = _parse_curl(out)

    if rc != 0 or code != 200:
        return TestResult(passed=False, name=name,
                          detail=f"HTTP {code}, rc={rc}")

    try:
        data = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return TestResult(passed=False, name=name,
                          detail="response is not valid JSON")

    if not data:
        return TestResult(passed=False, name=name,
                          detail="response is empty")

    # Try to summarise contents
    if isinstance(data, dict):
        type_count = len(data)
        total = sum(v if isinstance(v, int) else len(v) if isinstance(v, list) else 0
                    for v in data.values())
        return TestResult(passed=True, name=name,
                          detail=f"{type_count} record types, {total} total")

    return TestResult(passed=True, name=name, detail="non-empty response")


def test_schedules_healthy(tenant: Tenant) -> TestResult:
    name = "schedules_healthy"

    EXPECTED = {
        "al-event-processor",
        "al-session-tracker",
        "al-learning",
        "al-judgment",
        "al-task-runner",
        "al-hourly-enrichment",
        "al-daily-digest",
        "al-reflection",
    }

    rc, out = ssh_exec(tenant, _curl_api("/api/v1/schedules"), timeout=20)
    body, code = _parse_curl(out)

    if rc != 0 or code != 200:
        return TestResult(passed=False, name=name,
                          detail=f"HTTP {code}, rc={rc}")

    try:
        data = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return TestResult(passed=False, name=name,
                          detail="response is not valid JSON")

    schedules = data if isinstance(data, list) else data.get("schedules", [])

    found_ids = set()
    paused = []
    for s in schedules:
        sid = s.get("scheduleId", s.get("id", s.get("name", "")))
        found_ids.add(sid)
        if s.get("paused"):
            paused.append(sid)

    missing = EXPECTED - found_ids
    if missing:
        return TestResult(passed=False, name=name,
                          detail=f"missing schedules: {', '.join(sorted(missing))}")

    if paused:
        return TestResult(passed=False, name=name,
                          detail=f"paused schedules: {', '.join(sorted(paused))}")

    active_count = len(EXPECTED & found_ids)
    return TestResult(passed=True, name=name,
                      detail=f"{active_count}/{len(EXPECTED)} schedules active")


def test_no_stuck_workflows(tenant: Tenant) -> TestResult:
    name = "no_stuck_workflows"

    rc, out = ssh_exec(tenant, _curl_api("/api/v1/workflows"), timeout=20)
    body, code = _parse_curl(out)

    if rc != 0 or code != 200:
        return TestResult(passed=False, name=name,
                          detail=f"HTTP {code}, rc={rc}")

    try:
        data = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return TestResult(passed=False, name=name,
                          detail="response is not valid JSON")

    workflows = data if isinstance(data, list) else data.get("workflows", [])
    now = datetime.now(timezone.utc)
    stuck = []

    for wf in workflows:
        status = wf.get("status", "")
        if status != "RUNNING":
            continue

        started = wf.get("startTime", wf.get("start_time", ""))
        if not started:
            continue

        try:
            # Handle ISO format with or without Z suffix
            started_str = started.replace("Z", "+00:00")
            start_dt = datetime.fromisoformat(started_str)
            elapsed_min = (now - start_dt).total_seconds() / 60
            if elapsed_min > 30:
                wf_type = wf.get("workflowType", wf.get("type", "unknown"))
                if isinstance(wf_type, dict):
                    wf_type = wf_type.get("name", "unknown")
                stuck.append(f"{wf_type} ({int(elapsed_min)}m)")
        except (ValueError, TypeError):
            continue

    if stuck:
        return TestResult(passed=False, name=name,
                          detail=f"{len(stuck)} workflow(s) running >30m: {', '.join(stuck)}")

    return TestResult(passed=True, name=name, detail="no stuck workflows")


def test_gateway_health(tenant: Tenant) -> TestResult:
    name = "gateway_health"

    rc, out = ssh_exec(tenant,
                       "docker exec compose-openclaw-1 curl -sf http://localhost:18789/health",
                       timeout=15)

    if rc != 0:
        return TestResult(passed=False, name=name,
                          detail=f"gateway unhealthy (rc={rc}): {out[:120]}")

    return TestResult(passed=True, name=name, detail="healthy")


def test_streams_active(tenant: Tenant) -> TestResult:
    name = "streams_active"

    rc, out = ssh_exec(tenant, _curl_api("/api/v1/streams"), timeout=20)
    body, code = _parse_curl(out)

    if rc != 0 or code != 200:
        return TestResult(passed=False, name=name,
                          detail=f"HTTP {code}, rc={rc}")

    try:
        data = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return TestResult(passed=False, name=name,
                          detail="response is not valid JSON")

    streams = data if isinstance(data, list) else data.get("streams", [])

    if not streams:
        return skip(name, "no streams configured")

    # Check if any stream has recent events (last 24h)
    now = datetime.now(timezone.utc)
    active_count = 0

    for s in streams:
        last_event = s.get("lastEventAt", s.get("last_event_at", s.get("lastSync", "")))
        if not last_event:
            continue
        try:
            last_str = last_event.replace("Z", "+00:00")
            last_dt = datetime.fromisoformat(last_str)
            hours_ago = (now - last_dt).total_seconds() / 3600
            if hours_ago <= 24:
                active_count += 1
        except (ValueError, TypeError):
            continue

    if active_count == 0:
        return skip(name, f"{len(streams)} stream(s) but none active in last 24h")

    return TestResult(passed=True, name=name,
                      detail=f"{active_count}/{len(streams)} streams active in last 24h")


def test_learn_container_stable(tenant: Tenant) -> TestResult:
    name = "learn_container_stable"

    # Check container start time
    rc, out = ssh_exec(tenant,
                       "docker inspect compose-alfred-learn-1 "
                       "--format '{{.State.StartedAt}}'",
                       timeout=15)

    if rc != 0:
        return TestResult(passed=False, name=name,
                          detail=f"cannot inspect container: {out[:120]}")

    now = datetime.now(timezone.utc)
    try:
        started_str = out.strip().strip("'").replace("Z", "+00:00")
        # Docker format: 2026-04-13T10:30:00.123456789Z — truncate nanoseconds
        if "." in started_str:
            base, frac = started_str.split(".", 1)
            # Keep only up to 6 digits of fractional seconds
            frac_clean = ""
            tz_suffix = ""
            for i, c in enumerate(frac):
                if c.isdigit():
                    frac_clean += c
                else:
                    tz_suffix = frac[i:]
                    break
            frac_clean = frac_clean[:6]
            started_str = f"{base}.{frac_clean}{tz_suffix}"
        start_dt = datetime.fromisoformat(started_str)
        uptime_min = (now - start_dt).total_seconds() / 60
    except (ValueError, TypeError) as e:
        return TestResult(passed=False, name=name,
                          detail=f"cannot parse start time '{out.strip()}': {e}")

    if uptime_min < 10:
        return TestResult(passed=False, name=name,
                          detail=f"uptime only {uptime_min:.0f}m (recent restart)")

    # Check error count in recent logs
    rc2, out2 = ssh_exec(tenant,
                         "docker logs compose-alfred-learn-1 --tail=50 2>&1 "
                         "| grep -c 'ERROR\\|Traceback'",
                         timeout=15)

    error_count = 0
    try:
        error_count = int(out2.strip())
    except (ValueError, TypeError):
        pass

    if error_count >= 5:
        return TestResult(passed=False, name=name,
                          detail=f"uptime {_fmt_duration(uptime_min)}, "
                                 f"{error_count} errors in last 50 lines")

    return TestResult(passed=True, name=name,
                      detail=f"uptime: {_fmt_duration(uptime_min)}, "
                             f"{error_count} errors")


def test_workers_healthy(tenant: Tenant) -> TestResult:
    name = "workers_healthy"

    rc, out = ssh_exec(tenant,
                       "docker inspect compose-openclaw-workers-1 "
                       "--format '{{.RestartCount}} {{.State.StartedAt}}'",
                       timeout=15)

    if rc != 0:
        return TestResult(passed=False, name=name,
                          detail=f"cannot inspect container: {out[:120]}")

    parts = out.strip().split(" ", 1)
    if len(parts) < 2:
        return TestResult(passed=False, name=name,
                          detail=f"unexpected inspect output: {out[:120]}")

    try:
        restart_count = int(parts[0])
    except ValueError:
        return TestResult(passed=False, name=name,
                          detail=f"cannot parse restart count: {parts[0]}")

    now = datetime.now(timezone.utc)
    try:
        started_raw = parts[1].strip().strip("'").replace("Z", "+00:00")
        if "." in started_raw:
            base, frac = started_raw.split(".", 1)
            frac_clean = ""
            tz_suffix = ""
            for i, c in enumerate(frac):
                if c.isdigit():
                    frac_clean += c
                else:
                    tz_suffix = frac[i:]
                    break
            frac_clean = frac_clean[:6]
            started_raw = f"{base}.{frac_clean}{tz_suffix}"
        start_dt = datetime.fromisoformat(started_raw)
        uptime_min = (now - start_dt).total_seconds() / 60
    except (ValueError, TypeError) as e:
        return TestResult(passed=False, name=name,
                          detail=f"cannot parse start time: {e}")

    # Check current stability: uptime >5min means not actively crash-looping
    # (total restart count is cumulative and can be high from past issues)
    if uptime_min < 5:
        return TestResult(passed=False, name=name,
                          detail=f"uptime only {uptime_min:.0f}m, "
                                 f"{restart_count} total restarts — may be crash-looping")

    return TestResult(passed=True, name=name,
                      detail=f"{restart_count} restarts, "
                             f"uptime: {_fmt_duration(uptime_min)}")


# -- Helpers --------------------------------------------------------------- #

def _fmt_duration(minutes: float) -> str:
    if minutes < 60:
        return f"{int(minutes)}m"
    hours = minutes / 60
    if hours < 24:
        return f"{hours:.0f}h"
    days = hours / 24
    return f"{days:.0f}d"


# -- All tests ------------------------------------------------------------- #

ALL_TESTS = [
    test_vault_crud,
    test_mcp_ctrl_tool,
    test_vault_context,
    test_schedules_healthy,
    test_no_stuck_workflows,
    test_gateway_health,
    test_streams_active,
    test_learn_container_stable,
    test_workers_healthy,
]


# -- Runner ---------------------------------------------------------------- #

def run_tenant(tenant: Tenant) -> bool:
    """Run all smoke tests for a tenant. Returns True if all passed."""
    print(f"\n{BOLD}{'=' * 3} Smoke Tests: {tenant.name} {'=' * 3}{RESET}")

    passed = 0
    failed = 0
    skipped = 0

    for test_fn in ALL_TESTS:
        try:
            result = test_fn(tenant)
        except Exception as exc:
            result = TestResult(passed=False, name=test_fn.__name__.removeprefix("test_"),
                                detail=f"unhandled exception: {exc}")

        label = result.name.ljust(24, ".")
        if result.skipped:
            icon = f"{YELLOW}-{RESET}"
            status = f"{YELLOW}SKIP{RESET}"
            skipped += 1
        elif result.passed:
            icon = f"{GREEN}\u2713{RESET}"
            status = f"{GREEN}PASS{RESET}"
            passed += 1
        else:
            icon = f"{RED}\u2717{RESET}"
            status = f"{RED}FAIL{RESET}"
            failed += 1

        print(f"  {icon} {label} {status} ({result.detail})")

    print()
    parts = [f"{GREEN}{passed} passed{RESET}"]
    if failed:
        parts.append(f"{RED}{failed} failed{RESET}")
    if skipped:
        parts.append(f"{YELLOW}{skipped} skipped{RESET}")
    print(f"  Result: {', '.join(parts)}")

    return failed == 0


def main() -> None:
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <tenant|all>")
        print(f"  Available tenants: {', '.join(TENANTS.keys())}")
        sys.exit(2)

    target = sys.argv[1].lower()
    all_ok = True

    if target == "all":
        for tenant in TENANTS.values():
            ok = run_tenant(tenant)
            if not ok:
                all_ok = False
    else:
        tenant = get_tenant(target)
        all_ok = run_tenant(tenant)

    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
