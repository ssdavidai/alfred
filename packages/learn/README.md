# Alfred Learn

Alfred Learn is the self-improving intelligence layer for [Alfred Black control plane](../ctrl). It watches what flows through Streams — conversations, webhooks, incoming data — processes raw events into structured vault records, and over time learns how each tenant organises their world so it can do it autonomously. Two layers do the work: a **Processor** that classifies and files incoming events, and an **Intuition Engine** that observes how the user routes things, builds pattern memory, and gradually takes over routine decisions. The system starts knowing nothing and earns its autonomy through observation.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     ALFRED-SAAS  (Platform)                       │
│                                                                   │
│  Streams Dashboard          Intuition Dashboard                   │
│  Webhook Receiver ──────────────────────────────────────────────  │
└──────────────┬───────────────────────────────────────────────────┘
               │ proxyToTenant()
               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    TENANT INSTANCE  (VPS)                         │
│                                                                   │
│  ┌───────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────┐  │
│  │  OPENCLAW  │  │ TEMPORAL  │  │ ALFRED-CTRL│  │ ALFRED-LEARN │  │
│  │  :18789    │  │ :7233     │  │ :3100      │  │(packages/learn)│  │
│  └─────┬─────┘  └────┬─────┘  └─────┬──────┘  └──────┬───────┘  │
│        │              │              │                 │          │
│        │  Schedules ──┘    Vault API─┘     Workflows ──┘          │
│        │                                                          │
│        └── Gateway API (clerk sessions) ──────────────────────┘   │
│                                                                   │
│  VAULT (/mnt/encrypted/vault/)                                    │
│  ├── task/            extracted from stream events                │
│  ├── session/         conversation session boundaries             │
│  ├── event/           events, daily digests                       │
│  ├── note/            notes, summaries                            │
│  ├── person/          discovered entities                         │
│  ├── observation/     routing reasoning records                   │
│  ├── intuition/       learned patterns                            │
│  │   ├── instincts/   individual pattern files                    │
│  │   └── index.md     master index                                │
│  ├── reflection/      nightly reports                             │
│  └── inbox/           raw inputs from streams                     │
└──────────────────────────────────────────────────────────────────┘
```

Alfred Learn connects to **Temporal** for scheduling, calls the LLM through **OpenClaw** gateway, and reads/writes the vault exclusively through the **alfred-ctrl** API. It never touches the filesystem directly and never calls the LLM without going through the gateway.

---

## Terminology

Alfred Black uses butler-appropriate language.

| Term | What it is |
|------|------------|
| **Observation** | A record of *why* something was routed a certain way. Alfred observed the master's preference. |
| **Instinct** | A learned routing pattern, distilled from many observations. Alfred developed an instinct for how to handle this. |
| **Intuition** | The collection of all instincts. Alfred's accumulated intuition about how the household runs. |
| **Reflection** | The nightly process where Alfred reviews observations and refines instincts. The butler reflecting on the day. |
| **Judgment** | The per-input decision process. Alfred exercising judgment on where something belongs. |
| **Discretion** | Knowing when to act versus when to ask. A good butler's most important quality. |
| **Clerk** | The stateless LLM worker called for creative tasks. A junior clerk Alfred dispatches for analysis. |

---

## Workflows

All workflows run on the `alfred-learn` Temporal task queue.

| Schedule ID | Workflow | Interval | Purpose |
|-------------|----------|----------|---------|
| `al-event-processor` | EventProcessorWorkflow | Every 2 min | Classifies stream events and writes vault records |
| `al-session-tracker` | SessionTrackerWorkflow | Every 5 min | Detects conversation session boundaries and groups records |
| `chore-briefing-morning` | BriefingWorkflow (slot=morning) | `0 5 * * *` tenant-local | Visits every active matter through `state_mutator.apply_state_change_v2`, composes the morning brief, writes `briefing/<YYYY-MM-DD>-morning.md` |
| `chore-briefing-evening` | BriefingWorkflow (slot=evening) | `0 17 * * *` tenant-local | Same workflow, evening slot, writes `briefing/<YYYY-MM-DD>-evening.md` |
| `al-learning` | LearningWorkflow | Every 5 min | Captures observations from routing decisions and hint files |
| `al-reflection` | ReflectionWorkflow | Daily 2 am | Reviews observations, creates/updates/merges/deprecates instincts |
| `al-judgment` | JudgmentWorkflow | Every 2 min | Scores inputs against instincts and routes or escalates |

`BriefingWorkflow` replaced the deleted `DailyMorningBriefingWorkflow`,
`DailyEveningDigestWorkflow`, and `DailyDigestWorkflow` (commit f20556d).
The SaaS `/brief` page reads each snapshot through the `getBriefing`
operation — there is no separate notification step.

---

## Trust Model

| Layer | Decides | Examples |
|-------|---------|----------|
| **Temporal** | *When* things run | Schedules, retries, timeouts, workflow state |
| **Python** | *Structural* things | Frontmatter validation, discretion thresholds, matching scores, dedup |
| **LLM (Clerk)** | *Creative* things | Understanding content, extracting entities, classifying inputs, writing summaries |

The LLM never decides whether to run or what to enforce. It is called by Temporal, constrained by Python, and writes to the vault through validated paths.

---

## Data Sources

### OpenClaw Chat Hook (built-in)

The `alfred-inbox` hook in alfred-ctrl buffers chat messages and writes them to `vault/inbox/`. An enhancement emits each flushed session as a `StreamEvent` to `system-openclaw-sessions.jsonl`, which the Event Processor picks up automatically.

### Webhooks (plug and play)

External services POST to alfred-saas at `/webhooks/:webhookToken`. The platform validates HMAC, wraps the payload in a StreamEvent envelope, and forwards it to the tenant. GitHub, Stripe, Polar, Zapier, n8n — any source works. The Processor classifies whatever arrives.

### Observation Hook

The `alfred-learn-observer` hook watches Alfred's outgoing messages for routing language (`"filed under"`, `"moved to"`, `"categorized as"`, vault write confirmations). When detected, it queues an observation for the Learning workflow to process.

---

## Cold Start

Alfred Learn starts knowing nothing. The bootstrap sequence:

1. **Empty intuition** — no instincts exist yet
2. **Everything escalates** — Judgment has no basis to route, so every input goes to the user
3. **User routes inputs** — each routing decision is captured as an observation
4. **Observations accumulate** — Learning workflow processes the queue every 5 minutes
5. **Reflection creates instincts** — the nightly 2 am run distils patterns from observations (minimum 3 observations required)
6. **Judgment starts routing** — instincts with enough evidence begin handling inputs autonomously
7. **Discretion tightens over time** — as observation counts grow, thresholds relax and Alfred acts with greater confidence

The system earns its autonomy. No configuration required.

---

## Discretion Thresholds

Thresholds scale with evidence. More observations mean more confidence.

| Observations | Threshold | What it means |
|--------------|-----------|---------------|
| < 5 | 0.95 | *"I've barely seen this before, sir. Your guidance?"* |
| 5–9 | 0.90 | *"I believe I know, but I'd rather confirm."* |
| 10–19 | 0.85 | *"I'm fairly certain this goes here."* |
| 20–49 | 0.80 | *"I've seen this many times. Handling it."* |
| 50+ | 0.75 | *"This is routine. Already done."* |

---

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `TEMPORAL_HOST` | `temporal:7233` | Temporal server address |
| `OPENCLAW_GATEWAY_URL` | `http://openclaw:18789` | OpenClaw gateway endpoint |
| `OPENCLAW_GATEWAY_TOKEN_FILE` | `/alfred-data/.gateway-token` | Path to gateway auth token |
| `VAULT_PATH` | `/vault` | Mount path for the encrypted vault |
| `ALFRED_DATA_DIR` | `/alfred-data` | Shared Alfred data directory |
| `TASK_QUEUE` | `alfred-learn` | Temporal task queue name |
| `ALFRED_LEARN_ENABLED` | `true` | Feature flag — set to `false` to disable |

---

## Development Setup

```bash
# Clone
git clone https://github.com/ssdavidai/alfred-platform.git
cd alfred-platform/packages/learn

# Virtual environment
python3.12 -m venv .venv
source .venv/bin/activate

# Dependencies
pip install -r requirements.txt
pip install pytest  # for tests

# Run tests
pytest tests/ -v

# Run the worker locally (requires Temporal and alfred-ctrl running)
export TEMPORAL_HOST=localhost:7233
export OPENCLAW_GATEWAY_URL=http://localhost:18789
export VAULT_PATH=/tmp/vault
export ALFRED_DATA_DIR=/tmp/alfred-data
export ALFRED_LEARN_ENABLED=true

python -m src.worker
```

For local development with the full tenant stack, use the dev compose override:

```bash
docker compose -f docker-compose.dev.yml up
```

---

## Docker

### Build

```bash
docker build -t ssdavidai00/alfred-learn:latest .
```

### Run with Compose

Add to the tenant `docker-compose.yaml`:

```yaml
alfred-learn:
  image: ssdavidai00/alfred-learn:latest
  depends_on:
    temporal:
      condition: service_healthy
    openclaw:
      condition: service_healthy
  volumes:
    - /mnt/encrypted/vault:/vault
    - /mnt/encrypted/alfred:/alfred-data
  environment:
    - TEMPORAL_HOST=temporal:7233
    - OPENCLAW_GATEWAY_URL=http://openclaw:18789
    - OPENCLAW_GATEWAY_TOKEN_FILE=/alfred-data/.gateway-token
    - VAULT_PATH=/vault
    - TASK_QUEUE=alfred-learn
    - ALFRED_LEARN_ENABLED=${ALFRED_LEARN_ENABLED:-true}
  restart: unless-stopped
  mem_limit: 1g
  pids_limit: 128
```

On first boot, register Temporal schedules and initialise vault folders:

```bash
docker exec alfred-learn python -m scripts.register_schedules
docker exec alfred-learn python -m scripts.init_vault
```

---

## Repo Structure

```
alfred-learn/
├── src/
│   ├── worker.py                  Temporal worker entry point
│   ├── config.py                  Environment config and defaults
│   ├── workflows/
│   │   ├── event_processor.py     Stream events → classified vault records
│   │   ├── session_tracker.py     Detects session boundaries
│   │   ├── briefing.py            Morning + evening brief composer (BriefingWorkflow)
│   │   ├── learning.py            Observation capture from queue and hints
│   │   ├── reflection.py          Nightly instinct refinement
│   │   └── judgment.py            Scores inputs, routes or escalates
│   ├── activities/
│   │   ├── clerk.py               OpenClaw gateway bridge (all LLM calls)
│   │   ├── classify.py            Metadata extraction and classification
│   │   ├── streams.py             Fetch and mark stream events
│   │   ├── vault.py               Vault CRUD via alfred-ctrl API
│   │   ├── session.py             Session boundary detection logic
│   │   ├── observe.py             Observation queue and routing hints
│   │   ├── reflect.py             Reflection proposal validation
│   │   ├── judge.py               Instinct scoring, routing, escalation
│   │   └── notify.py              Digest and escalation notifications
│   ├── validators/
│   │   ├── schema.py              Shared constants, types, weights
│   │   ├── frontmatter.py         Classification result validation
│   │   ├── observation.py         Observation record validation
│   │   └── instinct.py            Instinct record validation
│   ├── matching/
│   │   ├── scorer.py              Deterministic instinct scoring
│   │   ├── discretion.py          Threshold logic (when to act vs ask)
│   │   └── metadata.py            Input metadata extraction
│   └── utils/
│       ├── vault_client.py        HTTP client for alfred-ctrl vault API
│       └── jsonl.py               JSONL read/write helpers
├── tests/
│   ├── test_validators.py         Validator tests
│   ├── test_scorer.py             Scoring tests
│   ├── test_discretion.py         Discretion threshold tests
│   └── test_metadata.py           Metadata extraction tests
├── templates/
│   ├── observation.md             Vault template for observations
│   ├── instinct.md                Vault template for instincts
│   └── reflection.md              Vault template for reflection reports
├── hooks/
│   └── alfred-learn-observer/
│       ├── handler.js             Chat observation hook
│       └── HOOK.md                Hook documentation
├── scripts/
│   ├── register_schedules.py      Register Temporal schedules
│   └── init_vault.py              Create vault folders and seed files
├── Dockerfile
├── requirements.txt
└── CLAUDE.md
```

---

## Integration Points

### alfred-ctrl (tenant API)

Alfred Learn requires the following routes in alfred-ctrl (`src/api/routes/learning.ts`):

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/v1/learning/status` | Processor stats, instinct count, auto-route rate |
| `GET` | `/api/v1/learning/observations` | Paginated observation records |
| `GET` | `/api/v1/learning/instincts` | Active instincts with stats |
| `GET` | `/api/v1/learning/reflections` | Reflection reports |
| `GET` | `/api/v1/learning/queue` | Unrouted inputs awaiting judgment |
| `POST` | `/api/v1/learning/route` | Human routes an input (creates observation) |
| `POST` | `/api/v1/learning/enable` | Enable Alfred Learn |
| `POST` | `/api/v1/learning/disable` | Pause schedules, preserve data |
| `GET` | `/api/v1/learning/quarantine` | Quarantined events |
| `POST` | `/api/v1/learning/quarantine/:id/retry` | Retry quarantined event |
| `POST` | `/api/v1/learning/quarantine/:id/dismiss` | Dismiss quarantined event |

Vault schema extensions: `observation` and `instinct` added to `KNOWN_TYPES`, `STATUS_BY_TYPE`, and `TYPE_DIRECTORY`.

### alfred-saas (platform dashboard)

- Prisma migration adds `vaultRecord`, `processedAt`, `classification`, `quarantined` fields to `StreamEvent`
- New Wasp operations: `getIntuitionStatus`, `getIntuitionInstincts`, `getIntuitionQueue`, `routeInput`, `enableIntuition`, `disableIntuition`
- Dashboard page at `/dashboard/intuition` with status bar, judgment queue, instincts list, and activity feed

### OpenClaw Hooks

- **alfred-inbox** (enhanced) — emits `StreamEvent` on session flush
- **alfred-learn-observer** (new) — detects routing language in Alfred responses, queues observations

---

## License

MIT
