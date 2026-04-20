# AgentPhone Rollout Runbook

Phase 10 of the AgentPhone build. Everything upstream (Phases 1-9) is in the
`agentphone` branch; this document is the checklist for actually putting
Alfred on the phone.

## Pre-flight (one-time, before any PR merges)

1. **Twilio account set up** — see [deploy/README.md](./README.md) for account
   setup. Capture:
   - `TWILIO_ACCOUNT_SID` (starts with `AC…`)
   - `TWILIO_AUTH_TOKEN`
   Add both to `/opt/alfred-saas/.env.server` on the SaaS host.

2. **OpenAI account with Realtime API access** — capture `OPENAI_API_KEY`.
   Add to the same `.env.server`.

3. **Generate shared internal secret**:
   ```bash
   openssl rand -hex 32
   ```
   Add as `VOICE_BRIDGE_INTERNAL_TOKEN`. Also add to **each tenant's**
   `/opt/alfred/compose/.env` (Phase 7 provisioner does this automatically for
   fresh tenants; existing tenants need manual addition — see "Existing
   tenants" below).

## Merge order

Per the project's deploy-batching policy, merge one phase at a time. Watch CI
after each; verify on David before the next.

Suggested sequence (each a separate PR off `agentphone`):

| PR | Scope | Risk |
|---|---|---|
| 1 | Phase 1 (#221): SaaS Twilio webhooks + master client + Prisma migration | Low (new routes only, schema migration additive) |
| 2 | Phase 2 + 3 + 4 + 5 + 6 (voice + SMS + outbound): everything tenant-side; Voice Bridge | Medium (new service, depends on PR 1) |
| 3 | Phase 7 (#223 part 1): provisioner `provision_phone` step | Low (non-blocking step; new tenants only) |
| 4 | Phase 8 (#223 part 2): dashboard PhonePage | Low (new route, no regressions) |
| 5 | Phase 9 (#220): spam filter + metrics | Low (additive) |

Alternatively, merge the whole branch as one if you prefer a single deploy.

## David (reference tenant) smoke test

After PR 1 + 2 deploy:

1. **Manually provision a test number in Twilio console** pointing at:
   - Voice URL: `https://alfred.black/webhooks/twilio/voice` (POST)
   - SMS URL:   `https://alfred.black/webhooks/twilio/sms` (POST)

2. **Attach the number to David's Instance by hand**:
   ```bash
   ssh -o IdentityAgent=none -i ~/.ssh/alfred-david-99 deploy@100.119.63.29
   # On the SaaS host Postgres:
   # UPDATE "Instance" SET phoneNumber = '+36...', twilioNumberSid = 'PN...', phoneCountry = 'HU' WHERE customerName = 'david';
   ```

3. **Push AgentPhone env vars to David's `.env`**:
   ```bash
   ssh -o IdentityAgent=none -i ~/.ssh/alfred-david-99 deploy@100.119.63.29 '
     cat >> /opt/alfred/compose/.env << EOF

   # AgentPhone
   TENANT_ID=<david-instance-uuid>
   AGENTPHONE_PHONE_NUMBER=+36...
   SAAS_INTERNAL_URL=https://alfred.black
   VOICE_BRIDGE_INTERNAL_TOKEN=<from-saas-env>
   EOF
     cd /opt/alfred/compose && docker compose restart ctrl-api
   '
   ```

4. **Bootstrap authorised-numbers list** (David's own mobile):
   ```bash
   ssh -o IdentityAgent=none -i ~/.ssh/alfred-david-99 deploy@100.119.63.29 '
     echo "[\"+36...\"]" > /mnt/encrypted/alfred/.authorized-phone-numbers.json
   '
   ```

5. **Run the verification matrix** (from the plan):
   - Call David's number → "Yes, sir?" within 1.5s → "what's on my calendar?"
     → hear "One moment, sir" then real answer within 3s → hang up.
   - Within 1 min: `ssh … 'ls /mnt/encrypted/vault/event/voice-call-*.md'` exists.
   - Within 5 min: ask Alfred in Slack "what did we just talk about" — expects
     to know.
   - SMS David's number from David's phone → SMS reply within 5s → continue
     thread, coherent.
   - SMS from another number → no reply, vault `event/sms-…md` within 1h.
   - From David's openclaw run `self({endpoint:"/api/v1/phone/sms", method:"POST", body:{to:"+...", body:"hello"}})` — SMS arrives at David's phone.

## Miguel + Rapali rollout

After David is stable:

1. **Provision numbers via the SaaS internal endpoint** (from the SaaS host):
   ```bash
   for NAME in miguel rapali; do
     curl -X POST https://alfred.black/api/internal/twilio/provision \
       -H "Authorization: Bearer $VOICE_BRIDGE_INTERNAL_TOKEN" \
       -H "Content-Type: application/json" \
       -d "{\"customerName\":\"$NAME\",\"country\":\"HU\"}"
   done
   ```
   (Each tenant needs Twilio to have availability in HU — it does.)

2. **Push env vars to each tenant** (same pattern as David above, swapping key
   path + IP from CLAUDE.md fleet inventory):
   - Miguel: `~/.ssh/alfred-miguel-103` → `100.72.147.32`
   - Rapali: `~/.ssh/alfred-rapali-101` → `100.121.134.35`

3. **Restart `compose-init-1` on each tenant** so init step 2 copies the new
   `alfred-voice` skill:
   ```bash
   ssh … deploy@… 'cd /opt/alfred/compose && docker compose up -d --force-recreate init'
   ```

4. **Send each user a welcome SMS**:
   ```bash
   curl -X POST https://alfred.black/api/internal/twilio/send-sms \
     -H "Authorization: Bearer $VOICE_BRIDGE_INTERNAL_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"tenantId":"<miguel-uuid>","from":"+36...","to":"<miguel-mobile>","body":"Sir — your Alfred is reachable at +36… . Save this contact and call or text any time."}'
   ```

5. **Watch for 24h**: monitor Twilio usage + OpenAI Realtime costs via the
   respective dashboards. Alert thresholds (suggested): >$5/day Twilio, >$20/day
   OpenAI, per tenant.

## DNS: `voice.alfred.black` (DNS-only, MUST NOT be proxied)

Twilio's Media Stream WS upgrades fail with error 31920 when routed through
Cloudflare's proxy (WAF drops the Upgrade). Use a dedicated DNS-only subdomain
for the Voice Bridge, keep everything else (dashboard, webhooks, APIs) proxied.

**At Cloudflare (zone `alfred.black`):**

```bash
CF_KEY=...     # CLOUDFLARE_API_KEY (legacy global key — email + key, not a scoped token)
CF_EMAIL=...   # CLOUDFLARE_EMAIL
ZONE=f13033654094bba0fdfb4c5605496e47

# A record
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records" \
  -H "X-Auth-Email: ${CF_EMAIL}" -H "X-Auth-Key: ${CF_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"type":"A","name":"voice","content":"138.199.236.244","proxied":false}'

# AAAA record (SaaS VM has both)
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records" \
  -H "X-Auth-Email: ${CF_EMAIL}" -H "X-Auth-Key: ${CF_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"type":"AAAA","name":"voice","content":"2a01:4f8:c012:5470::1","proxied":false}'
```

Verify DNS-only (grey cloud) from the dashboard or:

```bash
dig +short voice.alfred.black
# Should return the raw VM IPs (138.199.236.244 / 2a01:...), NOT Cloudflare's
# edge IPs (104.21.x.x / 172.67.x.x). If you see Cloudflare edges, proxy is ON.
```

**At the SaaS VM**: the `voice.alfred.black` Caddyfile block (in [deploy/Caddyfile](./Caddyfile))
reverse-proxies to `localhost:9000`. Caddy auto-obtains the LetsEncrypt cert
via `tls-alpn-01` on first request. No rollback needed unless renaming.

**At Twilio**: no change. The SaaS-side TwiML emitter (`packages/saas/app/src/server/twilio/webhooks.ts`)
reads `VOICE_BRIDGE_WS_HOST` env var (default `voice.alfred.black`) and emits
`wss://voice.alfred.black/voice/<tenantId>` with the HMAC sig in a
`<Parameter name="sig">` child element — Twilio strips query strings from
`<Stream>` URLs, so sig MUST NOT be in the URL query.

## Rollback

- **Disable a tenant's phone line** (emergency): manually clear
  `Instance.phoneNumber` in Postgres; next inbound gets `<Reject/>` because the
  voice webhook can't resolve the tenant.
- **Release a number**: `POST /api/internal/twilio/release {customerName}`.
- **Revert the Voice Bridge**: `docker compose stop voice-bridge` on the SaaS
  host; inbound calls fail with Cloudflare 502. SMS keeps working (its path
  doesn't route through the bridge).
- **Revert SaaS Twilio webhooks**: point Twilio console webhooks to a dummy
  endpoint; Twilio retries silently, user calls fail fast.

## Known gaps to fix post-rollout (pinned for later)

- **Dashboard nav link** to `/dashboard/phone` — not added in Phase 8 to keep
  the commit self-contained. Add to `components/TopBar.tsx` as a micro-commit.
- **Automated abandoned-call detection** feeding the spam list — Phase 9
  ships the DB table + admin endpoints but no automated signal yet. Voice
  Bridge needs to POST `/api/internal/twilio/spam/add` on short-duration
  zero-transcript dispose.
- **Daily spend caps** in `internal.ts` `consumeRate` — per-minute bucket
  exists; daily limit placeholder is read but not enforced.
- **Cross-tenant call context bleed test** — verify a call to tenant A's
  number cannot access tenant B's vault even if the signed WS query is
  spoofed (Prisma unique on `phoneNumber` should prevent it, but test it).
