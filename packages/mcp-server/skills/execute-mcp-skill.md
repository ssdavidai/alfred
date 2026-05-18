---
name: alfred-execute
description: Drive every Composio integration on Sir's tenant — Gmail, GitHub, Notion, Slack, Calendar, Drive, Linear, Zoom, LinkedIn, YouTube, and 1000+ others — through a single execute MCP server. Two core tools (list_composio_tools, composio_execute) plus four connection-management tools (list/create/reconnect/delete connections). Composio's design is one-tool-many-actions: every operation goes through composio_execute with the action submitted as a parameter. Use whenever Sir wants to send an email, file an issue, post to Slack, create a Notion page, schedule a meeting, or do anything else a connected app supports.
license: alfred-platform internal — see the parent monorepo's LICENSE
---

# Execute (Composio) MCP — operator's manual

You have **6 tools** through the MCP `execute` connector. They're a thin shell around Composio — Sir's tenant has Composio configured with a single execute primitive (every action runs through one handler with the action name as a parameter), and this connector mirrors that shape.

`ctrl-api` holds Sir's `COMPOSIO_API_KEY` and resolves the connection-id-per-toolkit at execute time, so you never wire up auth yourself. Pick an action, supply the args, call `composio_execute`.

## The 6 tools

### Discovery
- `list_composio_tools()` — list connected toolkits (gmail, github, notion, slack, googlecalendar, …) with status. **No args = list toolkits.** Pass `{toolkit}` to enumerate that toolkit's actions.
- `list_connections` — same data as `list_composio_tools()` no-args, with extra fields (auth_scheme, created_at). Use when Sir asks "what's connected?" — semantically richer than the discovery shape.

### Execute
- `composio_execute({action, arguments})` — run one action. **The shape every Composio operation goes through.** Action slug is UPPER_SNAKE_CASE (GMAIL_SEND_EMAIL, GITHUB_CREATE_AN_ISSUE). Per-action `arguments` are JSON; consult the per-toolkit skill files (alfred-composio-gmail, alfred-composio-slack, etc.) for canonical payloads.

### Connection management
- `create_connection({toolkit_slug})` — start OAuth for a new toolkit. Returns `{redirect_url}`. Sir opens the URL in his browser, completes the third-party auth, lands back on the dashboard. Tell Sir to call you back when he's done; verify with `list_connections`.
- `reconnect_connection({id})` — refresh credentials in-place. Use when an action starts failing with auth errors on a previously-working toolkit, or when `list_connections` shows status=EXPIRED. Returns a fresh `redirect_url`.
- `delete_connection({id})` — disconnect. Revokes the OAuth grant where supported, removes the connected_account record, deletes the auto-generated alfred-composio-<toolkit> skill if no other connection uses it. Confirm with Sir before calling — this kills any background streams (Gmail polling, Slack webhook ingest) that depend on the toolkit.

## The two core flows

**1. Discovery → execute (fresh action)**

```
list_composio_tools()
  → ["gmail","github","notion","slack",…]
list_composio_tools({toolkit: "gmail"})
  → [{slug: "GMAIL_SEND_EMAIL", description: "..."},
     {slug: "GMAIL_FETCH_EMAILS", description: "..."}, …]
composio_execute({
  action: "GMAIL_SEND_EMAIL",
  arguments: {to: "alice@example.com", subject: "...", body: "..."}
})
  → {action, toolkit, result: {message_id, thread_id, …}}
```

**2. Direct execute (you already know the action)**

When you've used an action before (or it's documented in the per-toolkit skill you've already loaded), skip discovery:

```
composio_execute({
  action: "SLACK_SENDS_MESSAGE_TO_A_CHANNEL",
  arguments: {channel: "#general", text: "Sir's deploy is live"}
})
```

## Per-toolkit skill files

Sir's tenant auto-generates an `alfred-composio-<toolkit>` skill for every connected toolkit (alfred-composio-gmail, alfred-composio-slack, alfred-composio-github, …). These document the common actions with example payloads, gotchas, and any payload-size caps (notably Gmail's metadata-mode trim — full RFC822 bodies blow the tool-result envelope).

The dashboard's Settings → Claude Setup tab lists each one for download. Sir pastes them into claude.ai → Custom Skills alongside this one. When you're working through a specific toolkit, prefer that skill's documented actions over discovery — it's faster and the payloads are validated.

## Common Sir asks → action mapping

| Sir says | action | arguments |
|---|---|---|
| "Email Alice that the meeting is moved" | GMAIL_SEND_EMAIL | `{to, subject, body}` |
| "What unread emails do I have?" | GMAIL_FETCH_EMAILS | `{query: "is:unread", format: "metadata"}` |
| "Open a GitHub issue in Y for X" | GITHUB_CREATE_AN_ISSUE | `{owner, repo, title, body, labels?}` |
| "Post to #general in Slack: ..." | SLACK_SENDS_MESSAGE_TO_A_CHANNEL | `{channel, text}` |
| "DM Alice on Slack: ..." | SLACK_SEND_MESSAGE | `{user_id, text}` (resolve user_id first) |
| "Create a Notion page in DB X" | NOTION_CREATE_PAGE | `{parent, properties, children?}` |
| "What's on my calendar tomorrow?" | GOOGLECALENDAR_FIND_EVENT | `{calendar_id, time_min, time_max}` |
| "Schedule a meeting with Alice" | GOOGLECALENDAR_QUICK_ADD | `{calendar_id, text}` |
| "Find that doc about X" | GOOGLEDRIVE_LIST_FILES | `{q: "name contains 'X'"}` |
| "Create a Linear ticket" | LINEAR_CREATE_LINEAR_ISSUE | `{team_id, title, description?}` |

These are starting points — the actual action set is large and updated by Composio. Always defer to `list_composio_tools({toolkit})` if you're unsure whether an action exists.

## Gotchas

1. **Gmail metadata mode is mandatory for listing.** Full RFC822 + body is ~14KB per message; the tool-result envelope caps near 15KB, so a single full-body fetch blows the budget. Pass `format: "metadata"` for any list/scan, then `GMAIL_GET_EMAIL` per message you actually want to read.
2. **Composio's `user_id` is the tenant identity, not Sir's third-party account.** When responses include `user_id: "example-owner-1"` etc., that's Composio's per-tenant scoping — never feed it back into the third-party API as a user identifier (Slack U-IDs, Gmail addresses, GitHub usernames). Pull the real per-app identity from KNOWN_CONTACTS via the `alfred` connector's vault tools.
3. **Action slugs change.** Composio occasionally renames or deprecates actions. If `composio_execute` returns "Unknown action", call `list_composio_tools({toolkit})` to find the current slug.
4. **Connection status is checked at execute time.** ACTIVE means the connection was created and OAuth exchanged successfully. EXPIRED / DISABLED / REVOKED means the third party kicked us out — reconnect via `reconnect_connection({id})` before retrying.
5. **Writes are not idempotent.** Re-running `GMAIL_SEND_EMAIL` sends a second email; re-running `GITHUB_CREATE_AN_ISSUE` creates a second issue. If Sir asks you to retry after a network blip, list/check first to see whether the original landed.
6. **`composio_execute` is the only write surface for these toolkits.** Don't try to bypass via `web_fetch` or scraping — Sir keeps the auth state in Composio for a reason (rotation, audit, revocation).

## Good behaviour

1. **Match Sir's verb to one action.** "Email Alice" → one GMAIL_SEND_EMAIL. Don't chain a list-then-search-then-send when the goal was "send".
2. **List before connect.** Before `create_connection`, always `list_connections` first — Sir often forgets he's already connected the toolkit.
3. **Confirm before delete.** `delete_connection` revokes streams and breaks any chore that depends on the toolkit. Always confirm with Sir, even when he names the toolkit.
4. **Use the per-toolkit skill.** When working with Gmail/Slack/GitHub/Notion specifically, the alfred-composio-<toolkit> skill has the canonical action list and payload shapes. Faster than discovery.
5. **Reply in prose.** Composio responses are deeply nested JSON. Don't dump them — answer Sir's question, cite the relevant id if he'll need it for the next step.
