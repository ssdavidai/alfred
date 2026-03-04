---
name: alfred-learn-observer
type: message
description: Observes routing patterns in Alfred's responses for the learning engine
enabled: true
---

# alfred-learn-observer

Watches for routing language in Alfred's assistant messages. When detected, writes a structured observation request to the observation queue JSONL file.

## Detection Patterns

- "filed under", "moved to", "categorized as", "routed to"
- "assigned to project", "belongs in", "putting this in"
- "this is a [type] for/about/from"
- vault write confirmations (created/wrote/saved ... vault/task/event/note/person)

## Queue File

`/mnt/encrypted/alfred/observation-queue.jsonl`

Each line is a JSON object:
```json
{
  "id": "uuid",
  "timestamp": "ISO-8601",
  "session_key": "session-id",
  "user_input": "what the user said",
  "alfred_response": "what Alfred said (containing routing language)",
  "source": "chat"
}
```

## Consumed By

`LearningWorkflow` (Workflow 4) — reads and clears the queue every 5 minutes.
