#!/usr/bin/env bash
# AgentMail one-time bootstrap — idempotent.
# See deploy/agentmail-bootstrap.md for context and post-run steps.

set -euo pipefail

# ────────────────────────────── Config ──────────────────────────────
AGENTMAIL_DOMAIN="${AGENTMAIL_DOMAIN:-mail.alfred.black}"
AGENTMAIL_POD_CLIENT_ID="${AGENTMAIL_POD_CLIENT_ID:-alfred-shared}"
AGENTMAIL_POD_NAME="${AGENTMAIL_POD_NAME:-Alfred Shared}"
AGENTMAIL_WEBHOOK_CLIENT_ID="${AGENTMAIL_WEBHOOK_CLIENT_ID:-alfred-fleet-ingest}"
AGENTMAIL_WEBHOOK_URL="${AGENTMAIL_WEBHOOK_URL:-https://alfred.black/webhooks/agentmail}"
AGENTMAIL_API="https://api.agentmail.to/v0"

CF_API="https://api.cloudflare.com/client/v4"
VERIFY_POLL_SECONDS="${VERIFY_POLL_SECONDS:-10}"
VERIFY_POLL_MAX="${VERIFY_POLL_MAX:-30}"  # 30 × 10s = 5min

# ────────────────────────────── Helpers ─────────────────────────────
log()   { printf '%s\n' "$*" >&2; }
ok()    { printf '✓ %s\n' "$*" >&2; }
warn()  { printf '⚠ %s\n' "$*" >&2; }
fail()  { printf '✗ %s\n' "$*" >&2; exit 1; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "required command missing: $1"; }
require_env() { [ -n "${!1:-}" ] || fail "required env var missing: $1"; }

am() {
  # AgentMail API call: `am GET /pods` or `am POST /pods '{"client_id":"x"}'`
  local method="$1" path="$2" body="${3:-}"
  local url="${AGENTMAIL_API}${path}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" \
      -H "Authorization: Bearer $AGENTMAIL_MASTER_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$body" "$url"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer $AGENTMAIL_MASTER_API_KEY" "$url"
  fi
}

cf() {
  # Cloudflare API call using legacy global key
  local method="$1" path="$2" body="${3:-}"
  local url="${CF_API}${path}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" \
      -H "X-Auth-Key: $CLOUDFLARE_API_KEY" \
      -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
      -H "Content-Type: application/json" \
      -d "$body" "$url"
  else
    curl -sS -X "$method" \
      -H "X-Auth-Key: $CLOUDFLARE_API_KEY" \
      -H "X-Auth-Email: $CLOUDFLARE_EMAIL" "$url"
  fi
}

# ────────────────────────────── Pre-flight ──────────────────────────
require_cmd curl
require_cmd jq
require_env AGENTMAIL_MASTER_API_KEY
require_env CLOUDFLARE_API_KEY
require_env CLOUDFLARE_EMAIL
require_env CLOUDFLARE_ZONE_ID

log "─── AgentMail bootstrap ───"
log "domain:       $AGENTMAIL_DOMAIN"
log "pod:          $AGENTMAIL_POD_CLIENT_ID"
log "webhook url:  $AGENTMAIL_WEBHOOK_URL"
log "cf zone:      $CLOUDFLARE_ZONE_ID"
log ""

# ────────────────────────────── 1. Domain ───────────────────────────
log "[1/4] Domain"

existing_domain=$(am GET "/domains" | jq -r --arg d "$AGENTMAIL_DOMAIN" \
  '.domains[] | select(.domain == $d)')

if [ -n "$existing_domain" ] && [ "$existing_domain" != "null" ]; then
  status=$(echo "$existing_domain" | jq -r '.status')
  ok "domain $AGENTMAIL_DOMAIN exists (status=$status)"
  domain_payload="$existing_domain"
else
  log "  creating domain $AGENTMAIL_DOMAIN..."
  domain_payload=$(am POST "/domains" \
    "{\"domain\":\"$AGENTMAIL_DOMAIN\",\"feedback_enabled\":true}")
  created=$(echo "$domain_payload" | jq -r '.domain // "null"')
  [ "$created" = "$AGENTMAIL_DOMAIN" ] \
    || fail "domain create failed: $domain_payload"
  ok "domain $AGENTMAIL_DOMAIN created"
fi

records_count=$(echo "$domain_payload" | jq '.records | length')
log "  $records_count DNS records required"

# ────────────────────────────── 2. DNS ──────────────────────────────
log "[2/4] Cloudflare DNS"

# Get existing DNS records in the zone for the subdomain
existing_cf=$(cf GET "/zones/$CLOUDFLARE_ZONE_ID/dns_records?per_page=500")
cf_ok=$(echo "$existing_cf" | jq -r '.success')
[ "$cf_ok" = "true" ] || fail "cloudflare list failed: $existing_cf"

# Process each required AgentMail record
echo "$domain_payload" | jq -c '.records[]' | while IFS= read -r rec; do
  rtype=$(echo "$rec" | jq -r '.type')
  rname=$(echo "$rec" | jq -r '.name')
  rvalue=$(echo "$rec" | jq -r '.value')
  rprio=$(echo "$rec" | jq -r '.priority // empty')

  # Check if record already exists with the exact same value
  match=$(echo "$existing_cf" | jq -c --arg n "$rname" --arg t "$rtype" --arg v "$rvalue" \
    '.result[] | select(.name == $n and .type == $t and (.content == $v))')

  if [ -n "$match" ]; then
    ok "  $rtype $rname (already present)"
    continue
  fi

  # Check if record exists with different value (needs update, not create)
  stale=$(echo "$existing_cf" | jq -c --arg n "$rname" --arg t "$rtype" \
    '.result[] | select(.name == $n and .type == $t)' | head -1)

  if [ -n "$stale" ]; then
    stale_id=$(echo "$stale" | jq -r '.id')
    warn "  $rtype $rname exists with different value — updating"
    body=$(jq -n --arg t "$rtype" --arg n "$rname" --arg v "$rvalue" \
      --argjson p "${rprio:-null}" \
      '{type:$t, name:$n, content:$v, ttl:1} + (if $p then {priority:$p} else {} end)')
    resp=$(cf PUT "/zones/$CLOUDFLARE_ZONE_ID/dns_records/$stale_id" "$body")
    [ "$(echo "$resp" | jq -r '.success')" = "true" ] \
      || fail "cloudflare update failed: $resp"
    ok "  $rtype $rname (updated)"
  else
    body=$(jq -n --arg t "$rtype" --arg n "$rname" --arg v "$rvalue" \
      --argjson p "${rprio:-null}" \
      '{type:$t, name:$n, content:$v, ttl:1} + (if $p then {priority:$p} else {} end)')
    resp=$(cf POST "/zones/$CLOUDFLARE_ZONE_ID/dns_records" "$body")
    [ "$(echo "$resp" | jq -r '.success')" = "true" ] \
      || fail "cloudflare create failed for $rtype $rname: $resp"
    ok "  $rtype $rname (created)"
  fi
done

# Verification loop
log "  polling verification..."
domain_id=$(echo "$domain_payload" | jq -r '.domain_id')
poll=0
while [ "$poll" -lt "$VERIFY_POLL_MAX" ]; do
  status_payload=$(am GET "/domains/$domain_id")
  status=$(echo "$status_payload" | jq -r '.status')
  case "$status" in
    VERIFIED)
      ok "domain verified"
      break
      ;;
    VERIFYING|PENDING|NOT_STARTED)
      printf '    status=%s, retry in %ds\n' "$status" "$VERIFY_POLL_SECONDS" >&2
      # Trigger verification if not started
      if [ "$status" = "NOT_STARTED" ] || [ "$status" = "FAILED" ]; then
        am POST "/domains/$domain_id/verify" >/dev/null || true
      fi
      sleep "$VERIFY_POLL_SECONDS"
      ;;
    INVALID|FAILED)
      warn "status=$status — DNS records may not have propagated. Details:"
      echo "$status_payload" | jq '.records[] | select(.status != "VALID")' >&2
      warn "re-run this script in 5-10 minutes; it will retry verification"
      break
      ;;
    *)
      warn "unexpected status: $status"
      sleep "$VERIFY_POLL_SECONDS"
      ;;
  esac
  poll=$((poll + 1))
done

# ────────────────────────────── 3. Pod ──────────────────────────────
log "[3/4] Shared pod"

existing_pod=$(am GET "/pods" | jq -r --arg c "$AGENTMAIL_POD_CLIENT_ID" \
  '.pods[] | select(.client_id == $c)')

if [ -n "$existing_pod" ] && [ "$existing_pod" != "null" ]; then
  pod_id=$(echo "$existing_pod" | jq -r '.pod_id')
  ok "pod $AGENTMAIL_POD_CLIENT_ID already exists (pod_id=$pod_id)"
else
  log "  creating pod $AGENTMAIL_POD_CLIENT_ID..."
  pod_resp=$(am POST "/pods" \
    "{\"client_id\":\"$AGENTMAIL_POD_CLIENT_ID\",\"name\":\"$AGENTMAIL_POD_NAME\"}")
  pod_id=$(echo "$pod_resp" | jq -r '.pod_id')
  [ -n "$pod_id" ] && [ "$pod_id" != "null" ] \
    || fail "pod create failed: $pod_resp"
  ok "pod created (pod_id=$pod_id)"
fi

# ────────────────────────────── 4. Webhook ──────────────────────────
log "[4/4] Shared webhook"

existing_webhook=$(am GET "/webhooks" | jq -r --arg c "$AGENTMAIL_WEBHOOK_CLIENT_ID" \
  '.webhooks[] | select(.client_id == $c)')

if [ -n "$existing_webhook" ] && [ "$existing_webhook" != "null" ]; then
  webhook_id=$(echo "$existing_webhook" | jq -r '.webhook_id')
  # Fetch full details for secret (list endpoint may omit it)
  detail=$(am GET "/webhooks/$webhook_id")
  webhook_secret=$(echo "$detail" | jq -r '.secret // empty')
  ok "webhook $AGENTMAIL_WEBHOOK_CLIENT_ID already exists (webhook_id=$webhook_id)"
else
  log "  creating webhook $AGENTMAIL_WEBHOOK_CLIENT_ID..."
  webhook_body=$(jq -n \
    --arg url "$AGENTMAIL_WEBHOOK_URL" \
    --arg cid "$AGENTMAIL_WEBHOOK_CLIENT_ID" \
    --arg pod "$pod_id" \
    '{url:$url, event_types:["message.received"], pod_ids:[$pod], client_id:$cid}')
  webhook_resp=$(am POST "/webhooks" "$webhook_body")
  webhook_id=$(echo "$webhook_resp" | jq -r '.webhook_id // empty')
  webhook_secret=$(echo "$webhook_resp" | jq -r '.secret // empty')
  [ -n "$webhook_id" ] || fail "webhook create failed: $webhook_resp"
  ok "webhook created (webhook_id=$webhook_id)"
fi

# ────────────────────────────── Output ──────────────────────────────
cat <<EOF >&2

─── ENV VARS TO SAVE ───
AGENTMAIL_MASTER_API_KEY=<set from Keychain; value not re-printed>
AGENTMAIL_DOMAIN=$AGENTMAIL_DOMAIN
AGENTMAIL_SHARED_POD_ID=$pod_id
AGENTMAIL_WEBHOOK_ID=$webhook_id
AGENTMAIL_WEBHOOK_SECRET=${webhook_secret:-<fetch via: am GET /webhooks/$webhook_id | jq .secret>}

Save to SaaS .env, mirror to macOS Keychain, push to GitHub secrets.
See deploy/agentmail-bootstrap.md for the post-run checklist.
EOF
