#!/usr/bin/env python3
"""Comprehensive infrastructure probe for Alfred Black tenants.

Usage:
    python scripts/tenant_probe.py david
    python scripts/tenant_probe.py all
"""

from __future__ import annotations

import json
import sys
import textwrap
from datetime import datetime, timezone

from tenant_config import TENANTS, Tenant, get_tenant, ssh_exec

# ── ANSI colors ──────────────────────────────────────────────────────────────

GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"
CYAN = "\033[36m"


def ok(msg: str) -> str:
    return f"{GREEN}[PASS]{RESET} {msg}"


def warn(msg: str) -> str:
    return f"{YELLOW}[WARN]{RESET} {msg}"


def fail(msg: str) -> str:
    return f"{RED}[FAIL]{RESET} {msg}"


def header(title: str) -> str:
    return f"\n{BOLD}{CYAN}── {title} ──{RESET}"


# ── Remote probe script ─────────────────────────────────────────────────────
# All checks run in a single SSH session. Each section emits a sentinel line
# (@@SECTION_NAME@@) followed by its output so we can split locally.

REMOTE_SCRIPT = r"""
set -o pipefail

AAS=$(grep ^AAS_API_KEY /opt/alfred/compose/.env 2>/dev/null | head -1 | cut -d= -f2)

echo '@@CONTAINERS@@'
docker ps -a --format '{{.Names}}|{{.Status}}|{{.Image}}' 2>&1

echo '@@IMAGE_DIGESTS@@'
for c in $(docker ps -a --format '{{.Names}}'); do
  digest=$(docker inspect --format '{{.Image}}' "$c" 2>/dev/null)
  echo "${c}|${digest}"
done

echo '@@SCHEDULES@@'
if [ -n "$AAS" ]; then
  curl -sf -H "Authorization: Bearer $AAS" http://localhost:3100/api/v1/schedules 2>&1 || echo '{"error":"curl_failed"}'
  echo ""
else
  echo '{"error":"no_aas_key"}'
fi

echo '@@WORKFLOWS@@'
if [ -n "$AAS" ]; then
  curl -sf -H "Authorization: Bearer $AAS" http://localhost:3100/api/v1/workflows 2>&1 || echo '{"error":"curl_failed"}'
  echo ""
else
  echo '{"error":"no_aas_key"}'
fi

echo '@@VAULT_CONTEXT@@'
if [ -n "$AAS" ]; then
  curl -sf -H "Authorization: Bearer $AAS" http://localhost:3100/api/v1/vault/context 2>&1 || echo '{"error":"curl_failed"}'
  echo ""
else
  echo '{"error":"no_aas_key"}'
fi

echo '@@STREAMS@@'
if [ -n "$AAS" ]; then
  curl -sf -H "Authorization: Bearer $AAS" http://localhost:3100/api/v1/streams 2>&1 || echo '{"error":"curl_failed"}'
  echo ""
else
  echo '{"error":"no_aas_key"}'
fi

echo '@@OPENCLAW_HEALTH@@'
docker exec compose-openclaw-1 curl -sf http://localhost:18789/health 2>&1 || echo 'HEALTH_FAILED'
echo ""

echo '@@MCP_CONFIG@@'
python3 -c "
import json, sys
try:
    c = json.load(open('/mnt/encrypted/openclaw/openclaw.json'))
    mcp = c.get('mcp', {}).get('servers', {}).get('alfred-ctrl')
    if mcp:
        print('YES')
    else:
        print('NO')
except Exception as e:
    print(f'ERROR: {e}')
" 2>&1

echo '@@WORKERS_MEMORY@@'
python3 -c "
import json, sys
try:
    c = json.load(open('/mnt/encrypted/openclaw-workers/openclaw.json'))
    print(c.get('memory', {}).get('backend', 'unknown'))
except Exception as e:
    print(f'ERROR: {e}')
" 2>&1

echo '@@ONBOARDING@@'
python3 -c "
import json, sys
try:
    d = json.load(open('/mnt/encrypted/alfred/onboard.json'))
    print(d.get('stage', 'unknown'))
except Exception as e:
    print(f'ERROR: {e}')
" 2>&1

echo '@@CHORES@@'
echo "vault_chores=$(find /mnt/encrypted/vault -maxdepth 2 -name '*.yaml' -path '*/chores/*' 2>/dev/null | wc -l | tr -d ' ')"
echo "user_chore_files=$(ls /mnt/encrypted/alfred/user-chores/*.py 2>/dev/null | wc -l | tr -d ' ')"

echo '@@DISK_MEM@@'
echo "disk_pct=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %')"
free -m 2>/dev/null | awk '/Mem:/{printf "mem_used=%d\nmem_total=%d\nmem_pct=%.0f\n", $3, $2, $3/$2*100}'

echo '@@ENV_KEYS@@'
grep -oP '^[A-Z_]+(?==)' /opt/alfred/compose/.env 2>/dev/null | sort

echo '@@SKILLS@@'
ls /mnt/encrypted/openclaw/workspace/skills/*/SKILL.md 2>/dev/null | while read f; do dirname "$f" | xargs basename; done

echo '@@LEARN_ERRORS@@'
LEARN_ERRS=$(docker logs compose-alfred-learn-1 --tail=50 2>&1 | grep -ciE "error|traceback|exception" || true)
echo "${LEARN_ERRS:-0}"

echo '@@DONE@@'
"""


# ── Parsing helpers ──────────────────────────────────────────────────────────


def split_sections(raw: str) -> dict[str, str]:
    """Split raw SSH output into named sections by @@SENTINEL@@ markers."""
    sections: dict[str, str] = {}
    current_name: str | None = None
    current_lines: list[str] = []

    for line in raw.splitlines():
        if line.startswith("@@") and line.endswith("@@") and len(line) > 4:
            if current_name is not None:
                sections[current_name] = "\n".join(current_lines).strip()
            current_name = line.strip("@")
            current_lines = []
        else:
            current_lines.append(line)

    if current_name is not None:
        sections[current_name] = "\n".join(current_lines).strip()

    return sections


def try_parse_json(raw: str) -> dict | list | None:
    """Try to parse JSON, return None on failure."""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


# ── Check functions ──────────────────────────────────────────────────────────
# Each returns (lines: list[str], passes: int, warns: int, fails: int)

Result = tuple[list[str], int, int, int]


def check_containers(data: str) -> Result:
    lines: list[str] = [header("1. Containers")]
    p = w = f = 0
    if not data:
        lines.append(fail("No container data returned"))
        return lines, 0, 0, 1

    for row in data.splitlines():
        parts = row.split("|", 2)
        if len(parts) < 3:
            continue
        name, status, image = parts[0].strip(), parts[1].strip(), parts[2].strip()
        status_lower = status.lower()
        is_up = "up" in status_lower
        is_healthy = "healthy" in status_lower
        is_unhealthy = "unhealthy" in status_lower
        # init containers are expected to exit
        is_init = "init" in name.lower()
        short_image = image.split("/")[-1] if "/" in image else image

        if is_init:
            # Init containers should have exited with 0
            if "exited (0)" in status_lower:
                lines.append(ok(f"  {name:35s} Exited(0)  {DIM}{short_image}{RESET}"))
                p += 1
            elif "exited" in status_lower:
                lines.append(warn(f"  {name:35s} {status:20s} {DIM}{short_image}{RESET}"))
                w += 1
            else:
                lines.append(ok(f"  {name:35s} {status:20s} {DIM}{short_image}{RESET}"))
                p += 1
        elif is_unhealthy:
            lines.append(fail(f"  {name:35s} {status:20s} {DIM}{short_image}{RESET}"))
            f += 1
        elif is_up:
            lines.append(ok(f"  {name:35s} {status:20s} {DIM}{short_image}{RESET}"))
            p += 1
        else:
            lines.append(fail(f"  {name:35s} {status:20s} {DIM}{short_image}{RESET}"))
            f += 1

    if p + w + f == 0:
        lines.append(warn("No containers found"))
        w += 1
    return lines, p, w, f


def check_image_digests(data: str) -> Result:
    lines: list[str] = [header("2. Docker Image Digests")]
    p = w = f = 0
    if not data:
        lines.append(warn("No image digest data"))
        return lines, 0, 1, 0

    for row in data.splitlines():
        parts = row.split("|", 1)
        if len(parts) < 2:
            continue
        name, digest = parts[0].strip(), parts[1].strip()
        short_digest = digest[:19] + "..." if len(digest) > 22 else digest
        lines.append(f"       {name:35s} {DIM}{short_digest}{RESET}")
        p += 1

    return lines, p, w, f


def check_schedules(data: str) -> Result:
    lines: list[str] = [header("3. Temporal Schedules")]
    p = w = f = 0
    parsed = try_parse_json(data)

    if parsed is None:
        lines.append(fail("Failed to parse schedules response"))
        return lines, 0, 0, 1

    if isinstance(parsed, dict) and "error" in parsed:
        lines.append(fail(f"API error: {parsed['error']}"))
        return lines, 0, 0, 1

    schedules = parsed if isinstance(parsed, list) else parsed.get("schedules", parsed.get("data", []))
    if not isinstance(schedules, list):
        lines.append(warn(f"Unexpected schedules format: {type(schedules).__name__}"))
        return lines, 0, 1, 0

    if not schedules:
        lines.append(warn("No schedules found"))
        return lines, 0, 1, 0

    for sched in schedules:
        sid = sched.get("scheduleId") or sched.get("id") or sched.get("schedule_id", "?")
        paused = sched.get("paused", sched.get("isPaused", False))
        # Try several field paths for schedule spec
        interval = sched.get("interval") or sched.get("spec", {}).get("intervals", [{}])[0].get("every", "") if isinstance(sched.get("spec"), dict) else ""
        calendar = sched.get("calendar") or ""

        # Last run info
        last_action = sched.get("lastAction") or sched.get("info", {}).get("recentActions", [{}])[-1] if isinstance(sched.get("info"), dict) else {}
        if isinstance(last_action, list) and last_action:
            last_action = last_action[-1]
        elif not isinstance(last_action, dict):
            last_action = {}

        last_time = last_action.get("scheduledTime") or last_action.get("actualTime") or last_action.get("time", "")
        last_result = last_action.get("result") or last_action.get("status", "")

        schedule_str = str(interval or calendar or "?")
        if len(schedule_str) > 25:
            schedule_str = schedule_str[:25] + "..."

        if paused:
            lines.append(warn(f"  {sid:40s} PAUSED  {schedule_str}"))
            w += 1
        else:
            lines.append(ok(f"  {sid:40s} active  {schedule_str}"))
            p += 1

    return lines, p, w, f


def check_workflows(data: str) -> Result:
    lines: list[str] = [header("4. Running Workflows (stuck detector)")]
    p = w = f = 0
    parsed = try_parse_json(data)

    if parsed is None:
        lines.append(fail("Failed to parse workflows response"))
        return lines, 0, 0, 1

    if isinstance(parsed, dict) and "error" in parsed:
        lines.append(fail(f"API error: {parsed['error']}"))
        return lines, 0, 0, 1

    workflows = parsed if isinstance(parsed, list) else parsed.get("workflows") or parsed.get("executions") or parsed.get("data", [])
    if not isinstance(workflows, list):
        lines.append(warn(f"Unexpected workflows format: {type(workflows).__name__}"))
        return lines, 0, 1, 0

    now = datetime.now(timezone.utc)
    stuck_count = 0
    running_count = 0

    for wf in workflows:
        status = (wf.get("status") or wf.get("state", "")).lower()
        if status != "running":
            continue
        running_count += 1
        wf_type = wf.get("type") or wf.get("workflowType") or wf.get("name", "?")
        if isinstance(wf_type, dict):
            wf_type = wf_type.get("name", str(wf_type))
        start_str = wf.get("startTime") or wf.get("start_time") or wf.get("startedAt", "")
        if start_str:
            try:
                # Handle ISO format with or without Z
                start_str_clean = start_str.replace("Z", "+00:00")
                start_dt = datetime.fromisoformat(start_str_clean)
                if start_dt.tzinfo is None:
                    start_dt = start_dt.replace(tzinfo=timezone.utc)
                elapsed = now - start_dt
                elapsed_min = elapsed.total_seconds() / 60
                if elapsed_min > 30:
                    lines.append(warn(f"  {wf_type:40s} running {elapsed_min:.0f}min (>30min)"))
                    stuck_count += 1
                    w += 1
                else:
                    lines.append(ok(f"  {wf_type:40s} running {elapsed_min:.0f}min"))
                    p += 1
            except (ValueError, TypeError):
                lines.append(ok(f"  {wf_type:40s} running (start time unparseable)"))
                p += 1
        else:
            lines.append(ok(f"  {wf_type:40s} running"))
            p += 1

    if running_count == 0:
        lines.append(ok("No running workflows (idle)"))
        p += 1
    elif stuck_count > 0:
        lines.append(warn(f"  {stuck_count} workflow(s) running >30 minutes"))

    return lines, p, w, f


def check_vault_context(data: str) -> Result:
    lines: list[str] = [header("5. Vault Record Counts")]
    p = w = f = 0
    parsed = try_parse_json(data)

    if parsed is None:
        lines.append(fail("Failed to parse vault context"))
        return lines, 0, 0, 1

    if isinstance(parsed, dict) and "error" in parsed:
        lines.append(fail(f"API error: {parsed['error']}"))
        return lines, 0, 0, 1

    # The context endpoint may return counts keyed by entity type or a summary
    counts = parsed.get("counts") or parsed.get("summary") or parsed
    if isinstance(counts, dict):
        total = 0
        for entity_type, count in sorted(counts.items()):
            if isinstance(count, (int, float)):
                lines.append(f"       {entity_type:25s} {int(count):>6d}")
                total += int(count)
            elif isinstance(count, list):
                lines.append(f"       {entity_type:25s} {len(count):>6d}")
                total += len(count)
        if total > 0:
            lines.append(ok(f"  Total: {total} records"))
            p += 1
        else:
            lines.append(warn("Vault appears empty"))
            w += 1
    elif isinstance(counts, list):
        lines.append(ok(f"  {len(counts)} items in vault context"))
        p += 1
    else:
        lines.append(warn(f"Unexpected vault context shape"))
        w += 1

    return lines, p, w, f


def check_streams(data: str) -> Result:
    lines: list[str] = [header("6. Streams")]
    p = w = f = 0
    parsed = try_parse_json(data)

    if parsed is None:
        lines.append(fail("Failed to parse streams response"))
        return lines, 0, 0, 1

    if isinstance(parsed, dict) and "error" in parsed:
        lines.append(fail(f"API error: {parsed['error']}"))
        return lines, 0, 0, 1

    streams = parsed if isinstance(parsed, list) else parsed.get("streams") or parsed.get("data", [])
    if not isinstance(streams, list):
        lines.append(warn(f"Unexpected streams format"))
        return lines, 0, 1, 0

    if not streams:
        lines.append(warn("No streams configured"))
        return lines, 0, 1, 0

    for s in streams:
        name = s.get("name") or s.get("id") or s.get("type", "?")
        stype = s.get("type") or s.get("provider", "")
        enabled = s.get("enabled", True)
        last_pull = s.get("lastPull") or s.get("last_pull") or s.get("lastSyncAt", "")
        event_count = s.get("eventCount") or s.get("event_count") or s.get("totalEvents", "?")

        status_str = "enabled" if enabled else "DISABLED"
        detail = f"{name:25s} type={stype:12s} events={event_count}  last_pull={last_pull or 'never'}"

        if not enabled:
            lines.append(warn(f"  {detail}  {status_str}"))
            w += 1
        else:
            lines.append(ok(f"  {detail}"))
            p += 1

    return lines, p, w, f


def check_openclaw_health(data: str) -> Result:
    lines: list[str] = [header("7. OpenClaw Gateway Health")]
    if "HEALTH_FAILED" in data:
        lines.append(fail("OpenClaw gateway health check failed"))
        return lines, 0, 0, 1
    else:
        # Try to parse as JSON for details
        parsed = try_parse_json(data)
        if parsed and isinstance(parsed, dict):
            status = parsed.get("status", "ok")
            lines.append(ok(f"Gateway healthy (status={status})"))
        else:
            lines.append(ok(f"Gateway healthy"))
        return lines, 1, 0, 0


def check_mcp_config(data: str) -> Result:
    lines: list[str] = [header("8. MCP Config (alfred-ctrl server)")]
    val = data.strip()
    if val == "YES":
        lines.append(ok("mcp.servers.alfred-ctrl configured"))
        return lines, 1, 0, 0
    elif val == "NO":
        lines.append(warn("mcp.servers.alfred-ctrl NOT configured"))
        return lines, 0, 1, 0
    else:
        lines.append(fail(f"Could not read MCP config: {val}"))
        return lines, 0, 0, 1


def check_workers_memory(data: str) -> Result:
    lines: list[str] = [header("9. Workers Memory Backend")]
    val = data.strip()
    if val.startswith("ERROR"):
        lines.append(fail(f"Could not read workers config: {val}"))
        return lines, 0, 0, 1
    else:
        lines.append(ok(f"Backend: {val}"))
        return lines, 1, 0, 0


def check_onboarding(data: str) -> Result:
    lines: list[str] = [header("10. Onboarding Stage")]
    val = data.strip()
    if val.startswith("ERROR"):
        lines.append(fail(f"Could not read onboard.json: {val}"))
        return lines, 0, 0, 1
    elif val == "done":
        lines.append(ok(f"Stage: {val}"))
        return lines, 1, 0, 0
    elif val == "unknown":
        lines.append(warn(f"Stage: {val}"))
        return lines, 0, 1, 0
    else:
        lines.append(warn(f"Stage: {val} (not 'done')"))
        return lines, 0, 1, 0


def check_chores(data: str) -> Result:
    lines: list[str] = [header("11. Chores")]
    p = w = f = 0
    vault_chores = 0
    user_chore_files = 0
    for line in data.splitlines():
        if line.startswith("vault_chores="):
            try:
                vault_chores = int(line.split("=", 1)[1])
            except ValueError:
                pass
        elif line.startswith("user_chore_files="):
            try:
                user_chore_files = int(line.split("=", 1)[1])
            except ValueError:
                pass

    lines.append(ok(f"  Vault chore records: {vault_chores}"))
    lines.append(ok(f"  User-chore .py files: {user_chore_files}"))
    p += 1
    if vault_chores > 0 and user_chore_files == 0:
        lines.append(warn("Chore records exist but no .py templates deployed"))
        w += 1
    return lines, p, w, f


def check_disk_mem(data: str) -> Result:
    lines: list[str] = [header("12. Disk & Memory")]
    p = w = f = 0
    disk_pct = None
    mem_used = mem_total = mem_pct = None

    for line in data.splitlines():
        if line.startswith("disk_pct="):
            try:
                disk_pct = int(line.split("=", 1)[1])
            except ValueError:
                pass
        elif line.startswith("mem_used="):
            try:
                mem_used = int(line.split("=", 1)[1])
            except ValueError:
                pass
        elif line.startswith("mem_total="):
            try:
                mem_total = int(line.split("=", 1)[1])
            except ValueError:
                pass
        elif line.startswith("mem_pct="):
            try:
                mem_pct = int(line.split("=", 1)[1])
            except ValueError:
                pass

    # Disk
    if disk_pct is not None:
        if disk_pct >= 90:
            lines.append(fail(f"  Disk usage: {disk_pct}%"))
            f += 1
        elif disk_pct >= 75:
            lines.append(warn(f"  Disk usage: {disk_pct}%"))
            w += 1
        else:
            lines.append(ok(f"  Disk usage: {disk_pct}%"))
            p += 1
    else:
        lines.append(warn("  Disk usage: unknown"))
        w += 1

    # Memory
    if mem_used is not None and mem_total is not None and mem_pct is not None:
        mem_str = f"{mem_used}/{mem_total}MB ({mem_pct}%)"
        if mem_pct >= 95:
            lines.append(fail(f"  Memory: {mem_str}"))
            f += 1
        elif mem_pct >= 85:
            lines.append(warn(f"  Memory: {mem_str}"))
            w += 1
        else:
            lines.append(ok(f"  Memory: {mem_str}"))
            p += 1
    else:
        lines.append(warn("  Memory: unknown"))
        w += 1

    return lines, p, w, f


def check_env_keys(data: str) -> Result:
    lines: list[str] = [header("13. .env Keys Present")]
    p = w = f = 0
    keys = [k.strip() for k in data.splitlines() if k.strip()]

    # Essential keys that should always be present
    # Note: TEMPORAL_HOST and ALFRED_LEARN_ENABLED are set in docker-compose
    # environment, not in .env — so only check AAS_API_KEY here
    essential = {"AAS_API_KEY"}
    # LLM keys — at least one should be present
    llm_keys = {"OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"}

    for ek in sorted(essential):
        if ek in keys:
            p += 1
        else:
            lines.append(warn(f"  Missing essential key: {ek}"))
            w += 1

    found_llm = llm_keys & set(keys)
    if found_llm:
        p += 1
    else:
        lines.append(warn("  No LLM provider key found in .env"))
        w += 1

    lines.append(ok(f"  {len(keys)} keys total, {len(found_llm)} LLM provider key(s): {', '.join(sorted(found_llm)) or 'none'}"))

    # List all keys in dim
    lines.append(f"       {DIM}Keys: {', '.join(keys)}{RESET}")

    return lines, p, w, f


def check_skills(data: str) -> Result:
    lines: list[str] = [header("14. Deployed Skills")]
    p = w = f = 0
    skills = [s.strip() for s in data.splitlines() if s.strip()]

    expected_main = {"alfred-vault-operations", "alfred-chore-management", "alfred-learning-introspection", "alfred-ops-health"}
    expected_worker = {"vault-curator", "vault-janitor", "vault-distiller"}
    all_expected = expected_main | expected_worker

    found = set(skills)
    missing_main = expected_main - found
    missing_worker = expected_worker - found

    for s in sorted(skills):
        lines.append(ok(f"  {s}"))
        p += 1

    if missing_main:
        for m in sorted(missing_main):
            lines.append(warn(f"  Missing main-agent skill: {m}"))
            w += 1

    if missing_worker:
        for m in sorted(missing_worker):
            lines.append(warn(f"  Missing worker skill: {m}"))
            w += 1

    if not skills:
        lines.append(fail("No skills deployed"))
        f += 1

    return lines, p, w, f


def check_learn_errors(data: str) -> Result:
    lines: list[str] = [header("15. Recent Learn Container Errors (last 50 log lines)")]
    try:
        count = int(data.strip())
    except ValueError:
        count = -1

    if count < 0:
        lines.append(warn("Could not read learn container logs"))
        return lines, 0, 1, 0
    elif count == 0:
        lines.append(ok("No errors in recent logs"))
        return lines, 1, 0, 0
    elif count <= 3:
        lines.append(warn(f"{count} error/traceback/exception line(s) in recent logs"))
        return lines, 0, 1, 0
    else:
        lines.append(fail(f"{count} error/traceback/exception line(s) in recent logs"))
        return lines, 0, 0, 1


# ── Main probe ───────────────────────────────────────────────────────────────


def probe_tenant(tenant: Tenant) -> int:
    """Run all checks on a tenant. Returns exit code (0/1/2)."""
    print(f"\n{BOLD}{'=' * 60}")
    print(f"  PROBE: {tenant.name}  ({tenant.ip})")
    print(f"{'=' * 60}{RESET}")

    # Single SSH call with the full probe script
    exit_code, raw_output = ssh_exec(tenant, f"bash -s <<'PROBE_EOF'\n{REMOTE_SCRIPT}\nPROBE_EOF", timeout=60)

    if exit_code == -1:
        print(fail(f"SSH connection failed: {raw_output}"))
        return 2

    sections = split_sections(raw_output)

    if "DONE" not in sections:
        print(fail(f"Probe script did not complete. Got sections: {list(sections.keys())}"))
        if raw_output:
            # Print first few lines of raw output for debugging
            for line in raw_output.splitlines()[:10]:
                print(f"  {DIM}{line}{RESET}")
        return 2

    total_p = total_w = total_f = 0

    checks = [
        ("CONTAINERS", check_containers),
        ("IMAGE_DIGESTS", check_image_digests),
        ("SCHEDULES", check_schedules),
        ("WORKFLOWS", check_workflows),
        ("VAULT_CONTEXT", check_vault_context),
        ("STREAMS", check_streams),
        ("OPENCLAW_HEALTH", check_openclaw_health),
        ("MCP_CONFIG", check_mcp_config),
        ("WORKERS_MEMORY", check_workers_memory),
        ("ONBOARDING", check_onboarding),
        ("CHORES", check_chores),
        ("DISK_MEM", check_disk_mem),
        ("ENV_KEYS", check_env_keys),
        ("SKILLS", check_skills),
        ("LEARN_ERRORS", check_learn_errors),
    ]

    for section_key, check_fn in checks:
        data = sections.get(section_key, "")
        result_lines, cp, cw, cf = check_fn(data)
        total_p += cp
        total_w += cw
        total_f += cf
        for line in result_lines:
            print(line)

    # Summary
    print(f"\n{BOLD}{'─' * 60}")
    summary_parts = []
    summary_parts.append(f"{GREEN}{total_p} pass{RESET}")
    if total_w > 0:
        summary_parts.append(f"{YELLOW}{total_w} warn{RESET}")
    else:
        summary_parts.append(f"{total_w} warn")
    if total_f > 0:
        summary_parts.append(f"{RED}{total_f} fail{RESET}")
    else:
        summary_parts.append(f"{total_f} fail")

    verdict = "HEALTHY" if total_f == 0 and total_w == 0 else ("DEGRADED" if total_f == 0 else "UNHEALTHY")
    verdict_color = GREEN if verdict == "HEALTHY" else (YELLOW if verdict == "DEGRADED" else RED)

    print(f"  {BOLD}{tenant.name}{RESET}: {' / '.join(summary_parts)}  →  {verdict_color}{BOLD}{verdict}{RESET}")
    print(f"{'─' * 60}{RESET}")

    if total_f > 0:
        return 2
    elif total_w > 0:
        return 1
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <tenant|all>")
        print(f"  Available tenants: {', '.join(TENANTS.keys())}")
        return 1

    target = sys.argv[1].lower()

    if target == "all":
        tenants = list(TENANTS.values())
    else:
        try:
            tenants = [get_tenant(target)]
        except ValueError as e:
            print(f"{RED}Error: {e}{RESET}")
            return 1

    worst_exit = 0
    results: dict[str, int] = {}

    for tenant in tenants:
        code = probe_tenant(tenant)
        results[tenant.name] = code
        worst_exit = max(worst_exit, code)

    # Multi-tenant summary
    if len(tenants) > 1:
        print(f"\n{BOLD}{'=' * 60}")
        print(f"  FLEET SUMMARY")
        print(f"{'=' * 60}{RESET}")
        for name, code in results.items():
            if code == 0:
                print(ok(f"  {name}"))
            elif code == 1:
                print(warn(f"  {name}"))
            else:
                print(fail(f"  {name}"))

    return worst_exit


if __name__ == "__main__":
    sys.exit(main())
