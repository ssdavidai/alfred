---
name: alfred-channel-delivery
description: How to deliver a message to Sir on a specific channel (Slack DM, Telegram, SMS, voice call, email) using cached contact IDs from KNOWN_CONTACTS.md instead of walking workspace directories. Read this whenever Sir says "send/text/call/email me…".
triggers: deliver, send to me, text me, slack me, telegram me, dm me, call me, email me, ping me, post to slack, send sms, drop me an email, U08, D0AQ
---

# Channel Delivery — Use the Cached IDs

When Sir says **"send this to me on Slack"**, **"text me when it's done"**, **"drop me an email"**, **"call me at 5"**, your job is to put a message in front of him on the channel he named. The wrong way is to walk Slack's user directory looking for "David Szabó-Stubán", page through Telegram updates trying to find his chat, or scan email contacts. That path costs 25+ turns and usually fails.

The right way: **read `KNOWN_CONTACTS.md` once, then call `self()` with the cached ID.**

## Step 1 — Load the contact

Every tenant ships with `~/.openclaw/workspace/KNOWN_CONTACTS.md` containing Sir's known channel identifiers. Read it from the qmd memory backend or directly:

```
self({ endpoint: "/api/v1/admin/workspace/KNOWN_CONTACTS.md" })
```

Returns `{ filename, content }` where `content` is the markdown. The bottom of the file has a `Machine-readable` JSON block — parse that for programmatic use. Schema:

```json
{
  "sir": {
    "displayName": "...",
    "email": "...",
    "channels": {
      "slack":      { "userId": "U…", "dmChannelId": "D…" },
      "telegram":   { "chatId": "…", "botAccount": "default" },
      "agentmail":  { "address": "…@…" },
      "agentphone": { "e164": "+…" }
    }
  }
}
```

If a channel sub-object is missing or its values are empty strings, that channel hasn't been paired yet — see "Fallback: pair-then-cache" below.

## Step 2 — Send via `/api/v1/notifications` (preferred)

The unified delivery endpoint dispatches through OpenClaw's `message.send` tool to the right channel adapter. Pass the cached `to` value explicitly so the endpoint doesn't have to guess.

### Slack DM

```
self({
  endpoint: "/api/v1/notifications",
  method: "POST",
  body: {
    channel: "slack",
    to: "<knownContacts.sir.channels.slack.dmChannelId>",   // e.g. "D0AQYNQCJ5A"
    message: "Sir, the weekly report is ready.",
    urgency: "normal"
  }
})
```

The `dmChannelId` (starts with `D`) is what `chat.postMessage` wants. Do NOT pass the `userId` (`U…`) — that requires Slack to open a new DM channel and may fail if the bot doesn't have `im:write` for an unpaired user.

### Telegram

```
self({
  endpoint: "/api/v1/notifications",
  method: "POST",
  body: {
    channel: "telegram",
    to: "<knownContacts.sir.channels.telegram.chatId>",     // e.g. "432094090"
    message: "Sir — quick heads-up: …",
    urgency: "normal"
  }
})
```

The `chatId` is the integer Telegram returns from `getUpdates`, but stringified.

### Email

Email goes through the dedicated AgentMail endpoints, not `/notifications`. See the `alfred-email-channel` skill for reply/forward shapes. To send a fresh outbound:

```
self({
  endpoint: "/api/v1/email/send",
  method: "POST",
  body: {
    to: ["<knownContacts.sir.channels.agentmail.address>"],   // or .email if different
    subject: "Weekly report",
    text: "Sir, please find this week's summary below…",
    // html / attachments optional
  }
})
```

### SMS

```
self({
  endpoint: "/api/v1/phone/sms",
  method: "POST",
  body: {
    to: "<knownContacts.sir.channels.agentphone.e164>",     // e.g. "+17174238259"
    body: "Sir — heads-up, your two o'clock just moved."
  }
})
```

### Voice call (TTS one-shot)

```
self({
  endpoint: "/api/v1/phone/call",
  method: "POST",
  body: {
    to: "<knownContacts.sir.channels.agentphone.e164>",
    message: "Sir, your two o'clock is starting in five minutes.",
    mode: "tts"      // or "realtime" to open a live Voice Bridge session
  }
})
```

## Fallback: pair-then-cache

If the cached value for a channel is missing/empty AND Sir explicitly asks for that channel:

1. **Slack**: ask Sir to send you a one-line DM (`"hi alfred"`). When the inbound arrives, the session payload contains `chat_id: "user:U..."` and the channel ID. Capture both.
2. **Telegram**: ask Sir to send `/start` (or any message) to the bot. The next inbound contains `from.id` (= chat ID).
3. **AgentMail**: usually known at provision time. If empty, read `process.env.AGENTMAIL_INBOX_ADDRESS` via `self({ endpoint: "/api/v1/admin/env/AGENTMAIL_INBOX_ADDRESS" })` if available, or ask Sir.
4. **AgentPhone**: read `self({ endpoint: "/api/v1/phone/config" })` — returns `{ phoneNumber: "+1…" }` if a number was provisioned.

Once you have the value, **persist it back to `KNOWN_CONTACTS.md`** so the next delivery is instant:

```
self({
  endpoint: "/api/v1/admin/workspace/KNOWN_CONTACTS.md",
  method: "PUT",
  body: { content: "<full updated markdown>" }
})
```

Read the file first, edit the relevant cell + the JSON block, then PUT the whole new content. Keep the prose sections unchanged — only the channel table and the `Machine-readable` JSON should change.

## Don't

- **Don't search Slack's user directory.** No `users.list`, no fuzzy name matching on `"David"`. The cached `dmChannelId` is the answer.
- **Don't assume `auto` channel selection.** When Sir names a channel, pass it explicitly (`channel: "slack"`). Auto-pick is for system-initiated notifications, not user requests.
- **Don't invent IDs.** If `KNOWN_CONTACTS.md` has an empty value, do the pair-then-cache flow above. Never fill in a guess.
- **Don't post the same message on two channels** unless Sir asked you to. Pick one.

## A sanity-check ritual

Before you call `/api/v1/notifications`, mentally check:

> "Did I read `KNOWN_CONTACTS.md` in this turn?"
> "Is my `to` value copied verbatim from the file (or derived via pair-then-cache)?"
> "Am I passing `channel:` explicitly?"

If yes to all three, send.
