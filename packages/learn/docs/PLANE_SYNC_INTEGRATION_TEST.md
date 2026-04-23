# Plane two-way sync — integration test plan

Target: the David tenant (production reference; `PLANE_SYNC_ENABLED=true`).
Runs after `al-plane-sync` + `al-plane-reverse-sync` schedules are registered.

Each scenario below records the expected path (forward or reverse), the expected
Temporal workflow behaviour, and a sanity-check command for the operator.

## Prerequisites

1. Tenant `.env` has:
   - `PLANE_SYNC_ENABLED=true`
   - `PLANE_API_URL`, `PLANE_API_TOKEN`, `PLANE_WORKSPACE_SLUG` populated
   - `PLANE_WEBHOOK_SECRET` matches the Plane-side webhook registration
2. `al-plane-sync` + `al-plane-reverse-sync` schedules are visible in
   Temporal UI:
   ```bash
   tctl --address temporal:7233 schedule list | grep plane
   ```
3. `/alfred-data/state/plane_sync_cursor.json` and
   `/alfred-data/state/plane_reverse_sync_cursor.json` either don't exist
   (fresh tenant) or reflect a known-good cursor.
4. Before each run, clear outbound signatures to get a clean baseline:
   ```bash
   ssh deploy@<tenant> rm -f /mnt/encrypted/alfred/state/plane_outbound_signatures.json
   ```

## T1 — vault → Plane (forward sync smoke)

**Goal**: confirm forward-sync still works with the B7 outbound-signature hook.

1. In the vault, create a matter named `b7-smoke-client`:
   ```bash
   curl -H "Authorization: Bearer $AAS" -X POST \
     http://localhost:3100/api/v1/vault/records \
     -d '{"type":"matter","name":"b7-smoke-client","fields":{"description":"B7 test"}}'
   ```
2. Wait 60–120 seconds for the next `al-plane-sync` tick.
3. **Expected**:
   - A Plane project named `b7-smoke-client` appears in the workspace.
   - `/alfred-data/state/plane_sync_cursor.json` has a new entry in
     `project_map` mapping `b7-smoke-client` → the Plane project UUID.
   - `/alfred-data/state/plane_outbound_signatures.json` has a new
     entry keyed by the Plane project UUID.
4. Temporal UI: exactly one `PlaneSyncWorkflow` run in the window.

## T2 — Plane → vault (matter title update)

**Goal**: confirm reverse-sync applies an edit AND the loop doesn't amplify.

1. In the Plane UI, rename `b7-smoke-client` to `b7-smoke-client-renamed`.
2. Wait 30–60 seconds for the webhook + reverse-sync tick.
3. **Expected**:
   - Vault matter frontmatter `name` changes to `b7-smoke-client-renamed`.
   - `al-plane-reverse-sync` ran once and reported `matters_updated: 1`.
   - Exactly ONE echo arrives on the next `al-plane-sync` tick — that tick
     must NOT write anything back to Plane (the forward-sync guard is
     mtime-based, and the reverse-sync write DID bump mtime, so forward
     WILL push once; that push's webhook echo must be suppressed).
4. Temporal UI check:
   - `al-plane-reverse-sync`: ≤2 runs with work in the 3-minute window
     (initial + confirm idle).
   - `al-plane-sync`: ≤2 runs with work (the echo-push + confirm idle).
   - No cascading loop where counts keep climbing.

## T3 — Plane → vault (human-created issue)

**Goal**: confirm inbound human-created issues become vault tasks with
correct matter linkage.

1. In Plane, create an issue `Follow up with Sir` in the
   `b7-smoke-client-renamed` project. Don't touch `external_id`.
2. Wait 30–60 seconds.
3. **Expected**:
   - New vault task at `task/follow-up-with-sir.md` (or similar slug).
   - Frontmatter: `plane_issue_id: <uuid>`, `matter: matter/b7-smoke-client-renamed`,
     `status` reflects the Plane state group.
   - Reverse-sync reports `tasks_created: 1`.

## T4 — assign issue to Alfred (B8 trigger prep)

**Goal**: verify the assignment webhook arrives without triggering a write
today (B7 just catalogs it; B8 will dispatch).

1. In Plane, assign the issue from T3 to the Alfred user.
2. Wait 30–60 seconds.
3. **Expected**:
   - `al-plane-reverse-sync` logs show the `issue updated` event passed
     through with `events_seen` incremented.
   - Guard #3 should result in a no-op write if only assignees changed
     (current loop-guard fields don't include assignee name, but B8
     will add that handling).
   - No infinite loop.

## T5 — Plane → vault (issue delete = archive)

1. In Plane, delete the issue from T3 via the "Delete issue" action.
2. Wait 30–60 seconds.
3. **Expected**:
   - `task/follow-up-with-sir.md` still exists on disk (verify via
     `ls /mnt/encrypted/vault/task/ | grep follow-up`).
   - Frontmatter has `archived: true` and `status: cancelled`.
   - Reverse-sync reports `archives: 1`.

## T6 — 5-minute quiet window

1. Don't touch Plane or the vault for 5 minutes.
2. **Expected**:
   - Every `al-plane-sync` run reports `matters_synced: 0, tasks_synced: 0`.
   - Every `al-plane-reverse-sync` run reports `events_seen: 0` (or only
     non-managed events that land as `unknown_events`).
   - No workflow cascades, no retries.

## T7 — toggle feature flag

1. Set `PLANE_SYNC_ENABLED=false` in the tenant `.env`.
2. Restart `alfred-learn` container.
3. **Expected**:
   - Both schedules disappear from the Temporal UI within one
     `register_schedules` run (triggered on container boot).
   - No further `PlaneSyncWorkflow` or `PlaneReverseSyncWorkflow`
     activations.
4. Restore the flag and confirm schedules come back cleanly.

## Monitoring during the full run

In a second terminal, keep these open:

```bash
# Temporal workflow history
docker compose logs -f alfred-learn | grep plane_

# Outbound signature store mutations
watch -n 2 'ls -la /mnt/encrypted/alfred/state/ && cat /mnt/encrypted/alfred/state/plane_outbound_signatures.json 2>/dev/null | jq "length"'

# Reverse cursor advancement
watch -n 2 'cat /mnt/encrypted/alfred/state/plane_reverse_sync_cursor.json 2>/dev/null'
```

## Pass criteria

* Every scenario above completes with the expected outcome.
* **Zero cascading loops**: no scenario generates more than 2 workflow
  runs per side per real edit.
* `plane_outbound_signatures.json` never exceeds 1000 entries (FIFO cap).
* `plane_reverse_sync_cursor.json` advances monotonically; no resets.
* Sir's `vault/matter/*.md` and `vault/task/*.md` files show expected
  frontmatter changes but no content drift (body preserved on archive).

---

## Alfred-as-user (B8 — #536)

When a human in Plane @mentions Alfred in a comment OR assigns an issue
to him, reverse-sync spawns an openclaw session on the main gateway
(`:18789`) with the issue context. Alfred then acts, posts a reply
comment, and (when required) waits for an explicit approval comment
from the requester before taking destructive action.

**Prerequisites**:
- Tenant `.env` has `PLANE_ALFRED_USER_ID` populated (written by the
  provisioner in PR #547).
- Tenant Plane workspace has an "Alfred" user matching that id.
- `PLANE_SYNC_ENABLED=true`.

### T8 — @alfred mention (autonomous path)

**Goal**: plain `@alfred` mention spawns a session, Alfred replies on
the issue.

1. In Plane, open any issue (preferably one Alfred has already mirrored
   from a vault task, so the matter linkage exists).
2. Post a comment: `@alfred summarise the thread for me`.
3. Wait 30–60 seconds for the next `al-plane-reverse-sync` tick.
4. **Expected**:
   - `al-plane-reverse-sync` result shows
     `alfred_triggers_seen: 1, alfred_sessions_spawned: 1,
     alfred_spawns_failed: 0`.
   - A session appears in openclaw history for `agent: "main"` with
     `metadata.source = "plane"` and `metadata.trigger_type = "mention"`.
   - Alfred posts a reply comment on the same Plane issue (usually
     within 30–120s depending on the main agent's response time).
5. Check in Temporal UI: `PlaneReverseSyncWorkflow` logs include
   `plane_reverse_sync: alfred session spawned type=mention
   issue=<uuid> session=<key> requires_approval=False`.
6. Check in openclaw logs: `docker compose logs openclaw --tail=200 |
   grep sessions_spawn` — one entry with `agentId=main` immediately
   after the reverse-sync tick.

### T9 — @alfred mention with destructive verb (gated path)

**Goal**: destructive verbs force an approval gate, Alfred posts a plan
and waits.

1. Post a comment: `@alfred please delete the stale drafts`.
2. Wait 30–60 seconds.
3. **Expected**:
   - Reverse-sync result shows
     `alfred_triggers_seen: 1, alfred_sessions_spawned: 1`.
   - Spawn metadata in openclaw history has `requires_approval: True`.
   - Alfred's reply comment on Plane describes the plan and asks for
     explicit approval (something like "Please confirm with `@alfred
     approved` before I remove …").
   - `/mnt/encrypted/alfred/state/plane_pending_approvals.json` has an
     entry keyed by the Plane issue UUID with the requester's actor id.
4. Post a follow-up comment from the **same user**:
   `@alfred approved`.
5. Wait 30–60 seconds.
6. **Expected**:
   - Reverse-sync result shows `alfred_approvals_resolved: 1`.
   - The pending-approvals file no longer contains the entry.
   - Alfred sends a `sessions_message` follow-up to the original
     session (visible in openclaw history) and proceeds with the
     action.

**Negative case**: if someone OTHER than the original requester posts
`@alfred approved`, reverse-sync must leave the pending entry untouched
and log `no_matching_pending`.

### T10 — Assign issue to Alfred

**Goal**: assignment always spawns in gated mode; first response is a
plan + approval request.

1. In Plane, create a new issue and assign it to the Alfred user at
   creation time (or assign via the assignee picker on an existing
   issue).
2. Wait 30–60 seconds.
3. **Expected**:
   - Reverse-sync result shows `alfred_triggers_seen: 1,
     alfred_sessions_spawned: 1` with spawn metadata
     `trigger_type: "assignment", requires_approval: True`.
   - Alfred's reply comment on Plane presents a plan (no destructive
     action yet) and asks for `@alfred go ahead`.
   - `plane_pending_approvals.json` has the entry.
4. Reply with `@alfred go ahead` from the assigner.
5. **Expected**: same approval resolution as T9.

### T11 — Echo suppression (Alfred's own comments)

**Goal**: Alfred's own reply comment on a Plane issue must NOT
re-trigger him.

1. Observe the comment Alfred posted in T8. Inspect its id via the
   Plane API:
   ```bash
   curl -H "x-api-key: $PLANE_API_TOKEN" \
     "$PLANE_API_URL/api/v1/workspaces/$PLANE_WORKSPACE_SLUG/projects/<proj>/issues/<iss>/comments/" \
     | jq '.[] | {id, actor}'
   ```
2. Check that comment id appears in
   `/mnt/encrypted/alfred/state/plane_self_comments.json` (list of
   up to 500 most recent self-posted comment ids, FIFO-evicted).
3. **Expected**:
   - Reverse-sync result for the tick that processed the echo event:
     `alfred_triggers_seen: 0`.
   - No second session in openclaw history matching that comment.
4. Also verify that if Alfred's user id appears as the comment actor,
   the detector skips via layer-1 echo defense even if the comment id
   happens to be missing from the ledger.

### T12 — Assignment update where Alfred was already assigned

**Goal**: editing a title or priority on an issue already assigned to
Alfred must NOT spawn another session.

1. Open an issue already assigned to Alfred (from T10).
2. Change the title from the Plane UI (don't touch assignees).
3. Wait 30–60 seconds.
4. **Expected**:
   - Reverse-sync `alfred_triggers_seen: 0` (no new trigger).
   - Vault-side: the task record's `name` frontmatter field updates
     via the usual reverse-sync path.
   - `plane_pending_approvals.json` is unchanged.

### Monitoring for B8

```bash
# Watch the Alfred trigger fields in the reverse-sync result
docker compose logs -f alfred-learn | grep -E 'alfred session|alfred_triggers'

# Pending approvals
watch -n 2 'cat /mnt/encrypted/alfred/state/plane_pending_approvals.json 2>/dev/null | jq .'

# Self-comment ledger (confirm it grows by one after every Alfred reply)
watch -n 5 'cat /mnt/encrypted/alfred/state/plane_self_comments.json 2>/dev/null | jq "length"'
```

### Troubleshooting

* **No session spawned on `@alfred ...`** — check that
  `PLANE_ALFRED_USER_ID` is set in the tenant `.env`; without it the
  detector no-ops on assignments and only matches plain `@alfred`
  tokens (not user-mention markup). `docker compose exec alfred-learn
  env | grep PLANE_ALFRED_USER_ID` confirms.
* **Spawn fails with `http_error`** — the main openclaw gateway
  probably restarted (e.g. after a Composio connect). Check
  `GET /api/v1/openclaw/ready` on the tenant; the next reverse-sync
  tick will retry.
* **Alfred's reply re-triggered him** — one of the two defense layers
  broke. Either (a) the Plane webhook payload didn't include the
  `actor.id` field and you hit the ledger-miss path, or (b) the
  `create_comment` call bypassed the self-comment ledger recorder.
  Verify by checking `plane_self_comments.json` contains the reply
  comment id shortly after Alfred posts.
* **Approval ignored** — ensure the approver is the SAME actor id as
  the original requester. Approvals from other users are deliberately
  rejected. The workflow log line
  `resolve_plane_approval: no_matching_pending` indicates either the
  requester id mismatched or the pending entry expired (24h TTL).
