#!/usr/bin/env bash
# smoke-storage.sh — Per-phase smoke checks for the Storage Architecture
# migration (epic #898). Run from a workstation with SSH access to the
# tenant SSH aliases (david, miguel, rapali, raj313).
#
# Usage:
#   bash scripts/smoke-storage.sh <phase-number> <tenant>
#   bash scripts/smoke-storage.sh 0 david
#
# Phase 0 verifies the "stop the bleeding" work: P0-1 (walkMd scope),
# P0-2 (audit-rescue), P0-3 (briefing re-raise), P0-4 (janitor drop).
#
# Exit code: 0 = all PASS, 1 = one or more FAIL.
#
# The script SSHes to deploy@<tenant> using the local ~/.ssh/config
# aliases (david, miguel, rapali, raj313). It then `docker exec`s into
# compose-ctrl-api-1 to read AAS_API_KEY and to count vault files; and
# greps the local checkout for Phase 0 code markers (re-raise + janitor
# patch) because the deploy artifact on the tenant is bundled and the
# source markers are guaranteed to be on disk in /opt/alfred/dev only
# if the dev-mount overlay is in use (see MEMORY: alfred-learn-dev-mount).
set -euo pipefail

PHASE="${1:?phase required: bash scripts/smoke-storage.sh <phase> <tenant>}"
TENANT="${2:?tenant required: bash scripts/smoke-storage.sh <phase> <tenant>}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PASS=0
FAIL=0
FAILED_CHECKS=()

pass() {
  echo "PASS [$1]"
  PASS=$((PASS + 1))
}

fail() {
  echo "FAIL [$1]: $2"
  FAIL=$((FAIL + 1))
  FAILED_CHECKS+=("$1")
}

# ---------------------------------------------------------------------------
# SSH helpers
# ---------------------------------------------------------------------------

# Run a command on the tenant host. Uses the SSH config alias so the
# script never has to know IPs or key paths.
ssh_tenant() {
  ssh -o IdentityAgent=none -o BatchMode=yes -o ConnectTimeout=10 \
      "$TENANT" "$@"
}

# Run a command inside compose-ctrl-api-1 on the tenant.
ctrl_exec() {
  ssh_tenant "docker exec compose-ctrl-api-1 sh -c '$*'"
}

# ---------------------------------------------------------------------------
# Phase 0 checks
# ---------------------------------------------------------------------------

phase0() {
  echo "[smoke phase 0 · $TENANT]"

  # --- check 1: vault list latency for /api/v1/vault/list/matter < 500ms
  # We use ctrl-api's loopback inside the container and read AAS_API_KEY
  # from the container's environment (compose-injected from .env).
  # First request is discarded as a page-cache warm-up; we then take the
  # median of 3 requests. Pre-P0-1 this was 6-7s steady-state (every call
  # walked all 87k vault files); post-P0-1 it should be <500ms steady.
  local latency_ms
  latency_ms=$(
    ssh_tenant "docker exec compose-ctrl-api-1 sh -c '
      AAS=\$(cat /proc/1/environ | tr \"\\0\" \"\\n\" | grep ^AAS_API_KEY= | cut -d= -f2)
      # warm-up
      curl -s -o /dev/null -H \"Authorization: Bearer \$AAS\" \
        http://localhost:3100/api/v1/vault/list/matter
      # 3 measured requests, median wins
      for i in 1 2 3; do
        curl -s -o /dev/null -w \"%{time_total}\\n\" \
          -H \"Authorization: Bearer \$AAS\" \
          http://localhost:3100/api/v1/vault/list/matter
      done | sort -n | sed -n 2p
    '" 2>/dev/null | awk '{ printf "%d", $1 * 1000 }'
  ) || latency_ms=99999

  if [ -z "$latency_ms" ] || [ "$latency_ms" = "0" ]; then
    fail "vault list latency" "could not measure (got empty result; check ssh + AAS_API_KEY)"
  elif [ "$latency_ms" -lt 500 ]; then
    pass "vault list latency (${latency_ms}ms < 500ms)"
  else
    fail "vault list latency" "${latency_ms}ms ≥ 500ms (pre-P0-1 was 6000-7000ms; regression?)"
  fi

  # --- check 2: briefing.py has the re-raise behavior (P0-3)
  # We grep the local repo because that's the source of truth; CI deploys
  # this same file to the tenant. The check guards against accidental
  # revert before any deploy.
  local hits
  hits=$(grep -c "list_active_matters_for_briefing failed" \
    "$REPO_ROOT/packages/learn/src/activities/briefing.py" 2>/dev/null || echo 0)
  if [ "$hits" -ge 1 ]; then
    pass "briefing.py has re-raise log (P0-3)"
  else
    fail "briefing.py re-raise" \
      "expected ≥1 hit for 'list_active_matters_for_briefing failed' in packages/learn/src/activities/briefing.py, got $hits"
  fi

  # --- check 3: nightly_maintenance.py drops the janitor step (P0-4)
  hits=$(grep -c "store-p0-4-drop-janitor-step" \
    "$REPO_ROOT/packages/learn/src/workflows/nightly_maintenance.py" 2>/dev/null || echo 0)
  if [ "$hits" -ge 1 ]; then
    pass "nightly_maintenance drops janitor step (P0-4)"
  else
    fail "nightly_maintenance janitor patch" \
      "expected ≥1 hit for 'store-p0-4-drop-janitor-step' in packages/learn/src/workflows/nightly_maintenance.py, got $hits"
  fi

  # --- check 4: vault/event/ file count is sane after P0-2 audit-rescue
  # david steady-state should be <200; rapali has ~3k legitimate
  # stream_events that haven't been migrated yet. The threshold per
  # tenant: tenants on which audit-rescue has run must show <200 in
  # event/. Tenants with legitimate stream_event/* files are checked
  # separately (we look only at event/ here, not stream_event/).
  local event_count
  event_count=$(ctrl_exec "find /mnt/encrypted/vault/event -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l" \
    | tr -d ' \r\n' || echo "?")
  if [ "$event_count" = "?" ] || [ -z "$event_count" ]; then
    fail "vault event/ file count" "could not list /mnt/encrypted/vault/event/ via ctrl exec"
  elif [ "$event_count" -lt 200 ]; then
    pass "vault event/ count is sane ($event_count < 200; pre-P0-2 david had 73k)"
  else
    fail "vault event/ count" \
      "$event_count files in /mnt/encrypted/vault/event/ — expected <200 after P0-2 audit-rescue"
  fi

  # --- check 5: alfred-learn container running + recently restarted
  # If P0-3/P0-4 deploys landed, the container should have been restarted
  # in the last ~14 days. We just verify the container is running and
  # that its started-at timestamp parses.
  local started
  started=$(ssh_tenant "docker inspect -f '{{.State.Running}}/{{.State.StartedAt}}' compose-alfred-learn-1 2>/dev/null" \
    | tr -d '\r' || echo "missing/?")
  case "$started" in
    true/*)
      pass "alfred-learn container running (started $(echo "$started" | cut -d/ -f2-))"
      ;;
    *)
      fail "alfred-learn container" "not running ($started)"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

case "$PHASE" in
  0) phase0 ;;
  1) echo "TODO when phase 1 ships" ;;
  2) echo "TODO when phase 2 ships" ;;
  3) echo "TODO when phase 3 ships" ;;
  4) echo "TODO when phase 4 ships" ;;
  5) echo "TODO when phase 5 ships" ;;
  6) echo "TODO when phase 6 ships" ;;
  *)
    echo "unknown phase: $PHASE" >&2
    exit 1
    ;;
esac

echo ""
echo "[smoke phase $PHASE · $TENANT] Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "failed checks: ${FAILED_CHECKS[*]}"
  exit 1
fi
