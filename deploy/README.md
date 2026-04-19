# SaaS host deploy

Files in this directory configure the alfred.black SaaS host (single Hetzner VM).

## AgentPhone (Twilio) setup

The SaaS host runs the master Twilio account. Tenants never hold Twilio
credentials — every Twilio API call originates here, dispatched on behalf of
tenants via the `/api/internal/twilio/*` endpoints.

### One-time account setup

1. Sign up for a Twilio account (https://twilio.com).
2. From the Twilio console, capture the **Account SID** and **Auth Token**.
3. Add to `/opt/alfred-saas/.env.server`:
   ```
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=<auth-token>
   VOICE_BRIDGE_INTERNAL_TOKEN=$(openssl rand -hex 32)
   OPENAI_API_KEY=sk-...
   TWILIO_DEFAULT_COUNTRY=HU
   ```
4. Restart the SaaS app: `docker compose restart app`.

### Provisioning a number for a tenant

The provisioner step `provision_phone` (Phase 7) calls
`POST /api/internal/twilio/provision` with `{tenantId, country?}` automatically
during fresh tenant setup.

Manual provisioning for an existing tenant:
```bash
curl -X POST https://alfred.black/api/internal/twilio/provision \
  -H "Authorization: Bearer $VOICE_BRIDGE_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tenantId": "<uuid>", "country": "HU"}'
```

The endpoint:
- Searches Twilio for an available SMS+Voice-capable local number in the country.
- Buys it.
- Sets both `voiceUrl` → `/webhooks/twilio/voice` and `smsUrl` → `/webhooks/twilio/sms`.
- Persists `Instance.phoneNumber`, `Instance.twilioNumberSid`, `Instance.phoneCountry`.

### Releasing a number

```bash
curl -X POST https://alfred.black/api/internal/twilio/release \
  -H "Authorization: Bearer $VOICE_BRIDGE_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tenantId": "<uuid>", "twilioNumberSid": "PN..."}'
```

The provisioner destroy path calls this automatically.

### Webhook security

Every inbound Twilio webhook (`/webhooks/twilio/voice`, `/webhooks/twilio/sms`)
validates `X-Twilio-Signature` using `twilio.validateRequest`. Unsigned or
mis-signed requests return 403.

Internal endpoints (`/api/internal/twilio/*`) are gated on
`Authorization: Bearer $VOICE_BRIDGE_INTERNAL_TOKEN`. **Never expose this
token to user auth or to the open internet without that header.**

### Country coverage

Twilio has global coverage. v1 default is `HU` (matches our current EU fleet).
Override per-tenant via the `country` arg, or globally via
`TWILIO_DEFAULT_COUNTRY` env.

### Voice Bridge

The voice runtime (Twilio Media Streams ↔ OpenAI Realtime) lives in
`packages/voice-bridge/` and runs as a separate container on this host
(Phase 2 of the AgentPhone build). Caddy proxies `wss://alfred.black/voice/*`
to that container's port `9000`.
