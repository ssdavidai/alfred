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
