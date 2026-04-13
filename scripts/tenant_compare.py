#!/usr/bin/env python3
"""Cross-tenant comparison audit.

Usage:
    python scripts/tenant_compare.py                  # compare all tenants
    python scripts/tenant_compare.py david miguel      # compare specific tenants
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from tenant_config import get_tenant, ssh_exec, TENANTS, Tenant

# ---------------------------------------------------------------------------
# Data collection — one batched SSH command per tenant
# ---------------------------------------------------------------------------

CONTAINER_NAMES = {
    "openclaw": "compose-openclaw-1",
    "alfred-learn": "compose-alfred-learn-1",
    "alfred": "compose-alfred-1",
    "openclaw-workers": "compose-openclaw-workers-1",
    "ctrl-api": "compose-ctrl-api-1",
}

# Single heredoc script executed in one SSH session per tenant.
# Outputs JSON with all collected data.
COLLECT_SCRIPT = r"""
set -e
AAS=$(grep '^AAS_API_KEY=' /opt/alfred/compose/.env 2>/dev/null | cut -d= -f2)

# 1. Docker image SHAs
images_json='{'
first=1
for svc in compose-openclaw-1 compose-alfred-learn-1 compose-alfred-1 compose-openclaw-workers-1 compose-ctrl-api-1; do
    sha=$(docker inspect "$svc" --format '{{.Image}}' 2>/dev/null || echo "NOT_FOUND")
    [ $first -eq 0 ] && images_json="$images_json,"
    images_json="$images_json\"$svc\":\"$sha\""
    first=0
done
images_json="$images_json}"

# 2. openclaw.json structure
oc_json=$(python3 -c "
import json, sys
try:
    c = json.load(open('/mnt/encrypted/openclaw/openclaw.json'))
    print(json.dumps({
        'mcp_servers': sorted(c.get('mcp',{}).get('servers',{}).keys()),
        'memory_backend': c.get('memory',{}).get('backend',''),
        'tools_allow': sorted(c.get('gateway',{}).get('tools',{}).get('allow',[])),
        'agents': sorted([a.get('name','') for a in c.get('agents',{}).get('list',[])])
    }))
except Exception as e:
    print(json.dumps({'error': str(e)}))
" 2>/dev/null || echo '{"error":"failed"}')

# 3. openclaw-workers config
ocw_json=$(python3 -c "
import json, sys
try:
    c = json.load(open('/mnt/encrypted/openclaw-workers/openclaw.json'))
    print(json.dumps({
        'mcp_servers': sorted(c.get('mcp',{}).get('servers',{}).keys()),
        'memory_backend': c.get('memory',{}).get('backend',''),
        'tools_allow': sorted(c.get('gateway',{}).get('tools',{}).get('allow',[])),
        'agents': sorted([a.get('name','') for a in c.get('agents',{}).get('list',[])])
    }))
except Exception as e:
    print(json.dumps({'error': str(e)}))
" 2>/dev/null || echo '{"error":"failed"}')

# 4. Skill files deployed
skills=$(ls /mnt/encrypted/openclaw/workspace/skills/ 2>/dev/null | sort | tr '\n' ',' | sed 's/,$//')

# 5. Temporal schedules
schedules=$(curl -sf -H "Authorization: Bearer $AAS" http://localhost:3100/api/v1/schedules 2>/dev/null \
    | python3 -c "import json,sys; print(json.dumps(sorted([s.get('scheduleId','') for s in json.load(sys.stdin)])))" 2>/dev/null \
    || echo '[]')

# 6. .env keys present
env_keys=$(grep -oP '^[A-Z_]+(?==)' /opt/alfred/compose/.env 2>/dev/null | sort | tr '\n' ',' | sed 's/,$//')

# 7. TOOLS.md hash
tools_hash=$(md5sum /mnt/encrypted/openclaw/workspace/TOOLS.md 2>/dev/null | cut -d' ' -f1 || echo "MISSING")

# Emit single JSON blob
cat <<ENDJSON
{
  "images": $images_json,
  "openclaw_config": $oc_json,
  "openclaw_workers_config": $ocw_json,
  "skills": "$skills",
  "schedules": $schedules,
  "env_keys": "$env_keys",
  "tools_hash": "$tools_hash"
}
ENDJSON
"""


def collect_tenant(tenant: Tenant) -> dict:
    """Run the batched collection script on a single tenant."""
    code, output = ssh_exec(tenant, COLLECT_SCRIPT, timeout=30)
    if code != 0:
        return {"_error": f"SSH failed (exit {code}): {output[:300]}"}
    # The JSON blob is at the end of the output. Find it.
    try:
        # Find the last { ... } block
        start = output.rfind("\n{")
        if start == -1:
            start = 0 if output.startswith("{") else -1
        else:
            start += 1  # skip the newline
        if start == -1:
            return {"_error": f"No JSON found in output: {output[:300]}"}
        return json.loads(output[start:])
    except json.JSONDecodeError as e:
        return {"_error": f"JSON parse error: {e}\nRaw: {output[:500]}"}


# ---------------------------------------------------------------------------
# Comparison logic
# ---------------------------------------------------------------------------

FRIENDLY_CONTAINER = {v: k for k, v in CONTAINER_NAMES.items()}


def compare_simple_field(label: str, data: dict[str, dict], extract) -> tuple[bool, list[str]]:
    """Compare a field across tenants. Returns (is_match, output_lines)."""
    lines = []
    values = {}
    for name, d in data.items():
        if "_error" in d:
            values[name] = f"ERROR: {d['_error'][:80]}"
        else:
            values[name] = extract(d)

    unique = set()
    for v in values.values():
        unique.add(str(v))

    lines.append(f"{label}:")
    for name, v in values.items():
        lines.append(f"  {name:10s} {v}")
    match = len(unique) == 1
    lines.append(f"  {'OK MATCH' if match else 'MISMATCH'}")
    return match, lines


def compare_lists(label: str, data: dict[str, dict], extract) -> tuple[bool, list[str]]:
    """Compare list fields across tenants, showing set differences."""
    lines = []
    per_tenant: dict[str, list[str]] = {}
    for name, d in data.items():
        if "_error" in d:
            per_tenant[name] = [f"ERROR: {d['_error'][:60]}"]
        else:
            per_tenant[name] = extract(d)

    all_items = set()
    for items in per_tenant.values():
        all_items.update(items)

    # Check which items are common to all
    common = set(all_items)
    for items in per_tenant.values():
        common &= set(items)

    match = common == all_items  # no differences

    lines.append(f"{label}:")
    if match:
        display = ", ".join(sorted(common))
        if len(display) > 120:
            display = display[:117] + "..."
        lines.append(f"  ALL:       {display}")
    else:
        for name, items in per_tenant.items():
            display = ", ".join(sorted(items))
            if len(display) > 100:
                display = display[:97] + "..."
            lines.append(f"  {name:10s} {display}")
        # Show what's missing per tenant
        for name, items in per_tenant.items():
            missing = sorted(all_items - set(items))
            if missing:
                lines.append(f"  Missing on {name}: {', '.join(missing)}")

    lines.append(f"  {'OK MATCH' if match else 'MISMATCH'}")
    return match, lines


def run_comparison(tenant_names: list[str]) -> int:
    """Main comparison routine. Returns 0 if all match, 1 otherwise."""
    tenants = []
    for name in tenant_names:
        try:
            tenants.append(get_tenant(name))
        except ValueError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 2

    if len(tenants) < 2:
        print("Need at least 2 tenants to compare.", file=sys.stderr)
        return 2

    # Collect in parallel
    print(f"Collecting data from {len(tenants)} tenants...", file=sys.stderr)
    data: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=len(tenants)) as pool:
        futures = {pool.submit(collect_tenant, t): t.name for t in tenants}
        for future in as_completed(futures):
            name = futures[future]
            data[name] = future.result()

    # Check for total failures
    for name, d in data.items():
        if "_error" in d:
            print(f"  WARNING: {name} collection failed: {d['_error'][:120]}", file=sys.stderr)

    # --- Output ---
    print()
    print("\u2550\u2550\u2550 Tenant Comparison \u2550\u2550\u2550")
    print()

    matches = 0
    mismatches = 0

    # 1. Docker Images
    print("Docker Images:")
    svc_names = ["compose-openclaw-1", "compose-alfred-learn-1", "compose-alfred-1",
                 "compose-openclaw-workers-1", "compose-ctrl-api-1"]
    for svc in svc_names:
        friendly = FRIENDLY_CONTAINER.get(svc, svc)
        values = {}
        for name, d in data.items():
            if "_error" in d:
                values[name] = "ERROR"
            else:
                sha = d.get("images", {}).get(svc, "MISSING")
                # Abbreviate sha256 for display
                if sha.startswith("sha256:"):
                    sha = "sha256:" + sha[7:19]
                values[name] = sha

        unique = set(values.values())
        is_match = len(unique) == 1
        parts = "  ".join(f"{n}={v}" for n, v in values.items())
        status = "OK MATCH" if is_match else "MISMATCH"
        print(f"  {friendly:20s} {parts}  {status}")
        if is_match:
            matches += 1
        else:
            mismatches += 1
    print()

    # 2. MCP Servers
    ok, lines = compare_lists("MCP Servers", data,
                              lambda d: d.get("openclaw_config", {}).get("mcp_servers", []))
    matches += ok
    mismatches += (not ok)
    print("\n".join(lines))
    print()

    # 3. Memory Backend
    ok, lines = compare_simple_field("Memory Backend", data,
                                     lambda d: d.get("openclaw_config", {}).get("memory_backend", "MISSING"))
    matches += ok
    mismatches += (not ok)
    print("\n".join(lines))
    print()

    # 4. Gateway Tools Allow
    ok, lines = compare_lists("Gateway Tools Allow", data,
                              lambda d: d.get("openclaw_config", {}).get("tools_allow", []))
    matches += ok
    mismatches += (not ok)
    print("\n".join(lines))
    print()

    # 5. Agent Names
    ok, lines = compare_lists("Agent Names", data,
                              lambda d: d.get("openclaw_config", {}).get("agents", []))
    matches += ok
    mismatches += (not ok)
    print("\n".join(lines))
    print()

    # 6. Workers Config — MCP Servers
    ok, lines = compare_lists("Workers MCP Servers", data,
                              lambda d: d.get("openclaw_workers_config", {}).get("mcp_servers", []))
    matches += ok
    mismatches += (not ok)
    print("\n".join(lines))
    print()

    # 7. Workers Tools Allow
    ok, lines = compare_lists("Workers Tools Allow", data,
                              lambda d: d.get("openclaw_workers_config", {}).get("tools_allow", []))
    matches += ok
    mismatches += (not ok)
    print("\n".join(lines))
    print()

    # 8. Workers Agent Names
    ok, lines = compare_lists("Workers Agent Names", data,
                              lambda d: d.get("openclaw_workers_config", {}).get("agents", []))
    matches += ok
    mismatches += (not ok)
    print("\n".join(lines))
    print()

    # 9. Skills
    ok, lines = compare_lists("Skills Deployed", data,
                              lambda d: [s.strip() for s in d.get("skills", "").split(",") if s.strip()])
    matches += ok
    mismatches += (not ok)
    print("\n".join(lines))
    print()

    # 10. Schedules
    ok, lines = compare_lists("Schedules", data,
                              lambda d: d.get("schedules", []))
    matches += ok
    mismatches += (not ok)
    print("\n".join(lines))
    print()

    # 11. .env Keys
    ok, lines = compare_lists(".env Keys", data,
                              lambda d: [k.strip() for k in d.get("env_keys", "").split(",") if k.strip()])
    matches += ok
    mismatches += (not ok)
    print("\n".join(lines))
    print()

    # 12. TOOLS.md Hash
    ok, lines = compare_simple_field("TOOLS.md Hash", data,
                                     lambda d: d.get("tools_hash", "MISSING"))
    matches += ok
    mismatches += (not ok)
    print("\n".join(lines))
    print()

    # Summary
    print(f"Summary: {matches} match, {mismatches} mismatch")
    return 0 if mismatches == 0 else 1


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) > 1:
        names = sys.argv[1:]
    else:
        names = list(TENANTS.keys())

    sys.exit(run_comparison(names))


if __name__ == "__main__":
    main()
