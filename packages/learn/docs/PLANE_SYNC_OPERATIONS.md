# Plane sync operations runbook

Day-2 operations for the vault <-> Plane two-way sync. Read this before
you touch a running tenant. Every symptom that cost us time in the
B1-B8 rollout is captured in the [Failure modes](#failure-modes) table.

The Plane field-mapping rules live in [`PLANE_SYNC_DATA_MODEL.md`](./PLANE_SYNC_DATA_MODEL.md).
The first-time rollout checklist lives in
[`packages/ctrl/docs/PLANE_TENANT_ROLLOUT.md`](../../ctrl/docs/PLANE_TENANT_ROLLOUT.md).

## Architecture

```
 +------------------+
 | vault (markdown) |  canonical source of truth
 +--------+---------+
          | ctrl-api :3100 /api/v1/vault/*
          v
 +---------------------------------------------------------------------+
 | alfred-learn (Temporal worker, task_queue "alfred-learn")            |
 |                                                                     |
 |  al-plane-sync           -->  PlaneSyncWorkflow         (forward)   |
 |    every 15s, SKIP            vault -> Plane upsert                 |
 |                                                                     |
 |  al-plane-reverse-sync   -->  PlaneReverseSyncWorkflow  (reverse)   |
 |    every 10s, SKIP            Plane stream events -> vault          |
 +-------------+-------------------------+-------------------------------+
               | HTTP                    | reads stream_type:"plane"
               | PLANE_API_BASE_URL      | from /api/v1/streams/events
               v                         ^
 +----------------------+     +----------------------------------+
 | plane-proxy  :80     |     | ctrl-api  POST /api/v1/plane/    |
 | (Caddy inside the    |     |            webhook               |
 |  compose network)    |     |  - HMAC(X-Plane-Signature)       |
 +----------+-----------+     |  - LRU dedupe on delivery UUID   |
            |                 |  - emits stream_type:"plane"     |
            v                 +-------------+--------------------+
 +----------------------+                   | Svix-style POST
 | plane-api (Django +  |<------------------+ with HMAC-SHA256
 |  gunicorn :8000)     |   Workspace webhook registered by
 |                      |   setup_plane during provisioning.
 | + plane-web/admin/   |
 |   space/live/worker/ |
 |   beat/migrator/db/  |
 |   redis/mq/minio     |
 +----------------------+
```

Forward and reverse share a single feature flag:
`PLANE_SYNC_ENABLED=true`. Either path being off breaks the loop-guard
contract, so toggle them together.

## Workflows

### `PlaneSyncWorkflow` (forward)

Source: `packages/learn/src/workflows/plane_sync.py`.
Activities: `packages/learn/src/activities/plane_sync.py`.

Behaviour per tick:

1. `plane_sync_is_enabled` - env probe; bail out if off.
2. `load_plane_sync_state` - load `state/plane_sync_cursor.json`.
3. `fetch_changed_matters(since)` and `fetch_changed_tasks(since)` -
   `GET /api/v1/vault/records?type=...` over ctrl-api, client-side
   filter where `_record_mtime(rec) > since`. Both capped at 10 000
   records per vault list; further capped to `MAX_RECORDS_PER_RUN=200`
   workflow-side with matter-first ordering so a task's project exists
   when the task upserts.
4. `ensure_inbox_project` - idempotent. Guarantees the Inbox project
   exists before any task loop touches `project_map`.
5. For each matter: `sync_matter_to_plane` POSTs (or PATCHes) the Plane
   project, stamps origin via `external_id=alfred:<slug>`, records an
   outbound signature.
6. For each task: `sync_task_to_plane` resolves destination project
   (real matter project -> Inbox -> skip), POSTs or PATCHes, records
   outbound signature.
7. `save_plane_sync_state` - writes new cursor only if no errors.
   Skips do NOT hold the cursor anymore (post-#573).

Reads:

- `GET /api/v1/vault/records?type=matter&limit=10000`
- `GET /api/v1/vault/records?type=task&limit=10000`
- `state/plane_sync_cursor.json`
- `state/plane_outbound_signatures.json` (append-only log)

Writes:

- `POST/PATCH <PLANE_API_BASE_URL>/api/v1/workspaces/<slug>/projects/...`
- `POST/PATCH .../projects/<pid>/issues/...`
- `state/plane_sync_cursor.json` (atomic rename)
- `state/plane_outbound_signatures.json` (FIFO-evicted at 1000 entries)

### `PlaneReverseSyncWorkflow` (reverse)

Source: `packages/learn/src/workflows/plane_reverse_sync.py`.
Activities: `packages/learn/src/activities/plane_reverse_sync.py` and
`packages/learn/src/activities/plane_alfred_triggers.py`.

Behaviour per tick:

1. Feature-flag probe (shared with forward).
2. `load_reverse_sync_state` - `state/plane_reverse_sync_cursor.json`
   plus the forward-sync `project_map`/`issue_map` inverted to
   `plane_id -> slug`, plus `outbound_signatures`.
3. `fetch_plane_events(since_id)` - pulls recent
   `stream_type: "plane"` stream events
   (`GET /api/v1/streams/events?status=unprocessed&limit=200`), sorts
   by `received_at` ascending, drops everything at or before
   `since_id`.
4. For each event: `_maybe_spawn_alfred` first (B8 triggers are
   fire-and-forget, captures session ids onto the result), then
   `_dispatch_event` routes to project/issue/comment branches.
5. Project/issue `updated`/`created`/`deleted` events pass through
   `check_loop_guards` (guards #1 + #2); guard #3 fires inside
   `apply_plane_patch_to_vault`.
6. Cursor advances on every processed event (including loop-guard
   skips and `unknown_events`). It holds only on a real activity
   failure.

Reads:

- `GET /api/v1/streams/events?status=unprocessed&limit=200`
- `state/plane_reverse_sync_cursor.json`
- `state/plane_sync_cursor.json` (for the inverted id -> slug maps)
- `state/plane_outbound_signatures.json`
- `state/plane_self_comments.json` (B8 echo defence)

Writes:

- `POST/PATCH /api/v1/vault/records/...` (matter/task/comment patches)
- `state/plane_reverse_sync_cursor.json`
- `state/plane_self_comments.json` (when Alfred posts a reply comment)
- `state/plane_pending_approvals.json` (when a trigger needs approval)

### Webhook handler

Source: `packages/ctrl/src/api/routes/plane.ts`.

`POST /api/v1/plane/webhook` is public and authenticated only by HMAC
over the raw request body. Does three things:

1. Verifies `X-Plane-Signature: sha256=<hex>` with
   `PLANE_WEBHOOK_SECRET` via `crypto.timingSafeEqual`.
2. LRU-dedupes `X-Plane-Delivery` UUIDs (1000-wide in RAM, persisted
   to `/alfred-data/.plane-deliveries`, hydrated on first hit after
   restart, rotated at 10 000 lines down to 5000).
3. Emits `stream_type: "plane"` via in-process `emitStreamEvent(...)` -
   no HTTP loopback.

If `PLANE_WEBHOOK_SECRET` is unset, the route returns HTTP 500 with
`CONFIG_ERROR` and logs `PLANE_WEBHOOK_SECRET is not set`.

## Schedules

Registered by `python -m scripts.register_schedules` on alfred-learn
worker startup. Both schedules are gated on `PLANE_SYNC_ENABLED=true`;
when the flag flips off the register script deletes any existing
handle so you don't leave zombies.

| Schedule id              | Workflow                    | Interval | Overlap |
|--------------------------|-----------------------------|----------|---------|
| `al-plane-sync`          | `PlaneSyncWorkflow`         | 15s      | SKIP    |
| `al-plane-reverse-sync`  | `PlaneReverseSyncWorkflow`  | 10s      | SKIP    |

Expected cadence on a quiet fleet: one `done` log line every 10s / 15s
with all counters at zero. Expect at most 2 workflow runs with work
during a three-minute window after any vault or Plane edit (the edit
itself plus one confirm-idle tick).

Verify on a tenant:

```bash
# On the tenant VPS.
docker exec compose-temporal-1 tctl --address 127.0.0.1:7233 schedule list \
  | grep -E 'al-plane-(sync|reverse-sync)'
```

Expected output is two lines. If one is missing, the worker either
hasn't been restarted since `PLANE_SYNC_ENABLED` flipped on, or the
register script failed. Check
`docker compose logs alfred-learn | grep register_schedules`.

## Cursor files

All under `/mnt/encrypted/alfred/state/` on the host, mounted at
`/alfred-data/state/` inside alfred-learn. All written atomically
(temp-file + rename).

| Path                                    | Writer                    | Shape                                                                 | When to clear                                                                 |
|-----------------------------------------|---------------------------|-----------------------------------------------------------------------|-------------------------------------------------------------------------------|
| `state/plane_sync_cursor.json`          | `save_plane_sync_state`   | `{last_vault_mtime: float, project_map: {slug->uuid}, issue_map: {slug->uuid}}` | Full resync (forward). Drops all id -> slug memory; forward re-creates or re-adopts by hash. |
| `state/plane_reverse_sync_cursor.json`  | `save_reverse_sync_cursor`| `{last_event_id: str, last_event_ts: float}`                          | Replay a backlog of stream events. All unprocessed events re-enter the dispatcher. |
| `state/plane_outbound_signatures.json`  | forward-sync, each upsert | `{plane_id: {hash: str, ts: int_ms}}` FIFO-capped at 1000             | Hot-fix for guard #2 false-positives. Rebuilt on next forward tick.           |
| `state/plane_self_comments.json`        | B8 triggers               | `["comment_uuid", ...]` FIFO-capped at 500                            | Only if Alfred's own comments start re-triggering him - strong signal of a bug, open an issue. |
| `state/plane_pending_approvals.json`    | B8 triggers               | `{issue_id: {requested_at, session_key, requires_approval}}`          | Stale entries auto-expire after 24h; clear manually only if an approval is wedged. |
| `/alfred-data/.plane-deliveries`        | ctrl-api webhook route    | newline-delimited delivery UUIDs                                      | Almost never. LRU rotates itself at 10 000 lines.                             |

**Clearing a cursor is safe-ish but not free**: forward resync from
cursor 0.0 may write every matter + task back to Plane even if
unchanged (mtime will be fresh). Loop guards absorb the resulting
echo, but watch the counters for an hour after a clear.

## Loop guards

Forward and reverse will oscillate without guards - forward writes
Plane, Plane fires a webhook, reverse picks it up, reverse writes
vault, vault mtime bumps, forward picks up the bumped mtime, writes
Plane again. Three guards cover the three race windows:

1. **Origin stamp + hash match**. Issues/projects created by forward
   sync carry `external_id: "alfred:<slug>"`. On an inbound event, if
   `external_id` parses to a slug we own AND
   `compute_loop_guard_hash` of the inbound payload matches the last
   outbound signature for that Plane id, skip. Implemented in
   `check_loop_guards` (guard #1).

2. **Suppression window**. For every successful outbound PUT/POST we
   record `(plane_id -> {hash, ts})` in
   `state/plane_outbound_signatures.json`. Any inbound event within
   `_SUPPRESSION_WINDOW_MS = 30_000` (30s) whose hash matches is
   treated as the PUT's own echo -> skip. Covers the race where the
   webhook arrives before the outbound signature finishes persisting
   (guard #2).

3. **Field-level idempotency**. Inside `apply_plane_patch_to_vault`,
   we compute the loop-guard hash of the current vault frontmatter. If
   the inbound patch wouldn't change that hash, no write. No write
   means no mtime bump, so forward won't try to push back (guard #3).

Canonical guard fields (see `LOOP_GUARD_FIELDS` in
`packages/learn/src/utils/plane_mapping.py`): `name`, `description`,
`state` (normalised to Plane state group, never state UUID),
`priority`, `due_date`, `assignees` (sorted). Keep the list tight -
every extra field widens the chance of a spurious mismatch.

Both directions must hash with
`json.dumps(obj, sort_keys=True, separators=(",", ":"))` over the same
canonical field set, or guard #2 is a no-op.

## Inbox project

Any task whose `matter` frontmatter field does not resolve to a known
vault matter (garbage string, unsynced matter, empty) gets routed to a
workspace-level **Inbox** project (`identifier=INBOX`). Before #573
these tasks were `skip`-ed forever AND the skip held the forward
cursor, which froze the entire backfill.

- Created once by `ensure_inbox_project`; stored in `project_map`
  under the sentinel slug `__inbox__`.
- Reverse-sync knows about the sentinel: dragging an issue from Inbox
  into a real matter project propagates
  `related_matters=[<new-slug>]` + scalar `matter` onto the vault
  task.
- Dragging an issue back INTO Inbox clears `related_matters` and
  `matter`.

To move a task OUT of Inbox in the vault directly, set its
`related_matters: [<real-slug>]` or scalar `matter: <real-slug>`. The
next forward tick will create the issue in the real project and
reverse-sync will (eventually) reap the Inbox copy once you delete
it.

Do NOT delete the Inbox project from Plane. It gets recreated on the
next `ensure_inbox_project` call but you lose every issue currently in
it.

## Failure modes

Grep for your symptom. Every row is a bug we actually hit on David,
Miguel, or Rapali during B1-B8 + the follow-up hotfixes.

| Symptom                                                                                                                               | Cause                                                                                                                                                                 | Fix                                                                                                                                                                                                               | Reference |
|---------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------|
| `setup_plane` provisioner hangs forever on `waitForPlaneReady`; plane-api logs `wait_for_migrations` in a loop.                       | Plane 1.3.0 `plane-api` blocks on migrations, but no container was running them.                                                                                      | One-shot `plane-migrator` service (`restart: "no"`, runs `docker-entrypoint-migrator.sh`) with `plane-api depends_on: plane-migrator: service_completed_successfully`. In template today - verify it's present.   | #555, #556 |
| Plane-API healthcheck forever `unhealthy`; `docker inspect` shows `curl: not found`.                                                  | `makeplane/plane-backend:stable` ships `wget` but not `curl`.                                                                                                         | Healthcheck uses `wget -qO- http://127.0.0.1:8000/`. See the check block in `docker-compose.yaml.njk`.                                                                                                            | #557       |
| Plane-API healthcheck `unhealthy` even with `wget`; exit status 4 ("network unreachable") in `docker inspect`.                        | busybox `wget` resolves `localhost` to `::1` first; gunicorn binds IPv4 only.                                                                                         | Use `127.0.0.1` in every Plane healthcheck test. Same pattern for `plane-web`, `plane-proxy`.                                                                                                                     | #558       |
| `plane-web` / `plane-admin` / `plane-space` crash-loop with `node: command not found` or stack trace from node.js.                    | Prior compose had `command: ["node", ...]` overrides, but these images are nginx / `react-router-serve`.                                                              | Drop the `command:` overrides. Rely on image default CMD.                                                                                                                                                         | #559       |
| `plane-web` stays unhealthy; port probe shows nothing on 80.                                                                          | Image listens on `:3000` (its own bundled `nginx.conf`), not `:80`.                                                                                                   | Healthcheck against `127.0.0.1:3000`.                                                                                                                                                                             | #560       |
| `plane-live` exits with `LIVE_SERVER_SECRET_KEY is required`.                                                                         | Env var not seeded.                                                                                                                                                   | Seeded by `deployPlane` before first up; re-run deploy-plane or write `LIVE_SERVER_SECRET_KEY=$(openssl rand -hex 32)` into tenant `.env`.                                                                         | #561       |
| `plane-proxy` returns 502 for every path; Caddyfile references `web`, `admin`, `space`, `live`, `api`, but names don't resolve.      | The Plane Caddyfile uses bare hostnames. Compose service names include the `plane-` prefix.                                                                           | Each Plane container gets a `networks.default.aliases: [web/admin/space/live/api]`. See the `aliases:` blocks in the template.                                                                                    | #561       |
| `plane-proxy` OOM-killed or exits immediately on boot with cryptic Caddy error.                                                       | Bare `{ ... }` global block with no `SITE_ADDRESS` collapses Caddy parser into "global configuration, if used, must be first". OR mem_limit too low under load.       | `SITE_ADDRESS=:80` env var makes the Caddyfile a plain-HTTP listener with no ACME; bump `mem_limit` if OOM observed (128m is enough on small tenants).                                                            | #564       |
| `plane-worker` restarts every 60s; logs show `uv_thread_create assertion failure`.                                                    | 1g `mem_limit` + 256 `pids_limit` saturates under fresh-node healthcheck every 10s + MCP subproc load.                                                                | Template is `mem_limit: 2g`, `pids_limit: 256`. For noisy tenants bump `pids_limit: 512`.                                                                                                                         | #561, #570 |
| All Plane secrets written to `.env` on a single line (`PLANE_API_TOKEN=...PLANE_WORKSPACE_SLUG=...PLANE_ALFRED_USER_ID=...`).          | Earlier `writeTenantEnv` joined keys with a literal `\n` that `printf %s` does NOT interpret.                                                                         | Shipped fix uses repeated `printf '%s\n'`. If you hit a legacy tenant: manually split, chmod 600, restart alfred-learn.                                                                                           | #552, #554 |
| `setupPlane` fails with `image tag makeplane/plane-backend:stable-v0.30 does not exist`.                                              | Old pin referenced a tag Makeplane never published.                                                                                                                   | Template uses `:stable` on every Plane image. Pin to a specific `stable-v...` only if you've verified it on Docker Hub.                                                                                           | #554       |
| `setupPlane` fails with 403 CSRF / 404 on `/api/instances/admin/sign-up/` / anonymous cookie errors.                                  | Plane 1.3.0 public HTTP bootstrap flow is fundamentally broken.                                                                                                       | Bootstrap rewritten as a single `docker exec plane-api python manage.py shell` ORM script. 680 -> 220 lines. Idempotent via `get_or_create`. See `PLANE_BOOTSTRAP_PY` in `provisioner.ts`.                         | #566, #568 |
| Provisioner `tenantCurl` fails silently; tenant logs show the command but shell-expanded `$(date)` / `$()` at the wrong time.         | Script was passed as a heredoc; the remote bash expanded `$()` before we wanted it to.                                                                                | `tenantCurl` now base64-encodes every bash script it ships. Same pattern in `runPlaneBootstrap`.                                                                                                                  | #565       |
| Forward sync runs every tick but `matters_synced=0` even though the vault has 12 matters with fresh edits.                            | `_iso_to_epoch` regex required a time component; vault frontmatter has `created: 2026-04-08` (date-only); every record parsed to mtime 0.0; filter `mtime > 0` excluded them. | Regex loosened: `^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2})?)?`. If you still hit this: touch any matter (update any frontmatter field) and wait one tick; the patched mtime extractor will pick it up.          | #569       |
| Forward sync returns 400 `Project name cannot contain special characters` for matter "Family Life & Hanna's First Year".             | Plane 1.3.0 rejects `-`, `&`, `'`, `"` in project names.                                                                                                              | `_sanitize_plane_name` replaces `-`/`&` with space and drops quotes. Collapses whitespace. Falls back to "Untitled". See `packages/learn/src/activities/plane_sync.py`.                                            | #570       |
| Forward sync fails with `Connection refused 127.0.0.1:8080`.                                                                          | `PLANE_API_BASE_URL` was set to `http://127.0.0.1:8080` (host port); alfred-learn is inside the compose network and needs the in-network address.                     | Set `PLANE_API_BASE_URL=http://plane-proxy/` in tenant `.env`. The `:8080` mapping is HOST-side only.                                                                                                             | #570       |
| openclaw-workers gateway OOMs on boot; task_runs / flow_runs accumulate.                                                              | `task-registry-*.js` does `SELECT *` on both tables at boot.                                                                                                          | Bump openclaw-workers heap + `mem_limit` (see #567). Not a Plane bug per se, but Plane's busier Temporal activity schedule unmasks it.                                                                             | #567       |
| Forward sync only reads scalar `matter:` frontmatter; tasks emitted by hourly enrichment (array `related_matters`) go to Inbox.       | `_resolve_task_matter` originally checked scalar `matter` and `related_matter` only.                                                                                  | Extended to fall through to `related_matters[0]` when scalars absent. See `plane_sync.py` `_resolve_task_matter`.                                                                                                  | #571       |
| Reverse sync doesn't update `related_matters` when human drags an issue between projects in Plane UI.                                 | Reverse-sync patch only carried Plane-owned fields; didn't touch matter linkage.                                                                                      | Reverse-sync now reads `data.project` on `issue.updated` events, looks up `plane_project_to_slug`, and writes `related_matters` + `matter` - clearing both when moved into the Inbox project.                      | #571       |
| Plane rejects issue create/update with 400 `Invalid HTML passed` when task has no description.                                        | Plane 1.3.0 rejects `description_html: ""`.                                                                                                                           | Omit the field entirely when empty. See the `if description_html:` guard in `sync_task_to_plane`.                                                                                                                  | #572       |
| Forward cursor stuck at 0.0 for hours; `tasks_skipped` ticks up forever; hundreds of tasks never sync.                                | Tasks with unresolvable `matter` field (human free-text like "Manus AI billing") emitted `action: "skip"`, AND the old cursor logic refused to advance past any skip. | Unknown `matter` -> route to Inbox instead of skipping. Skips no longer hold the cursor; only real activity errors do. See `sync_task_to_plane` + `PlaneSyncWorkflow` cursor branch.                               | #573       |
| Reverse-sync reports `loop_guard_skipped` for every event; no vault updates ever land.                                                | `state/plane_outbound_signatures.json` got populated by a run with the wrong canonical field set and every inbound hash "matches" somehow.                            | Clear `state/plane_outbound_signatures.json`. Diff forward + reverse `compute_loop_guard_hash` calls on one sample - they must produce identical digests over the same payload.                                    | -          |

### Quick-diagnosis commands

```bash
# On a tenant VPS, `deploy` user, everything in /opt/alfred/compose.

AAS=$(grep ^AAS_API_KEY /opt/alfred/compose/.env | cut -d= -f2)

# Are both schedules registered?
docker exec compose-temporal-1 tctl --address 127.0.0.1:7233 schedule list \
  | grep -E 'al-plane-(sync|reverse-sync)'

# Latest forward-sync run summary (counters at the end).
docker compose logs --tail=200 alfred-learn 2>/dev/null \
  | grep -E 'plane_sync\.(start|done|project_upsert|issue_upsert)'

# Latest reverse-sync run summary.
docker compose logs --tail=200 alfred-learn 2>/dev/null \
  | grep 'plane_reverse_sync\.'

# Cursor state.
sudo cat /mnt/encrypted/alfred/state/plane_sync_cursor.json | jq .
sudo cat /mnt/encrypted/alfred/state/plane_reverse_sync_cursor.json | jq .
sudo cat /mnt/encrypted/alfred/state/plane_outbound_signatures.json | jq '. | length'

# Plane services health.
docker compose ps --filter name=plane-

# Plane-API reachable from inside alfred-learn?
docker compose exec alfred-learn python -c \
  "import os, httpx; print(httpx.get(os.environ['PLANE_API_BASE_URL'] + 'api/instances/', timeout=5).status_code)"

# Webhook round-trip (synthetic). Replace SECRET with the tenant's PLANE_WEBHOOK_SECRET.
SECRET=$(grep ^PLANE_WEBHOOK_SECRET /opt/alfred/compose/.env | cut -d= -f2)
BODY='{"event":"project","action":"updated","data":{"id":"test-uuid","name":"x","external_id":"alfred:nonexistent"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -s -X POST "http://localhost:3100/api/v1/plane/webhook" \
  -H "Content-Type: application/json" \
  -H "X-Plane-Signature: sha256=$SIG" \
  -H "X-Plane-Delivery: synthetic-$(date +%s)" \
  --data-raw "$BODY"
# Expect: {"ok":true,"delivery":"synthetic-...","forwarded":true}
```

## Deploying code changes to running tenants

The mid-workflow-deploy trap:

> `deploy-ctrl.yml` + `build-learn.yml` recreate alfred-learn
> mid-workflow. The in-flight `PlaneSyncWorkflow` /
> `PlaneReverseSyncWorkflow` run is abandoned by the worker. Temporal
> thinks it's still running; SKIP overlap policy means the next 100+
> ticks are skipped until the abandoned run hits its own timeout.

Every time you deploy a learn-side change that touches a Plane
workflow, follow this ritual:

```bash
# On the tenant VPS, AFTER the deploy lands.

# 1. Find in-flight plane workflow runs (should normally be 0 - the
#    runs are very fast). "Running" state here actually means "the
#    previous worker abandoned this and Temporal hasn't timed it out
#    yet".
docker exec compose-temporal-1 tctl --address 127.0.0.1:7233 wf list -q \
  "ExecutionStatus='Running' AND (WorkflowType='PlaneSyncWorkflow' OR WorkflowType='PlaneReverseSyncWorkflow')"

# 2. Terminate each hung run. Replace WF_ID with the workflow id from
#    step 1.
docker exec compose-temporal-1 tctl --address 127.0.0.1:7233 wf terminate \
  --workflow_id <WF_ID> --reason "post-deploy-cleanup"

# 3. Confirm the schedules are unstuck - next tick should start within
#    10-15s.
docker compose logs --tail=50 alfred-learn 2>/dev/null \
  | grep -E 'plane_sync\.start|plane_reverse_sync\.start' | tail -5
```

Alternative: `docker compose up -d --force-recreate alfred-learn`
before the deploy lands a change, but that's only safe when the plane
workflows aren't in the middle of a run.

Every alfred-learn deploy that touches Plane should be followed by one
minute of observation on counters:

```bash
watch -n 10 "docker compose logs --tail=50 alfred-learn 2>/dev/null \
  | grep -E 'plane_sync\.done|plane_reverse_sync\.done' | tail -6"
```

If counters keep climbing for the same matter/task slug across ticks,
either a loop guard is mis-computing the hash, or there's an error
path that re-enters without skipping - stop and investigate, don't let
it run.

## Emergency stop

```bash
# On the tenant.
sudo sed -i 's/^PLANE_SYNC_ENABLED=.*/PLANE_SYNC_ENABLED=false/' /opt/alfred/compose/.env
cd /opt/alfred/compose
docker compose up -d --force-recreate alfred-learn
```

Both workflows will then short-circuit at the feature-flag check
(`plane_sync_is_enabled` / `plane_reverse_sync_is_enabled`). The
register script on the next boot deletes both schedules so no ticks
even fire. Plane itself keeps running but is no longer coupled to the
vault until you flip the flag back on.
