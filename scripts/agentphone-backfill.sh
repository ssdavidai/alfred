#!/usr/bin/env bash
# AgentPhone env-var backfill for pre-#455 tenants.
#
# Usage:
#   scripts/agentphone-backfill.sh <customer-slug> <tenant-ssh-key> <tenant-tailscale-ip>
#
# Example:
#   scripts/agentphone-backfill.sh david  ~/.ssh/alfred-david-99  100.119.63.29
#
# What it does:
#   1. Reads the tenant's Instance.id + Instance.phoneNumber from SaaS Prisma.
#   2. Reads the shared VOICE_BRIDGE_INTERNAL_TOKEN from SaaS .env.server.
#   3. SSHes into the tenant using the local deploy key, upserts four env vars
#      (AGENTPHONE_PHONE_NUMBER, TENANT_ID, VOICE_BRIDGE_INTERNAL_TOKEN,
#      SAAS_INTERNAL_URL) onto /opt/alfred/compose/.env, restarts ctrl-api.
#   4. Verifies ctrl-api picks up the new env + /phone/voice-context still 200s.
#
# Idempotent. Requires:
#   - ~/.ssh/id_ed25519 with access to alfred-control (SaaS VM Tailscale IP
#     100.106.110.95)
#   - the tenant's deploy key on the local filesystem
#
# See deploy/AGENTPHONE_ROLLOUT.md § "Backfilling pre-#455 tenants".

set -euo pipefail

CUSTOMER=${1:?customer slug required (e.g. david)}
KEY=${2:?tenant ssh key path required}
TENANT_IP=${3:?tenant tailscale IP required}

SAAS_IP=100.106.110.95
SAAS_KEY="${HOME}/.ssh/id_ed25519"

if [ ! -f "$KEY" ]; then
  echo "ERROR: tenant ssh key not found at $KEY" >&2
  exit 1
fi
if [ ! -f "$SAAS_KEY" ]; then
  echo "ERROR: SaaS ssh key not found at $SAAS_KEY" >&2
  exit 1
fi

SSH_SAAS="ssh -o IdentityAgent=none -o ConnectTimeout=10 -i $SAAS_KEY deploy@$SAAS_IP"
SSH_TENANT="ssh -o IdentityAgent=none -o ConnectTimeout=10 -i $KEY deploy@$TENANT_IP"

echo "==> looking up Instance row for customerName containing '$CUSTOMER'"
LOOKUP=$($SSH_SAAS "docker exec alfred-saas-postgres-1 psql -U postgres -d alfred_saas -At -F '|' -c \"SELECT id, \\\"phoneNumber\\\" FROM \\\"Instance\\\" WHERE \\\"customerName\\\" ILIKE '%${CUSTOMER}%' AND \\\"phoneNumber\\\" IS NOT NULL LIMIT 1;\"")

if [ -z "$LOOKUP" ]; then
  echo "ERROR: no Instance with phoneNumber for customerName~'$CUSTOMER'" >&2
  exit 1
fi

TENANT_ID="${LOOKUP%|*}"
PHONE="${LOOKUP#*|}"
echo "    tenant_id = $TENANT_ID"
echo "    phone     = $PHONE"

echo "==> reading VOICE_BRIDGE_INTERNAL_TOKEN from SaaS .env.server"
TOKEN=$($SSH_SAAS 'grep ^VOICE_BRIDGE_INTERNAL_TOKEN= /opt/alfred-saas/.env.server | cut -d= -f2')
if [ -z "$TOKEN" ]; then
  echo "ERROR: VOICE_BRIDGE_INTERNAL_TOKEN missing on SaaS" >&2
  exit 1
fi
echo "    token len=${#TOKEN}"

echo "==> upserting env vars on $CUSTOMER"
$SSH_TENANT bash <<EOF
set -euo pipefail
ENV_FILE=/opt/alfred/compose/.env
cp "\$ENV_FILE" "\$ENV_FILE.bak-agentphone-\$(date +%s)"

# Strip any stale versions, then append fresh ones. Using a temp file
# rather than in-place sed to avoid the truncation pitfalls of
# ambiguous pipe chains (see 2026-04-20 incident in CLAUDE.md).
grep -vE '^(AGENTPHONE_PHONE_NUMBER=|TWILIO_PHONE_NUMBER=|TENANT_ID=|VOICE_BRIDGE_INTERNAL_TOKEN=|SAAS_INTERNAL_URL=)' "\$ENV_FILE" > /tmp/env.new
cat >> /tmp/env.new <<ENV
# AgentPhone (backfilled $(date -Iseconds))
AGENTPHONE_PHONE_NUMBER=$PHONE
TENANT_ID=$TENANT_ID
VOICE_BRIDGE_INTERNAL_TOKEN=$TOKEN
SAAS_INTERNAL_URL=https://alfred.black
ENV

# Sanity: every required prior var must still be present.
for k in AAS_API_KEY COMPOSIO_API_KEY; do
  if ! grep -q "^\$k=" /tmp/env.new; then
    echo "FATAL: \$k missing from new env, aborting — keeping original" >&2
    rm /tmp/env.new
    exit 1
  fi
done

mv /tmp/env.new "\$ENV_FILE"
echo "    env updated (lines: \$(wc -l < \$ENV_FILE))"

cd /opt/alfred/compose && docker compose up -d --force-recreate ctrl-api 2>&1 | tail -3
EOF

echo "==> waiting for ctrl-api to come back healthy"
$SSH_TENANT 'AAS=$(grep ^AAS_API_KEY /opt/alfred/compose/.env | cut -d= -f2); until [ "$(curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer $AAS" http://localhost:3100/api/v1/phone/voice-context)" = "200" ]; do sleep 3; done; echo "    ctrl-api healthy ✓"'

echo "==> verifying env inside the container"
for k in AGENTPHONE_PHONE_NUMBER TENANT_ID SAAS_INTERNAL_URL; do
  $SSH_TENANT "docker exec compose-ctrl-api-1 sh -lc 'if [ -n \"\$$k\" ]; then echo \"    $k=<set>\"; else echo \"    $k=<MISSING>\"; fi'"
done

echo
echo "✓ $CUSTOMER backfilled."
