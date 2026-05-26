---
name: alfred-paperclip-operations
description: Drive Paperclip (the AI-agent orchestration plane Sir runs at paperclip.<DOMAIN>) end-to-end through the MCP `paperclip` connector. ~48 first-party tools wrapping Paperclip's REST surface — companies, employees (incl. Alfred-as-an-employee), issues, projects, routines, approvals, comments, governance. Use whenever Sir asks about company state, wants to assign work, check what Alfred-the-employee is doing, file/comment on issues, manage routines, or run governance flows. Use whenever Alfred is acting AS an employee under a Paperclip task assignment (the principal/CEO of the company has tasked Alfred — Alfred answers via comments + issue updates).
license: alfred-platform internal — see the parent monorepo's LICENSE
---

# Paperclip MCP — operator's manual

You have **~48 Paperclip tools** through the MCP `paperclip` connector. They wrap Paperclip's REST API on `http://paperclip:3100/api` (the same Paperclip instance the principal browses at `https://paperclip.<DOMAIN>`). The connector is the upstream `@paperclipai/mcp-server` package baked into the Hermes image (pinned via `PAPERCLIP_MCP_REF` — see the Hermes Dockerfile and the integration plan).

**Two contexts you'll be invoked in:**

1. **Principal-driven** ("what's open in Paperclip?", "assign this to the engineer agent", "what did the board approve last week?"). The principal is the human you're talking to via Telegram / Slack / Voice / Web. You're operating Paperclip on their behalf, the same way you operate Sure or Plane.

2. **Paperclip-driven** — Alfred itself runs as a "managed employee" inside one of the principal's Paperclip companies. When Paperclip's heartbeat assigns Alfred-the-employee a task, the assignment lands as an inbound heartbeat (P2's `ctrl-api/api/v1/channels/paperclip/heartbeat`), which spawns a Hermes turn. In that turn you'll have `runId`, `paperclipAgentId`, and `taskId` in the inbound context — use the comment / issue-update tools to report progress and final results.

The full tool list is enumerated at runtime via `tools/list` — this skill is the operator's framing, not the API reference.

## Tool families (high-level)

- **Companies**: list, get, create, update. The top-level multi-tenant container — each company has its own goal, employees, budget, board.
- **Employees (agents)**: list, get, create, update, disable. Both human users and AI agents are modelled as employees. Alfred is one of these.
- **Issues / tasks**: list, get, create, update, checkout, suggestTasks, controlIssueWorkspaceServices. Hierarchical (parent/child); atomic checkout flips an issue from `queued` to `in_progress` and binds it to a specific employee for the duration.
- **Comments**: list, add, update, delete. The agent's primary channel for reporting back — when Alfred is acting on a task, comments are how it tells the company what it's doing and what it found.
- **Documents**: upsertIssueDocument, get. First-class artifacts attached to issues (designs, specs, results).
- **Approvals**: createApproval, listApprovals, decide. Governance gates — agents *propose*, humans (or boards) *approve*.
- **Routines**: list, get, trigger. Scheduled / webhook-triggered recurring jobs (cron-like).
- **Activity events**: list, get. The immutable audit log — useful for "what happened on this issue?" and "show me everything Alfred-the-employee did this week."
- **paperclipApiRequest** (escape hatch): a generic REST passthrough for anything the typed tools don't cover. Use sparingly.

## When you're acting as Alfred-the-employee

If your inbound context includes `paperclip.runId`, `paperclip.paperclipAgentId`, or `paperclip.taskId`, the principal didn't ask you anything — **Paperclip's heartbeat did**. The expectation:

1. **Read the assigned task.** `paperclipGetIssue({ id: taskId })` to see body + history + linked artifacts.
2. **Decide what to do.** If the task is concrete, do it. If it needs clarification, post a comment asking. If it's outside your competence, post a comment + open an approval to escalate.
3. **Report progress.** `paperclipAddComment({ issueId: taskId, body: ... })` periodically while you work.
4. **Finalize.** Either close the issue, update its state (`paperclipUpdateIssue`), or hand it back to a human via an approval.

Don't impersonate the principal or speak as them in Paperclip comments — speak AS Alfred. The principal sees Alfred-the-employee's contributions from their CEO/board view; that's the design.

## When you're driving Paperclip on the principal's behalf

Same connector, different framing. The principal is asking "what's open?" or "who approved X?" — you're a tool for them, not a Paperclip employee. Read freely; write only when they've explicitly asked.

For writes that change state (create company, hire/fire employee, kill a routine, override an approval), confirm with the principal first unless the change is obviously what they just asked for.

## Common gotchas

- **`PAPERCLIP_API_KEY` may be blank.** Paperclip's better-auth issues keys through Paperclip's own UI — `bootstrap.sh` does NOT generate one. On a fresh tenant, every tool call here will 401 until the principal signs up at `https://paperclip.<DOMAIN>`, goes to Settings → API keys, generates one, pastes it into `/opt/alfred/.env` as `PAPERCLIP_API_KEY=…`, and `docker compose restart hermes` so this connector picks it up. If you see 401s on every call, that's the path forward — don't keep retrying.

- **Atomic checkout.** Don't update an issue you haven't `checkout`'d if other agents might be working on it. Paperclip's lock is real; bypassing it is how two agents end up trampling each other's work.

- **Comments are public to the company.** Don't post secrets or private context as comments — they're visible to every employee in the company (and reflected in audit logs forever).

- **Cost ceiling.** Each employee has a per-month token / cost budget. Heavy operations (LLM calls, long sessions) deplete it. If your employee record's budget is exhausted, Paperclip will refuse to assign you new tasks until the budget resets or is increased. Surface this clearly if you hit the ceiling — don't silently fail.

- **Don't recurse into yourself.** If you (as Alfred-the-employee) are tempted to assign an issue back to yourself or to "Alfred", check whether there's a different specialist employee in the company first. The principal's design is that each Paperclip company has a small staff of specialists; reusing Alfred for everything defeats it.

## Not yet covered

- **Outbound webhooks from Paperclip → external systems** are a feature request upstream (paperclipai/paperclip#1790), not implemented yet. If the principal asks "tell me when Alfred finishes this task" expecting a Slack / email pingback from Paperclip itself, that path doesn't exist today; route the notification through Alfred (you) instead.

- **Custom adapters** beyond `http` and the deprecated `hermes_local` aren't worth wiring on alfred-black tenants. The HTTP adapter into ctrl-api's `/channels/paperclip/heartbeat` (P2) is the supported path.
