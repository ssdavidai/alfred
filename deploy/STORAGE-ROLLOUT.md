# Storage Architecture Migration — Per-Tenant Rollout Runbook

> Status: **Active**. Tracks epic [#898](https://github.com/ssdavidai/alfred-platform/issues/898).
> Last updated: 2026-05-18 (Phase 0 in progress).
> Owner: Sir (one-stakeholder doc; this is a self-discipline runbook,
> not a customer-comms one).

This runbook covers how each phase of the Storage Architecture
migration (`STORAGE-ARCHITECTURE.md` in the repo root) ships across
the four production tenants. The migration is six phases deep; each
phase is shipped per-tenant with a smoke gate and a 48h soak between
tenants, so a regression in any one phase blasts at most one tenant
before we catch it.

The precedent for this style of doc is `deploy/CUTOVER.md` (Alfred
Black 1.0). The shape is the same: pre-flight, ordered rollout, smoke
gate, rollback, post-cutover. The difference is that this runbook is
run six times (once per phase) and re-uses the same scaffold.

---

## 1. The four tenants

| Tenant | Role | SSH alias | Notes |
|---|---|---|---|
| `david` | principal canary | `david` | Most demanding workload (87k vault files pre-P0-2). Pain landed here first; fixes land here first. |
| `preview` | parallel-preview validation | (see `MEMORY: preview-alfred-control.md`) | Tracks `main`; safety switches block writes to real tenants. Used to validate SaaS-plane changes that aren't tenant-local. |
| `rapali` | secondary canary | `rapali` | Medium-size vault; has ~3k legitimate `stream_event/` files that Phase 3 will migrate. |
| `miguel` | secondary | `miguel` | Quieter workload. |
| `raj313` | smallest | `raj313` | Smallest vault; useful for cheap bug-catching during data migrations. |

Tenant SSH aliases resolve via `~/.ssh/config` to `deploy@<tailscale-ip>`.
Use `-o IdentityAgent=none` to bypass the 1Password agent (see
`MEMORY: preview-saas-deploy-paths.md`).

## 2. Two rollout orders — pick the right one per phase

The migration has two kinds of work, and they get rolled out in
**opposite** orders.

### Order A — new behavior (the default)

For phases that *add* behavior (new endpoints, new write paths, new
workflows): land on **david first**, because the principal's workload
is the most demanding and surfaces edge cases that smaller tenants
won't.

```
david → preview (validation) → rapali → miguel → raj313
```

48h soak on david canary; if no regression, promote to rapali/miguel/
raj313 in parallel (they're smaller and similar to each other).

This applies to:

- Phase 1 (`vault_index` as read accelerator — new SQL table, new
  write hook, new boot-time scan)
- Phase 4 (stream log + raw TTL — new compactor workflow)
- Phase 5 (cold archive — new archival sweep)
- Phase 6 (vault demotion — new ctrl-api ingress rules)

### Order B — bulk data migrations

For phases that **bulk-mv** existing data (Phase 2 audit migration
moves ~80k files out of `event/`; Phase 3 stream-event migration moves
~7k records on david), land on **raj313 first**. Smallest tenant
catches migration-script bugs cheap. If a migration corrupts something,
you'd rather it corrupt raj313's 50 files than david's 80,000.

```
raj313 → miguel → rapali → david
```

48h soak on raj313 before promoting; then 48h between each subsequent
tenant. david goes last because it has the most to lose.

This applies to:

- Phase 2 (audit-table migration — bulk-mv 80k `event/*.md` into SQL)
- Phase 3 (signal/observation/embedding migration — bulk-mv stream
  events + signals + observations into SQL)

### Why Phase 0 doesn't fit either order

Phase 0 was an emergency stop-the-bleeding pass. Each of P0-1..P0-4
shipped immediately to all four tenants (with the audit-rescue script
run smallest-first inside the same day). The runbook applies from
Phase 1 onward; Phase 0 is documented here only so the smoke gate
can verify it remains in place.

---

## 3. The 48h soak rule

> Phase N never ships to tenant T+1 until tenant T has been on phase N
> for 48 hours with no regression.

"Regression" means any of:

- `bash scripts/smoke-storage.sh <phase> <tenant>` fails
- A new `clerk timeout` rate or workflow retry-storm appears on the
  target tenant in the SaaS-plane observability dashboard
- Any user-visible degradation (`/brief` falls back to "quiet
  morning", `/desk` empties, `/decisions` stops loading)
- Any new zombie workflow (see `MEMORY: zombie-workflow-cleanup-playbook.md`)

The 48h timer **resets** if any of the above appear. Fix first, then
soak again.

The soak applies between tenants *and* between phases on the same
tenant: e.g. Phase 2 doesn't start on david until Phase 1 has been on
david for 48h clean. This is the difference between a migration that
ships and one that stalls.

---

## 4. Smoke gate per phase

The smoke gate is `scripts/smoke-storage.sh <phase> <tenant>`. It
must exit 0 before promotion. Each phase's smoke is filled in as the
phase lands — the skeleton lives in the script.

### Phase 0 — bleeding stopped (LIVE)

`bash scripts/smoke-storage.sh 0 <tenant>` verifies:

- [x] `GET /api/v1/vault/list/matter` returns in <500ms (steady-state,
      median of 3 with warm cache) — pre-P0-1 baseline was 6–7s
- [x] `packages/learn/src/activities/briefing.py` contains the
      `list_active_matters_for_briefing failed` re-raise log (P0-3)
- [x] `packages/learn/src/workflows/nightly_maintenance.py` contains
      the `store-p0-4-drop-janitor-step` patched-marker (P0-4)
- [x] `/mnt/encrypted/vault/event/` has <200 files (P0-2 audit-rescue
      moved the misfiled audit records to typed subdirs)
- [x] `compose-alfred-learn-1` is running and has a parseable
      `StartedAt` timestamp

### Phase 1 — `vault_index` as read accelerator

TODO. Will be filled in when Phase 1 lands. Expected checks:

- [ ] `state.db` exists, has `vault_index` table, row count matches
      `find /mnt/encrypted/vault -name '*.md' | wc -l` ±5
- [ ] `GET /api/v1/vault/list/<every-known-type>` returns in <100ms
      (SQL query path, not `walkMd`)
- [ ] `alfred-ctrl reindex` CLI runs cleanly to completion
- [ ] Boot-time reconciler logs "vault_index OK" on ctrl-api startup
- [ ] No `walkMd` calls in ctrl-api's perf log for list endpoints

### Phase 2 — `audit` table

TODO. Expected checks:

- [ ] `state.db` `audit` table row count ≈ pre-migration `event/*.md`
      count (after audit-rescue routed types) for the tenant
- [ ] `GET /api/v1/audit/feed` returns in <100ms with sane pagination
- [ ] `/vault/event/` is empty (post-migration)
- [ ] `/decisions` page loads and shows recent rows from SQL
- [ ] Reversibility: a `reversible=1` audit row can be reversed end-to-end

### Phase 3 — `signal` + `observation` + `embedding`

TODO. Expected checks:

- [ ] `signal`, `observation`, `embedding` tables exist with row counts
      matching pre-migration markdown counts
- [ ] SignalExtractWorkflow writes new signals to SQL (no new
      `/vault/signal/*.md`)
- [ ] `/instincts/:id` shows observation count from SQL
- [ ] sqlite-vec extension loads on ctrl-api boot

### Phase 4 — stream log + raw TTL

TODO. Expected checks:

- [ ] `/vault/_raw/<date>/stream_event.jsonl` files exist
- [ ] Processed events older than 7d are gone
- [ ] Alert fires if an unprocessed event survives >7d
- [ ] EventProcessorWorkflow tail latency stable

### Phase 5 — cold archive

TODO. Expected checks:

- [ ] `/vault/_archive/<month>/audit.parquet` files exist for months
      older than 90d
- [ ] `state.db` audit row count is bounded (90d window only)
- [ ] Audit feed pagination crossing the 90d boundary returns the
      cold-tier rows correctly
- [ ] DuckDB attach works against the Parquet files

### Phase 6 — vault demotion final sweep

TODO. Expected checks:

- [ ] ctrl-api rejects writes to any vault type outside the
      canonical 12-type list (400 with a helpful error)
- [ ] CLAUDE.md and CONTRACT.md document the closed-set type list
- [ ] `/vault/` total file count is bounded at ~5,000 steady-state
      on david (the original principal-knowledge size)

---

## 5. Rollback per phase

Every phase that introduces a new writer ships with an
**enforcement env flag** that gives instant rollback. This is the
same pattern proven in the state-mutator rollout
(`packages/learn/docs/STATE-MUTATION.md`):

```
STATE_CHANGE_ENFORCEMENT=shadow   # write to new path AND old path; old wins
STATE_CHANGE_ENFORCEMENT=warn     # write to new path; warn on old-path writes
STATE_CHANGE_ENFORCEMENT=reject   # new path only; reject old-path writes
```

For each storage phase, the equivalent flag controls writer behavior:

| Phase | Flag | shadow | warn | reject |
|---|---|---|---|---|
| 1 | `VAULT_INDEX_ENFORCEMENT` | dual-write: SQL index + `walkMd` fallback | SQL index only, but `walkMd` keeps working | (n/a — read-only accelerator, no writers to flip) |
| 2 | `AUDIT_STORE_ENFORCEMENT` | dual-write audit to SQL **and** markdown | SQL only; warn on markdown writes from old callers | SQL only; reject markdown writes |
| 3 | `SIGNAL_STORE_ENFORCEMENT` | dual-write signals/observations | SQL only; warn | SQL only; reject |
| 4 | `STREAM_LOG_ENFORCEMENT` | new JSONL + old `/vault/stream_event/*.md` | new only; warn | new only; reject |
| 6 | `VAULT_TYPE_ENFORCEMENT` | accept-all (today's behavior) | accept-all, log non-canonical | reject non-canonical types |

**Rollback procedure for any of phases 1-6:**

1. SSH to the affected tenant.
2. `sed -i 's/^<FLAG>=.*/<FLAG>=shadow/' /opt/alfred/compose/.env`
   (or remove the line entirely; default is `shadow`).
3. `cd /opt/alfred/compose && docker compose restart ctrl-api alfred-learn`.
4. Re-run `bash scripts/smoke-storage.sh <previous-phase> <tenant>` to
   confirm the previous phase's invariants still hold.
5. Open a regression issue. Do **not** advance to the next tenant
   until the underlying bug is fixed and the phase re-deployed in `warn`.

Each sub-issue (`STORE-Pn-x`) has its own "Rollback" section with
phase-specific commands; this section is the cross-cutting summary.

### Phase 0 rollback

Phase 0 has no enforcement flag because it's pure code change
(walkMd scope, briefing re-raise, janitor patch) + a one-shot data
move (audit-rescue). Rollback is per-fix:

- Revert the relevant commit + redeploy via `deploy-ctrl.yml` /
  `build-learn.yml`.
- Audit-rescue is reversible via the `_rescue/audit-rescue-<date>.log`
  manifest each tenant carries (`mv` lines that can be played
  backwards). No data loss; only files moved.

---

## 6. Pre-flight checklist

Before any phase starts on any tenant:

- [ ] Restic snapshot of `/mnt/encrypted/` taken within the last hour.
      Verify with `restic snapshots --tag pre-storage-phase-N --host
      <tenant>` or whatever tagging convention is current.
- [ ] SaaS-plane observability dashboard (the alfred.black `/desk`
      health surface) shows green for the target tenant: no
      `clerk timeout` rate spike in the last 24h, no workflow
      retry-storm, no Caddy 5xx surge.
- [ ] No in-flight zombie Temporal workflows on the target tenant
      (see `MEMORY: zombie-workflow-cleanup-playbook.md`). Check via
      `temporal workflow list --query 'ExecutionStatus="Running" AND
      StartTime < "now-24h"'` from inside the temporal container.
- [ ] Previous phase has been on the target tenant for ≥48h with no
      regression (smoke-storage `<prev-phase>` passes).
- [ ] The sub-issue for this phase has its "Smoke" and "Rollback"
      sections filled in.
- [ ] You have ~30 minutes of un-distracted time. Migrations done in
      a hurry are the migrations that lose data.

---

## 7. What "shipped" means

Phase N is **shipped** (and its sub-issues closed) only when **all**
of these hold:

1. All sub-issue acceptance criteria are met (the boxes are checked).
2. `bash scripts/smoke-storage.sh N <tenant>` exits 0 for every
   tenant in the rollout order.
3. Each tenant has been on phase N for ≥48h with no regression.
4. The phase's writer flag (`<X>_ENFORCEMENT`) is in `reject` mode on
   every tenant (the migration is the new default; the old path is
   gone).
5. The phase's sub-issues are closed in GitHub.
6. The phase's row in the smoke gate table above is checked off.

Anything less and the phase is **in progress**, not shipped, even if
the code is on every tenant.

---

## 8. Communication

This is a one-stakeholder migration. The audience is Sir.

- **Per-phase kickoff:** drop a note in the daily brief that phase N
  is starting today on the canary tenant. No customer email.
- **Per-tenant promotion:** silent. The smoke gate is the signal.
- **Regression:** open a GitHub issue immediately, tag the epic
  (#898). Sir reads the issue queue daily.
- **Phase shipped:** check off the row in §4 and close the sub-issues.
  The epic body holds the running checklist.

No customer-facing maintenance windows are required for any storage
phase — every change is tenant-local and the data plane keeps serving
through the deploy. If a phase ever needs downtime, that's a redesign
flag, not a comms exercise.

---

## 9. References

- `STORAGE-ARCHITECTURE.md` — the proposal this runbook ships
- `deploy/CUTOVER.md` — precedent for this style of runbook
- `packages/learn/docs/STATE-MUTATION.md` — the enforcement-flag
  rollout pattern that phases 1-6 each re-use
- `scripts/smoke-storage.sh` — the smoke gate
- `scripts/audit-rescue.sh` — Phase 0 (P0-2) bulk-mv script
- `MEMORY: zombie-workflow-cleanup-playbook.md` — the kind of
  cleanup that should happen before a phase starts, not during it
- `MEMORY: preview-alfred-control.md` — preview/staging environment
