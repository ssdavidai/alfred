#!/usr/bin/env bash
# Deploy the current :latest images to one tenant and VERIFY it converged.
#
# Usage: deploy-tenant.sh <host> <index>
#
# The index, not the host, is what reaches logs and summaries: this repository
# is public and tenant hostnames identify clients.
#
# A deploy that reports success without checking is how a fleet ends up ten
# days into a restart loop with nobody the wiser, so this runs the same
# read-only drift check afterwards and fails if the tenant did not land clean.
set -uo pipefail
host="${1:?usage: deploy-tenant.sh <host> <index>}"
idx="${2:-?}"
# Belt and braces: mask even if the caller already did.
echo "::add-mask::${host}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "═══ tenant #${idx}"

if ! ssh -o BatchMode=yes "$host" 'echo ok' >/dev/null 2>&1; then
  echo "  UNREACHABLE"
  { echo "### :x: tenant #${idx} — unreachable"; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
fi

ssh -o BatchMode=yes "$host" '
  set -euo pipefail
  cd /opt/alfred
  # Validate before doing anything that restarts a container.
  docker compose -p alfred-black config --quiet
  docker compose -p alfred-black pull
  docker compose -p alfred-black up -d
' 2>&1 | grep -iE 'Pulled|Recreated|Started|Error|error' | sed 's/^/    /'
rc=${PIPESTATUS[0]}

if [ "$rc" -ne 0 ]; then
  echo "  DEPLOY FAILED (rc=$rc)"
  { echo "### :x: tenant #${idx} — deploy failed"; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
fi

# Settle before verifying — containers need a moment to report healthy.
sleep 30

report=$(ssh -o BatchMode=yes "$host" 'bash -s' < "${here}/tenant-drift-check.sh" 2>&1)
vrc=$?
if [ "$vrc" -eq 0 ]; then
  echo "  VERIFIED clean"
  { echo "### :white_check_mark: tenant #${idx} — deployed and verified"; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
else
  echo "  DID NOT CONVERGE: ${report}"
  {
    echo "### :warning: tenant #${idx} — deployed but did not converge"
    echo '```'; echo "$report"; echo '```'
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
fi
exit "$vrc"
