---
name: alfred-inbox
description: "Buffers OpenClaw chat messages and flushes conversations as stream events for the alfred-learn pipeline"
homepage: https://alfred.black
metadata:
  {
    "openclaw":
      {
        "emoji": "📥",
        "events": ["message:received", "message:sent"],
        "requires":
          {
            "config": ["workspace.dir"],
          },
      },
  }
---

# Alfred Inbox Hook

Captures user and assistant messages from the `main` agent and writes
batched conversation transcripts as stream events to the
`system-openclaw-sessions` stream.

The EventProcessor → Judgment → Curator pipeline then classifies, routes,
and structures these conversations into vault records automatically.

## Flush strategy

- After **10 conversation turns** (user + assistant pairs), OR
- After **5 minutes of silence** since the last message

Each flush writes a stream event containing the buffered messages.
The alfred-learn pipeline processes it into structured vault records.

## Configuration

In `openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "alfred-inbox": {
          "enabled": true,
          "flushTurns": 10,
          "flushIdleMs": 300000
        }
      }
    }
  }
}
```
