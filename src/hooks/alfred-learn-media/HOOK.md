---
name: alfred-learn-media
description: "Detects media/file attachments in OpenClaw sessions and writes StreamEvents to the media ingestion stream for the learning engine"
homepage: https://alfred.black
metadata:
  {
    "openclaw":
      {
        "emoji": "🎞️",
        "events": ["message:received", "message:sent"],
        "requires":
          {
            "config": ["workspace.dir"],
          },
      },
  }
---

# Alfred Learn Media Hook

Watches for media and file attachments in `main` agent message events.
When a supported file is detected, writes a StreamEvent to the
`system-media-ingestion` JSONL stream for processing by the
`MediaIngestionWorkflow` in alfred-learn.

## Supported file types

| Category  | Extensions                         |
|-----------|------------------------------------|
| Images    | `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` |
| PDFs      | `.pdf`                             |
| Audio     | `.mp3`, `.wav`, `.ogg`, `.m4a`, `.webm`  |
| Video     | `.mp4`, `.webm`, `.mov`           |
| Documents | `.doc`, `.docx`, `.xlsx`, `.csv`   |

## Trigger

Any `message` event (received or sent) that includes a `files` or
`attachments` array with at least one file matching a supported extension
or MIME type.

## Output

Appends one StreamEvent per detected file to:

```
/mnt/encrypted/alfred/streams/system-media-ingestion.jsonl
```

### StreamEvent format

```json
{
  "id": "<uuid>",
  "stream_id": "system-media-ingestion",
  "stream_type": "media",
  "received_at": "<ISO timestamp>",
  "source_ref": "<sessionKey>:<file_name>:<epoch_ms>",
  "raw": {
    "file_path": "/path/to/file",
    "file_name": "document.pdf",
    "mime_type": "application/pdf",
    "file_size": 102400,
    "session_key": "agent:main:abc123",
    "context": {
      "last_3_messages": [ ... ],
      "timestamp": "<ISO timestamp>"
    }
  },
  "summary": "Media file: document.pdf (application/pdf)"
}
```

## Configuration

In `openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "alfred-learn-media": {
          "enabled": true
        }
      }
    }
  }
}
```
