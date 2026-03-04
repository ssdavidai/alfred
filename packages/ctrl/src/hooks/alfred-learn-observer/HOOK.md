---
name: alfred-learn-observer
description: "Watches assistant messages for routing/classification patterns and writes observation queue entries for learning feedback"
homepage: https://alfred.black
metadata:
  {
    "openclaw":
      {
        "emoji": "🔭",
        "events": ["message:received", "message:sent"],
        "requires":
          {
            "filesystem": ["/mnt/encrypted/alfred/"],
          },
      },
  }
---

# Alfred Learn Observer Hook

Monitors assistant messages for signs of routing or classification
activity (e.g. "filed under tasks", "categorized as a person record")
and writes structured observation entries to a JSONL queue for
downstream learning pipeline consumption.

## Detection patterns

The hook matches assistant messages against three regex patterns:

1. **Filing/routing verbs** — `filed under`, `moved to`, `categorized as`, `routed to`, `assigned to`, etc.
2. **Classification language** — `belongs in`, `this is a note for`, `this is an event about`, etc.
3. **Vault write actions** — `created vault/`, `wrote task/`, `saved person/`, etc.

## What it writes

Each matched observation is appended as a JSON line to
`/mnt/encrypted/alfred/observation-queue.jsonl`:

```json
{
  "id": "uuid",
  "timestamp": "ISO-8601",
  "session_key": "agent:main:...",
  "user_input": "the last user message in this session",
  "alfred_response": "the assistant message that matched",
  "source": "chat"
}
```

## Configuration

In `openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "alfred-learn-observer": {
          "enabled": true
        }
      }
    }
  }
}
```
