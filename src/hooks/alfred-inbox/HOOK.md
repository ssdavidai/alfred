---
name: alfred-inbox
description: "Buffers OpenClaw chat messages and flushes conversations to the vault inbox for curator processing"
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
batched conversation transcripts to the vault inbox directory.

## Flush strategy

- After **10 conversation turns** (user + assistant pairs), OR
- After **5 minutes of silence** since the last message

Each flush writes the full buffered conversation as a Markdown file with
YAML frontmatter. The curator then processes it into a vault conversation
record.

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
