---
name: alfred-connected-apps
description: Conversational management of Sir's Composio-connected third-party apps — list, connect (OAuth + API key), reconnect on expiry, disconnect, and inspect capabilities. Covers the full OAuth lifecycle including the 1h grace window after reconnect.
triggers: connected apps, reconnect, oauth expired, disconnect, integrations, what apps am I connected to, connect my, add my api key
version: "1.0"
metadata:
  openclaw:
    emoji: "🔌"
---

# Alfred Connected Apps

Sir manages his third-party app connections (Gmail, Calendar, Notion, GitHub, Slack, Clockify, …) through Composio. This skill teaches you to handle every conversational verb on that surface — list, connect, reconnect, disconnect, inspect — without fumbling the OAuth handshake or claiming an app is connected before Sir actually completes it.

All endpoints below live on this tenant's ctrl-api. Call them through the `self` MCP tool: `self({endpoint, method?, body?, query?})`. Never invent a `ctrl_*` tool name — those don't exist.

## 1. List connected apps

**Sir says:** "What apps am I connected to?" / "What's hooked up?" / "Show me my integrations."

```
self({ endpoint: "/api/v1/integrations" })
```

Response is a list of `{connection_id, toolkit, status, …}`. Group your reply by status so Sir sees the picture at a glance:

- **ACTIVE** — working. Speak by display name ("Gmail", "Google Calendar"), not the slug ("gmail", "googlecalendar").
- **INITIATED** — OAuth started but Sir hasn't completed it yet. Surface these and offer the link again if you still have it.
- **FAILED / EXPIRED** — needs reconnect. Offer to do it.

**Hard rule:** never list more than 10 connections in chat. If Sir has 30 apps connected, group by status and summarize counts.

## 2. Browse the catalog (1000+ available apps)

**Sir says:** "What integrations are available?" / "Can you add Linear?" / "Do you support Airtable?"

```
self({ endpoint: "/api/v1/integrations/catalog", query: { search: "linear" } })
```

The catalog has 1000+ entries. ALWAYS pass a `search` filter; never list everything. Cap conversational replies at 10 hits per turn.

## 3. OAuth connect

**Sir says:** "Connect my Notion." / "Hook up Linear."

```
self({
  endpoint: "/api/v1/integrations/connect",
  method: "POST",
  body: { toolkit_slug: "notion" },
})
```

Response includes `connect_url` (the OAuth link) + `connection_id` + `status: "INITIATED"`.

**Mandatory rules** (these matter — get them wrong once and Sir loses trust):

1. **Surface the URL verbatim.** Paste it into the reply exactly as Composio returned it. Do not shorten, hyperlink-wrap, or paraphrase it.
2. **Tell Sir to click it and complete the handshake.** "Click here, sign in to Notion, and approve. I'll see it land as ACTIVE."
3. **DO NOT claim it's connected.** Status is `INITIATED` until Sir finishes the OAuth dance. Saying "your Notion is now connected" before that is a lie. After Sir confirms (or after a polling pass, see §6), you may say so.

## 4. API-key connect (non-OAuth)

**Sir says:** "Add my Clockify API key: <key>" / "Here's my Tavily token: <key>"

```
self({
  endpoint: "/api/v1/integrations/connect-api-key",
  method: "POST",
  body: { toolkit_slug: "clockify", credential: "<key>", auth_scheme: "API_KEY" },
})
```

`auth_scheme` defaults to `API_KEY`; pass `BEARER_TOKEN` if the toolkit needs it (PostHog, some Slack flavors).

This goes straight to ACTIVE — there's no browser handshake. Confirm immediately: "Clockify connected, Sir. Anything you'd like me to pull right away?"

**Hard rules:**
- **Never echo the key back to Sir in your reply.** Audit logs capture chat. "Got it — Clockify is connected" is correct. "Got it, your key sk-abc123 is connected" is not.
- **Never log the key in a vault note**, session summary, or commit message. Composio holds the credential; you must not redistribute it.

## 5. Reconnect on OAuth expiry — the one-call flow (#635)

**Sir says:** "Reconnect Calendar — the OAuth expired." / "Notion looks dead, fix it." / "Gmail keeps 401-ing."

This is the most common breakage on the fleet (Gmail re-auth happens roughly every few weeks). Use the dedicated reconnect endpoint — do NOT chain `/connect` + `DELETE /:id` manually.

### Step A — find the connection_id

```
self({ endpoint: "/api/v1/integrations" })
```

Look for the toolkit Sir named (`gmail`, `googlecalendar`, `notion`, …) and grab its `connection_id`. If Sir didn't name the app but said "X isn't working", check recent logs/events:

```
self({ endpoint: "/api/v1/streams/events", query: { status: "error", limit: 20 } })
```

If you see repeated `401`/`403` against a Composio-backed stream, that toolkit is the culprit.

### Step B — call reconnect

```
self({
  endpoint: "/api/v1/integrations/ca_OldConnId/reconnect",
  method: "POST",
})
```

Response shape:

```json
{
  "old_connection_id": "ca_OldConnId",
  "new_connection_id": "ca_NewConnId",
  "new_connection_link": "https://composio.dev/oauth/...",
  "app": "googlecalendar",
  "expires_at": "2026-04-01T00:00:00Z",
  "cleanup_after_ms": 1745692800000,
  "grace_window_seconds": 3600,
  "instructions": "Send this link to Sir. After he completes the OAuth handshake..."
}
```

### Step C — deliver the link to Sir on his most-immediate channel

Use the `alfred-channel-delivery` skill (PR #642 / KNOWN_CONTACTS.md) to pick Sir's best reachable channel right now (active Slack DM thread, ongoing voice call, the email thread you're already in, etc.). Inline the URL verbatim — same rule as a fresh OAuth connect.

If you're already in a chat turn with Sir, just paste the URL into your reply. Don't fan out across channels.

### Step D — confirm ACTIVE before declaring success

After Sir completes the handshake (he'll usually say "done" or "fixed it"), verify:

```
self({ endpoint: "/api/v1/integrations/ca_NewConnId/capabilities" })
```

If status reads ACTIVE and you see a sensible action list, the new connection is healthy. Tell Sir: "Confirmed — Calendar's back. The old connection will be cleaned up in about an hour."

### Step E — DO NOT preemptively disconnect the old one

The old connection stays alive during the 1-hour grace window so:
- In-flight `composio_execute` calls keyed off the old id keep working until streams naturally migrate.
- If Sir abandons the OAuth handshake, he isn't left with NO connection at all.

A background reaper deletes the old connection 1 hour after the new one becomes ACTIVE. You don't need to do anything. If Sir explicitly asks "kill the old one now," you may call:

```
self({ endpoint: "/api/v1/integrations/reconnect-cleanup?force=1", method: "POST" })
```

Otherwise, leave it. The reaper handles it.

### Worked example

**Sir:** "Reconnect my Gmail — it stopped working this morning."

```
// 1. Find Gmail
self({ endpoint: "/api/v1/integrations" })
// → finds {connection_id: "ca_oldGmail", toolkit: "gmail", status: "EXPIRED"}

// 2. Reconnect
self({ endpoint: "/api/v1/integrations/ca_oldGmail/reconnect", method: "POST" })
// → {new_connection_link: "https://composio.dev/oauth/abc...", new_connection_id: "ca_newGmail", ...}
```

**Reply to Sir:**
> Sir — your Gmail OAuth has expired. Open this link, sign in to Google, and approve:
>
> `https://composio.dev/oauth/abc...`
>
> Once you're back, tell me "done" and I'll confirm. The old connection stays live for an hour as a fallback, then gets cleaned up automatically.

**After Sir confirms:**

```
self({ endpoint: "/api/v1/integrations/ca_newGmail/capabilities" })
// → {status: "ACTIVE", stream_actions: [...], tool_actions: [...]}
```

**Reply to Sir:**
> Confirmed — Gmail is back, Sir. I see the daily fetch is queued for the next pull. Nothing to do on your end.

## 6. Disconnect

**Sir says:** "Disconnect GitHub." / "Drop my Notion connection."

Before calling DELETE, **walk Sir through the blast radius**. The disconnect cascade removes:

- The Composio connected_account (credential gone — he'll need to re-OAuth to reconnect later).
- All stream configs backed by this connection (Gmail digests, Calendar pulls, GitHub PR streams).
- The associated Temporal schedules (no more periodic pulls).
- The skill file in `~/.openclaw/workspace/skills/alfred-composio-<toolkit>/` (you lose the per-app conversational hints).
- The toolkit's tool-prefix from `gateway.tools.allow` (no more `GMAIL_*` / `GOOGLECALENDAR_*` action calls).

If Sir has a daily chore reading from this stream, name it in your warning: "Disconnecting Gmail will stop your daily 6pm digest. Sure?"

```
self({
  endpoint: "/api/v1/integrations/ca_OldConnId",
  method: "DELETE",
})
```

Response lists what was actually cleaned up. If the response shows `gateway_restart_triggered: true`, openclaw will restart for ~40s. Tell Sir to expect a brief unresponsive window if he was about to ask something.

## 7. Inspect a connection

**Sir says:** "What can my Notion integration do?" / "Why isn't my Calendar pulling?"

```
self({ endpoint: "/api/v1/integrations/ca_ConnId/capabilities" })
```

Returns:

- `stream_actions[]` — read-side actions (FETCH/LIST/SEARCH). Each has `enabled`, `stream_id`, `schedule_interval_seconds`, `last_event_at`, `last_pull_status`. If `last_pull_status` is a 4xx, that's likely the OAuth-expiry signal — offer reconnect.
- `tool_actions[]` — write-side actions (SEND/CREATE/UPDATE). Always available once `composio_execute` is in the gateway allowlist; no per-action toggles to read.
- `stale_streams[]` — stream configs whose action slug is NOT in Composio's current catalog for this toolkit. Broken on every pull. Offer the migrate-stream flow.
- `deprecated` — flagged true if Composio has marked the toolkit deprecated.

Use this to answer "why is X broken" precisely, not by guessing.

## Anti-patterns — never do these

1. **Never silently swap accounts on the same toolkit.** Composio allows two Gmail connections per tenant. If Sir says "connect Gmail" and one already exists, ASK: "You already have Gmail connected as `<address>`. Is this for a different account, or did you mean reconnect?"
2. **Never paste an API key back to Sir** in chat or vault notes. (See §4.)
3. **After reconnect, the old `connection_id` is dead in 1h** — update any prose, vault notes, or stream configs that reference it. Don't tell Sir "your Gmail is `ca_OldId`" if it's been reconnected to `ca_NewId`.
4. **Never claim ACTIVE status before verifying via `/capabilities` or `/integrations`.** OAuth is asynchronous; trust the API, not your inference.
5. **Never manually `DELETE` the old connection after a reconnect.** The reaper does it after 1h. Forcing it early breaks in-flight tool calls and any user who isn't watching gets a worse outcome.
6. **Don't try to write tool calls outside `composio_execute`.** Toolkit actions all dispatch through that one gateway tool — there is no standalone `gmail_send` or `notion_update_page` MCP tool, despite what older skill files might suggest.

## When something goes sideways

- **`/reconnect` returns 422 "no auth_config_id"** — the old connection was created via a flow that didn't persist its auth_config (rare, mostly old API-key migrations). Fall back to `/connect` with the toolkit_slug, then disconnect the old one manually after Sir confirms the new one works.
- **`/reconnect` returns 404** — the connection_id is unknown to Composio (already deleted, never existed, or belongs to a different tenant). Don't retry — re-list `/integrations` to find the live id.
- **OAuth handshake stalls** — Composio's INITIATED status persists. If Sir says "I clicked it, it's done" but `/capabilities` still reads INITIATED, ask him to check the popup wasn't blocked. Last resort: call `/reconnect` again (the new entry supersedes the prior one and the reaper handles cleanup).
- **`composio_execute` calls 401 right after reconnect** — the gateway may not have picked up the new token yet. Wait 30s for the openclaw debounce + readiness probe (`GET /api/v1/openclaw/ready`), then retry.

## Relationship to other skills

- `alfred-email-channel`, `alfred-voice` — channel-specific output. This skill is the upstream OAuth lifecycle; those skills consume the resulting capability.
- `alfred-channel-delivery` (PR #642 / KNOWN_CONTACTS.md) — how to pick the right channel to deliver the OAuth URL to Sir.
- The auto-generated `alfred-composio-<toolkit>` skills — per-app action references. Created on first connect, refreshed on `/regenerate-skills`. Refer to those for "what does Notion's `NOTION_UPDATE_PAGE` need as arguments".

Sir owns his integrations. Your job is to make the lifecycle frictionless — one chat turn for connect, one chat turn for reconnect, no juggling between Composio's dashboard and Alfred's chat.
