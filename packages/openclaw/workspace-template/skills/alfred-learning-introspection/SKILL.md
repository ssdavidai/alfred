---
name: alfred-learning-introspection
description: Look inside Alfred's own learning system — what observations have been recorded, what instincts have been learned, what reflections have been synthesized, and what's queued. Use when Sir asks questions like "what have you noticed about me lately?" or "why are you routing X emails to urgent?" or "show me what you've learned this week".
version: "1.0"
metadata:
  openclaw:
    emoji: "🧠"
---

# Alfred — Learning Introspection

The learning system is Alfred's self-improvement loop. It has five parts that all live in the vault and all emit records the `ctrl_learning_*` tools can read:

1. **observation** — atomic behavioral signals extracted from streams. Example: "Sir replies to emails from retool-email.com within 2 hours on weekdays".
2. **instinct** — learned routing rules derived from many observations. Example: "Route Retool community emails to the inner-circle priority queue". Each instinct has a `confidence_score`, a `discretion_threshold`, and a `matching_weights` block that determines how it fires.
3. **reflection** — weekly synthesis of patterns across many instincts and observations, produced by the reflection workflow. Example: "Sir's afternoon peak email window has shifted earlier by ~90 min since the second baby news".
4. **sessions** — the learning system's tracking of individual conversation sessions (who Sir talked to, when, duration, summary).
5. **queue** — items waiting for the next learning/reflection/judgment workflow cycle.

## Tools available to you

### Status

- **`ctrl_learning_status`** — high-level counts and workflow state. Returns observations_count, instincts_count, reflections_count, last_learning_run, last_reflection_run, last_judgment_run, enabled (bool).
- **`ctrl_learning_queue`** — items currently waiting to be processed. Useful for diagnosing "why haven't I seen a new reflection in a week".

### Read

- **`ctrl_learning_observations`** — list observations. Filterable via query params (date range, tags, source stream).
- **`ctrl_learning_instincts`** — list all instincts with their frontmatter: name, description, confidence_score, discretion_threshold, observation_count, status (`active`/`proposed`/`paused`), tags.
- **`ctrl_learning_reflections`** — list reflections (weekly synthesis records).
- **`ctrl_learning_sessions`** — list tracked conversation sessions.

### Act (use with caution)

- **`ctrl_learning_enable`** — re-enable the learning system if it was disabled.
- **`ctrl_learning_disable`** — turn the learning system off. Only if Sir explicitly asks (e.g., during a debugging session or if he's about to do something he doesn't want Alfred to learn from).

## Related tools worth knowing

- **`ctrl_vault_list type=observation`** / **`ctrl_vault_list type=instinct`** / **`ctrl_vault_list type=reflection`** — these are the same records, but pulled directly from the vault filesystem. Useful when the learning API is slow or unavailable.
- **`ctrl_workers_status`** — returns status of curator/janitor/distiller/surveyor daemons. The curator feeds observations; if it's dead, new observations stop flowing.

## Key concepts for answering Sir

### Instinct lifecycle

1. **proposed** — a new candidate instinct the learning system has inferred but not yet activated. Sir should review and either accept (→ active) or discard.
2. **active** — firing on observations. Contributing to routing decisions.
3. **paused** — kept for reference but not firing. Can be reactivated.

### Discretion threshold

Each instinct has a `discretion_threshold` (0.0–1.0). If the judgment step's confidence about applying this instinct is below the threshold, it skips the action. Higher threshold = more conservative. Sir can tune this.

### observation_count

Counts how many observations have matched this instinct since creation. A high count (e.g., 369) means the instinct is firing frequently and should be treated as load-bearing. A low count (e.g., 0) means it's not being hit — either the pattern never occurs, or the matching_weights are wrong.

## Good behavior

1. **Don't expose raw frontmatter to Sir.** When he asks "what have you learned", translate instincts into plain English with their observation counts and confidence scores, not raw YAML.
2. **Surface the "proposed" instincts first.** These are the ones waiting for Sir's review — highlight them when he asks for a learning digest.
3. **If learning is disabled, say so.** Don't pretend it's running if `ctrl_learning_status` says `enabled: false`.
4. **Cross-reference with observation counts.** An instinct with `observation_count: 0` that's been active for weeks is a dead instinct — flag it for review.

## Examples

**Sir: "What have you learned about me lately?"**
→ `ctrl_learning_status` → `ctrl_learning_reflections` latest 1 → `ctrl_learning_instincts` filter `status=proposed` → summarize.

**Sir: "Why are you routing Stripe emails to urgent?"**
→ `ctrl_learning_instincts` → find the one with `stripe` in name or description → read its matching_weights + sender_domains + subject_keywords → explain in plain English what triggers it.

**Sir: "Show me the instincts that haven't fired in a while."**
→ `ctrl_learning_instincts` → filter `status=active` with low `observation_count` relative to age → list with a suggestion to review.

**Sir: "Stop learning from my emails for the next hour."**
→ confirm intent → `ctrl_learning_disable` → set a reminder to re-enable after an hour.
