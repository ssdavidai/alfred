# CONTRACT.md — alfred-learn

> What this package provides and what it requires.
> Update this file when adding/removing workflows, env vars, or API dependencies.

---

## Provides

### 6 Temporal Workflows (task queue: `alfred-learn`)

Self-improving intelligence layer: observation → instinct → reflection cycle.

| Workflow | Schedule | Purpose |
|----------|----------|---------|
| `EventProcessorWorkflow` | every 2 min | Classify and route stream events to vault |
| `SessionTrackerWorkflow` | every 5 min | Group observations into user sessions |
| `DailyDigestWorkflow` | daily 6pm | Summarize day's activity |
| `LearningWorkflow` | every 5 min | Extract instincts from observations |
| `ReflectionWorkflow` | daily 2am | Synthesize cross-instinct patterns |
| `JudgmentWorkflow` | every 2 min | Route inputs using learned instincts |

### Activities

| Module | Purpose |
|--------|---------|
| `observe` | Create observation records from events |
| `classify` | LLM-based event classification |
| `session` | Session boundary detection |
| `vault` | Vault read/write via alfred-ctrl API |
| `clerk` | LLM calls via OpenClaw gateway |
| `reflect` | Cross-instinct pattern synthesis |
| `judge` | Input routing via instinct matching |
| `notify` | Push notifications to Alfred agent |
| `braindump` | Bulk observation ingestion |
| `media` | Media file processing |
| `streams` | Stream event fetch/update |

---

## Requires

### External Services

| Service | Address | Protocol | Env Var |
|---------|---------|----------|---------|
| Temporal | `temporal:7233` | gRPC | `TEMPORAL_HOST` |
| OpenClaw gateway | `http://openclaw:18789` | HTTP | `OPENCLAW_GATEWAY_URL` |
| alfred-ctrl API | `http://ctrl-api:3100` | HTTP | `ALFRED_CTRL_URL` |

### alfred-ctrl API Endpoints Consumed

From `src/utils/vault_client.py`:

**Vault routes:**
- `POST /api/v1/vault/records` — write observation/instinct/reflection records
- `GET /api/v1/vault/records/{path}` — read a vault record
- `PATCH /api/v1/vault/records/{path}` — append to existing record
- `GET /api/v1/vault/list/{type}` — list records by type
- `GET /api/v1/vault/search` — search vault (grep-based)

**Streams routes:**
- `GET /api/v1/streams/events` — fetch unprocessed events
- `POST /api/v1/streams/events/{id}/processed` — mark event processed
- `POST /api/v1/streams/events/{id}/quarantine` — quarantine bad event

**Learning routes:**
- `GET /api/v1/learning/queue` — fetch inputs awaiting routing

**Notification routes:**
- `POST /api/v1/notifications` — send notification to Alfred agent

### Files

| Path | Access | Purpose |
|------|--------|---------|
| `/alfred-data/.gateway-token` | read | OpenClaw gateway auth token |
| `/vault` | read | Vault markdown records |
| `/alfred-data` | read/write | Observation queue, session state, streams |

### Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `TEMPORAL_HOST` | yes | `temporal:7233` | Temporal gRPC address |
| `OPENCLAW_GATEWAY_URL` | yes | `http://openclaw:18789` | OpenClaw HTTP gateway |
| `OPENCLAW_GATEWAY_TOKEN_FILE` | yes | `/alfred-data/.gateway-token` | Path to gateway auth token |
| `VAULT_PATH` | yes | `/vault` | Vault mount path |
| `TASK_QUEUE` | yes | `alfred-learn` | Temporal task queue name |
| `ALFRED_CTRL_URL` | yes | `http://ctrl-api:3100` | alfred-ctrl API base URL |
| `ALFRED_LEARN_ENABLED` | no | `true` | Feature flag to disable learn |
| `ALFRED_DATA_DIR` | no | `/alfred-data` | Runtime data directory |
| `TENANT_TIMEZONE` | no | `UTC` | IANA timezone for daily schedules |
| `CLERK_AGENT_ID` | no | `learn_clerk` | OpenClaw agent ID for LLM calls |
| `USE_DATE_PATHS` | no | `true` | Date-based vault path organization |

### Runtime

| Dependency | Version | Notes |
|-----------|---------|-------|
| Python | 3.12 | Base image: `python:3.11-slim-bookworm` (alfred-worker) |
| temporalio SDK | — | Temporal workflow/activity SDK |
| httpx | — | Async HTTP client for ctrl API |
| pyyaml | — | YAML parsing |

### Consumed By

No downstream consumers — alfred-learn is a leaf node. It reads events and writes vault records.
