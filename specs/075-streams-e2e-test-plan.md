# 075 — Streams: End-to-End Integration Test Plan

## Stream Types Supported

| Source | Label | Type | Icon | UI Status |
|--------|-------|------|------|-----------|
| `openclaw` | OpenClaw Sessions | `scheduled` | Activity | Implemented (system stream) |
| `gmail` | Gmail | `scheduled` | Mail | **UI-only placeholder** |
| `omi` | Omi Ambient | `realtime` | Smartphone | **UI-only placeholder** |
| `polar` | Polar Payments | `webhook` | ShoppingBag | Partially implemented (separate payment webhook exists) |
| `github` | GitHub | `webhook` | GitBranch | **Webhook receiver ready, no source-specific handler** |
| `custom` | Custom | `webhook` | Zap | **Webhook receiver ready, generic handler** |

---

## Architecture: Data Flow Per Stream Type

### Webhook streams (Polar, GitHub, Custom)

```
External service
  --> POST /webhooks/:webhookToken (SaaS Express app)
  --> webhookReceiver.ts validates token + optional HMAC signature
  --> Builds StreamEvent payload
  --> proxyToTenant() --> POST /api/v1/streams/ingest (ctrl API on tenant)
  --> ctrl appends event to JSONL file on encrypted volume
  --> Falls back to Prisma StreamEvent table if tenant unreachable
  --> EventProcessorWorkflow (Temporal, every 2 min) picks up unprocessed events
  --> classify --> validate --> write vault record --> mark processed
```

### Scheduled streams (Gmail, OpenClaw)

```
OpenClaw Sessions (implemented):
  openclaw hooks (alfred-inbox, alfred-learn-observer in openclaw-config.json.njk)
  --> ctrl POST /api/v1/streams/system/openclaw-sessions/report
  --> Updates stream meta counters
  --> Inbox scan: POST /api/v1/streams/inbox/scan reads /vault/inbox/ files
  --> Creates events in system-inbox stream

Gmail (NOT implemented):
  No poller, no OAuth integration, no Gmail API client exists.
  Would need: OAuth token storage, Gmail API polling activity, scheduled Temporal workflow or cron.
```

### Realtime streams (Omi)

```
Omi (NOT implemented):
  No WebSocket/SSE handler, no Omi SDK integration.
  Would need: Omi API client, realtime connection manager, event bridge to /api/v1/streams/ingest.
  Alternative: Omi could push via webhook if it supports outbound webhooks.
```

---

## Implementation Status

### Fully Implemented

1. **Webhook receiver** (`packages/saas/app/src/server/webhookReceiver.ts`)
   - Token-based routing via `Stream.webhookToken`
   - HMAC-SHA256 signature verification (optional, from `config.webhookSecret`)
   - Proxy-to-tenant with Prisma fallback
   - Source-ref extraction for dedup
   - Summary extraction from payload

2. **Ctrl streams API** (`packages/ctrl/src/api/routes/streams.ts`)
   - Full CRUD: create, list, pause, resume, delete streams
   - `POST /api/v1/streams/ingest` — generic event ingest with dedup
   - `GET /api/v1/streams/events?status=unprocessed` — event listing with status filter
   - `POST /api/v1/streams/events/:id/processed` and `/quarantine` — lifecycle marking
   - `POST /api/v1/streams/inbox/scan` — inbox file scanner
   - `POST /api/v1/streams/system/openclaw-sessions/report` — OpenClaw stats

3. **SaaS operations** (`packages/saas/app/src/streams/operations.ts`)
   - `getStreams`, `createStream`, `deleteStream`, `pauseStream`, `resumeStream`, `regenerateWebhookToken`
   - All proxy CRUD to tenant ctrl API

4. **Temporal EventProcessorWorkflow** (`packages/learn/src/workflows/event_processor.py`)
   - Fetches unprocessed events via `VaultClient.fetch_unprocessed_events()`
   - Classifies via Clerk (OpenClaw LLM gateway)
   - Validates frontmatter
   - Detects braindumps for deep extraction
   - Writes vault records
   - Marks processed/quarantined
   - Entity extraction
   - Judgment routing

5. **Prisma schema** (`packages/saas/app/schema.prisma`)
   - `Stream` model with webhookToken, config JSON, status tracking
   - `StreamEvent` model with raw JSON, processing lifecycle fields
   - Unique constraint on `[userId, source]`

6. **UI** (`packages/saas/app/src/streams/StreamsPage.tsx`)
   - Integration picker (all 6 sources)
   - Stream cards with pause/resume/delete
   - Event log viewer
   - Source health overview grid

### Placeholder / Not Implemented

1. **Gmail integration** — No OAuth flow, no Gmail API client, no polling scheduler. The UI lets you "connect" Gmail but nothing will poll.

2. **Omi integration** — No realtime client, no Omi SDK. The UI shows it as a "realtime" type but no handler exists.

3. **Polar as a stream** — The existing Polar webhook (`packages/saas/app/src/payment/polar/webhook.ts`) handles `order.paid` and `subscription.updated` for billing. It does NOT forward events to the streams pipeline. A user can create a Polar stream and point Polar's webhook at `webhookToken`, but this is separate from the payment webhook.

4. **GitHub webhook processing** — The generic webhook receiver would accept GitHub payloads, but no GitHub-specific event parsing (PR events, push events, issue events) is implemented.

---

## Test Plan

### Prerequisites

- Running tenant instance with ctrl API at `:3100`
- Temporal worker running (`alfred-learn` task queue)
- OpenClaw gateway running at `:18789`
- SaaS app running with Prisma database

### Test 1: Custom Webhook — Full E2E

**Goal:** Verify the complete webhook path from external POST to vault record.

Steps:
1. Create a custom webhook stream via SaaS API:
   ```
   POST /api/operations/createStream
   { name: "Test Custom", type: "webhook", source: "custom" }
   ```
2. Note the returned `webhookToken`.
3. Send a test payload:
   ```
   POST /webhooks/<webhookToken>
   Content-Type: application/json
   { "type": "test", "title": "E2E test event", "data": {"key": "value"} }
   ```
4. Verify SaaS side:
   - `Stream.lastEventAt` updated
   - If tenant reachable: event proxied to ctrl
   - If tenant unreachable: `StreamEvent` row created in Prisma
5. Verify ctrl side:
   - `GET /api/v1/streams/<id>/events` returns the event
   - Event appears in `GET /api/v1/streams/events?status=unprocessed`
6. Wait for EventProcessorWorkflow (2 min cycle) or trigger manually.
7. Verify:
   - Event classified and vault record written
   - Event marked as processed: `GET /api/v1/streams/events?status=processed`

**Expected result:** Event flows from webhook to vault record within one processor cycle.

### Test 2: Custom Webhook — HMAC Signature Verification

**Goal:** Verify webhook secret validation.

Steps:
1. Create stream with config: `{ webhookSecret: "test-secret-123" }`
2. Send payload WITHOUT signature header -> expect 401
3. Send payload WITH correct `X-Webhook-Signature: sha256=<hmac>` -> expect 200
4. Send payload WITH incorrect signature -> expect 401

### Test 3: Custom Webhook — Dedup

**Goal:** Verify duplicate events are rejected.

Steps:
1. Send event with `{ "id": "dedup-test-001", "type": "test" }`
2. Send same event again with same `id`
3. Verify ctrl returns `{ status: "duplicate" }` on second send
4. Verify only one event in stream events list

### Test 4: Inbox Upload Stream

**Goal:** Verify the inbox file scanner creates stream events.

Steps:
1. Drop a markdown file into `/vault/inbox/test-file.md` on the tenant
2. Call `POST /api/v1/streams/inbox/scan`
3. Verify response shows `ingested: 1`
4. Verify `GET /api/v1/streams/system-inbox/events` contains the event
5. Verify event summary extracted from frontmatter (if present)
6. Call scan again -> verify `skipped: 1, reason: already_ingested`

### Test 5: OpenClaw Sessions Stream

**Goal:** Verify OpenClaw session reporting updates stream metadata.

Steps:
1. Confirm `system-openclaw-sessions` stream exists in `GET /api/v1/streams`
2. Call `POST /api/v1/streams/system/openclaw-sessions/report` with:
   ```json
   { "messages_harvested": 5, "status": "active" }
   ```
3. Verify stream meta updated: `event_count` incremented, `last_event_at` set, `status` = "active"

### Test 6: Stream Lifecycle (Pause / Resume / Delete)

**Goal:** Verify stream management operations.

Steps:
1. Create a stream
2. Pause it: `POST /api/v1/streams/<id>/pause` -> verify `enabled: false, status: paused`
3. Send webhook while paused -> verify `{ status: "stream_paused" }` from webhook receiver
4. Resume: `POST /api/v1/streams/<id>/resume` -> verify `enabled: true, status: idle`
5. Send webhook after resume -> verify event ingested
6. Delete: `DELETE /api/v1/streams/<id>` -> verify stream and events removed
7. Verify system streams cannot be paused/resumed/deleted

### Test 7: Webhook Token Regeneration

**Goal:** Verify old tokens stop working after regeneration.

Steps:
1. Create webhook stream, note token
2. Send event with old token -> 200
3. Regenerate token via `regenerateWebhookToken`
4. Send event with OLD token -> 404
5. Send event with NEW token -> 200

### Test 8: EventProcessorWorkflow — Classification + Vault Write

**Goal:** Verify the Temporal workflow correctly processes events.

Steps:
1. Ingest a realistic event directly via ctrl API:
   ```json
   {
     "stream_id": "<test-stream>",
     "stream_type": "custom",
     "raw": { "subject": "Meeting notes from project sync", "body": "Discussed roadmap..." },
     "summary": "Meeting notes"
   }
   ```
2. Trigger EventProcessorWorkflow (or wait for 2-min schedule)
3. Verify:
   - Event classified (type determined by Clerk LLM)
   - Frontmatter validated
   - Vault record created at expected path
   - Event marked processed with vault_path and classification
   - Entities extracted if present

### Test 9: EventProcessorWorkflow — Quarantine Path

**Goal:** Verify invalid classifications are quarantined.

Steps:
1. Ingest an event with minimal/garbage data that will fail validation
2. Wait for processor
3. Verify event is quarantined with reason

### Test 10: Tenant Unreachable Fallback

**Goal:** Verify webhook events are stored in Prisma when tenant is down.

Steps:
1. Stop the tenant ctrl API
2. Send webhook event via SaaS
3. Verify `StreamEvent` row created in Prisma database
4. Restart tenant
5. Verify event can be manually replayed to tenant (currently no auto-replay exists)

---

## Missing Endpoints and Handlers

| Gap | Component | What's Needed |
|-----|-----------|---------------|
| Gmail OAuth flow | saas + ctrl | OAuth consent screen, token storage in `Stream.config`, refresh token rotation |
| Gmail poller | learn or ctrl | Scheduled activity that calls Gmail API, creates stream events for new emails |
| Omi realtime client | learn or ctrl | WebSocket/SSE connection to Omi API, event bridge to streams ingest |
| Omi auth | saas | Device pairing flow, API key storage |
| Polar stream bridge | saas | Forward payment webhook events into the streams pipeline (alongside billing handling) |
| GitHub event parsing | saas or ctrl | Parse GitHub webhook payloads into meaningful summaries (PR title, commit messages, issue body) |
| Event replay | saas -> ctrl | Replay Prisma-stored events to tenant when it comes back online |
| Stream health monitoring | ctrl | Detect stale streams (no events for N hours), set `status: error` |
| Webhook delivery retries | saas | Queue failed proxy-to-tenant deliveries for retry instead of one-shot fallback |

---

## Test Environment Setup

```bash
# Start tenant stack
docker compose -f packages/openclaw/docker-compose.yaml up -d

# Verify services
curl http://localhost:3100/api/v1/streams          # ctrl API
curl http://localhost:18789/health                  # OpenClaw gateway

# Start SaaS (development)
cd packages/saas/app && wasp start

# Run learn worker
cd packages/learn && python -m src.worker
```

## Automation Notes

- Tests 1-7 can be scripted with `curl` or `httpx`
- Tests 8-9 require Temporal + OpenClaw to be running (integration environment)
- Test 10 requires ability to stop/start tenant services
- Consider adding a `scripts/test-streams-e2e.sh` that runs Tests 1-7 against a live instance
