---
name: alfred-plane
description: Drive Plane (issue tracker) end-to-end through the per-tenant MCP server — list/search/create/update issues, post comments, browse cycles. Use whenever Sir asks about Plane state or an @alfred mention fires on a Plane comment.
license: alfred-platform internal — see the parent monorepo's LICENSE
---

# Plane MCP — operator's manual

You have **10 Plane tools** through the MCP `plane` connector. Three originals (read + comment) plus seven v2 tools that flesh out list / search / create / update + the resolution helpers (cycles, projects, states, labels). Together they let you drive Plane without bouncing through the vault mirror.

`ctrl-api` holds the Plane PAT and the workspace slug — never bash-curl Plane directly, every call is a tool call.

## The 10 tools

### Read & resolve (cheap, call freely)

- `list_projects` — every workspace project. **First call when Sir names a project** ("what's open in Galerius?"); you need the UUID.
- `list_cycles` — cycles in one project. Resolve "Sprint 12" → cycle UUID; find the active cycle (`status === "CURRENT"`).
- `list_states` — workflow states in one project. Resolve "In Review" → state UUID. Group taxonomy is `backlog`|`unstarted`|`started`|`completed`|`cancelled`. Skip if you're using `state_groups` in `search_issues` — that resolves server-side.
- `list_labels` — labels in one project. Resolve "blocked", "p0", etc. to UUIDs.
- `get_issue` — one issue by id. Refresh assignees/state/description before commenting or updating.
- `list_issue_comments` — full thread, oldest → newest. Each comment has `is_alfred: true|false` so you don't quote yourself.

### Browse & filter

- `list_issues` — simple paginated list in **one** project. Light filters (state_id, assignee_id, cycle_id, order_by). Use for "show me the open tickets in project X."
- `search_issues` — **the power tool.** Multi-dimensional filter, optionally cross-project. Use for everything more nuanced than `list_issues`. See worked examples below.

### Write

- `create_issue` — new issue. NOT idempotent — re-search before retrying after a network error.
- `update_issue` — partial update. **`assignees` and `labels` REPLACE the existing set** — to add, `get_issue` first, append, then PATCH.
- `post_issue_comment` — comment as Alfred. NOT idempotent — `list_issue_comments` first if retrying.

Vault `matter/` and `task/` records mirror to Plane automatically — a 15 s forward-sync cron picks up every change. There is no manual push tool; just edit the vault record and the cron reconciles it.

## Resolution chain

Plane's API is UUID-driven. **You almost never have UUIDs at the start of a conversation; you have names.** The chain:

1. Sir says a project name → `list_projects` → `project_id` (UUID).
2. Need a state ("Done", "In Review")? → `list_states({project_id})` → `state_id`.
3. Need a label ("blocked", "p0")? → `list_labels({project_id})` → `label_id`.
4. Need a cycle ("Sprint 12", "current")? → `list_cycles({project_id})` → `cycle_id`.
5. Need a Plane user other than yourself? Sir's user UUID is in env (`PLANE_ALFRED_USER_ID`); for others you'll usually have it from a comment's `actor.id` already.

`search_issues` short-cuts step 2 via `state_groups` (resolved per-project server-side) and `assigned_to_me` (resolves to Alfred's UUID). Use those when you can — fewer round trips.

## When to use `list_issues` vs `search_issues`

- **`list_issues`**: you have one project, one optional filter, just want the page. "List Sir's open tickets in Galerius."
- **`search_issues`**: any of — multiple projects (or all-workspace), multiple filter dimensions, state-group filters, time-range filters, text search, blocked-tickets queries, assigned-to-me. Default to this if you're combining ≥2 dimensions.

The cross-project fan-out is **capped at 15 projects** — if the workspace has more, `search_issues` returns 400 `FANOUT_TOO_LARGE` and you must pass `project_ids` explicitly. List projects, decide what's relevant, scope the search.

## Worked search examples

**1. "All blocked tickets across all projects assigned to me"**

```
search_issues({
  is_blocked: true,
  assigned_to_me: true,
})
```

`is_blocked: true` matches issues with a label literally named `blocked` (case-insensitive). For nuanced blocking semantics ("waiting-on-client", "blocked-by-design") run `list_labels` per project, collect the relevant label_ids, and pass `label_ids` instead.

**2. "Everything that landed in the current cycle and isn't done"**

```
list_projects()                                  # find project_id
list_cycles({project_id})                        # find the cycle whose status === "CURRENT"
search_issues({
  project_ids: ["<project_id>"],
  cycle_ids: ["<current_cycle_id>"],
  state_groups: ["backlog", "unstarted", "started"],
  order_by: "-priority",
})
```

`state_groups` is the friendly form — server resolves to UUIDs per project. Excludes `completed` and `cancelled`.

**3. "Tickets I commented on this week"**

Plane's REST has no "I commented on" filter, so this is two-stage. First, find candidate issues:

```
search_issues({
  assigned_to_me: true,
  updated_after: "<7 days ago, ISO-8601>",
  limit: 50,
})
```

Then for each, `list_issue_comments({project_id, issue_id})` and check for `is_alfred: true` comments inside the window. Don't fan this out beyond ~20 issues — it's expensive.

**4. "Anything new in the last 24h, anywhere"**

```
search_issues({
  created_after: "<24h ago>",
  order_by: "-created_at",
  limit: 100,
})
```

Workspace-wide; will fan-out. Returns issues tagged with `project_id` so you can group by project in your reply.

**5. "What's overdue?"**

```
search_issues({
  state_groups: ["unstarted", "started"],
  target_date_before: "<today, ISO-8601>",
  order_by: "target_date",
})
```

Excludes already-done issues; sorts oldest target_date first.

**6. "High-priority tickets with no assignee"**

Plane's REST has no "no assignee" filter — pull and filter client-side:

```
search_issues({
  priority: ["urgent", "high"],
  state_groups: ["backlog", "unstarted", "started"],
  limit: 200,
})
```

Then in the response, drop any with non-empty `assignees`.

## Composing with the v1 tools

The originals still do the heavy lifting on single-issue flows:

- **search → get → comment**: `search_issues` to find candidates, `get_issue` to refresh full state, `post_issue_comment` to reply.
- **mention → list_issue_comments → post_issue_comment**: when @alfred fires, the bootstrap prompt has the triggering comment + ids; pull the rest of the thread, then reply, using `is_alfred` to avoid repeating yourself.

## Good behaviour

1. **Resolve UUIDs once per conversation, then cache.** `list_projects` / `list_states` / `list_labels` are stable within a session — don't call them in a loop.
2. **`assignees` and `labels` on `update_issue` REPLACE.** To add, `get_issue` first, splice in the new id, PATCH the full array.
3. **Don't paste raw issue JSON to Sir.** All tools return structured shapes — your job is to translate to natural language.
4. **Mind the 15-project cap.** If workspace-wide `search_issues` returns 400 `FANOUT_TOO_LARGE`, pass `project_ids` explicitly. List projects, decide what's relevant, retry.
5. **`is_blocked` is label-based, not relationship-based.** Plane's REST exposes blocking-relations awkwardly; we approximate via the literal `blocked` label. If Sir wants the relationship-graph version, say so and adapt.
6. **Order matters across projects.** Cross-project searches sort the merged result client-side — don't assume Plane's per-project ordering survives the merge. Pass `order_by` explicitly when sequence matters.
