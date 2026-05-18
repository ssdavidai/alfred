# Alfred Learn — Production Specification

**Monorepo path:** `packages/learn`
**Created:** 2026-03-02
**Status:** Final — ready for build
**Tier:** All plans (Premium + Black)

---

## What This Is

Alfred Learn is Alfred Black's self-improving intelligence layer. It watches what flows through Streams, processes raw events into structured vault records, and — over time — learns how each tenant organizes their world so it can do it autonomously.

Two layers:

1. **The Processor** — takes raw stream events and turns them into vault records (tasks, events, notes, sessions)
2. **The Intuition Engine** — observes how the user routes things, builds pattern memory, and gradually takes over routine decisions

This is a new Docker container (`alfred-learn`) deployed alongside the existing tenant stack. Python + Temporal. Talks to the vault via alfred-ctrl API and to the LLM via OpenClaw gateway subagent sessions.

---

## Terminology

Alfred Black uses butler-appropriate language, not academic jargon.

| Internal (Acme Consulting) | Alfred Black term | What it is |
|---------------------|-------------------|------------|
| Cognition | **Observation** | A record of WHY something was routed a certain way. Alfred observed the master's preference. |
| Skill | **Instinct** | A learned routing pattern, distilled from many observations. Alfred developed an instinct for how to handle this. |
| Skill Graph | **Intuition** | The collection of all instincts. Alfred's accumulated intuition about how the household runs. |
| Synthesis | **Reflection** | The nightly process where Alfred reviews observations and refines instincts. The butler reflecting on the day. |
| Router | **Judgment** | The per-input decision process. Alfred exercising judgment on where something belongs. |
| Confidence Gate | **Discretion** | Knowing when to act vs. when to ask. A good butler's most important quality. |
| Cognition Capture | **Learning** | The act of recording a new observation from human behavior. |
| Subagent (subken) | **Clerk** | The stateless LLM worker called for creative tasks. A junior clerk Alfred dispatches for analysis. |

**Vault record types:**
- `observation` (was: cognition) — routing reasoning records
- `instinct` (was: skill) — learned routing patterns

**Vault folders:**
- `intuition/` (was: skill-graph/) — contains instincts and the index
- `intuition/instincts/` (was: skill-graph/skills/)
- `observation/` (was: cognition/) — routing observations
- `reflection/` (was: synthesis/) — nightly reflection reports

**Dashboard section:** "Intuition" (not "Learning Engine")

**Temporal task queue:** `alfred-learn`

**Schedule prefixes:** `al-` (not `le-`)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      ALFRED-SAAS (Platform)                   │
│                                                               │
│  Streams dashboard        Intuition dashboard (NEW)           │
│  Stream/StreamEvent ──→   ProcessedEvent fields (NEW)         │
│  Webhook receiver ──→     Learning API proxy ops (NEW)        │
└────────────────────┬─────────────────────────────────────────┘
                     │ proxyToTenant()
                     ▼
┌──────────────────────────────────────────────────────────────┐
│                TENANT INSTANCE (Acme Cloud VPS)                  │
│                                                               │
│  ┌───────────┐  ┌──────────┐  ┌────────────┐  ┌───────────┐│
│  │ OPENCLAW   │  │ TEMPORAL  │  │ ALFRED-CTRL│  │ALFRED-LEARN││
│  │ :18789     │  │ :7233    │  │ :3100      │  │(NEW)      ││
│  └─────┬─────┘  └────┬─────┘  └─────┬──────┘  └─────┬─────┘│
│        │              │              │               │       │
│        │   Schedules ─┘    Vault API─┘    Workflows ─┘       │
│        │                                                      │
│        └── Gateway API (subagent spawn) ─────────────────────┘│
│                                                               │
│  VAULT (/mnt/encrypted/vault/)                                │
│  ├── task/          ← extracted from stream events            │
│  ├── session/       ← session boundaries                      │
│  ├── event/         ← events, daily digests                   │
│  ├── note/          ← notes, summaries                        │
│  ├── person/        ← entities discovered                     │
│  ├── observation/   ← [NEW] routing reasoning                 │
│  ├── intuition/     ← [NEW] learned patterns                  │
│  │   ├── instincts/ ← individual pattern files                │
│  │   └── index.md   ← master index                           │
│  ├── reflection/    ← [NEW] nightly reports                   │
│  └── inbox/         ← raw inputs from streams                 │
└──────────────────────────────────────────────────────────────┘
```

---

## Trust Model (non-negotiable)

| Layer | Decides | Examples |
|-------|---------|----------|
| **Temporal** | WHEN things run | Schedules, retries, timeouts, workflow state |
| **Python** | STRUCTURAL things | Frontmatter validation, discretion thresholds, matching scores, dedup |
| **LLM (Clerk)** | CREATIVE things | Understanding content, extracting entities, classifying inputs, writing summaries |

The LLM never decides whether to run or what to enforce. It is called by Temporal, constrained by Python, and writes to the vault through validated paths.

**Clerk model:** Tenant-configurable via agent model config in alfred-ctrl services. Defaults to whatever model the tenant's main Alfred agent uses.

---

## Data Sources (Streams Integration)

Alfred Learn consumes stream events. Two source types are hardwired for launch:

### Source 1: OpenClaw Chat Hook (built-in)

The `alfred-inbox` hook already exists in alfred-ctrl. It buffers OpenClaw chat messages (user + assistant turns) and writes them to `vault/inbox/` as markdown files when either 10 turns accumulate or 5 minutes of idle pass.

**For Alfred Learn, we enhance this hook** to also write a structured event to the streams JSONL:

```javascript
// In alfred-inbox/handler.js — add after flush():
// Write a StreamEvent to the learning engine's ingest endpoint
appendEvent("system-openclaw-sessions", {
  id: crypto.randomUUID(),
  stream_id: "system-openclaw-sessions",
  stream_type: "conversation",
  received_at: new Date().toISOString(),
  source_ref: `${sessionKey}:${Date.now()}`,
  raw: { session_key: sessionKey, messages: session.messages, turns: session.turns },
  summary: `Chat session — ${session.turns} turns`
});
```

This means every Alfred conversation automatically becomes a stream event that the Processor can classify and extract from. No polling needed — it's push-based via the existing hook.

### Source 2: Webhooks (plug and play)

Already built in alfred-saas. External services POST to `/webhooks/:webhookToken`, which validates HMAC, wraps in StreamEvent envelope, and forwards to tenant via `proxyToTenant()` → `POST /api/v1/streams/ingest`.

Any webhook source works: GitHub, Stripe, Polar, Zapier, n8n, custom. The Processor classifies whatever arrives.

### Future Sources (not in this build)

Gmail polling, Omi WebSocket, RSS feeds, calendar sync — these are future Stream pollers that will feed into the same pipeline. When they're built, Alfred Learn processes them automatically because it reads from the same StreamEvent store.

---

## Layer 1: The Processor

### Workflow 1: Event Processor

**Schedule:** `al-event-processor` — every 2 minutes
**What:** Reads unprocessed stream events, classifies them, writes vault records.

```python
@workflow.defn(name="EventProcessorWorkflow")
class EventProcessorWorkflow:
    @workflow.run
    async def run(self) -> ProcessorResult:
        # 1. Fetch unprocessed events from streams API (max 20 per run)
        events = await workflow.execute_activity(
            fetch_unprocessed_events,
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        results = []
        for event in events[:20]:  # Rate limit: 20 per run
            # 2. Extract metadata (Python — deterministic)
            metadata = await workflow.execute_activity(
                extract_metadata, args=[event],
                start_to_close_timeout=timedelta(seconds=10),
            )
            
            # 3. Classify via Clerk (LLM — creative)
            classification = await workflow.execute_activity(
                classify_event, args=[event, metadata],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            
            # 4. Validate (Python — structural)
            validated = await workflow.execute_activity(
                validate_classification, args=[classification],
                start_to_close_timeout=timedelta(seconds=10),
            )
            
            if not validated.valid:
                # Quarantine on second failure
                await workflow.execute_activity(
                    quarantine_event, args=[event, validated.errors],
                    start_to_close_timeout=timedelta(seconds=10),
                )
                continue
            
            # 5. Write to vault
            vault_path = await workflow.execute_activity(
                write_vault_record, args=[classification],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            # 6. Mark processed
            await workflow.execute_activity(
                mark_event_processed,
                args=[event.id, vault_path, classification.type],
                start_to_close_timeout=timedelta(seconds=10),
            )
            
            # 7. Entity extraction — ensure person/org records exist
            if classification.entities:
                await workflow.execute_activity(
                    ensure_entities_exist, args=[classification.entities],
                    start_to_close_timeout=timedelta(seconds=30),
                )
            
            # 8. Attempt judgment (router) if instincts exist
            await workflow.execute_activity(
                attempt_judgment, args=[event, metadata, classification],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            results.append(vault_path)
        
        return ProcessorResult(processed=len(results), paths=results)
```

**Clerk prompt for classification:**
```
You are a butler's clerk. Analyze this raw event from the {source} stream.

Classify it as exactly one of: task, event, note, conversation, braindump, noise.

Extract:
- title (concise, descriptive)
- entities (people, organizations, places mentioned)
- action_items (if any — concrete next steps)
- dates (any dates/deadlines mentioned)
- tags (topical keywords, max 5)

If the content is trivial, automated, or contains no meaningful information, classify as "noise".

Return JSON only:
{
  "type": "task|event|note|conversation|braindump|noise",
  "title": "...",
  "entities": [{"name": "...", "type": "person|org|place"}],
  "action_items": ["..."],
  "dates": ["..."],
  "tags": ["..."],
  "summary": "One sentence summary"
}
```

**Quarantine:** Events that fail validation twice go to `inbox/_quarantine/{event_id}.md` with error details. Dashboard shows quarantine count. User can retry or dismiss.

### Workflow 2: Session Tracker

**Schedule:** `al-session-tracker` — every 5 minutes
**What:** Detects conversation session boundaries and groups related records.

```python
@workflow.defn(name="SessionTrackerWorkflow")
class SessionTrackerWorkflow:
    @workflow.run
    async def run(self) -> SessionResult:
        # 1. Read recent unassigned vault records (last 24h)
        records = await workflow.execute_activity(
            fetch_unassigned_records,
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        # 2. Group by time proximity (Python — deterministic)
        groups = await workflow.execute_activity(
            detect_session_boundaries, args=[records],
            start_to_close_timeout=timedelta(seconds=10),
        )
        # Rules:
        # - Records within 30min = same session (deterministic)
        # - 30min–2h gap = ask Clerk to decide (LLM)
        # - >2h gap = different sessions (deterministic)
        
        # 3. For ambiguous gaps, ask Clerk
        for group in groups.ambiguous:
            decision = await workflow.execute_activity(
                clerk_session_boundary, args=[group],
                start_to_close_timeout=timedelta(seconds=30),
            )
            groups.resolve(group, decision)
        
        # 4. Create session records + update members
        sessions_created = []
        for session in groups.finalized:
            path = await workflow.execute_activity(
                create_session_record, args=[session],
                start_to_close_timeout=timedelta(seconds=30),
            )
            await workflow.execute_activity(
                assign_records_to_session, args=[session.records, path],
                start_to_close_timeout=timedelta(seconds=30),
            )
            sessions_created.append(path)
        
        return SessionResult(sessions=len(sessions_created))
```

### Workflow 3: Daily Digest

**Schedule:** `al-daily-digest` — daily at 6pm tenant timezone (configurable)
**What:** End-of-day summary written to vault.

```python
@workflow.defn(name="DailyDigestWorkflow")
class DailyDigestWorkflow:
    @workflow.run
    async def run(self) -> DigestResult:
        # 1. Collect today's vault activity
        activity = await workflow.execute_activity(
            collect_daily_activity,
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        # 2. Ask Clerk to summarize
        digest = await workflow.execute_activity(
            clerk_daily_digest, args=[activity],
            start_to_close_timeout=timedelta(seconds=60),
        )
        
        # 3. Write event record
        path = await workflow.execute_activity(
            write_digest_record, args=[digest],
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        # 4. Notify main Alfred agent (optional — if user has notifications enabled)
        await workflow.execute_activity(
            notify_digest_ready, args=[path, digest.summary],
            start_to_close_timeout=timedelta(seconds=15),
        )
        
        return DigestResult(path=path)
```

---

## Layer 2: The Intuition Engine

### Workflow 4: Learning (Observation Capture)

**Two entry points, one workflow.**

**Entry Point A — Chat Hook:**

New OpenClaw hook: `alfred-learn-observer` (added to alfred-ctrl hooks).

When the main Alfred agent's response contains routing language, the hook writes an observation request to `/mnt/encrypted/alfred/observation-queue.jsonl`.

Detection keywords (in assistant messages):
- "filed under", "moved to", "categorized as", "routed to"
- "assigned to project", "belongs in", "putting this in"
- "this is a", "classified as", "tagged as"
- vault write confirmations (regex: `created.*vault|wrote.*to.*\/`)

```javascript
// Hook: alfred-learn-observer/handler.js
const ROUTING_PATTERNS = [
  /(?:filed?|moved?|put(?:ting)?|categori[sz]ed?|routed?|assigned?)\s+(?:under|to|in|as)/i,
  /(?:belongs?\s+in|this\s+is\s+a[n]?\s+\w+\s+(?:for|about|from))/i,
  /(?:created|wrote|saved)\s+.*(?:vault|task\/|event\/|note\/|person\/)/i,
];

const handler = async (event) => {
  if (event.type !== "message" || event.action !== "sent") return;
  const content = String(event.context?.content || "");
  
  const matched = ROUTING_PATTERNS.some(p => p.test(content));
  if (!matched) return;
  
  // Get the user message that triggered this (last received message in buffer)
  const userMessage = getLastUserMessage(event.sessionKey);
  if (!userMessage) return;
  
  const observation = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    session_key: event.sessionKey,
    user_input: userMessage,
    alfred_response: content,
    source: "chat",
  };
  
  appendToJsonl("/mnt/encrypted/alfred/observation-queue.jsonl", observation);
};
```

**Entry Point B — Routing Hint Watcher:**

Part of the Learning workflow itself. Every 5 minutes, scans recently modified vault files for a `routing_hint` frontmatter field.

```yaml
# Example: user adds this to a vault record
---
type: input
name: Vendor Invoice March
routing_hint: "This is a recurring vendor invoice — route to finance/invoices"
---
```

When detected, the workflow creates an observation AND executes the routing.

**Schedule:** `al-learning` — every 5 minutes
**What:** Processes observation queue and routing hints into observation records.

```python
@workflow.defn(name="LearningWorkflow")
class LearningWorkflow:
    @workflow.run
    async def run(self) -> LearningResult:
        observations_created = 0
        
        # Entry Point A: Process observation queue
        queue_items = await workflow.execute_activity(
            read_observation_queue,
            start_to_close_timeout=timedelta(seconds=10),
        )
        
        for item in queue_items:
            # Ask Clerk to extract structured observation
            observation = await workflow.execute_activity(
                clerk_extract_observation, args=[item],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            # Validate (Python)
            if await workflow.execute_activity(
                validate_observation, args=[observation],
                start_to_close_timeout=timedelta(seconds=10),
            ):
                await workflow.execute_activity(
                    write_observation_record, args=[observation],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                observations_created += 1
        
        # Entry Point B: Scan for routing hints
        hints = await workflow.execute_activity(
            scan_routing_hints,
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        for hint in hints:
            observation = await workflow.execute_activity(
                clerk_extract_hint_observation, args=[hint],
                start_to_close_timeout=timedelta(seconds=30),
            )
            if await workflow.execute_activity(
                validate_observation, args=[observation],
                start_to_close_timeout=timedelta(seconds=10),
            ):
                await workflow.execute_activity(
                    write_observation_record, args=[observation],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                # Also execute the routing
                await workflow.execute_activity(
                    execute_routing_hint, args=[hint],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                observations_created += 1
        
        # Clear processed queue items
        await workflow.execute_activity(
            clear_observation_queue, args=[len(queue_items)],
            start_to_close_timeout=timedelta(seconds=10),
        )
        
        return LearningResult(observations=observations_created)
```

**Observation record schema:**
```yaml
---
type: observation
created: 2026-03-15T10:30:00
status: unprocessed
input_type: email
input_source: gmail
input_ref: "stream-event-abc123"
routing_decision: "project/client-x-onboarding"
reasoning: "Email from client X's HR department about onboarding timeline — belongs in client X project"
signals:
  domain_patterns: ["clientx.com"]
  keyword_patterns: ["onboarding", "timeline", "HR"]
  input_types: ["email"]
  attachment_patterns: []
confidence: human
routed_by: user
---
```

### Workflow 5: Reflection (Nightly Synthesis)

**Schedule:** `al-reflection` — daily at 2am tenant timezone
**What:** Reviews new observations, refines instincts, builds intuition.

```python
@workflow.defn(name="ReflectionWorkflow")
class ReflectionWorkflow:
    @workflow.run
    async def run(self) -> ReflectionResult:
        # 1. Read unprocessed observations
        observations = await workflow.execute_activity(
            fetch_unprocessed_observations,
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        if not observations:
            return ReflectionResult(changes=0)
        
        # 2. Read current intuition (all active instincts)
        instincts = await workflow.execute_activity(
            fetch_active_instincts,
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        # 3. Ask Clerk to analyze (LLM — creative)
        proposals = await workflow.execute_activity(
            clerk_reflect, args=[observations, instincts],
            start_to_close_timeout=timedelta(seconds=120),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        # Clerk returns: create_instincts, update_instincts,
        #                merge_instincts, deprecate_instincts
        
        # 4. Validate each proposal (Python — structural)
        valid_proposals = await workflow.execute_activity(
            validate_proposals, args=[proposals],
            start_to_close_timeout=timedelta(seconds=10),
        )
        
        # 5. Apply changes to vault
        changes = 0
        for proposal in valid_proposals:
            await workflow.execute_activity(
                apply_instinct_change, args=[proposal],
                start_to_close_timeout=timedelta(seconds=30),
            )
            changes += 1
        
        # 6. Mark observations as processed
        await workflow.execute_activity(
            mark_observations_processed, args=[observations],
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        # 7. Rebuild intuition index
        await workflow.execute_activity(
            rebuild_intuition_index,
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        # 8. Write reflection report
        report_path = await workflow.execute_activity(
            write_reflection_report,
            args=[observations, valid_proposals, changes],
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        return ReflectionResult(changes=changes, report=report_path)
```

**Clerk prompt for reflection:**
```
You are a butler's head clerk, reviewing today's observations to refine the household's instincts.

CURRENT INSTINCTS (learned patterns):
{instincts_json}

NEW OBSERVATIONS (today's routing decisions):
{observations_json}

Analyze the observations against existing instincts. For each observation, determine:

1. Does it strengthen an existing instinct? → UPDATE (add signals, increment count)
2. Does it represent a new pattern not covered? → CREATE new instinct
3. Do two instincts now overlap enough to merge? → MERGE
4. Does new evidence contradict an instinct? → DEPRECATE

Rules:
- A new instinct needs at least 3 observations of the same pattern to be created
- Never delete observations — only instincts can be deprecated
- Be conservative: when in doubt, don't create a new instinct yet
- Signal patterns must be specific enough to avoid false positives

Return JSON:
{
  "create": [{ instinct object }],
  "update": [{ instinct_id, changes }],
  "merge": [{ source_ids, merged_instinct }],
  "deprecate": [{ instinct_id, reason }],
  "reasoning": "Brief explanation of changes"
}
```

**Instinct record schema:**
```yaml
---
type: instinct
name: Client Invoice Processing
created: 2026-03-15
status: active
domain: finance
observation_count: 12
discretion_threshold: 0.85
signals:
  domain_patterns: ["*@clientx.com", "*@vendor*.com"]
  keyword_patterns: ["invoice", "payment", "due date", "PO number"]
  input_types: ["email"]
  attachment_patterns: ["*.pdf", "*.xlsx"]
matching_weights:
  domain: 0.30
  keywords: 0.30
  input_type: 0.15
  attachment: 0.15
  tags: 0.10
routing_destination: "process/invoice-processing"
last_matched: 2026-03-14
total_matches: 8
total_escalations: 2
based_on:
  - "[[observation/2026-03-10-invoice-routing-001]]"
  - "[[observation/2026-03-12-invoice-routing-002]]"
---

## Routing Logic
When an email arrives from a known vendor domain containing invoice-related
keywords and a PDF attachment, route to the invoice processing workflow.

## Exceptions
- Invoices over $10,000 always escalate to human review
- New vendors (not in person/ or org/) always escalate first time
```

### Workflow 6: Judgment (Router)

**Trigger:** Called by Event Processor (Workflow 1, step 8) after classification. Also runs as `al-judgment` schedule every 2 minutes to catch unrouted inputs.

```python
@workflow.defn(name="JudgmentWorkflow")
class JudgmentWorkflow:
    @workflow.run
    async def run(self, input_event: Optional[dict] = None) -> JudgmentResult:
        # If called with specific input, judge it
        # If called by schedule, scan for unrouted inputs
        
        if input_event:
            inputs = [input_event]
        else:
            inputs = await workflow.execute_activity(
                fetch_unrouted_inputs,
                start_to_close_timeout=timedelta(seconds=30),
            )
        
        routed = 0
        escalated = 0
        
        for inp in inputs:
            # 1. Extract metadata (Python — deterministic)
            metadata = await workflow.execute_activity(
                extract_input_metadata, args=[inp],
                start_to_close_timeout=timedelta(seconds=10),
            )
            
            # 2. Load intuition index (Python — deterministic)
            instincts = await workflow.execute_activity(
                load_intuition_index,
                start_to_close_timeout=timedelta(seconds=10),
            )
            
            if not instincts:
                # No instincts yet — everything escalates
                escalated += 1
                continue
            
            # 3. Score each instinct (Python — deterministic)
            scores = await workflow.execute_activity(
                score_instincts, args=[metadata, instincts],
                start_to_close_timeout=timedelta(seconds=10),
            )
            # Weighted scoring:
            # domain: 0.30, keywords: 0.30, input_type: 0.15,
            # attachment: 0.15, tags: 0.10
            
            # 4. Apply discretion (Python — deterministic)
            best = scores[0] if scores else None
            
            if best and best.score >= best.instinct.discretion_threshold:
                # Route autonomously
                await workflow.execute_activity(
                    execute_route,
                    args=[inp, best.instinct.routing_destination],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                # Record observation (machine-routed)
                await workflow.execute_activity(
                    write_observation_record,
                    args=[build_machine_observation(inp, best)],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                routed += 1
            else:
                # Escalate — notify main Alfred
                await workflow.execute_activity(
                    escalate_to_user,
                    args=[inp, best],  # include best match for context
                    start_to_close_timeout=timedelta(seconds=15),
                )
                escalated += 1
        
        return JudgmentResult(routed=routed, escalated=escalated)
```

**Discretion thresholds (scale with evidence):**
| Observations | Threshold | Butler equivalent |
|--------------|-----------|-------------------|
| < 5 | 0.95 | "I've barely seen this before, sir. Your guidance?" |
| 5–9 | 0.90 | "I believe I know, but I'd rather confirm." |
| 10–19 | 0.85 | "I'm fairly certain this goes here." |
| 20–49 | 0.80 | "I've seen this many times. Handling it." |
| 50+ | 0.75 | "This is routine. Already done." |

**Cold start:** Empty intuition → everything escalates → user routes → observations accumulate → reflection creates instincts → judgment starts routing. The system bootstraps from nothing.

---

## Infrastructure

### Docker Container

New service in `docker-compose.yaml.njk`:

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
    env_file:
      - .env
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 1g
    pids_limit: 128
```

### Package Structure: `packages/learn`

```
alfred-learn/
├── Dockerfile
├── requirements.txt
├── README.md
├── CLAUDE.md                          # Context for Claude Code
├── docs/
│   └── SPEC.md                        # This spec (reference)
├── src/
│   ├── __init__.py
│   ├── worker.py                      # Temporal worker entry point
│   ├── config.py                      # Configuration (env vars, defaults)
│   ├── activities/
│   │   ├── __init__.py
│   │   ├── streams.py                 # fetch_unprocessed_events, mark_event_processed
│   │   ├── vault.py                   # write_vault_record, fetch records, search
│   │   ├── clerk.py                   # OpenClaw subagent bridge (sessions_spawn)
│   │   ├── classify.py                # extract_metadata, classify_event
│   │   ├── session.py                 # detect_session_boundaries, create_session_record
│   │   ├── observe.py                 # read_observation_queue, write_observation_record
│   │   ├── reflect.py                 # clerk_reflect, apply_instinct_change
│   │   ├── judge.py                   # score_instincts, execute_route, escalate_to_user
│   │   └── notify.py                  # notify_digest_ready, escalate notifications
│   ├── workflows/
│   │   ├── __init__.py
│   │   ├── event_processor.py         # Workflow 1
│   │   ├── session_tracker.py         # Workflow 2
│   │   ├── daily_digest.py            # Workflow 3
│   │   ├── learning.py                # Workflow 4
│   │   ├── reflection.py              # Workflow 5
│   │   └── judgment.py                # Workflow 6
│   ├── validators/
│   │   ├── __init__.py
│   │   ├── frontmatter.py             # Validate vault record frontmatter
│   │   ├── observation.py             # Validate observation records
│   │   ├── instinct.py                # Validate instinct records
│   │   └── schema.py                  # Shared schema definitions
│   ├── matching/
│   │   ├── __init__.py
│   │   ├── scorer.py                  # Deterministic instinct scoring
│   │   ├── discretion.py              # Confidence gate / discretion thresholds
│   │   └── metadata.py                # Input metadata extraction
│   └── utils/
│       ├── __init__.py
│       ├── jsonl.py                    # JSONL read/write helpers
│       └── vault_client.py            # HTTP client for alfred-ctrl vault API
├── tests/
│   ├── __init__.py
│   ├── test_validators.py
│   ├── test_scorer.py
│   ├── test_discretion.py
│   └── test_metadata.py
├── hooks/
│   └── alfred-learn-observer/
│       ├── HOOK.md
│       └── handler.js                  # OpenClaw hook for observation capture
├── templates/
│   ├── observation.md                  # Vault template for observation records
│   ├── instinct.md                     # Vault template for instinct records
│   └── reflection.md                   # Vault template for reflection reports
├── scripts/
│   ├── register_schedules.py           # Register all Temporal schedules
│   ├── init_vault.py                   # Create vault folders + initial files
│   └── seed_intuition.py              # (Optional) Seed instincts from existing patterns
├── .github/
│   └── workflows/
│       └── build.yml                   # Build + push Docker image
└── docker-compose.dev.yml             # Local dev compose override
```

### Requirements

```
temporalio>=1.9.0
httpx>=0.27.0
pyyaml>=6.0
```

### Temporal Schedules

Registered by `scripts/register_schedules.py` on container first boot:

| Schedule ID | Workflow | Interval | Purpose |
|-------------|----------|----------|---------|
| `al-event-processor` | EventProcessorWorkflow | every 2 min | Process stream events → vault |
| `al-session-tracker` | SessionTrackerWorkflow | every 5 min | Detect session boundaries |
| `al-daily-digest` | DailyDigestWorkflow | daily 6pm | End-of-day summary |
| `al-learning` | LearningWorkflow | every 5 min | Capture observations |
| `al-reflection` | ReflectionWorkflow | daily 2am | Nightly instinct refinement |
| `al-judgment` | JudgmentWorkflow | every 2 min | Route unrouted inputs |

---

## API Changes

### alfred-ctrl: New Routes

New file: `src/api/routes/learning.ts`

```
GET  /api/v1/learning/status
     → { enabled, processor: {last_run, events_today, quarantine_count},
         intuition: {observation_count, instinct_count, auto_route_rate, last_reflection} }

GET  /api/v1/learning/observations
     → Paginated observation records (filterable by status)

GET  /api/v1/learning/observations/:id
     → Single observation detail

GET  /api/v1/learning/instincts
     → All active instincts with stats

GET  /api/v1/learning/instincts/:id
     → Single instinct with observation sources

GET  /api/v1/learning/reflections
     → List reflection reports

GET  /api/v1/learning/queue
     → Unrouted inputs waiting for human judgment

POST /api/v1/learning/route
     → { input_id, destination } — human routes input, creates observation

POST /api/v1/learning/enable
     → Enable Alfred Learn

POST /api/v1/learning/disable
     → Disable (pause schedules, preserve data)

GET  /api/v1/learning/quarantine
     → Quarantined events

POST /api/v1/learning/quarantine/:id/retry
POST /api/v1/learning/quarantine/:id/dismiss
```

### alfred-ctrl: Vault Schema Extensions

Add to `KNOWN_TYPES` in `vault.ts`:
```typescript
"observation",
"instinct",
```

Add to `STATUS_BY_TYPE`:
```typescript
observation: ["unprocessed", "processed", "invalid"],
instinct: ["active", "proposed", "deprecated", "merged"],
```

Add to `TYPE_DIRECTORY`:
```typescript
observation: "observation",
instinct: "intuition/instincts",
```

### alfred-saas: Prisma Migration

```prisma
model StreamEvent {
  // existing fields unchanged
  vaultRecord     String?    // path to created vault record
  processedAt     DateTime?  // when processed by alfred-learn
  classification  String?    // "task"|"event"|"note"|"conversation"|"braindump"|"noise"
  quarantined     Boolean    @default(false)
  quarantineError String?
}
```

### alfred-saas: New Wasp Operations

```
query getIntuitionStatus     — proxy to /api/v1/learning/status
query getIntuitionInstincts  — proxy to /api/v1/learning/instincts
query getIntuitionQueue      — proxy to /api/v1/learning/queue
action routeInput            — proxy to /api/v1/learning/route
action enableIntuition       — proxy to /api/v1/learning/enable
action disableIntuition      — proxy to /api/v1/learning/disable
```

### alfred-saas: Dashboard Page

**Route:** `/dashboard/intuition`

See the Dashboard UI section below for layout.

---

## Dashboard UI (alfred-saas)

### Intuition Page (`/dashboard/intuition`)

Follows existing Alfred Black design language: dark bg, gold accents, EB Garamond serif headings, JetBrains Mono for data, DM Sans for body.

#### Section 1: Status Bar
```
INTUITION                                          [Enabled ●]

Processed today    Observations    Instincts    Auto-route rate
      47              23             8              34%
```

#### Section 2: Needs Your Judgment
```
AWAITING JUDGMENT                                  [3 items]

From vendor@acme.com                               [Route ▼]
  "March services invoice attached"
  12m ago · Best match: Vendor Invoices (72%)

Voice memo — 4m32s                                 [Route ▼]
  "Discussion about Q2 hiring plan"
  1h ago · No instinct match

Slack thread from #ops                             [Route ▼]
  "Server migration timeline update"
  3h ago · Best match: Infrastructure (61%)
```

Route dropdown lists vault projects/processes. Routing creates an observation.

#### Section 3: Instincts
```
INSTINCTS                                  [8 active · 2 developing]

● Vendor Invoice Processing    12 obs · 85% discretion · 8 auto-routed
● Meeting Notes Extraction     8 obs · 90% discretion · 15 auto-routed
● Weekly Report Filing         5 obs · 90% discretion · 3 auto-routed
○ Hiring Pipeline Updates      3 obs · developing · needs 2 more
```

#### Section 4: Activity
```
RECENT ACTIVITY

10:30  Processed 3 events → 1 task, 1 note, 1 noise
10:25  Auto-routed vendor invoice (score: 0.91)
09:00  Reflection: updated "Meeting Notes" instinct (+2 observations)
08:55  Session detected: "Morning planning" (4 records, 12 min)
```

---

## Integration with Existing Alfred Black Hooks

### Enhanced alfred-inbox hook

The existing `alfred-inbox` hook in alfred-ctrl writes chat sessions to `vault/inbox/`. We enhance it to ALSO emit a StreamEvent:

```javascript
// Addition to alfred-inbox/handler.js flush() function:
function flush(sessionKey, workspaceDir) {
  // ... existing markdown write to inbox ...
  
  // NEW: Also emit a StreamEvent for alfred-learn
  const streamsDir = path.join("/mnt/encrypted/alfred", "streams");
  mkdirSync(streamsDir, { recursive: true });
  
  const event = {
    id: crypto.randomUUID(),
    stream_id: "system-openclaw-sessions",
    stream_type: "conversation",
    received_at: new Date().toISOString(),
    source_ref: `${sessionKey}:${Date.now()}`,
    raw: { session_key: sessionKey, messages: session.messages, turns: session.turns },
    summary: `Chat session — ${session.turns} turns`,
  };
  
  appendFileSync(
    path.join(streamsDir, "system-openclaw-sessions.jsonl"),
    JSON.stringify(event) + "\n"
  );
}
```

### New alfred-learn-observer hook

Deployed alongside alfred-inbox in the hooks directory. Watches for routing patterns in Alfred's responses and queues observations.

File: `hooks/alfred-learn-observer/handler.js` (maintained with Alfred Learn changes and deployed into `packages/ctrl` hooks)

---

## Build Phases

### Phase 1: Core Infrastructure
1. Create the `packages/learn` package structure in the monorepo
2. `config.py` — env vars, defaults, vault paths
3. `utils/vault_client.py` — HTTP client for alfred-ctrl API
4. `utils/jsonl.py` — JSONL helpers
5. `activities/clerk.py` — OpenClaw subagent bridge
6. `activities/vault.py` — vault read/write activities
7. `activities/streams.py` — stream event read/mark activities
8. `validators/schema.py` + `validators/frontmatter.py` — shared validation
9. `worker.py` — Temporal worker entry point (registers all workflows)
10. `Dockerfile` + `requirements.txt`
11. `.github/workflows/build.yml` — CI/CD

### Phase 2: Processor Layer
12. `activities/classify.py` — metadata extraction + classification
13. `workflows/event_processor.py` — Workflow 1
14. `validators/observation.py` — observation record validation
15. `activities/session.py` — session boundary detection
16. `workflows/session_tracker.py` — Workflow 2
17. `activities/notify.py` — notifications
18. `workflows/daily_digest.py` — Workflow 3

### Phase 3: Intuition Engine
19. `hooks/alfred-learn-observer/handler.js` — chat observation hook
20. `activities/observe.py` — observation queue + write
21. `workflows/learning.py` — Workflow 4
22. `validators/instinct.py` — instinct record validation
23. `matching/metadata.py` — input metadata extraction
24. `matching/scorer.py` — deterministic instinct scoring
25. `matching/discretion.py` — threshold logic
26. `activities/reflect.py` — reflection activities
27. `workflows/reflection.py` — Workflow 5
28. `activities/judge.py` — judgment activities
29. `workflows/judgment.py` — Workflow 6

### Phase 4: Integration
30. `scripts/register_schedules.py` — Temporal schedule registration
31. `scripts/init_vault.py` — vault folder creation
32. `templates/` — vault record templates (observation, instinct, reflection)
33. Enhanced `alfred-inbox` hook (StreamEvent emission)
34. alfred-ctrl: `src/api/routes/learning.ts` — all API routes
35. alfred-ctrl: vault.ts schema updates (observation + instinct types)
36. alfred-ctrl: `docker-compose.yaml.njk` — add alfred-learn service
37. alfred-ctrl: provisioner updates

### Phase 5: Dashboard
38. alfred-saas: Prisma migration (StreamEvent new fields)
39. alfred-saas: New Wasp operations (intuition queries/actions)
40. alfred-saas: `main.wasp` route + page declarations
41. alfred-saas: `IntuitionPage.tsx` — main dashboard
42. alfred-saas: `IntuitionStatus.tsx` — status bar component
43. alfred-saas: `JudgmentQueue.tsx` — unrouted inputs with routing UI
44. alfred-saas: `InstinctsList.tsx` — instinct browser
45. alfred-saas: `ActivityFeed.tsx` — recent activity
46. alfred-saas: Sidebar nav entry
47. alfred-saas: Dashboard home widget (like StreamsSection)

## Sure Transaction Clustering

**Module:** `src/profiler/transaction_clustering.py`, `src/profiler/iterative.py`, `src/profiler/llm_inference.py`, `src/cli/sure_cluster.py`.

**Purpose:** classify Sir's bank-feed transactions into Sure family-merchants + categories + tags without requiring him to write rules by hand. Coverage target: ≥80% on a typical Hungarian household.

**Architecture:** sister of the existing `clustering.py` (which clusters email senders into priority tiers). Same skeleton (TF-IDF → cluster → feature-extract → role inference) re-tuned for short bank-feed name strings instead of email behaviour vectors.

**Pipeline (multi-pass iterative loop):**

1. **Pass 1 — Keyword + word-TFIDF clustering** (`cluster_transactions`):
   - `clean_name()`: strips card numbers, postcodes, currency tokens, all digit runs, punctuation, 1-2 char leftover tokens.
   - `_alias_groups()`: TF-IDF on word tokens (≥3 chars) with sublinear TF, then agglomerative cosine clustering. On corpora <50 docs falls back to union-find token-overlap merging (TF-IDF math degenerates without IDF context).
   - `_classify_group()`: matches the canonical name + raw + cleaned member samples against ~80 keyword regex rules covering Hungarian + English merchants. Each rule maps to `(category, tag, role)`.
   - Cheap, deterministic, no external calls.

2. **Pass 2 — Behavioural co-occurrence** (`behavioural_groups`):
   - Groups transactions by `(account_id, amount_band_1k_HUF)`.
   - Keeps groups with ≥3 occurrences spanning ≥2 different months — that's "recurring monthly cadence" without requiring name overlap.
   - Catches behaviour-equivalent variants of the same payee that name-tokens miss.
   - Returns proposals with role (merchant vs income from signed direction) but no category — the LLM pass fills those.

3. **Pass 3 — LLM category inference** (`llm_inference.infer_categories_for_clusters`):
   - For any group still missing a category and with ≥2 transactions: batched (50 per call) into a structured prompt sent to the OpenClaw gateway's OpenAI-compatible `/v1/chat/completions` endpoint.
   - Default model: `x-ai/grok-4.1-fast` (override via `SURE_CLUSTER_LLM_MODEL` env or request body `llm_model`).
   - Prompt grounds the LLM in the tenant's actual category + tag list; explicit rules for Hungarian patika/orvosi/etterem/fizetés patterns and internal-transfer detection.
   - Returns `[{canonical_name, proposed_category, proposed_tag, role, confidence}]` per group.
   - Uses `/v1/chat/completions` (one-shot, ~5-15s) NOT `sessions_spawn` (subagent, 30-180s) — clustering is pure inference, no tool use needed.

**Iteration loop** (`iterative_cluster`):

```
covered_ids = set()
for iter in 1..max_iterations:
    residual = txns minus covered_ids
    pass1 = keyword_clustering(residual)
    pass2 = behavioural_groups(residual)            # if use_behavioural
    pass3 = llm_infer(pass1+pass2 unmatched groups) # if use_llm + token + cats
    update covered_ids from new high-confidence proposals
    if coverage >= target_coverage:    break (target_coverage_reached)
    if new_matches < progress_threshold: break (no_progress)
```

Returns the union of proposals across all iterations, deduplicated by canonical name (highest confidence wins), plus per-iteration stats.

**HTTP API (ctrl-api):**

- `POST /api/v1/sure/_cluster` — harvest all transactions from Sure, run the iterative pipeline via `docker exec compose-alfred-learn-1 python -m src.cli.sure_cluster`, return `{proposals, stats[], coverage_percent, stopped_reason}`. Body params (all optional): `iterative`, `target_coverage`, `max_iterations`, `use_llm`, `use_behavioural`, `llm_model`, `available_categories[]`, `available_tags[]`, `similarity_threshold`, `min_group_size`. Hard timeout: 9 minutes.
- `POST /api/v1/sure/_cluster/apply` — execute approved proposals: create FamilyMerchants (skip dupes by name), create Rules (`transaction_name LIKE %keyword%` → set merchant + category + tag), fire `apply_all`. Returns `{merchants_created, rules_created, failures, apply_all}`.

**Operational notes:**
- LLM pass costs ~30k tokens for a 6-iteration run on 3,000 txns (~$0.10-0.30 depending on model). One-shot bootstrap, not a recurring chore.
- LLM is non-deterministic at temperature 0.1; same input may produce slightly different categories at the margin. Use `iterative: false` for deterministic builds.
- The pipeline runs entirely inside `compose-alfred-learn-1`. No new ports, no new Temporal workflows. ctrl-api invokes via `dockerExecWithStdin` (mirrors the existing Rails-runner pattern for `sure-*-mutate.rb` scripts).
- LLM uses `model: "openclaw"` (NOT a raw upstream id like `x-ai/grok-4.1-fast`). The gateway selects the actual upstream model from its per-agent `auth-profiles.json` config; arbitrary upstream ids return HTTP 400.

**Measured baseline (david's tenant, 3,267 transactions, 2026-04-30):**
- Pipeline run: 15min, 357 proposals, 70% raw coverage at proposal level.
- After `_cluster/apply` quality filter (default `min_confidence=0.85`, drop low-confidence transfer-role proposals): 162 rules created, 90 family merchants created, **78.2% of all transactions categorised end-to-end** (2,555 of 3,267).
- Distribution of categorised transactions: Subscriptions 543, Transfers 500, Food & Drink 216, Income 202, Groceries 201, Healthcare 132, Services 130, Shopping 129, Investment Contributions 121, Transportation 93, Taxes 57, Personal Care 55, Home Improvement 45, Entertainment 43, Utilities 37, Sports & Fitness 19, Fees 15, Travel 6, Insurance 4, Loan Payments 4, Mortgage / Rent 3.
- Quality sample (manual review of 30 proposals across volume tiers): 25/30 correct, 3/30 borderline, 2/30 wrong (a behavioural mis-cluster + an LLM-mislabelled subscription). The default filter drops the wrong ones; the `drop_canonical_names` override exists for the rare borderline cases that survive the filter.

**End-to-end bootstrap on a fresh tenant** — single endpoint, ~30 min wall-clock, ~$0.20 in LLM tokens:

```
POST /api/v1/sure/_bootstrap
```

Internally calls:
1. `POST /api/v1/sure/categories/bootstrap` (idempotent — skipped if family has any categories).
2. `POST /api/v1/sure/_cluster` (auto-discovers the family's category + tag names; no need to pass them).
3. `POST /api/v1/sure/_cluster/apply` (with the quality filter).

Returns a single combined response with `cluster.coverage_percent`, `apply.merchants_created`, `apply.rules_created`, and a step-by-step `log[]`. All params from `/_cluster` and `/_cluster/apply` pass through (target_coverage, max_iterations, llm_top_n, min_confidence, drop_canonical_names[], etc.) — empty body works for the default case.

Use the explicit two-step (`/_cluster` then `/_cluster/apply`) when you need to review proposals before applying them. After this one-shot, Sure's own auto-rule engine handles new transactions on every sync.

### Phase 6: Tests + Polish
48. `tests/test_validators.py`
49. `tests/test_scorer.py`
50. `tests/test_discretion.py`
51. `tests/test_metadata.py`
52. Quarantine management (retry/dismiss in dashboard)
53. Instinct detail view (observation sources, match history)
54. `README.md` with setup instructions
55. alfred-documentation: feature doc for Intuition

---

## Layer 4: Living Narratives (RFC #884, Alfred Black 1.0)

The Steward already classifies signals and applies state transitions on tasks. What's missing is the **narrative layer** that turns matters and tasks into living documents — model-written paragraphs describing the current state, refreshed every night.

### Schema additions

**Matter frontmatter (`matter/*.md`)** — three new fields, all written by `nightly_narrative`:

| Field | Type | Source |
|---|---|---|
| `current_state` | `str \| null` | LLM-synthesised 2–4 sentence paragraph describing where the matter stands today |
| `as_of` | ISO-8601 datetime string `\| null` | When `current_state` was last rewritten |
| `signal_count_24h` | `int` | Count of signals routed to this matter in the last 24h (bookkeeping for the nightly run) |

**Task frontmatter (`task/*.md`)** — two new fields, written by Steward at every state transition:

| Field | Type | Source |
|---|---|---|
| `state` | `"pending" \| "in_progress" \| "done" \| "archived"` | Steward-owned. Promoted from the existing implicit `last_steward_outcome.decision` so the renderer doesn't have to peek inside that nested object. |
| `current_state` | `str \| null` | Single sentence describing the task's situation — e.g. *"Done — Alfred filed the Example Co receipt on 2026-05-11."* |
| `as_of` | ISO-8601 datetime string `\| null` | When `current_state` was last rewritten |

### Workflow 7: Nightly Narrative

**File:** `src/workflows/nightly_narrative.py`
**Schedule:** Temporal cron `0 2 * * *` (02:00 local, per tenant)
**Activities:**
- `load_matter_signals_24h(matter_path)` — `signal/*.md` where any `target_candidates[].path == matter/<x>.md` AND `applied_at` within 24h
- `load_task_transitions_24h(matter_path)` — tasks linked to this matter whose `state` changed in 24h
- `load_source_events(signal_paths)` — back-pointer expand for context
- `generate_matter_narrative(matter, signals, transitions, events)` — single clerk call via OpenClaw gateway, prompted for a 2–4 sentence current_state paragraph in Alfred's voice
- `patch_matter_narrative(matter_path, current_state, as_of, signal_count_24h)` — atomic vault_client write

**Idempotency:** If no signals AND no transitions in the last 24h, leave `current_state` alone and just refresh `as_of` (or skip — TBD on whether `as_of` should mean "last successfully rewrote" or "last attempted").

### Steward inline task writebacks (extension to Workflow 6)

Every time `StewardWorkflow` mutates a task's `state` field (via `apply_state_change`), it also writes `task.current_state` (one sentence describing what just happened) and `task.as_of` (now). Composed deterministically from the triggering signal — no extra LLM call.

### Daily Digest reads narratives (refactor of Workflow 3)

`daily_digest.py` becomes a thin composer: for each active matter (where `state != "done"`), read its `current_state` + `as_of`. The brief is a tight one-paragraph-per-matter readout pulled directly from the narrative layer. Fallback: if `as_of` is > 36h stale, re-walk recent events for that matter inline.

### Why this closes the loop

When a task gets completed because the Steward picked up the completion signal (e.g. a payment-confirmation email), sir doesn't get asked. The Steward writes `task.state = "done"` + `task.current_state = "Done — Alfred filed the confirmation on …"`. The nightly narrative folds that into the matter's `current_state`. The next morning's brief reads "Example Co invoice: settled" without sir ever being prompted.

