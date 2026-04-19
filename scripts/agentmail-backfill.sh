#!/usr/bin/env bash
# Backfill AgentMail inboxes for existing tenants that were provisioned
# before the AgentMail integration existed.
#
# For each tenant listed in the config:
#   1. Create an inbox in the shared pod with a stable client_id
#      (AgentMail dedupes on client_id, so re-runs are idempotent).
#   2. Mint an inbox-scoped API key.
#   3. SSH to the tenant VM and append AGENTMAIL_* + OWNER_EMAIL to
#      /opt/alfred/compose/.env.
#   4. Write /mnt/encrypted/alfred/.agentmail-credentials.json on the
#      tenant (fallback file that mirrors what the provisioner writes
#      for new tenants).
#   5. Seed /mnt/encrypted/vault/.auth/authorized_senders.json with the
#      owner's email (via ctrl-api POST /api/v1/auth/senders).
#
# This script DOES NOT update the SaaS PostgreSQL Instance rows — do
# that separately with psql once you have inbox_id + address from the
# script's output.
#
# Prerequisites:
#   - AGENTMAIL_MASTER_API_KEY in env
#   - AGENTMAIL_SHARED_POD_ID in env
#   - SSH keys for each tenant available at the paths listed below
#   - jq + curl + ssh installed locally
#
# Usage:
#   AGENTMAIL_MASTER_API_KEY=... \
#   AGENTMAIL_SHARED_POD_ID=... \
#     ./scripts/agentmail-backfill.sh path/to/tenants.json
#
# tenants.json shape:
#   [
#     {
#       "slug": "david",
#       "email": "david@szabostuban.com",
#       "ssh_key": "/Users/administrator/.ssh/alfred-david-99",
#       "host": "100.119.63.29",
#       "ssh_user": "deploy"
#     },
#     ...
#   ]

set -euo pipefail

AGENTMAIL_API="https://api.agentmail.to/v0"
AGENTMAIL_DOMAIN="${AGENTMAIL_DOMAIN:-mail.alfred.black}"

TENANTS_FILE="${1:-}"
[ -n "$TENANTS_FILE" ] || { echo "usage: $0 tenants.json" >&2; exit 2; }
[ -f "$TENANTS_FILE" ] || { echo "file not found: $TENANTS_FILE" >&2; exit 2; }

: "${AGENTMAIL_MASTER_API_KEY:?set AGENTMAIL_MASTER_API_KEY}"
: "${AGENTMAIL_SHARED_POD_ID:?set AGENTMAIL_SHARED_POD_ID (from bootstrap)}"

command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }
command -v ssh >/dev/null || { echo "ssh required" >&2; exit 1; }

log() { printf '%s\n' "$*" >&2; }

am() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" \
      -H "Authorization: Bearer $AGENTMAIL_MASTER_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$body" "${AGENTMAIL_API}${path}"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer $AGENTMAIL_MASTER_API_KEY" "${AGENTMAIL_API}${path}"
  fi
}

# Build username like provisionAgentMailForTenant does in saas: take the
# email local-part, lowercase, replace non-alnum+dot with dots, collapse.
build_username() {
  local email="$1"
  local local_part
  local_part="${email%%@*}"
  local_part=$(echo "$local_part" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9.]/./g; s/\.\.*/./g; s/^\.//; s/\.$//')
  [ -n "$local_part" ] || local_part="user"
  echo "alfred.${local_part}"
}

tenant_count=$(jq 'length' "$TENANTS_FILE")
log "─── AgentMail backfill: $tenant_count tenants ───"
echo ""

# Summary table (printed at end)
declare -a SUMMARY

for i in $(seq 0 $((tenant_count - 1))); do
  slug=$(jq -r ".[$i].slug" "$TENANTS_FILE")
  email=$(jq -r ".[$i].email" "$TENANTS_FILE")
  ssh_key=$(jq -r ".[$i].ssh_key" "$TENANTS_FILE")
  host=$(jq -r ".[$i].host" "$TENANTS_FILE")
  ssh_user=$(jq -r ".[$i].ssh_user // \"deploy\"" "$TENANTS_FILE")

  log ""
  log "═══ $slug ($email) ═══"

  username=$(build_username "$email")
  client_id="tenant-backfill-${slug}"

  # 1. Create inbox (idempotent on client_id)
  log "  [1/5] creating inbox alfred.${slug##*.}... ($username@$AGENTMAIL_DOMAIN)"
  inbox_body=$(jq -n \
    --arg u "$username" \
    --arg d "$AGENTMAIL_DOMAIN" \
    --arg c "$client_id" \
    --arg dn "Alfred for $slug" \
    '{username:$u, domain:$d, client_id:$c, display_name:$dn}')
  inbox_resp=$(am POST "/pods/${AGENTMAIL_SHARED_POD_ID}/inboxes" "$inbox_body")
  inbox_id=$(echo "$inbox_resp" | jq -r '.inbox_id // empty')
  inbox_email=$(echo "$inbox_resp" | jq -r '.email // empty')

  if [ -z "$inbox_id" ] && echo "$inbox_resp" | grep -qi "already\|duplicate\|taken"; then
    # username collision — retry with suffix
    suffix=$((100 + RANDOM % 900))
    first_seg=$(echo "$email" | sed 's/@.*//; s/[^a-zA-Z0-9]//g' | cut -c1-20 | tr '[:upper:]' '[:lower:]')
    username="alfred.${first_seg}${suffix}"
    log "    username collided, retry as $username"
    inbox_body=$(jq -n \
      --arg u "$username" \
      --arg d "$AGENTMAIL_DOMAIN" \
      --arg c "$client_id" \
      --arg dn "Alfred for $slug" \
      '{username:$u, domain:$d, client_id:$c, display_name:$dn}')
    inbox_resp=$(am POST "/pods/${AGENTMAIL_SHARED_POD_ID}/inboxes" "$inbox_body")
    inbox_id=$(echo "$inbox_resp" | jq -r '.inbox_id // empty')
    inbox_email=$(echo "$inbox_resp" | jq -r '.email // empty')
  fi

  if [ -z "$inbox_id" ]; then
    log "    ✗ inbox create failed: $inbox_resp"
    SUMMARY+=("$slug  FAILED  inbox create error")
    continue
  fi
  log "    ✓ inbox_id=$inbox_id email=$inbox_email"

  # 2. Mint inbox-scoped API key
  log "  [2/5] minting inbox-scoped API key..."
  key_body=$(jq -n --arg n "${slug}-backfill-$(date -u +%s)" '{name:$n}')
  key_resp=$(am POST "/inboxes/${inbox_id}/api-keys" "$key_body")
  api_key=$(echo "$key_resp" | jq -r '.api_key // empty')
  if [ -z "$api_key" ]; then
    log "    ✗ api-key create failed: $key_resp"
    SUMMARY+=("$slug  PARTIAL  inbox=$inbox_email  no key")
    continue
  fi
  log "    ✓ key minted (first 20 chars: ${api_key:0:20}...)"

  # 3. Append to tenant .env
  log "  [3/5] appending env vars on $host..."
  ssh_common=(-o IdentityAgent=none -o StrictHostKeyChecking=accept-new -i "$ssh_key" "${ssh_user}@${host}")
  env_append=$(cat <<EOF
AGENTMAIL_INBOX_ID=$inbox_id
AGENTMAIL_INBOX_ADDRESS=$inbox_email
AGENTMAIL_API_KEY=$api_key
OWNER_EMAIL=$email
EOF
)
  if ssh "${ssh_common[@]}" \
    "grep -q '^AGENTMAIL_INBOX_ID=' /opt/alfred/compose/.env 2>/dev/null && echo present" \
    | grep -q present; then
    log "    env already has AGENTMAIL_INBOX_ID — rewriting (idempotent)"
    ssh "${ssh_common[@]}" \
      "sudo sed -i '/^AGENTMAIL_/d; /^OWNER_EMAIL=/d' /opt/alfred/compose/.env"
  fi
  # shellcheck disable=SC2087  # intentional var expansion
  ssh "${ssh_common[@]}" \
    "printf '%s\n' '$env_append' | sudo tee -a /opt/alfred/compose/.env >/dev/null"
  log "    ✓ env appended"

  # 4. Write fallback file
  log "  [4/5] writing /mnt/encrypted/alfred/.agentmail-credentials.json..."
  fallback=$(jq -n \
    --arg id "$inbox_id" \
    --arg addr "$inbox_email" \
    --arg key "$api_key" \
    '{inbox_id:$id, inbox_address:$addr, api_key:$key}')
  ssh "${ssh_common[@]}" \
    "sudo mkdir -p /mnt/encrypted/alfred && sudo tee /mnt/encrypted/alfred/.agentmail-credentials.json >/dev/null && sudo chmod 600 /mnt/encrypted/alfred/.agentmail-credentials.json" \
    <<<"$fallback"
  log "    ✓ fallback file written"

  # 5. Seed authorized_senders.json
  log "  [5/5] seeding /mnt/encrypted/vault/.auth/authorized_senders.json..."
  email_lower=$(echo "$email" | tr '[:upper:]' '[:lower:]')
  auth_json=$(jq -n \
    --arg e "$email_lower" \
    --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{senders:[$e], updated_at:$t}')
  ssh "${ssh_common[@]}" \
    "sudo mkdir -p /mnt/encrypted/vault/.auth && ! [ -f /mnt/encrypted/vault/.auth/authorized_senders.json ] && sudo tee /mnt/encrypted/vault/.auth/authorized_senders.json >/dev/null || echo '    (authorized_senders.json already exists, leaving alone)' >&2" \
    <<<"$auth_json" || true
  log "    ✓ authorized_senders seeded (or preserved if present)"

  SUMMARY+=("$slug  OK  $inbox_email")
done

echo ""
log "─── summary ───"
for s in "${SUMMARY[@]}"; do
  log "$s"
done
log ""
log "Next: SaaS Instance rows are NOT updated by this script."
log "Update them manually with psql or a follow-up Wasp admin action:"
log ""
log "  UPDATE \"Instance\""
log "  SET \"agentmailInboxId\" = '...', \"agentmailInboxAddress\" = '...',"
log "      \"agentmailInboxApiKey\" = encrypt(...)"
log "  WHERE \"customerName\" = 'alfred-<slug>-...';"
log ""
log "Then restart each tenant to pick up the new env:"
log "  ssh deploy@<host> 'cd /opt/alfred/compose && sudo docker compose up -d --force-recreate'"
