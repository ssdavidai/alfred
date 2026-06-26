---
name: alfred-learning-introspection
description: Look inside Alfred's own learning system — what observations have been recorded, what instincts have been learned, what reflections have been synthesized, and what's queued. Use when Sir asks questions like "what have you noticed about me lately?" or "why are you routing X emails to urgent?" or "show me what you've learned this week".
version: "1.0"
metadata:
  openclaw:
    emoji: "🧠"
---

# Alfred — Learning Introspection

The learning system is Alfred's self-improvement loop. It has five parts that all live in the vault and are accessible via the `self` MCP tool:

1. **observation** — atomic behavioral signals extracted from streams. Example: "Sir replies to emails from retool-email.com within 2 hours on weekdays".
2. **instinct** — learned routing rules derived from many observations. Example: "Route Acme Tools community emails to the inner-circle priority queue". Each instinct has a `confidence_score`, a `discretion_threshold`, and a `matching_weights` block that determines how it fires.
3. **reflection** — weekly synthesis of patterns across many instincts and observations, produced by the reflection workflow. Example: "Sir's afternoon peak email window has shifted earlier by ~90 min since the second baby news".
4. **sessions** — the learning system's tracking of individual conversation sessions (who Sir talked to, when, duration, summary).
5. **queue** — items waiting for the next learning/reflection/signal-routing workflow cycle.

## Endpoints

### Status

- **`self endpoint="/api/v1/learning/status"`** — high-level counts and workflow state. Returns observations_count, instincts_count, reflections_count, last run times, enabled (bool).
- **`self endpoint="/api/v1/learning/queue"`** — items waiting to be processed. Useful for diagnosing "why haven't I seen a new reflection in a week".

### Read

- **`self endpoint="/api/v1/learning/observations"`** — list observations.
- **`self endpoint="/api/v1/learning/instincts"`** — list all instincts with frontmatter: name, description, confidence_score, discretion_threshold, observation_count, status.
- **`self endpoint="/api/v1/learning/reflections"`** — list reflections (weekly synthesis records).
- **`self endpoint="/api/v1/learning/sessions"`** — list tracked conversation sessions.

### Act (use with caution)

- **`self endpoint="/api/v1/learning/enable" method="POST"`** — re-enable the learning system if disabled.
- **`self endpoint="/api/v1/learning/disable" method="POST"`** — turn learning off. Only if Sir explicitly asks.

### Related

- **`self endpoint="/api/v1/vault/list/observation"`** / `instinct` / `reflection` — same records via the vault API. Useful as a fallback.
- **`self endpoint="/api/v1/workers/status"`** — curator/janitor/distiller/surveyor status.

## Key concepts for answering Sir

### Instinct lifecycle

1. **proposed** — a new candidate instinct the learning system has inferred but not yet activated. Sir should review and either accept (→ active) or discard.
2. **active** — firing on observations. Contributing to routing decisions.
3. **paused** — kept for reference but not firing. Can be reactivated.

### Discretion threshold

Each instinct has a `discretion_threshold` (0.0–1.0). If the signal router's discretion gate confidence about applying this instinct is below the threshold, it skips the action. Higher threshold = more conservative. Sir can tune this.

### observation_count

Counts how many observations have matched this instinct since creation. A high count (e.g., 369) means the instinct is firing frequently and should be treated as load-bearing. A low count (e.g., 0) means it's not being hit — either the pattern never occurs, or the matching_weights are wrong.

## Good behavior

1. **Don't expose raw frontmatter to Sir.** When he asks "what have you learned", translate instincts into plain English with their observation counts and confidence scores, not raw YAML.
2. **Surface the "proposed" instincts first.** These are the ones waiting for Sir's review — highlight them when he asks for a learning digest.
3. **If learning is disabled, say so.** Don't pretend it's running if `self endpoint="/api/v1/learning/status"` says `enabled: false`.
4. **Cross-reference with observation counts.** An instinct with `observation_count: 0` that's been active for weeks is a dead instinct — flag it for review.

## Examples

**Sir: "What have you learned about me lately?"**
→ `self endpoint="/api/v1/learning/status"` → `self endpoint="/api/v1/learning/reflections"` latest 1 → `self endpoint="/api/v1/learning/instincts"` filter proposed → summarize.

**Sir: "Why are you routing Stripe emails to urgent?"**
→ `self endpoint="/api/v1/learning/instincts"` → find the one mentioning stripe → explain in plain English.

**Sir: "Show me the instincts that haven't fired in a while."**
→ `self endpoint="/api/v1/learning/instincts"` → filter active with low observation_count → suggest review.

**Sir: "Stop learning from my emails for the next hour."**
→ confirm intent → `self endpoint="/api/v1/learning/disable" method="POST"` → set a reminder to re-enable.
