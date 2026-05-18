#!/usr/bin/env bash
#
# verify-plane-webhook.sh — end-to-end verification for POST /api/v1/plane/webhook
#
# Assumes ctrl-api is already running on 127.0.0.1:3100 with
# PLANE_WEBHOOK_SECRET set in its environment. You pass that same secret
# here via PLANE_WEBHOOK_SECRET (env) or --secret=<value>.
#
# Test matrix:
#   1. Valid signed delivery → 200 + forwarded=true
#   2. Same delivery again (dedupe) → 200 + forwarded=false + deduped=true
#   3. Bad signature → 401
#   4. Missing X-Plane-Signature → 401
#   5. Missing X-Plane-Delivery → 200 (content-hash fallback)
#
# Usage:
#   PLANE_WEBHOOK_SECRET=abc123 ./scripts/verify-plane-webhook.sh
#   ./scripts/verify-plane-webhook.sh --secret=abc123 --url=http://127.0.0.1:3100

set -euo pipefail

URL="http://127.0.0.1:3100"
SECRET="${PLANE_WEBHOOK_SECRET:-}"

for arg in "$@"; do
  case "$arg" in
    --secret=*) SECRET="${arg#*=}" ;;
    --url=*) URL="${arg#*=}" ;;
    -h|--help)
      sed -n '1,25p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$SECRET" ]]; then
  echo "ERROR: set PLANE_WEBHOOK_SECRET (env var or --secret=...)" >&2
  exit 2
fi

ENDPOINT="$URL/api/v1/plane/webhook"

# Deterministic payload so the signature is reproducible across the test run.
DELIVERY="test-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%04x' $((RANDOM % 65536)))"
PAYLOAD=$(printf '{"event":"issue","action":"created","data":{"id":"test-issue-%s","name":"smoke-test"},"activity":{}}' "$DELIVERY")

# Compute HMAC-SHA256(SECRET, PAYLOAD) as hex.
SIG_HEX=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
SIGNATURE="sha256=$SIG_HEX"

echo "[*] endpoint: $ENDPOINT"
echo "[*] delivery: $DELIVERY"
echo

pass=0
fail=0

assert_status() {
  local name="$1"
  local got="$2"
  local want="$3"
  local body="$4"
  if [[ "$got" == "$want" ]]; then
    echo "  PASS  [$name] got HTTP $got"
    pass=$((pass + 1))
  else
    echo "  FAIL  [$name] got HTTP $got, want $want"
    echo "        body: $body"
    fail=$((fail + 1))
  fi
}

# ---------------------------------------------------------------
# 1. Valid signed delivery
# ---------------------------------------------------------------
echo "[test 1] valid signed delivery"
resp=$(curl -s -o /tmp/plane_resp1.json -w "%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-Plane-Signature: $SIGNATURE" \
  -H "X-Plane-Delivery: $DELIVERY" \
  --data-binary "$PAYLOAD")
body=$(cat /tmp/plane_resp1.json)
assert_status "valid" "$resp" "200" "$body"
if [[ "$resp" == "200" ]]; then
  if grep -q '"forwarded":true' /tmp/plane_resp1.json; then
    echo "        forwarded=true  OK"
  else
    echo "        WARN: expected forwarded=true — body: $body"
  fi
fi
echo

# ---------------------------------------------------------------
# 2. Duplicate delivery → deduped
# ---------------------------------------------------------------
echo "[test 2] duplicate delivery (dedupe)"
resp=$(curl -s -o /tmp/plane_resp2.json -w "%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-Plane-Signature: $SIGNATURE" \
  -H "X-Plane-Delivery: $DELIVERY" \
  --data-binary "$PAYLOAD")
body=$(cat /tmp/plane_resp2.json)
assert_status "duplicate" "$resp" "200" "$body"
if [[ "$resp" == "200" ]]; then
  if grep -q '"deduped":true' /tmp/plane_resp2.json; then
    echo "        deduped=true  OK"
  else
    echo "        WARN: expected deduped=true — body: $body"
  fi
fi
echo

# ---------------------------------------------------------------
# 3. Bad signature
# ---------------------------------------------------------------
echo "[test 3] bad signature"
BAD_SIG="sha256=0000000000000000000000000000000000000000000000000000000000000000"
resp=$(curl -s -o /tmp/plane_resp3.json -w "%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-Plane-Signature: $BAD_SIG" \
  -H "X-Plane-Delivery: bad-sig-$DELIVERY" \
  --data-binary "$PAYLOAD")
body=$(cat /tmp/plane_resp3.json)
assert_status "bad_signature" "$resp" "401" "$body"
echo

# ---------------------------------------------------------------
# 4. Missing signature header
# ---------------------------------------------------------------
echo "[test 4] missing X-Plane-Signature"
resp=$(curl -s -o /tmp/plane_resp4.json -w "%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-Plane-Delivery: no-sig-$DELIVERY" \
  --data-binary "$PAYLOAD")
body=$(cat /tmp/plane_resp4.json)
assert_status "missing_signature" "$resp" "401" "$body"
echo

# ---------------------------------------------------------------
# 5. Missing delivery header → falls back to content hash
# ---------------------------------------------------------------
echo "[test 5] missing X-Plane-Delivery (content-hash fallback)"
# Use a fresh payload so the content hash is unique
FRESH_PAYLOAD=$(printf '{"event":"issue","action":"updated","data":{"id":"fresh-%s","name":"fallback"},"activity":{}}' "$DELIVERY")
FRESH_SIG_HEX=$(printf '%s' "$FRESH_PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
resp=$(curl -s -o /tmp/plane_resp5.json -w "%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-Plane-Signature: sha256=$FRESH_SIG_HEX" \
  --data-binary "$FRESH_PAYLOAD")
body=$(cat /tmp/plane_resp5.json)
assert_status "no_delivery_header" "$resp" "200" "$body"
if [[ "$resp" == "200" ]]; then
  if grep -q '"delivery":"sha256:' /tmp/plane_resp5.json; then
    echo "        fallback delivery=sha256:... OK"
  else
    echo "        WARN: expected fallback delivery=sha256:... — body: $body"
  fi
fi
echo

# ---------------------------------------------------------------
# Report
# ---------------------------------------------------------------
echo "========================================"
echo "  passed: $pass"
echo "  failed: $fail"
echo "========================================"
rm -f /tmp/plane_resp1.json /tmp/plane_resp2.json /tmp/plane_resp3.json /tmp/plane_resp4.json /tmp/plane_resp5.json
exit $([[ "$fail" -eq 0 ]] && echo 0 || echo 1)
