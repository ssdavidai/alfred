# AgentMail Bootstrap — One-Time SaaS Setup

One-time infrastructure setup for the AgentMail integration. Must be completed before any per-tenant provisioning code can run.

**Run once per environment** (production today; staging later if we add it). The helper script is idempotent, so re-running is safe and useful for verification.

## What this sets up

1. **Domain** `mail.alfred.black` registered at AgentMail (subdomain of `alfred.black` — apex is preserved for Cloudflare Email Routing).
2. **Shared pod** `alfred-shared` — all tenant inboxes live here (we're on the Developer plan's 2-pod limit; shared-pod with inbox-scoped keys is the isolation model).
3. **Single webhook** at `https://alfred.black/webhooks/agentmail` — all inbound tenant emails land here; the receiver disambiguates by `inbox_id`.
4. **DNS records** written to the `alfred.black` Cloudflare zone (MX, DKIM, SPF, DMARC under the `mail` subdomain).

## Prerequisites

- AgentMail master API key (`am_us_481f41...` — currently in macOS Keychain as `1p-saas-agentmail-master` and/or SaaS `.env`)
- Cloudflare legacy global API key + email with edit access to the `alfred.black` zone (already in `packages/ctrl/.env` as `CLOUDFLARE_API_KEY`, `CLOUDFLARE_EMAIL`, `CLOUDFLARE_ZONE_ID`)
- `curl` and `jq` installed locally
- The SaaS host URL (`https://alfred.black`) is live and routing to the Wasp app

## Run the script

```bash
cd alfred-platform
export AGENTMAIL_MASTER_API_KEY="am_us_481f41..."
export CLOUDFLARE_API_KEY="$(grep ^CLOUDFLARE_API_KEY= packages/ctrl/.env | cut -d= -f2-)"
export CLOUDFLARE_EMAIL="$(grep ^CLOUDFLARE_EMAIL=  packages/ctrl/.env | cut -d= -f2-)"
export CLOUDFLARE_ZONE_ID="$(grep ^CLOUDFLARE_ZONE_ID= packages/ctrl/.env | cut -d= -f2-)"

./deploy/agentmail-bootstrap.sh
```

The script will:

1. Check / create the `mail.alfred.black` domain at AgentMail.
2. Fetch the required DNS records and upsert each one in the Cloudflare zone.
3. Trigger verification and poll until `status=VERIFIED` (or bail with guidance if records haven't propagated yet — typically <15 min, can take up to 48h).
4. Check / create the `alfred-shared` pod (client_id `alfred-shared`).
5. Check / create the webhook (client_id `alfred-fleet-ingest`) pointing at `https://alfred.black/webhooks/agentmail`.
6. Print the env vars you need to paste into the SaaS `.env` and mirror to macOS Keychain.

## Expected output (success)

```
✓ domain mail.alfred.black already exists (VERIFIED)
✓ 4 DNS records already present in Cloudflare
✓ pod alfred-shared already exists (pod_id=...)
✓ webhook alfred-fleet-ingest already exists (webhook_id=ep_...)

─── ENV VARS TO SAVE ───
AGENTMAIL_MASTER_API_KEY=am_us_481f41...
AGENTMAIL_DOMAIN=mail.alfred.black
AGENTMAIL_SHARED_POD_ID=<pod_id>
AGENTMAIL_WEBHOOK_ID=<webhook_id>
AGENTMAIL_WEBHOOK_SECRET=whsec_...
```

## After the script

### 1. Save env to SaaS host

```bash
ssh deploy@alfred.black
sudo nano /opt/alfred-saas/.env
# append the 5 AGENTMAIL_* vars printed above
sudo systemctl restart alfred-saas
```

### 2. Mirror to macOS Keychain

```bash
# On your laptop (for disaster recovery)
security add-generic-password -a "$USER" -s "1p-saas-agentmail-master" -w "am_us_481f41..."
security add-generic-password -a "$USER" -s "1p-saas-agentmail-webhook-secret" -w "whsec_..."
```

### 3. Save to GitHub secrets (for CI deploys)

```bash
gh secret set AGENTMAIL_MASTER_API_KEY --repo ssdavidai/alfred-platform
gh secret set AGENTMAIL_WEBHOOK_SECRET --repo ssdavidai/alfred-platform
gh secret set AGENTMAIL_SHARED_POD_ID  --repo ssdavidai/alfred-platform
gh secret set AGENTMAIL_WEBHOOK_ID     --repo ssdavidai/alfred-platform
gh secret set AGENTMAIL_DOMAIN         --repo ssdavidai/alfred-platform --body "mail.alfred.black"
```

### 4. Sanity test

```bash
# Domain verified?
curl -s -H "Authorization: Bearer $AGENTMAIL_MASTER_API_KEY" \
  "https://api.agentmail.to/v0/domains" | jq '.domains[] | select(.domain=="mail.alfred.black")'

# Pod exists?
curl -s -H "Authorization: Bearer $AGENTMAIL_MASTER_API_KEY" \
  "https://api.agentmail.to/v0/pods" | jq '.pods[] | select(.client_id=="alfred-shared")'

# Webhook hitting us?
curl -s -H "Authorization: Bearer $AGENTMAIL_MASTER_API_KEY" \
  "https://api.agentmail.to/v0/webhooks" | jq '.webhooks[] | select(.client_id=="alfred-fleet-ingest")'
```

## What does NOT happen here

- **No tenant inboxes** are created (that's per-tenant provisioning — separate work).
- **No webhook traffic** arrives until the SaaS webhook handler at `/webhooks/agentmail` is implemented (later PR). AgentMail will retry; that's fine.
- **No existing tenant is affected.** Existing flows (Composio, Slack, Omi, etc.) are untouched.

## Troubleshooting

### Domain stuck on `PENDING`
DNS hasn't propagated. Wait 5 minutes, re-run the script — it will retry verification. If after 1 hour still pending, check Cloudflare dashboard to confirm records landed and are not proxied (orange cloud should be off for MX and TXT).

### `INVALID` status on a specific record
The script prints which record is invalid and what AgentMail expected. Most common cause: Cloudflare auto-flattening or proxying a record it shouldn't. Verify in Cloudflare UI and disable proxy for that record.

### 403 from Cloudflare API
Legacy global key lacks zone access. Check `CLOUDFLARE_EMAIL` matches the account that owns `alfred.black`, or mint a scoped token with `Zone:DNS:Edit` on the zone.

### Idempotency
All creates use `client_id` for dedup (`alfred-shared` for the pod, `alfred-fleet-ingest` for the webhook). DNS records are upserted by name+type. Safe to re-run as many times as needed.

## Capacity reminders

Developer plan ($20/mo):
- **10 inboxes total** — 2 already used (`alfred@agent.szabostuban.com`, `joeforeman@agentmail.to` — personal/experimental, left in place). **Fleet ceiling: 8 new tenant inboxes.**
- **2 pods** — Default Pod + `alfred-shared` = exactly at cap.
- **2 webhook endpoints** — `alfred-fleet-ingest` + 1 spare (existing disabled `alfred-email-relay` can be retired if needed).
- **10k emails/mo** — well above current usage.

At ~7 tenants, start the Enterprise conversation with AgentMail.
