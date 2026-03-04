# Alfred Learn v2 — NeoTerra Parity Fixes

**9 fixes to close the gap between Alfred Learn and NeoTerra UTS+SGR**

---

## Fix 1: Media Ingestion Hook + Workflow

**New hook:** `alfred-learn-media` in alfred-ctrl hooks.

Triggers when media files appear in OpenClaw sessions (images, PDFs, audio, video). Writes a StreamEvent to the JSONL with the file path, MIME type, and surrounding context (last 3 messages).

```javascript
// hooks/alfred-learn-media/handler.js
// Watches for: message events with media attachments
// Detects: images, PDFs, audio files, video files
// Writes to: /mnt/encrypted/alfred/streams/system-media-ingestion.jsonl
// Format: { id, stream_id: "system-media-ingestion", stream_type: "media",
//           file_path, mime_type, file_name, file_size,
//           context: { last_3_messages, session_key, timestamp } }
```

**New workflow:** `MediaIngestionWorkflow` in alfred-learn.

```python
# Per-file processing, spawned by EventProcessor when stream_type == "media"
# 1. Detect file type (Python — deterministic)
# 2. If audio → call Clerk to transcribe/summarize
# 3. If PDF/document → call Clerk to extract text + classify
# 4. If image → call Clerk to describe + extract text (OCR)
# 5. Classify: ingestion | braindump | task | conversation
# 6. For braindumps → topic-splitting extraction (Fix 2)
# 7. Write vault records (task, note, event, input)
# 8. Extract entities
```

---

## Fix 2: Braindump Extraction

When the Clerk classifies content as "braindump" (long, single-speaker, >2min equivalent in word count, no active session), the EventProcessor triggers a deeper extraction:

```python
@activity.defn
async def extract_braindump(content: str, metadata: dict) -> dict:
    """Deep extraction for braindumps — topic splitting + thorough analysis."""
    # Clerk prompt:
    # "This is a braindump — a long, stream-of-consciousness input.
    #  Split it into discrete topics. For each topic:
    #  - title
    #  - type: task | idea | decision | observation | question
    #  - summary
    #  - action_items (if any)
    #  - entities mentioned
    #  - related projects/processes (if identifiable)
    #  Return as JSON array of topics."
    
    # Each topic becomes its own vault record (task, note, or event)
    # All linked back to the source input record
```

Detection heuristic (Python, deterministic):
- Word count > 500 (equivalent to ~2 min speech)
- Single sender/speaker
- No back-and-forth pattern (no alternating user/assistant)
- Not part of an active conversation session

---

## Fix 3: `alfred_instructions` Watcher

The LearningWorkflow must treat `alfred_instructions` exactly like NeoTerra's `ken_instructions`:

1. **5-minute sweep** of recently modified vault records for `alfred_instructions` field changes
2. When detected, TWO things happen simultaneously:
   - **Create observation record** (the routing/handling preference is captured for learning)
   - **Trigger execution** — spawn a Clerk to interpret and execute the instructions

```python
# In LearningWorkflow.run():
# Entry Point B — alfred_instructions watcher
hints = await workflow.execute_activity(
    scan_alfred_instructions,  # renamed from scan_routing_hints
    start_to_close_timeout=timedelta(seconds=30),
)

for hint in hints:
    # Create observation (learning)
    observation = await workflow.execute_activity(
        clerk_extract_instruction_observation, args=[hint],
    )
    await workflow.execute_activity(
        write_observation_record, args=[observation],
    )
    # Execute the instructions (action)
    await workflow.execute_activity(
        execute_alfred_instructions, args=[hint],
    )
```

The `execute_alfred_instructions` activity spawns a Clerk with full context (the task record + instructions + related records) and the Clerk produces an execution plan. If the plan involves vault changes, they're validated by Python before writing.

---

## Fix 4: Rich Observation Schema (match NeoTerra cognition)

```yaml
---
type: observation
created: 2026-03-15T10:30:00
status: unprocessed
# Input context
input_ref: "[[task/2026/03/15/deploy-learning-engine.md]]"  # wikilink to source
input_type: email
input_source: gmail
# Routing decision (structured, not flat string)
routing_decision:
  destination: "[[project/Alfred Black Infrastructure]]"
  process: "deployment"
  assigned_to: "[[person/david-szabo-stuban]]"
# Reasoning
reasoning: "Task about deploying containers — infrastructure work, assigned to David as ops lead"
considered_alternatives:
  - "Could be project/NeoTerra — rejected because alfred-learn is Alfred Black specific"
# Signals for matching
signals:
  domain_patterns: []
  keyword_patterns: ["deploy", "docker", "learning-engine", "tenant", "bootstrap"]
  input_types: ["conversation"]
  attachment_patterns: []
# Provenance
confidence: human
routed_by: user
source: chat  # chat | alfred_instructions | dashboard | manual
source_session: "[[session/2026/03/15/afternoon-build-sprint.md]]"
created_by: "[[person/david-szabo-stuban]]"
tags: [deploy, infrastructure, alfred-learn]
---
```

---

## Fix 5: Rich Instinct Schema (match NeoTerra skill)

```yaml
---
type: instinct
name: Alfred Black Infrastructure Tasks
status: active
description: "Tasks related to deploying, configuring, or maintaining Alfred Black tenant infrastructure."
# Input patterns (structured, not flat)
input_patterns:
  sender_domains: []
  subject_keywords: ["deploy", "docker", "alfred-ctrl", "alfred-saas", "tenant", "bootstrap", "container"]
  attachment_types: []
  input_types: ["conversation", "webhook"]
# Routing rule (structured, supports dynamic resolution)
routing_rule:
  destination_type: project  # project | person | process | hold
  destination: "[[project/Alfred Black Infrastructure]]"
  destination_resolver: null  # or: "match entity to project via person→org→project relationship"
  process: "deployment"
  default_assignee: "[[person/david-szabo-stuban]]"
# Stats
confidence_score: 0.88
observation_count: 15
observations:
  - "[[observation/2026/03/02/deploy-learning-engine-routing.md]]"
  - "[[observation/2026/03/05/bootstrap-tenant-routing.md]]"
last_reflection: 2026-03-08
# Matching config
matching_weights:
  domain: 0.30
  keywords: 0.30
  input_type: 0.15
  attachment: 0.15
  tags: 0.10
discretion_threshold: 0.85
# Lifecycle
created: 2026-03-03
updated: 2026-03-08
tags: [infrastructure, deployment, docker]
---

## Routing Logic
Tasks mentioning Alfred Black infrastructure keywords (deploy, docker, tenant management)
route to the infrastructure project, assigned to David as the ops lead.

## Exceptions
- Security-related infrastructure tasks escalate to human review
- Tasks involving billing/payment infrastructure route to finance instead
```

---

## Fix 6: Session Tracking Redesign — Rolling 5-Minute Windows

Replace the retrospective boundary detection with a rolling state machine.

**Schedule:** `al-session-tracker` — every 5 minutes (unchanged interval, new logic)

**State:** Maintains a `current_session` state file at `/mnt/encrypted/alfred/session-state.json`:
```json
{
  "current_session": {
    "id": "session/2026/03/02/afternoon-build-sprint.md",
    "started": "2026-03-02T14:00:00",
    "last_activity": "2026-03-02T14:45:00",
    "topic_summary": "Building and deploying alfred-learn",
    "records": ["task/2026/03/02/deploy-learning-engine.md", ...],
    "record_count": 5
  }
}
```

**Flow every 5 minutes:**

```
1. Check: any new vault records in the last 5 minutes?
   
   NO → Mark current session as IDLE
        If idle for >30 min → close session (status: "paused")
        If idle for >2h → close session (status: "finished")
   
   YES →
   
2. Is there a current open session?
   
   NO → Create new session. Assign new records to it.
   
   YES →
   
3. Load current session summary + new records.
   Ask Clerk: "Is this new activity about the same topic as the current session?"
   
   SAME TOPIC → Append records to current session. Update last_activity + topic_summary.
   
   DIFFERENT TOPIC →
     a. Close current session:
        - Set status: "paused" (if user is still active) or "finished" (if gap > 30min)
        - Ask Clerk: "Match this session to relevant vault projects, people, entities"
        - Write session wikilinks: project, participants, entities
        - Write session summary
     b. Create new session with the new records
     c. Update session state file
```

**Session record on close:**
```yaml
---
type: session
name: 2026-03-02 Afternoon Build Sprint
status: finished  # active | paused | finished
started: 2026-03-02T14:00:00
ended: 2026-03-02T17:30:00
last_activity: 2026-03-02T17:25:00
duration_minutes: 210
record_count: 12
project: "[[project/Alfred Black Infrastructure]]"
participants:
  - "[[person/david-szabo-stuban]]"
entities:
  - "[[org/alfred-black]]"
tags: [deploy, infrastructure, learning-engine]
---

## Summary
Built and deployed the Alfred Learn container across all 3 tenant instances.
Created Intuition dashboard, Tasks dashboard. Fixed multiple deployment issues.

## Records
- [[task/2026/03/02/deploy-learning-engine.md]]
- [[task/2026/03/02/fix-bootstrap-script.md]]
- ...

## Outcome
All tenant instances running alfred-learn. Dashboard live at alfred.black/dashboard/intuition.
```

This gives you a proper activity log throughout the day. By 6pm, you have a timeline of sessions with projects, participants, and summaries.

---

## Fix 7: Daily Digest → Interactive EOD (match NeoTerra UTS)

The DailyDigestWorkflow should:

1. Compile the day's sessions, tasks, events
2. Identify open tasks carried forward
3. Identify orphan records (not assigned to any session)
4. **Send an interactive prompt to the user via the main Alfred agent:**

```
"Good evening, sir. Here's today's summary:

📋 Sessions: 5 (3 finished, 1 paused, 1 idle)
✅ Tasks completed: 3
🔄 Tasks open: 4
⚠️ 2 records unassigned to any session

Open tasks carrying forward:
1. Fix bootstrap script quoting
2. Add media ingestion hook

Anything to close out or reassign before end of day?"
```

5. Write the digest to vault regardless of response
6. If user responds, capture any routing/closing decisions as observations

**Implementation:** The workflow calls the OpenClaw gateway to send a message to the main agent's session, not just write a file.

---

## Fix 8: Vault Worker Integration

Alfred Learn must read from vault workers' output:

**Distiller integration:**
- When Reflection runs nightly, it reads `distiller_learnings` and `distiller_signals` from recently completed tasks
- These become additional signal data for instinct refinement
- A completed task with `distiller_learnings: ["invoices from @acme always go to project X"]` strengthens the relevant instinct

**Janitor integration:**
- When the janitor flags structural issues (`janitor_note`), the EventProcessor should note these as quality signals
- Tasks with janitor warnings get lower confidence in auto-routing (need human review)

```python
# In ReflectionWorkflow:
# 1. Read observations (existing)
# 2. Read distiller_learnings from completed tasks in last 24h (NEW)
# 3. Read janitor flags from recent records (NEW)
# 4. Feed all three into Clerk reflection prompt
```

---

## Fix 9: Hook-based architecture (confirmation)

Three hooks, clean separation:

| Hook | Trigger | Writes to | Purpose |
|------|---------|-----------|---------|
| `alfred-inbox` | 10 turns or 5min idle | `streams/system-openclaw-sessions.jsonl` + `vault/inbox/` | Chat buffer → StreamEvent |
| `alfred-learn-observer` | Routing language in assistant response | `observation-queue.jsonl` | Routing decisions → Observations |
| `alfred-learn-media` | Media file in session (image/PDF/audio/video) | `streams/system-media-ingestion.jsonl` | File uploads → Media StreamEvent |

All three exist in alfred-ctrl's hooks directory. All push to JSONL files. All consumed by alfred-learn's Temporal workflows.

---

## Build Order

1. Update observation schema (validators + templates) — Fix 4
2. Update instinct schema (validators + templates) — Fix 5
3. Rewrite SessionTracker as rolling 5-min state machine — Fix 6
4. Add braindump extraction activity — Fix 2
5. Add `alfred_instructions` watcher to LearningWorkflow — Fix 3
6. Add media ingestion hook to alfred-ctrl — Fix 1
7. Add MediaIngestionWorkflow — Fix 1
8. Rewrite DailyDigest as interactive EOD — Fix 7
9. Add vault worker integration to Reflection — Fix 8
10. Update Clerk prompts for richer observation/instinct schemas
11. Update tests
