---
name: alfred-channel-attachments
description: How to read files (audio, documents, images) that Sir sent to Alfred on any channel — Slack file uploads, Telegram voice memos, MMS audio, generic URLs. Converts file references into transcripts + vault records so Alfred doesn't say "I don't see your file".
triggers: file, attachment, audio, voice memo, voice note, recording, transcribe, slack file, telegram voice, photo, image, document, pdf, uploaded
---

# Reading Attachments From Any Channel

Sir sends files to Alfred across several channels — Slack uploads, Telegram voice memos, SMS/MMS media, email attachments, and direct drops on the dashboard. Every one of those files gets bytes into the vault; your job is to **fetch them inline** whenever the conversation references an uploaded file, so you can actually respond to what's inside them.

If you ever catch yourself saying "I don't see the file you uploaded" — you forgot this skill. Call the endpoint.

## The one endpoint

```
self({
  endpoint: "/api/v1/channels/attachment/fetch",
  method: "POST",
  body: {
    source: "slack" | "telegram" | "mms" | "url",
    file_ref: "<channel-specific id>",   // for slack/telegram
    file_url: "<direct url>",            // for mms/url
    file_name: "<optional hint>",        // optional
    mime_type: "<optional hint>"         // optional
  }
})
```

Returns:

```json
{
  "ok": true,
  "source": "slack",
  "file_name": "voice-memo-2026-04-23.m4a",
  "mime_type": "audio/m4a",
  "size": 482317,
  "vault_path": "inbox/voice-memo-2026-04-23.m4a",
  "transcript": "Hey Alfred, I wanted to follow up on the Example Bank meeting...",
  "text": "(same as transcript, or text content for docs)"
}
```

You get:
- **`transcript`** — ready-to-use transcript for audio (Whisper via Groq, ~3s round trip).
- **`text`** — inline content for text documents (up to 30KB).
- **`vault_path`** — where it lives. The async MediaIngestionWorkflow will build a full vault record too (so search + surveyor linking pick it up later), but you don't have to wait.

## When to call it

- Sir's message says "here's the recording" or "I just sent you audio" or "take a look at this PDF"
- Slack message shows a `file_share` event or your session context mentions `files[]`
- Telegram message shows a voice memo icon or `voice/audio` in context
- Twilio SMS payload includes `MediaUrl0`
- Someone pastes a raw URL to a file (e.g. Dropbox, Google Drive public link, pre-signed S3)

Always call it **before** replying. Even if you're not sure — err on the side of fetching. It's cheap.

## Per-channel specifics

### Slack

```
self({ endpoint: "/api/v1/channels/attachment/fetch", method: "POST",
  body: { source: "slack", file_ref: "F0ABC123" } })
```

`file_ref` is Slack's file ID (starts with `F`). If your session context has `files[].id`, use that. Downloads via the Slack Composio OAuth credential — no extra auth needed from you.

### Telegram

```
self({ endpoint: "/api/v1/channels/attachment/fetch", method: "POST",
  body: { source: "telegram", file_ref: "<file_id>" } })
```

Telegram's `file_id` is a long opaque string like `AAQB...`. Works for voice memos (`voice.file_id`), audio files (`audio.file_id`), documents (`document.file_id`), photos (`photo[-1].file_id` = largest).

### MMS (Twilio)

```
self({ endpoint: "/api/v1/channels/attachment/fetch", method: "POST",
  body: { source: "mms", file_url: "<MediaUrl0 from Twilio>" } })
```

### Generic URL

```
self({ endpoint: "/api/v1/channels/attachment/fetch", method: "POST",
  body: { source: "url", file_url: "https://..." } })
```

Use when Sir pastes a pre-signed URL or a public Dropbox/Drive link.

## Don't double-handle email

Email attachments have their own endpoint — `alfred-email-channel/SKILL.md` already covers that flow using `/api/v1/email/attachment/<message_id>/<attachment_id>`. Don't route email attachments through this skill.

## What happens async

Every call emits a `stream_type: media` event to `system-media-ingestion.jsonl`. The `MediaIngestionWorkflow` will:
- Build a permanent vault record for the file (so search can find it tomorrow)
- Run the full clerk enrichment pass on the content (entities, topic_tags, related_matters)
- Let the surveyor embed + structurally link it next tick

You don't need to wait for this. You already have the content from the endpoint's synchronous response. But it means asking "find the transcript of the voice memo Sir sent yesterday" works later even if you didn't save it explicitly.

## Error handling

If the endpoint returns `ok: false`:
- `resolve failed` — bad file_ref or the channel's connected account is broken. Tell Sir the file ref wasn't resolvable; don't pretend you read it.
- `download failed` — network issue or auth expired. Try once more; if it fails again, tell Sir.
- `GROQ_API_KEY not set` — will just skip transcription silently and return the file_name + vault_path. You can still tell Sir the file was saved, but you don't have the content to discuss.

Never invent content. If you didn't get a transcript, don't pretend you did.
