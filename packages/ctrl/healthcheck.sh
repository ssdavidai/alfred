#!/usr/bin/env bash
# /opt/alfred/healthcheck.sh — baked into the ctrl-api image (packages/ctrl/Dockerfile).
# Runs inside the ctrl-api container; prints one JSON line to stdout.
# Called by GET /api/v1/admin/health and GET /api/v1/admin/dashboard (admin.ts).
#
# In the old SaaS model this was provisioned by cloud-init on each tenant VM.
# In alfred-black (single-VM, docker compose) it is baked into the image at
# build time so the endpoint can report a real status on a healthy stack
# instead of the permanent "degraded" that an absent script produces (#526).
#
# Checks
#   disk — warns at 85 % used, degrades at 95 % used (/ mount inside container)
#
# Dependencies: bash, df (coreutils, present in node:22-slim), awk.
# No apt packages beyond what the Dockerfile already installs.

set -euo pipefail

# --- disk check ---
# awk extracts the "Use%" column from `df /` (column 5 of the data row),
# strips the trailing percent sign, and prints just the integer.
disk_used=$(df / | awk 'NR==2{gsub(/%/,"",$5); print $5}')

if [ -z "$disk_used" ]; then
  disk_status="unknown"
elif [ "$disk_used" -ge 95 ]; then
  disk_status="critical"
elif [ "$disk_used" -ge 85 ]; then
  disk_status="warn"
else
  disk_status="ok"
fi

# --- overall status ---
# "degraded" only when something is actionably wrong; "ok" for warn so the
# endpoint stops crying wolf on a healthy stack with normal disk pressure.
if [ "$disk_status" = "critical" ]; then
  overall="degraded"
else
  overall="ok"
fi

printf '{"status":"%s","checks":{"disk":{"used_pct":%s,"status":"%s"}}}\n' \
  "$overall" "${disk_used:-0}" "$disk_status"
