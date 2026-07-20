# FIX-CONTRACTS — frozen cross-lane interfaces

Every place a fix crosses a lane boundary is frozen here **before** any lane
codes. A consumer lane builds against the frozen shape; it never needs the
provider lane's code. If a contract is wrong, the lane **STOPs and reports** —
it does not improvise across the boundary. This file is in the Phase-0 forbidden
zone (no lane edits it).

Provider → consumer notation: *(Lane X provides → Lane Y consumes)*.

> **Status (added 2026-07-15).** This document remains forbidden-zone frozen
> truth: clauses C1–C11 were frozen 2026-05-20 (pre-cutover, commit `41f5678c`),
> C12–C19 on 2026-05-22 (commit `fcaad084`) from `debug/0522/SYNTHESIS.md`. The clause text below is
> historical and unedited — code comments cite these ids. A per-clause status
> table (end of this file) records what each clause looks like in the live
> tree as of the 2026-07-15 audit: **LIVE** (interface holding as frozen),
> **SUPERSEDED** (replaced by a named successor — the successor is now the
> binding shape), **NEVER-IMPLEMENTED** (frozen interface never built; the
> goal was met another way), **INCOMPLETE** (partially enforced; gaps cited).
> Statuses annotate, they do not amend. A lane that finds a status wrong
> STOPs and reports — this file is orchestrator/phase0-only.
>
> **C20 (frozen 2026-07-20 for issue #316)** is a new forward contract. Its
> provider and consumer implementations intentionally follow this phase-0
> contract change; the current synchronous worker routes are not evidence of
> the new interface.

---

### C1 · Observation counting + mark-processed *(I → II)*
- **`GET /api/v1/state/instinct-counts`** → `{counts: {<instinct_path>: int}}`,
  computed from **state.db** observations where `source_kind='decision'`, grouped
  by `instinct_ref`. ctrl repoints `instinctCounts.ts` here; `learning.ts` +
  `vault.ts` source `live_observation_count` from it (no more vault-FS walk).
- **`POST /api/v1/state/observations/mark-processed`** `{ids: [ulid]}` → stamps
  `processed_at`; returns `{ok, marked: int}`. learn's `mark_observations_processed`
  calls this with the ULID (not the vault path).
- **Invariant:** decision observations already carry `instinct_ref` via
  `create_observation`. Lane II verifies this; it does not redesign the write.
- Needs **C5** (the `processed_at` column).

### C2 · Signal status default = `unrouted` *(I → II)*
- A signal `INSERT` with no explicit status defaults to **`unrouted`**
  (`state.ts`). Lane II *also* passes `status="unrouted"` explicitly in
  `signal_state.py` (belt + braces; different file, no conflict).
- Lifecycle enum frozen: `unrouted → routed_human | routed_agent | dispatching | skipped | done`.

### C3 · Composio account pinning *(I → II)*
- The execute endpoint (`POST /api/v1/integrations/execute`) resolves the account
  via `resolve_active_connected_account_id(toolkit)` (newest ACTIVE) — **never**
  "first ACTIVE match" — and accepts an explicit `connected_account_id`. Lane II
  passes `connected_account_id` on every recurring pull (`pull.py`,
  `stream_puller.py`). The resolver is the single source of account selection.

### C4 · Desk action semantics *(I → III)*
- **One writer per action.** The per-source endpoint (`approve`/`skip`/`done`/
  `dispatch` via `attention`/`approvals`) is authoritative. `POST /decisions`
  records the audit decision **but does NOT also flip the source status** (the
  dual-write that races approve-vs-cancel is removed).
- Each action endpoint is idempotent and returns 2xx **only after** the source
  mutation commits.
- Web (Lane III) clears optimistically but **reconciles to the server response**;
  on failure it restores the card, and the source status is untouched because the
  server didn't pre-flip it.
- **Undo:** `POST /api/v1/decisions/:id/reverse` returns an honest `reversible`
  flag; the Ledger wires Undo for reversible rows; irreversible classes say so.

### C5 · Migration runner + the columns it adds *(Phase 0 owns)*
- Phase 0 builds `packages/ctrl/src/db/migrate.ts`: a `PRAGMA user_version`-gated
  applier for numbered `db/migrations/00NN_*.sql`, run transactionally at ctrl-api
  boot (this mechanism **does not exist today** — `schema.sql` is CREATE-IF-NOT-EXISTS
  only, so column adds silently no-op).
- Migration `0001` adds: `observation.processed_at TEXT NULL`; and sets/normalizes
  the signal status default per C2. Lanes consume the resulting columns; **no lane
  authors migrations** (forbidden zone).

### C6 · Ingest-event frontmatter shape *(II internal: pull → routing)*
- The ingest→record adapter output carries stamped `source_type`, `from`/`sender`,
  `event_type`. `pull.py` (pull task) owns the stamping; `signals.py` (routing)
  trusts it and, on `unknown`, **does not mark the event processed** (so it
  retries) instead of silently dropping real mail.

### C7 · Canonical runtime route prefix = `/api/v1/hermes/*` *(I → II, V)*
- **Decision (frozen):** ctrl (Lane I) **restores the `/api/v1/openclaw/*` alias**
  as a thin forward to `/api/v1/hermes/*` (smallest fix — one place). This un-breaks
  the ~7 callers (MCP `alfred.ts` tools, `briefing.py:1711`) without touching them.
  *(Alternative — repoint every caller — is larger and spread across II + V; not chosen.)*

### C8 · `notify_principal` channel resolution *(I → II, V consumers)*
- `pickPrimaryChannel()` (ctrl `notifications.ts`) **stops reading the deleted
  `/mnt/encrypted/openclaw/openclaw.json`**. The default `channel:"auto"` resolves
  from the Hermes session index / configured channels to a **deliverable** channel
  (telegram/slack/…), never `webchat`→424. Frozen: the resolution source is the
  Hermes session/channel config, and `auto` must never 424 when any deliverable
  channel exists.

### C9 · Owner identity env var = `OWNER_EMAIL` *(V → II)*
- The canonical name is **`OWNER_EMAIL`** (what the code reads). Lane V sets it in
  `docker-compose.yaml`, `.env.example`, and `bootstrap.sh` (today compose passes
  the wrong name `ALFRED_OWNER_EMAIL`). Lane II reads `OWNER_EMAIL` unchanged.

### C10 · `BriefingWorkflow` schedule input = positional `slot` string *(I → II)*
- Frozen: the schedule (`chores.ts` install-standard) passes a **positional string
  arg** `"morning"` / `"evening"` — matching `BriefingWorkflow.run(self, slot)` as
  written. Lane I fixes the schedule-create input (it currently passes a dict);
  Lane II keeps the workflow signature. The morning/evening discriminator is the
  positional value.

### C11 · Promotion-contract stance — RULED: **Fork A (enforce everywhere)** *(I + II)*
- **Decision (2026-05-20): enforce the contract everywhere.** This completes the
  storage cutover rather than papering over it.
- **Lane I (ctrl):** enforce `assertCanonicalVaultPath` on ALL vault write routes —
  the workhorse PATCH `/vault/records/*` and the bare-`fs.writeFileSync` routes
  (`learning.ts` `observation/`, `attention.ts` `event/`, `chores.ts`,
  `stateChanges.ts`, `decisions.ts`, `steward.ts`) must either route through the
  guarded write path or be re-pointed to the `state.db`/audit endpoints. Reconcile
  `KNOWN_TYPES` (the read allowlist) to the 12 canonical types so reads and writes
  agree.
- **Lane II (learn):** every writer of a demoted type (`observation`, `event`/audit
  classes, `signal`, `pattern_proposal`, …) writes through the `state.db`/audit
  endpoints (C1-style), never markdown. This is the same cutover as bugs #1/#2/#7/#8
  — Fork A makes it total.
- **Sequencing:** this is **PR-1 (foundational)** — most of the storage-dependent
  fixes sit on top of it. It needs the migration runner (C5) under it. Because it
  ripples across I + II, those two lanes coordinate via C1/C2/C6 and the per-route
  contract; each individual reroute is still a ≤200-LOC task.
- **Risk:** rerouting a writer that the UI silently depends on can blank a surface.
  Mitigation: each reroute is failing-test-first (prove the old path 422s / the new
  path persists + the consumer still reads it) before it lands.

---

## New contracts — 0522 fix campaign (C12–C19)

Frozen from `debug/0522/SYNTHESIS.md` §3. Consumers build against these shapes; a
provider lane never exposes a different shape without re-freezing here first.

### C12 · Audit ledger read endpoint *(I → III)*
`GET /api/v1/admin/audit?limit=&include_automated=0&cursor=<ts>` reads **`state.db audit`**
(the SQL ledger, via the existing `/api/v1/state/audit` hot+cold plumbing) — NOT
`event/*.md`. Returns `{items:[{id,ts,action_type,actor,headline,note,source,reversible,reversed_at}], total, next_cursor}`.
**One row per user action** (not the needs_attention_action + desk-action twin); `action_type`
normalised to one casing (F5) before grouping; `include_automated=1` surfaces steward/auto noise.

### C13 · ctrl→Hermes workspace write target *(I+V → III editor)*
Workspace writes (`SOUL.md`, `AGENTS.md`) land where the `main` gateway loads them: ctrl-api
gets read/write to the Hermes profile dir (mount `hermes_data` into ctrl-api, or a Hermes write
API). `SOUL.md`→`HERMES_HOME/profiles/main/SOUL.md`; `AGENTS.md`→the main gateway's `TERMINAL_CWD`
dir. **Standing rules = a sentinel `## Standing Rules` block inside `AGENTS.md`** (already
allow-listed; no new workspace file).

### C14 · Email provision *(I → III)*
`POST /api/v1/email/provision {api_key}` → `200 {configured, inbox_address, inbox_id, webhook_registered}`
/ `4xx {error,code}`. `GET /api/v1/email/status` → `{configured, inbox_address|null}`. Web
`getEmailChannelStatus` proxies status; the card branches on `configured`.

### C15 · Phone provision *(I + web-SaaS → III wizard)*
`POST /api/v1/phone/provision {openai_api_key, twilio_account_sid, twilio_auth_token, phone_number?|buy:{country,area_code?}}`
→ `200 {phone_number, provisioned}` / `4xx {error,code}`. ctrl persists creds (extended
`KNOWN_CREDENTIALS`) + (re)starts voice-bridge. SaaS exposes `/api/internal/{voice-bridge/tenant/:id,twilio/send-sms,twilio/initiate-call}`
+ `/api/twiml/say` + inbound voice/SMS webhooks (Bearer `VOICE_BRIDGE_INTERNAL_TOKEN`).
`GET /api/v1/phone/config` → `{phoneNumber, authorizedNumbers, recentActivity}` (web reads
those exact keys).

### C16 · Approval-secret reveal-once + rotate *(I → III)*
`GET /api/v1/claude-setup` → `{…, approval_secret: null, approval_secret_set: bool, last_rotated_at}`
(never echo the value). `POST /api/v1/claude-setup/approval-secret/rotate` → `200 {approval_secret}`
returned **exactly once**. Same reveal-once for `vault_login.master_password`; stored hashed at rest.

### C17 · Model-config matrix API *(I → III)*
`GET /api/v1/admin/models[?refresh=true]` → `{groups:[{provider,source,models:[{id,name,…}]}], cached, fetchedAt}`
(catalog reads a *reachable* cred source — F65; `refresh` actually busts cache — F66; web reads
`groups`, not `models`). `GET /api/v1/admin/profiles` → `{profiles:[{id,gateway_port,default_model,resolved_model,description,agents:[…]}], surveyor:{…}}`
incl. **`heavy`** (F67). `PATCH /api/v1/admin/agents/:agentId/model {model,field?}` → `{default_model}`.

### C18 · Decision record = single source of truth *(I → II + III)*
`POST /api/v1/decisions {source, source_record, intent, note}` (one call/click): (1) write
`decision/<ts>.md` **and `indexVaultWrite()`** it (F1) so readers see it same-request; (2) mirror
to `state.db audit`; (3) synchronous source-flip only for done/defer/noise/take_mine — **delegate**
flips NA→dispatched only *after* dispatch succeeds, returning the result. `GET /api/v1/decisions`
(the `vault_index` reader) + learn `list_decisions_by_state("open")` then return rows. Client
clears the card **only on 2xx** (F50).

### C19 · Vault graph focus/backlinks *(I → III)*
`GET /api/v1/vault/graph?focus=<record_path>` → `{nodes, edges, activity, backlinks:[{path,name,rel}]}`.
`LINK_FIELDS` extended with `key_people, related_persons, related_orgs, org` (F10) so person/matter
edges resolve; `MatterDetailPage` consumes `backlinks` (F55).

### C20 · Durable worker-run ledger + asynchronous control API *(I ↔ IV; II consumes)*

Janitor fixes and distiller extractions are durable asynchronous runs. Their
canonical ledger is the `alfred_data` volume-relative directory
`state/worker-runs/`, with one atomically replaced JSON file per run at
`state/worker-runs/<run_id>.json`. The same directory is visible to ctrl-api as
`/alfred-data/state/worker-runs/` and to the vault worker as
`/app/data/state/worker-runs/`; these are two container paths for one ledger,
not separate stores.

Every worker run record has this closed JSON top-level shape (timestamps are
RFC 3339 UTC strings or `null`):

```json
{
  "run_id": "01K0ABCDEF23456789GHJKMNPQ",
  "worker": "janitor",
  "trigger": "manual",
  "status": "queued",
  "started_at": null,
  "finished_at": null,
  "progress": {
    "files_scanned": 0,
    "issues_found": 0,
    "files_fixed": 0,
    "files_deleted": 0
  },
  "error": null,
  "last_success_at": null,
  "failure_streak": 0
}
```

- `run_id` is a ULID; its embedded timestamp is the canonical enqueue time.
  `worker` is `janitor | distiller`, `trigger` is `manual | scheduled`, and
  `status` is `queued | running | complete | failed | timed_out`.
- `progress` is selected by `worker`. Janitor counters are
  `{files_scanned, issues_found, files_fixed, files_deleted}`. Distiller
  counters are `{candidates_found, candidates_processed, batches,
  records_created}`. Every counter is a non-negative integer and starts at 0.
- `started_at` is `null` until execution begins; `finished_at` is `null` until
  a terminal state. `error` is `null` for queued/running/complete and a
  non-empty string for failed/timed_out.
- `last_success_at` is the most recent `finished_at` of a complete run for the
  same worker, including the current run after it completes, or `null` if that
  worker has never completed successfully. `failure_streak` is the number of
  consecutive failed/timed_out runs since that success; complete resets it to
  0. Queued/running records carry the current snapshot of both fields.

Writer ownership is frozen: **ctrl-api** mints `run_id`, chooses `worker` and
`trigger`, initializes the worker-specific zero counters and reliability
snapshot, and durably creates the record in `queued`. Those identity fields
are immutable. The **vault worker** is the only writer after handoff: it stamps
`started_at` with `running`, updates `progress`, and writes exactly one terminal
status together with `finished_at`, `error`, `last_success_at`, and
`failure_streak`. All updates use temp-file + atomic rename so readers never
observe partial JSON.

The ctrl surface is:

- `POST /api/v1/workers/janitor/fix` and
  `POST /api/v1/workers/distiller/run` durably enqueue and return
  **`202 {run_id,status}`** without waiting for worker completion. While that
  worker has a queued/running record, another POST is idempotent: it returns
  the same active `run_id` and current status and does not enqueue a second
  run. Scheduled callers identify `trigger: "scheduled"`; otherwise it
  defaults to `manual`. Existing distiller filters such as `project` remain
  request inputs, not run-record fields.
- `GET /api/v1/workers/runs/:run_id` returns the complete ledger record, or
  404 for an unknown ULID.
- `GET /api/v1/workers/status` includes a `workers` map with `janitor` and
  `distiller`. Each entry carries `active_run_id`, `active_status`, freshness
  classification `idle | stalled | failed | complete`, `last_success_at`,
  `failure_streak`, `queue_age_ms` (ULID enqueue age while queued, otherwise
  `null`), and `last_queue_latency_ms` (latest started run's
  `started_at - ULID timestamp`, otherwise `null`). `stalled` takes precedence
  when an active queued/running run exceeds its configured bound; otherwise
  the latest terminal run yields `failed` or `complete`, and no terminal
  history yields `idle`. Legacy daemon detail may remain additive, but these
  per-worker fields and meanings are stable.

---

## Per-clause status table (2026-07-15 audit)

| Clause | Status | Evidence (verified on main, 2026-07-15) |
|---|---|---|
| **C1** · Observation counting + mark-processed | **NEVER-IMPLEMENTED** (endpoints) — goal met otherwise | Neither frozen endpoint exists: no `GET /api/v1/state/instinct-counts`, no `POST /api/v1/state/observations/mark-processed` anywhere in `packages/ctrl/src` (grep-clean). The goal landed via different interfaces: in-process `getInstinctCounts()` (`packages/ctrl/src/api/instinctCounts.ts:32-46`, state.db `observation WHERE kind='decision' GROUP BY instinct_ref`, 30s TTL cache) consumed by `learning.ts:544` + `vault.ts:712-716` for `live_observation_count`; learn marks processed via `PATCH /api/v1/state/observations/:id {status:"processed"}` (`packages/learn/src/activities/vault.py:851-868` → `packages/learn/src/utils/state_client.py:266`); reads use the semantic `?status=unprocessed` filter (`packages/ctrl/src/api/routes/state.ts:281-291`). Migration `0001_fix_pack.sql` added `observation.processed_at`, but the live mark path flips `status`, not `processed_at`. Consumers coding "against C1" must target these interfaces, not the frozen ones. |
| **C2** · Signal status default = `unrouted` | **LIVE** (enum text stale) | Default holds on both sides: ctrl `state.ts:191-193` (absent status → `'unrouted'`); learn `packages/learn/src/utils/signal_state.py:164` (explicit default, belt+braces). The frozen lifecycle enum (`… dispatching | skipped | done`) is stale: live terminal names are `routed_suppressed` (`packages/learn/src/activities/signal_actions.py:2066`) and `agent_responded` (`signal_actions.py:1522,1555`); canonical vocab is in root `CLAUDE.md` §6.4. |
| **C3** · Composio account pinning | **LIVE** (learn) / drifted on ctrl execute | learn pins on backfill + metadata paths via `resolve_active_connected_account_id` — newest-ACTIVE by `created_at` (`packages/learn/src/integrations/composio_client.py:156-186`; call sites `packages/learn/src/activities/pull.py:954-959, 1050-1060`); `composio_pull` accepts an explicit `connected_account_id` param (`pull.py:1116+`). Drift: ctrl's `POST /api/v1/integrations/execute` (`packages/ctrl/src/api/routes/integrations.ts:3347-3384`) resolves via `fetchAllOwnedConnectedAccounts` + **first** ACTIVE match for the toolkit and does **not** accept a body `connected_account_id`. Mitigation making the drift mostly moot: the reconnect grace flow (`integrations.ts:904-1006`) deletes older duplicates so ≤1 ACTIVE per toolkit normally exists. |
| **C4** · Desk action semantics (no dual-write) | **SUPERSEDED** by C18 + the 2026-05-24 synchronous-flip redesign | C4's core rule ("`POST /decisions` does NOT flip the source status") was deliberately reversed: `decisions.ts:290-534` performs the synchronous source flip per intent (`synchronousFlipOk`, `side_effects.synchronous_flip = true` at :534), with DecisionRouter's 7 `if not synchronous_flip` guards skipping the double-act (`packages/learn/src/activities/decision_router.py:389,502,621,824,831,908,931`; flag read at :326 — the in-code comments at `decisions.ts:560` and `attention.ts:222` still cite the historical offsets `194,307,…`, now stale). Surviving C4 parts: the legacy per-source endpoints still exist and mint mirror decisions (`attention.ts:590,638,666` via `mintDecisionMirror`, `attention.ts:243`, guarded by `decision_origin` — see root `CLAUDE.md` §15.3), and the Undo endpoint is live (`POST /api/v1/decisions/:id/reverse`, `decisions.ts:982`, honest `reversible` flag). Build against C18 (+ C-B4/C-B5 amendments), not C4. |
| **C5** · Migration runner | **LIVE** | `packages/ctrl/src/db/migrate.ts` — `PRAGMA user_version`-gated (`migrate.ts:70-73`), transactional, boot-applied. 18 numbered migrations exist (`packages/ctrl/src/db/migrations/0001…0018`); `0001_fix_pack.sql` adds `observation.processed_at` + index as frozen. Forbidden-zone discipline holding (migrations are orchestrator-only). |
| **C6** · Ingest-event frontmatter shape | **SUPERSEDED** (shape) — invariant preserved | The "pull.py owns the stamping; signals.py trusts it" split is gone. Live: `signals.py` derives source type itself via the multi-tier open-world `_infer_source_type` (`packages/learn/src/activities/signals.py:416-544` — explicit `source_type` fm is tier 0, composio app tokens never map to `unknown`), on the #78 Design-B path (signals extracted directly from ingest.db). The C6 **invariant survives**: an event whose *only* defect is unclassifiable source is NOT marked processed — it retries (`_is_unknown_source_only_drop`, `signals.py:893-912`; pre-filter reject at `signals.py:843-845`); genuine garbage is terminally dropped + marked (`signals.py:175-205`). |
| **C7** · `/api/v1/hermes/*` canonical + `/api/v1/openclaw/*` alias | **LIVE** | `packages/ctrl/src/api/routes/hermes.ts:156-168` — every handler registered under BOTH prefixes via the `dual()` helper, same closure (genuine thin forward, no divergent copy). In-code comment cites C7. |
| **C8** · `notify_principal` channel resolution | **LIVE** | `packages/ctrl/src/api/routes/notifications.ts:127-142` — `resolveAutoTarget()` = `resolveDeliveryTarget("last")` off the native Hermes session index; never yields `webchat`; returns undefined (honest 424) only when no deliverable session exists. In-code comment cites C8 and the deleted `/mnt/encrypted/openclaw/openclaw.json` path it replaced. |
| **C9** · `OWNER_EMAIL` canonical | **LIVE** | `.env.example:92-95` defines `OWNER_EMAIL`; `docker-compose.yaml:730-736` sets both `OWNER_EMAIL` and the legacy-reader mirror `ALFRED_OWNER_EMAIL` from the same `.env` value (compose comment cites C9); also pinned on ctrl-api at `docker-compose.yaml:221-223`. |
| **C10** · `BriefingWorkflow` positional `slot` | **LIVE** | `packages/ctrl/src/api/routes/chores.ts:351-368` — schedule input is the positional JSON string `"morning"`/`"evening"` (`BRIEFING_SLOT_BY_TEMPLATE`); workflow signature unchanged: `packages/learn/src/workflows/briefing.py:76` `run(self, slot: Literal["morning","evening"])`. In-code comment at `chores.ts:1684` cites C10. |
| **C11** · Promotion contract Fork A (enforce everywhere) | **INCOMPLETE** | The gate exists and bites (`assertCanonicalVaultPath`, `packages/ctrl/src/db/promotionContract.ts:149`; 422 `PROMOTION_CONTRACT_VIOLATION`) but is called only from `vault.ts` (`packages/ctrl/src/api/routes/vault.ts:759, 899, 1178`). Gaps, all verified: **(a)** bare `fs.writeFileSync` vault writes persist outside the guard — `attention.ts:48` (`EVENTS_DIR = VAULT_PATH/event`) + `:186` and `:736` still write demoted `needs_attention_action` / `desk_action` records as `vault/event/*.md` (dual-written with the state.db audit mirror; in-code comment defers the reader cutover to "Phase 2"); `attention.ts:140,350,486` patch NA/signal markdown in place; `approvals.ts:39`; `chores.ts:437,726,940,1729` and `decisions.ts:626,887,1002` write canonical types (`chore`, `decision`) but mechanically bypass the guard. **(b)** `KNOWN_TYPES` (read allowlist, `vault.ts:153-177`) was never reconciled to the canonical 12 — it still lists ~25 types incl. demoted `event`, `observation`, `pattern_proposal`, `stream_event`, `signal_noise_pattern`. **(c)** `needs_attention` is an explicit interim carve-out (`promotionContract.ts` `CANONICAL_NON_RECORD_DIRS`, comment cites #78/#28). Fork A is directionally in force but not "total" as ruled. |
| **C12** · Audit ledger read endpoint | **LIVE** | `packages/ctrl/src/api/routes/admin.ts:672-700` — `GET /api/v1/admin/audit?limit&include_automated=0&cursor=<ts>` reads state.db `audit` via `queryAuditCrossTier` (hot+cold), NOT `event/*.md`; response shaped by `toC12AuditItem`; automated rows filtered unless `include_automated`. In-code comment cites F4/C12. |
| **C13** · Workspace write target | **LIVE** | `packages/ctrl/src/api/routes/workspace.ts:8-55` — `SOUL.md` and `AGENTS.md` route to the Hermes **main profile dir** (`PROFILE_DIR_FILES`, `workspace.ts:36`); standing rules = `## Standing Rules` sentinel block upserted INSIDE the profile-dir `AGENTS.md` (RULES.md alias, `workspace.ts:16-17,40`); `hermes_data` is mounted into ctrl-api (`docker-compose.yaml:555`, inside the `ctrl-api` service block at :546). |
| **C14** · Email provision | **LIVE** (+ per-profile superset) | Frozen single-tenant shape intact: `POST /api/v1/email/provision {api_key}` → `200 {configured, inbox_address, inbox_id, webhook_registered}` / `4xx {error, code}` (`packages/ctrl/src/api/routes/email.ts:226-260`, comment cites C14); `GET /api/v1/email/status` → `{configured, inbox_address|null}` (`email.ts:211-218`). Additive per-profile variant since shipped: `GET/POST /api/v1/channels/email/{status,provision}?profile=<slug>` (`channelsEmail.ts:650-704`). |
| **C15** · Phone provision | **LIVE** (ctrl) — `buy:` and SaaS legs diverge | `POST /api/v1/phone/provision` implements the frozen body/response exactly and cites "Contract C15" in-code (`packages/ctrl/src/api/routes/phone.ts:740-760`); persists creds + restarts `voice-bridge` (a real compose service, `docker-compose.yaml:763-765`); `GET /api/v1/phone/config` live (`phone.ts:690-692`). Divergences: `buy:{…}` returns `400 buy_not_supported` (BYO number only, `phone.ts:749`); the "web-SaaS" internal endpoints are not in this repo — `phone.ts:72-73` still points `SAAS_INTERNAL_URL` at `https://alfred.black` for `/api/internal/twilio/{send-sms,initiate-call}` (`phone.ts:628, 1020`). Treat the SaaS leg as **dormant, not deployed** on the single-VM stack (provider lives outside this tree; unverified end-to-end — TODO below). |
| **C16** · Reveal-once + rotate | **LIVE** (approval secret) / master-password sub-clause **SUPERSEDED** | Approval secret exactly as frozen: `GET /api/v1/claude-setup` returns `approval_secret: null, approval_secret_set, last_rotated_at` (`packages/ctrl/src/api/routes/claudeSetup.ts:264-267`); `POST /api/v1/claude-setup/approval-secret/rotate` returns the value exactly once (`claudeSetup.ts:275-294`, comment cites C16). The `vault_login.master_password` reveal-once sub-clause was deliberately reversed: the GET returns the full password every time behind the dashboard Reveal toggle, and it is not hashed at rest (`claudeSetup.ts:230-262` — in-code rationale: the principal must retrieve it on every Vaultwarden sign-in; F62). |
| **C17** · Model-config matrix API | **LIVE** | `GET /api/v1/admin/models[?refresh=true]` (`packages/ctrl/src/api/routes/models.ts:385-386`; cache bust wired via `credentials.ts:245`); `GET /api/v1/admin/profiles` including `heavy` :18791 (`agents.ts:326-329`, profile table `agents.ts:59`, comment cites C17); `PATCH /api/v1/admin/agents/:agentId/model` (`agents.ts:371-372`). |
| **C18** · Decision record = single source of truth | **LIVE** (amended by C-B4/C-B5 + the 2026-05-24 `state=open` fix) | `POST /api/v1/decisions`: writes `decision/<ts>.md` + `indexVaultWrite()` same-request (`decisions.ts:626, 636` — F1); mirrors to state.db audit (`decisions.ts:651` area); synchronous source flip per intent with `side_effects.synchronous_flip` (`decisions.ts:290-534`); delegate flips NA→dispatched only after dispatch succeeds (`decisions.ts:361-363`, F2/C18 comment). Amendment beyond the frozen text: **every** intent now mints `state: "open"` (`decisions.ts:568` `initialState = "open"`, rationale block :550-567) so DecisionRouter always runs `extract_observation_from_decision`; the router flips to `completed` itself. Root `CLAUDE.md` §6.3 documents the amended shape. |
| **C19** · Vault graph focus/backlinks | **LIVE** | `GET /api/v1/vault/graph?focus=` (`packages/ctrl/src/api/routes/vault.ts:1310`); `LINK_FIELDS` includes `key_people, related_persons, related_orgs, org` (F10) plus later `related_places, place` (B9) (`vault.ts:1316-1327`); `backlinks:[{path,name,rel}]` computed for the focused record (`vault.ts:1452-1462`). |
| **C20** · Durable worker-run ledger + asynchronous control API | **FROZEN — implementation pending (#316)** | Current `packages/ctrl/src/api/routes/workers.ts` still blocks on `dockerExec` and returns 200; current `packages/learn/src/activities/maintenance.py` consumes the synchronous body. Provider/consumer lanes must replace those paths with the C20 ledger and 202/poll contract rather than preserving observed legacy behaviour. |

---

## Registered post-campaign clauses

Sweep of the main tree for clause-style ids the doc never registered
(`git grep -nE "C-B[0-9]|C-OB|C-SHA"`, 2026-07-15). Eight real ids found —
all cited by shipped code/tests, none registered here until now. (`C-SHA`
matched only `HMAC-SHA-256`-style prose — no such clause family exists.)
One-line registrations; the cited files are the frozen source of truth:

- **C-B2** — `packages/ctrl/src/api/routes/matters.ts:72` (also :162, :520; test `packages/ctrl/tests/matters-key-entities.test.ts`) — froze the matter-detail `key_entities` shape: key people/orgs resolved to `person/`/`org/` vault paths, `path: null` when no record resolves *(I → III)*.
- **C-B4** — `packages/ctrl/src/api/routes/decisions.ts:538, 554` (test `packages/ctrl/tests/decisions-defer-resurface.test.ts`) — froze defer semantics: a `defer` decision stays `state=open` even after its synchronous source flip, and the 201 carries a resurface contract so learn's decision_router re-opens the NA at `resurface_at` *(I → II + III)*.
- **C-B5** — `packages/ctrl/src/api/routes/decisions.ts:278, 308, 651`; `attention.ts:531` (test `packages/ctrl/tests/decisions-provenance.test.ts`) — froze decision/NA provenance: `matter_ref`/`task_ref` ride explicitly on the decision record, the needs-attention list payload, and the audit row *(I → II + III)*.
- **C-B6** — `packages/learn/tests/test_instinct_threshold_floor.py:1`; `test_discretion.py:63` — froze the discretion floor: the observation-earned bar is a FLOOR in the runtime gate; an explicit per-instinct `discretion_threshold` is raise-only. Its original "never seed instincts" sub-rule is superseded by C-OB4 (`packages/learn/tests/test_packs_opus_instinct.py:235`) *(II internal)*.
- **C-OB1** — `packages/ctrl/src/api/middleware/onboarding_quality_gate.ts:1` (rule table :117; enforced at vault POST `vault.ts:762`; report `GET /api/v1/onboarding/quality-report`, `workflows.ts:197`; USER.md allowlist source `workspace.ts:156`; curator side `packages/alfred-vault/src/alfred/curator/note_filter.py:26`) — froze the onboarding promotion-quality gate: Unicode-aware person/org plausibility, facts-grounded orgs, fragment-matter + per-service-sender-summary rejection *(I + IV → II)*.
- **C-OB2** — `packages/learn/src/activities/onboarding_v3.py:1385-1438` — froze the `vault/RULES.md` shape: fixed frontmatter + four rule sections, honored by the renderer and the web editor *(II → III)*.
- **C-OB3** — `packages/learn/src/activities/desk_seed.py:1` (card renderer :157) — froze the day-one Desk seed: `needs_attention` card markdown for seeded cards so the principal's first `/desk` landing is populated *(II → I + III)*.
- **C-OB4** — `packages/learn/src/activities/packs_opus.py:2664-2694` (applied by both `packs_opus.py` and `packs.py`, e.g. `packs.py:466, 593`) — froze the unearned-instinct seeding caps at `observation_count == 0`: `tier=Asking`, `status=unconfirmed`, `confidence_score ≤ 0.4`, `discretion_threshold` floored at **0.95** (`_UNEARNED_DISCRETION_FLOOR`; nearby prose saying "≥ 0.7" understates the code constant). Supersedes C-B6's "never seed" sub-rule *(II internal; I reads the caps via the discretion gate)*.

---

## Open items (2026-07-15 verification)

- **TODO(C15):** the `SAAS_INTERNAL_URL` → `/api/internal/twilio/*` leg
  (`phone.ts:628, 1020`, default `https://alfred.black`) has no provider in
  this repo; whether SMS-send / call-initiate work on a single-VM tenant was
  not verified end-to-end. Marked "dormant, not deployed" pending a live probe.
- **TODO(C2):** live signal-status writers were spot-checked
  (`routed_suppressed`, `agent_responded`, `dispatching`), not exhaustively
  enumerated; the authoritative vocab statement lives in root `CLAUDE.md` §6.4.
- **TODO(C1 invariant):** "decision observations carry `instinct_ref`" is
  relied on by `instinctCounts.ts`'s query and documented in root `CLAUDE.md`
  §7, but the `create_observation` write path was not re-traced this audit.
