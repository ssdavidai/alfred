# FIX-CONTRACTS — frozen cross-lane interfaces

Every place a fix crosses a lane boundary is frozen here **before** any lane
codes. A consumer lane builds against the frozen shape; it never needs the
provider lane's code. If a contract is wrong, the lane **STOPs and reports** —
it does not improvise across the boundary. This file is in the Phase-0 forbidden
zone (no lane edits it).

Provider → consumer notation: *(Lane X provides → Lane Y consumes)*.

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
