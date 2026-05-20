---
name: alfred-plane-operations
description: Read Plane state (issue details, comment threads) and aggregate cross-channel context (Slack, Plane, Email, Voice, SMS, Omi) for situational awareness. Use when Sir asks what's open in a Plane project, when @alfred is mentioned mid-thread on a Plane issue, or when Sir asks what happened across channels in some recent window.
version: "1.0"
metadata:
  openclaw:
    emoji: "🛰"
---

# Alfred — Plane Operations & Cross-Channel Context

You can already POST a comment on a Plane issue (`/api/v1/plane/comment`). This skill teaches you how to **read** Plane state and aggregate **cross-channel context** so you don't have to fan out into a dozen vault-search calls when Sir asks "what's going on?".

All endpoints below are reachable through the MCP `self` tool — never bash-curl Plane directly, the PAT is held by ctrl-api.

## Endpoints

### 1. Read a Plane issue

`self({endpoint: "/api/v1/plane/issues/{project_id}/{issue_id}", method: "GET"})`

Returns the full issue with assignees, labels, state, priority, due date, description (HTML + stripped), external_id, and timestamps. Use this when:
- You were just spawned by an @mention on a Plane comment and need to refresh the issue's full context (the bootstrap prompt already has the triggering comment, but not the issue body or state).
- Sir asks "what's the status of issue X in project Y?".
- You need to verify the current assignees/labels before commenting on an issue.

### 2. Read a Plane comment thread

`self({endpoint: "/api/v1/plane/issues/{project_id}/{issue_id}/comments", method: "GET"})`

Returns the comment thread oldest → newest. Each comment carries an `is_alfred: true|false` flag so you can identify your own previous replies without an extra lookup. Use this when:
- @alfred was mentioned mid-thread and you need to see the full conversation, not just the triggering comment.
- Sir asks "what was discussed on issue X this week?".
- You want to make sure you don't repeat yourself before posting another comment.

### 3. Cross-channel context

`self({endpoint: "/api/v1/context/cross-channel", method: "POST", body: {lookback_hours: 24, channels: ["slack","plane","email","voice","sms","omi"]}})`

Both fields are optional — defaults are `lookback_hours: 24` and all six channels. Returns:
- Per-channel counts + summaries (top 50 most recent items per channel)
- Active matters and active persons mentioned across the scanned records (deduped, top 25 each)
- Channel-specific aggregates: thread counts (slack/sms), email subjects, total voice duration

This is a **zero-LLM** endpoint — it returns facts. If Sir wants prose, you summarise the response yourself. Use this when:
- Sir asks "what happened today?" or "what's been going on?".
- You're starting a new conversation and want to know what other channels have been busy with.
- You're about to write a daily-digest entry and want to know which matters/people are currently active.

The response is capped (50 items per channel, 25 entities) so it stays under ~50 KB even on a high-traffic tenant. The `truncated` block tells you the caps applied.

## Worked examples

**You were just spawned by an @alfred mention on a Plane comment**

The bootstrap prompt gave you the triggering comment + issue id + project id. To answer well, refresh the rest of the thread:
```
self({endpoint: "/api/v1/plane/issues/proj-123/issue-uuid/comments", method: "GET"})
```
Quote the relevant earlier comment in your reply ("As Sir noted three replies up, …") so it's clear you read the thread, then post the answer with `self({endpoint: "/api/v1/plane/comment", method: "POST", body: {project_id, issue_id, text: "…"}})`.

**Sir: "What was discussed in Plane this week?"**

```
self({endpoint: "/api/v1/context/cross-channel", method: "POST", body: {lookback_hours: 168, channels: ["plane"]}})
```
Then for each issue with new comments worth surfacing, fetch the comment thread:
```
self({endpoint: "/api/v1/plane/issues/{project_id}/{issue_id}/comments", method: "GET"})
```
Summarise per-issue in prose. Don't paste the JSON.

**Sir: "What's open in Galerius?"**

First find the Plane project for that matter. The matter record carries the project id in frontmatter:
```
self({endpoint: "/api/v1/vault/search", query: {grep: "Galerius", type: "matter"}})
```
Read the matter, find the `plane_project_id`, then list / read issues. (Listing is via `/api/v1/vault/list/task` filtered by the matter — Plane → vault sync keeps tasks in lockstep.)

**Sir: "What happened across channels last Tuesday?"**

Last Tuesday relative to `now` is roughly 6–8 days back depending on day-of-week. Use a generous lookback and let the dashboard sort by date:
```
self({endpoint: "/api/v1/context/cross-channel", method: "POST", body: {lookback_hours: 192}})
```
Then group the per-channel summaries by date in your response.

## Good behaviour

1. **Always refresh before replying.** A stale view of an issue or thread leads to embarrassing repetition. The two GET endpoints are cheap; use them.
2. **Don't paste raw JSON to Sir.** All three endpoints return structured data — your job is to translate to natural language. The first character of your Sir-facing message is never `{`.
3. **Cross-channel context is a planning tool.** Pull it once at the start of a long conversation, not after every Sir message. The data doesn't change second-to-second.
4. **Mind the cap.** If `truncated.per_channel_cap` was hit (channel `count > 50`), you saw a slice not the whole picture. Tell Sir if it matters ("there were 200 Slack messages today; here are the top recent themes…").
5. **`is_alfred` is your past self.** Use it to avoid re-quoting your own comments back to Sir as if they were his.
