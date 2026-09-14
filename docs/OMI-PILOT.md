# Native Omi chat and management tasks

The Omi model conducts the conversation. The `/omi/mcp` resource offers a
restricted context/read/task/request catalogue backed by ctrl-api. It never
forwards conversation generation to Hermes. This is a best-effort continuity
pilot; Omi does not enforce a context call before each response.

## Configuration

Set `OMI_PILOT_ENABLED=true` and `OMI_MCP_PUBLIC_URL=https://mcp.<domain>/omi/mcp`
on ctrl-api. Leave the feature disabled by default. The Omi account creates a
private MCP connection to that resource and completes OAuth. The exact Omi
callback receives an Omi-only RFC8707 resource fallback; other clients retain
their existing resource checks. Never put a tenant master credential into Omi.

The operator links a scoped `omi_mcp_...` credential through
`PUT /api/v1/channels/omi/pilot/connection` with `api_key` and `expected_email`.
The profile email must match, and chat/task reads must succeed. The server
binds this connection to its existing owner principal. Credential material
lives in Vaultwarden; state.db stores only its reference. Account changes are
rejected while mappings exist. Reconnect preserves mappings and pauses writes.

Required upstream key access: profile.read, chat.read, action_items.read,
action_items.write (use the names supported by the current Omi key screen).
The `/v1/mcp/chat` reader covers main chat, not separate persona/app chats.
Import begins at connection time; a backfill is not implicit.

## Controller contract

All paths below are under `/api/v1/channels/omi/pilot`; none is public.

| Endpoint | Purpose |
| --- | --- |
| GET /status | Feature, connection, write state, sync timestamp and conflicts; no credentials |
| PUT/DELETE /connection | Operator links/reconnects or disables the connection |
| POST /sync | Worker/manual reconciliation; no-op when disabled |
| GET /reconcile | Operator reviews native and canonical task lists and mappings |
| PUT /tasks | Operator maps a task, imports a selected management task, or resolves a conflict |
| PUT /writes | Enable/disable synchronization after first read and conflict review |
| POST /context | Refresh history; load identity, relevant records, journal and action receipts |
| POST /read | Business record/task/connection discovery only |
| POST /command | Idempotent create_task, update_task or request_work |

Commands require a stable `request_id`. Reusing it with different input is an
error. `request_work` records a human-owned task requiring review; it is not
an external send or workflow execution. No raw Composio, shell, credentials,
or administrative commands are exposed. Broader external execution remains
behind the existing review surfaces.

Completion changes use `/state-changes` with source `omi.task_update`; typed
title/due/state patches use the existing canonical vault API. The adapter does
not open another writable vault or database from the worker process.

## Synchronization and recovery

The existing learn worker registers `OmiSyncWorkflow` every minute. ctrl-api
owns the lock, mappings and command receipts. Real human and AI messages are
deduplicated by account/message ID and preserve provider timestamps in the
shared journal. Tool requests and verified outcomes remain separate receipts.

Only selected management tasks are mapped. Three-way field merges preserve
independent title/date/completion edits; conflicts pause the affected task.
Missing tasks never cause deletion. An uncertain remote create is not retried.
Omi's current MCP API cannot clear an existing due date; this becomes an explicit
`clear_due_in_omi` conflict. Clear it in Omi, then resolve the mapping. A matching
title is a review candidate, never an automatic match. Remote write responses
must retain the requested values before the baseline advances.
After inspecting Omi, link the returned remote ID using PUT /tasks; explicitly
choose `resolve: local` or `resolve: remote` if values differ. Do not issue a new
request ID to bypass uncertainty. Database pending receipts survive restarts.

Disconnect blocks cached clients at ctrl-api and stops future sync. An already
in-flight request may finish; review its receipt. Revoking the Omi OAuth grant
and upstream key completes credential revocation. Preserve receipts/mappings
for reconciliation. Roll back code only to a version tested against the additive
migration, or restore the pre-upgrade backup before resuming writes.

## Release evidence

Run the Omi controller unit and HTTP tests, journal/audio regressions, MCP
typecheck and OAuth/token tests, and learn activity/workflow tests. The HTTP
fixture exercises actual controller routing and canonical vault writes with
synthetic upstream responses. It is not evidence of a successful Omi cloud
connection. Live account authorization, Hungarian persona behavior and
cross-surface conversation checks are required before a user pilot.
