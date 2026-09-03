# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and human contributors working in
the `alfred-black` repo. This file is **the source of truth** for: what this
system is, how it's organized, the contracts everything else honours, the
fix-fan-out protocol, and the gotchas you'll otherwise relearn the hard way.

If you're new — read this end-to-end **once**, then keep it open as
reference. Most production incidents we've shipped through map cleanly to a
section here.

---

## 1. What this repo is

`alfred-black` is the single-VM, `docker compose up` reframing of the old
`alfred-platform` SaaS fleet: **one repo, one VM, one stack**. No Hetzner
auto-provisioning, no operator-owned Tailscale tailnet, no Cloudflare
provisioning, no billing.

(Note: there IS an optional Tailscale sidecar, off by default — see §15
"Optional Tailscale opt-in (#109)". It's the *principal's* tailnet, not
the operator's. The old SaaS-era admin tailnet does not exist in this
repo.)

The AI runtime is **Hermes Agent** (`NousResearch/hermes-agent`), which
replaces OpenClaw's two-container split with one Docker image running
three isolated profiles (`main` / `workers` / `heavy`).

Target outcome: a user with a Linux VM can `git clone`, fill `.env`, run
`./scripts/bootstrap.sh`, then `docker compose up -d`, and have a working
Alfred at `https://<their-domain>` with TLS, the dashboard, all 5 sidecars
(Plane, Sure, Vaultwarden, Hermes, the chat surface), and the full
intelligence layer.

Design rationale lives under `docs/design/` + `docs/specs/`; the
architecture contracts are §5–§10 here. Read them before making
structural changes.

---

## 2. Repo structure

```
alfred-black/
├── docker-compose.yaml      single static stack — pull-only, never builds
├── .env.example             single env template
├── scripts/
│   ├── bootstrap.sh         generates secrets, validates .env (run once pre-`up`)
│   └── hooks/               the commit gate (see §11)
├── caddy/
│   └── Caddyfile            reverse proxy + automatic Let's Encrypt TLS
├── packages/
│   ├── web/                 Wasp dashboard (auth + UI; proxies to ctrl-api)
│   ├── ctrl/                ctrl-api: tenant API server (:3100) + 4-store layer
│   ├── learn/               alfred-learn: Temporal intelligence layer (Python)
│   ├── alfred-vault/        the Python vault daemon (validator; separate package)
│   ├── mcp-server/          MCP app bundle (alfred/sure/vaultwarden/execute/…)
│   ├── vault-init/          Vaultwarden bootstrap
│   ├── hermes/              Hermes runtime image (Dockerfile + supervisor.sh + init/)
│   ├── voice-bridge/        Twilio/telephony bridge (own image + CI)
│   ├── paperclip/           Paperclip adapter (own image + CI; see docs/PAPERCLIP-BOOTSTRAP-CONTRACT.md)
│   ├── alfred-mac/          Alfred Black for macOS — menu-bar app pairing a Mac's Claude Cowork with the tenant's continuity layer (SwiftPM; see its README)
│   └── setup/               first-run setup wizard (own image + CI)
├── docs/
│   ├── lane-protocol.md     CANONICAL lane protocol (mirrored in the operator harness)
│   ├── FAILURE-MODES.md     ranked bug catalogue (historical; stamped)
│   ├── FIX-PLAN.md          lane fan-out plan (historical — protocol now lives here + §11)
│   ├── FIX-CONTRACTS.md     frozen cross-lane interfaces (Cn…)
│   ├── design/ specs/       design rationale + per-issue specs
│   └── operators/           ops runbooks
├── design-system/           the Alfred Black brand system — tokens, rules, templates (§19)
├── deploy/                  ops runbooks
├── debug/                   ignored — investigation outputs land here
└── CLAUDE.md                this file
```

---

## 3. Quick start (fresh deploy)

```bash
# 1. Clone, copy env template
git clone https://github.com/ssdavidai/alfred.git
cd alfred
cp .env.example .env

# 2. Fill required vars in .env: DOMAIN, ACME_EMAIL, OWNER_NAME, OWNER_EMAIL,
#    COMPOSIO_API_KEY. Hermes needs NO model API key — it authenticates to
#    OpenAI Codex over OAuth (see §9). Optional: GOOGLE_CLIENT_*, SENDGRID_API_KEY.

# 3. Generate auto-secrets (AAS_API_KEY, COLUMN_ENCRYPTION_KEY, JWT_SECRET,
#    HERMES_API_SERVER_KEY, plane/sure DB passwords, vaultwarden admin token,
#    MCP_APPROVAL_SECRET) — idempotent.
./scripts/bootstrap.sh

# 4. Point DNS A records at the VM:
#    @ → VM-IP, plane → same, sure → same, vault → same, mcp → same, api → same
#    (Caddy auto-issues a cert per host via HTTP-01; cert persists in caddy_data volume.)

# 5. Up
docker compose up -d

# 6. First signup at https://${DOMAIN} becomes the owner; lands on /desk.
```

**Minimum VM spec**: 48 GB RAM (32 GB will OOM under load), 4+ vCPU, 80+ GB
disk.

---

## 4. Vocabulary — the principal's surface

Alfred Black has 14 pages. Use these names everywhere (URL paths, code
comments, agent prompts, docs). The redesign moved away from `/dashboard/*`
sub-routes; that vocab is dead.

| Page | URL | Purpose |
|------|-----|---------|
| **Desk** | `/desk` | Today's decision queue + audit ledger (the daily landing) |
| **Brief** | `/brief` | The daily letterpress brief |
| **Vault** | `/vault` | Three-pane Obsidian view of the principal's vault |
| **Matters** | `/matters`, `/matters/:id` | Aggregator across the household |
| **Instincts** | `/instincts` | Asking / Confirming / Acting tiers |
| **Decisions** | `/decisions` | Audit feed with HANDLED/HELD/ASKED filters |
| **Chores** | `/chores`, `/chores/:slug` | The principal's recurring work |
| **Connections** | `/connections` | Composio catalogue + sibling-surface launcher |
| **Channels** | `/channels` | Email + phone + omi + Terminal cards |
| **Tools** | `/tools` | Gateway allowlist viewer |
| **Claude** | `/claude` | MCP setup + Skill + secrets |
| **Study** | `/study` | Unified back office (settings, credentials, API keys, audit, theme) |
| **Household** | `/household` | RULES.md editor + chores |
| **Staff** | `/staff` | Small staff of specialists, marketing surface |

The **onboarding ritual** is sequential, not a single page:
```
/awaken → /reading-the-room → /verify → /soul →
/composing → /preparing → /first-brief → /desk
```

`/onboarding` redirects to `/awaken`. `/dashboard` (legacy) thin-redirects
to `/desk`. `/triage` → `/desk`. `/back-office` → `/study`.

---

## 5. The four-store architecture

> **The vault is the principal's published output, not the system's database.**

alfred-black persists data in **four stores**, not one markdown directory:

| # | Store | Backing | Sole writer | Purpose |
|---|-------|---------|-------------|---------|
| 1 | **Vault** | Markdown (`vault_data` volume) | ctrl-api (via alfred daemon) | The principal's published surface |
| 2 | **`alfred-state.db`** | SQLite + WAL + sqlite-vec (`state_data`) | **ctrl-api** | Machine working memory |
| 3 | **Cold archive** | SQLite + zstd (`cold.db`, `cold_data` volume) | ctrl-api | Forensic long tail (>90d) — rows aged out of alfred-state.db by the TTL compactor |
| 4 | **`ingest.db`** | SQLite (`ingest_data`) | ctrl-api | Raw inbound stream events (7d TTL) |

The operational store is named **`alfred-state.db`** (not `state.db`) to
avoid a filename collision with Hermes' own gateway-session store at
`$HERMES_HOME/state.db`.

**Full detail**: `packages/ctrl/docs/STORAGE-ARCHITECTURE.md`.

### 5.1 The promotion contract — HARD RULE

> **A record exists in the vault only if the principal has a reason to read
> or edit it. Everything else is SQLite.**

The vault (Store 1) holds **exactly 13 canonical record types**:

```
matter  task  note  person  org  place  asset  chore  instinct  decision  briefing  daybook
commitment
```

Plus the `SOUL.md` / `RULES.md` singletons and `_templates/`.

`commitment` joined the set in #469/#470/#471 (phase 0 of #467). A commitment
is a promise with an accountable party and an evidence handle — one Sir made,
or one made to him. It hangs off a matter via `matter_ref`: the matter is the
ongoing concern, the commitments are the promises inside it. Its coarse
`status` uses the normal four-value vocabulary; the real 11-state lifecycle
lives in `commitment_state`, because the coarse field cannot express
`delivered_awaiting_acceptance` and forcing it would mean a false closure.

**ctrl-api is the sole vault writer.** Most vault write routes enforce the
contract in code by calling `assertCanonicalVaultPath()`
(`packages/ctrl/src/db/promotionContract.ts`) before touching the
filesystem. A write to a non-canonical path returns HTTP 422
`PROMOTION_CONTRACT_VIOLATION` with a `suggestion` field pointing at the
right endpoint.

**Demoted record types** and their correct store:

| Demoted type | Goes to |
|---|---|
| `signal-action` / `steward-action` / `desk-action` / `state-change` / `needs_attention_action` / `auto-task-created` / `event` | `alfred-state.db` **`audit`** table (via `POST /api/v1/state/audit`) |
| `signal` | `alfred-state.db` **`signal`** (via `POST /api/v1/state/signals`) |
| `observation` / `pattern_proposal` / `synthesis` / `contradiction` / `assumption` / `constraint` | `alfred-state.db` **`observation`** (via `POST /api/v1/state/observations`) |
| `stream_event` | `ingest.db` **`stream_event`** (via `POST /api/v1/ingest/events`) |

Paths the contract CODE exempts — the whole list, from
`promotionContract.ts` (`CANONICAL_NON_RECORD_DIRS` + `CANONICAL_TOP_LEVEL_FILES`):
`_templates/`, `needs_attention/`, `SOUL.md`, `RULES.md`.

`needs_attention/` is exempt on purpose: Desk cards stay vault-markdown until
storage-epic #28 lands.

**Two routes write demoted types straight to `vault/event/` with raw
`fs.writeFileSync`, bypassing their own contract check** — a deliberate
migration shim, not a rule:

| Route | Writes | Also writes (the real source of truth) |
|---|---|---|
| `stateChanges.ts:585` | `event/state-change-*.md` | `audit` row, `action_type: state_change` |
| `attention.ts:186` | `event/needs_attention_action-*.md` | `audit` row |

They persist because callers still resolve `audit_record_path` and the
calibration loop still reads the markdown. Single-writer discipline holds
(both are ctrl-api) and `state.db` is authoritative — but do NOT read §5.1 as
"a demoted type can never reach the vault." It can, via these two.

Other top-level dirs you may find in an older vault (`_rescue/`, `inbox/`,
`assumption/`, `synthesis/`, `constraint/`, `project/`, `stream_event/`, and a
tail of empty ones) are historical debris written before the cutover by
out-of-band scripts — NOT a code exemption. Adding a new one requires editing
`promotionContract.ts`.

### 5.2 Single-writer discipline

ctrl-api is the **only** process with a write handle to `alfred-state.db`
and `ingest.db`. `alfred-learn` and the alfred vault daemon write through
ctrl-api HTTP endpoints — never directly. Other services may open the
files read-only. This eliminates SQLite multi-process write contention and
makes the `vault_index` read-index drift structurally impossible.

When adding code that needs to persist a record:
- Does the principal read or edit it directly? → canonical vault type via
  the vault routes.
- Does the UI read a derived view? → SQLite table (audit/signal/observation/…).
- Neither? → SQLite or stream log (ephemeral).

**Never add a new vault directory.**

---

## 6. State machines

This is the part most teams get wrong: there are **multiple status/state
fields**, with different vocabularies, owned by different writers. Confusion
between them is the #1 source of "I clicked the button and nothing
happened" bugs.

### 6.1 Matter

Canonical type. `vault/matter/<slug>.md` (Obsidian-readable).

**Two parallel state surfaces**:
- `status` — `active | dormant | completed | archived` (principal-facing
  lifecycle; written by Steward / state-mutator)
- `current_state` (2-4 sentence narrative paragraph) + `as_of` (ISO
  timestamp) per RFC #884 (the "Living Narratives" layer). Owned by
  `NightlyNarrativeWorkflow` (`packages/learn/src/activities/nightly_narrative.py`).

**Roll-up `state`** — `done | active | waiting` — derived at read time from
linked tasks (`packages/ctrl/src/api/routes/matters.ts:486–497`,
`deriveMatterState`). `done` = all tasks done/archived; `active` = any
in_progress; `waiting` = otherwise.

**Transition primitive**: `state_mutator.apply_state_change_v2`
(`packages/learn/src/activities/state_mutator.py`). Every transition writes
a `state_change` audit row to alfred-state.db AND patches frontmatter.

**Mode-gated**: `state_mutator_mode` setting (see §8). Default `"live"`.

**Per-matter capabilities.** A matter's frontmatter can switch on shipped
skills. The convention, which any future capability should follow:

> **A capability is a shipped skill, switched on by a boolean on the matter,
> with an object form as the escape hatch.**

```yaml
commitment_register: true     # #466 — alfred-commitment-register
hours_tracking: true          # #468 — alfred-hours-reconstruction
```

Everything is derived — ID prefix from the matter slug, participants from its
related persons/orgs, sources from what the tenant has connected, projection
paths from the slug. The object form (`{enabled: true, prefix: ACME, …}`)
exists only to override a derived value that is wrong.

Two rules that are not configurable, because they are not choices: the skills
never perform external sends or client-facing writes during reconciliation, and
`hours_tracking` never accepts hours without Sir's explicit approval, at any
confidence level.

Defaults are chosen so a capability works on a tenant with **no integrations at
all** — `commitment_register`'s projection defaults to a vault note, with Slack
as an opt-in (`projection: slack:<channel>`).

The skills act only on matters carrying the block, so a matter driven by a
bespoke per-tenant wrapper skill keeps running on it, untouched. Migration is
per matter: add the block, delete the wrapper, verify one reconciliation.

### 6.2 Task

Canonical type. `vault/task/<slug>.md`.

**THREE different fields that look like they mean state**:
- `status` — alfred-vault validator vocab: **`active | blocked | cancelled | done | todo`**.
  This is the field the alfred-vault Python daemon enforces; any other value (e.g.
  the historic `queued` from comments) is rejected with HTTP 500.
- `state` — the matters-aggregator vocab: **`pending | in_progress | done | archived`**.
  `matters.ts:454` `normalizeTaskState` reads this.
- `current_state` / `as_of` — narrative layer, same as matters.

Both `status` and `state` coexist; writers must set both. **Validator-compatible
defaults for a fresh task**: `status: todo, state: pending`.

**Required linkage fields**:
- `parent_matter: matter/<slug>.md` — the matters aggregator looks here
- `matter_ref: matter/<slug>.md` — alias different readers use; set both
- `signal_sources: []` — task-creation provenance
- `closure_predicate: null` (or a real predicate) — for auto-close watcher

**Closure paths**:
1. Principal click on Desk → `decision/<ts>.md (intent=done)` → `DecisionRouter` → status flip.
2. `TaskClosureWatcherWorkflow` (every 5 min) — matches inbound signals
   against open tasks' `closure_predicate`. Two predicate styles:
   - **Deterministic** (`evaluate_predicate`) — e.g. `gmail_thread_reply`,
     `gmail_from_subject`, `calendar_event_accepted`, `payment_to_merchant`.
   - **LLM** (`assess_closure`) — clerk call, auto-close if `confidence ≥ 0.80`.
3. `archival_sweep.py` moves terminal-archived tasks aside.

**Auto-create from signals**: gated by `auto_task_create_mode` setting
(default `"live"`). `task_creation.create_task_from_signal` writes the rich
shape with `parent_matter` populated from `signal.matter_ref`.

**Onboarding errand-pack**: `packs_opus._build_rich_errand_content` writes
new tasks with the rich shape; `_resolve_parent_matter_path` does 4-tier
matter resolution (exact slug → fuzzy related_matter → fuzzy task name →
inbox fallback). `matter/inbox.md` is auto-seeded by the init container.

### 6.3 Decision

Canonical type. `vault/decision/<ts>-<sha8>.md`.

**State**: `open | executing | completed | reversed`.

Three write paths — **all of them mint `state: open` so DecisionRouter
runs `extract_observation_from_decision` (the learning loop closer)**:

1. **`POST /api/v1/decisions`** (DeskPage native) — Sir clicks Done/Defer/Noise/Delegate/Take-mine; ctrl-api synchronously flips the source NA card (sets `side_effects.synchronous_flip: true`) and writes the decision.
2. **`POST /api/v1/admin/needs-attention/:id/{done,dispatch,skip}`** (legacy Steward Phase 6.4 surface) — older UI path; `attention.ts` performs the same NA flip + emits the legacy `needs_attention_action` audit + **mints a mirror decision** via `mintDecisionMirror` *unless* `decision_origin` is set in the body (which only DecisionRouter does, preventing a recursive loop — see §15).
3. **Signal-router autonomous fire** — `signal_actions.route_signal_action` with `principal: alfred` + `decision_origin: instinct_fire`.

**The synchronous_flip guards**: `route_decision`
(`packages/learn/src/activities/decision_router.py`) has 6 `if not
synchronous_flip` guards (lines 194, 307, 426, 479, 486, 563, 586). They
skip the action paths when the source-record flip already happened
synchronously — but `extract_observation_from_decision` at line 647 has
NO such guard, so the observation always lands.

**Delegate has a fourth piece**: after Lane I #216 severed signal-router's
`principal_delegate_override` path, DecisionRouter calls
`dispatch_action_to_agent` directly when intent=delegate. Three idempotency
layers prevent double-firing (state guard + `dispatching` mark + `side_effects.agent_dispatched`).

### 6.4 Signal

Demoted to `alfred-state.db.signal` table. Never a vault record.

**Status vocabulary**: `unrouted | routed_human | routed_agent | routed_suppressed | dispatching | agent_responded`.

`SignalRouterWorkflow` filters `status='unrouted'`. Once routed, the signal
becomes terminal from the router's perspective — only `dispatching` is
reachable from `unrouted` in the live state machine.

**`matched_instinct` column** stamped by `route_signal_action` when the
matcher finds a match (Lane II Gap 5b fix: the scorer now matches
substrings + multi-word patterns; was structurally returning 0).

### 6.5 Chore

Canonical type. `vault/chore/<slug>.md` + matching `.py` workflow class
under `/alfred-data/user-chores/`.

Schedule lives in Temporal (one `chore-<slug>` schedule per chore). Cron
fires the registered workflow class via the dynamic loader at worker boot.
**`workflow_class_name` frontmatter MUST match the `@workflow.defn(name=...)`
of the deployed `.py`** (capitalization-sensitive — has bitten us; see §15).

First 3 runs are quarantine dry-runs (`quarantine: true, quarantine_remaining: 3`),
then `record_chore_run` writes both vault frontmatter (`last_run`,
`last_result`, body run-log line) AND
`/alfred-data/chore-run-history.jsonl`.

Weekly `ChorePromotionReflectionWorkflow` (Sunday 03:00) drafts a GitHub PR
for chores with 20+ live runs ≥95% success.

### 6.6 Instinct

Canonical type. `vault/instinct/<slug>.md`.

**Tiers**: `Asking → Confirming → Acting`. Tier promotion is **clerk-driven** —
`ReflectionWorkflow` (daily 02:00 tenant-local) feeds accumulated observations to Opus,
which proposes `apply_instinct_change` calls. `apply_instinct_change` is the
SOLE writer of `observation_count`, `confidence_score`, and `tier`.

**Status**: `unconfirmed | active | deprecated` — **do NOT filter the matcher
on `status='active'`**. Lane II Gap 3 fix: `_load_active_instincts` accepts
all non-deprecated instincts. The discretion gate at signal_actions:1825 is
the real safety belt (high threshold for low-observation_count instincts).

**The tier is the safety gate (#445/#446/#453).** It is a CEILING checked
BEFORE confidence, at two independent enforcement points, both reading the
shared reader in `matching/tiers.py` (fail-closed to `Asking`):

1. `signal_actions.route_signal_action` — may this instinct dispatch an agent
   unattended? Only `Acting` may.
2. `noise_patterns` / the pre-extraction noise gate — may this instinct make
   an inbound email cease to exist? Only `Acting` may; below that the match is
   audited and the email still reaches Sir.

No amount of confidence promotes an `Asking`/`Confirming` instinct into
autonomy. The legacy nested `execution.tier` integer is deliberately ignored —
it disagreed with the ladder on live data.

**Reaching `Acting` requires Sir's explicit approval (#452).** Reflection may
propose it; `apply_instinct_change` withholds it and records
`pending_promotion: Acting` on the instinct (idempotent, and visible on
`/instincts`). `resolve_instinct_promotion` is the only path that writes the
tier. Demotions, lateral moves, and `Asking → Confirming` still apply
immediately.

**Discretion threshold**: per-instinct, computed from `observation_count`
via `matching/discretion.py` (`effective_threshold` — the single shared
implementation; an explicit `discretion_threshold` may only RAISE the bar).
It applies *underneath* the tier ceiling. The `live_observation_count`
(ctrl-api enrichment) takes precedence over the snapshotted
`observation_count`.

---

## 7. The signal pipeline (end-to-end)

```
inbound webhook / composio poll / agent action
       ↓ POST /api/v1/ingest/events
ingest.db.stream_event (7d TTL)
       ↓ EventProcessorWorkflow (every 15 min)
   marks processed_at; signals routed directly from ingest.db (#78 Design-B)
       ↓ PRE-EXTRACTION NOISE GATE  (noise_patterns.py, inside extract_signal_from_event)
   active instincts with intent_key=noise OR routing_rule.destination_type=hold
   match on sender_domains (suffix-anchored) / subject_keywords →
     tier == Acting  → event DROPPED, never becomes a signal
     tier <  Acting  → audited (`signal_noise_match`) and ALLOWED THROUGH (#453)
   every match writes an audit row either way
       ↓ SignalExtractWorkflow (every 5 min, gated on STEWARD_SIGNAL_EXTRACT_ENABLED)
   chunked extraction via clerk → alfred-state.db.signal (status=unrouted)
   + extract_observation_from_signal → state.db.observation (kind=signal)
       ↓ SignalRouterWorkflow (every 2 min, gated on STEWARD_SIGNAL_ROUTER_ENABLED)
   _load_active_instincts → _match_best_instinct (substring + multi-word) → discretion gate
       ↓ branch:
   ┌─────────────────────┬─────────────────────┬─────────────────────┐
   │ HIGH (autonomous)   │ HUMAN               │ SUPPRESSED          │
   │ /v1/runs dispatch   │ needs_attention/    │ P0-2 dedup gate     │
   │ + instinct_fire     │ <ts>-<id>.md card   │ tripped             │
   │   decision          │                     │                     │
   └─────────────────────┴─────────────────────┴─────────────────────┘
       ↓ principal clicks on /desk
   POST /api/v1/decisions (or legacy /admin/needs-attention/:id/{done,dispatch,skip})
   → decision/<ts>.md (state=open, synchronous_flip=true)
       ↓ DecisionRouterWorkflow (every 60s)
   route_decision → side-effects (skipped if synchronous_flip)
                  → extract_observation_from_decision (ALWAYS — no guard)
                  → state.db.observation (kind=decision, instinct_ref stamped)
                  → state=completed (or =executing for delegate, then =completed on outcome)
       ↓ ReflectionWorkflow (daily 02:00 tenant-local)
   accumulated observations → Opus proposes instinct changes
   → apply_instinct_change → observation_count/confidence_score/tier updated
   → next signal scoring uses the new bar
```

The **loop closes** at `extract_observation_from_decision`. The whole
campaign on 2026-05-24 was about making sure this loop actually fires for
every Desk click (it didn't for done/noise/delegate until then) — see
§16 for the incident history.

---

## 8. The three mode flags

Three settings flags control how aggressively Alfred acts. **All default
`"live"`** (do the thing); flipped to `"shadow"` they record what would
have happened but don't act.

| Flag | Controls | Default | Env override |
|------|----------|---------|--------------|
| `signal_action_mode` | Whether SignalRouter dispatches autonomously when discretion clears the bar (vs always going HUMAN) | `live` | `STEWARD_SIGNAL_ACTION_LIVE_MODE` |
| `state_mutator_mode` | Whether `state_mutator` patches matter/task frontmatter (vs only writing the audit row) | `live` | `STEWARD_LIVE_MODE` |
| `auto_task_create_mode` | Whether signals auto-create tasks (`task_creation.create_task_from_signal`) | `live` | `STEWARD_SIGNAL_AUTOCREATE_TASKS` |

**Resolution precedence** (per Lane II resolvers):
1. Env var (override — for emergencies)
2. `/alfred-data/settings.json` key (UI toggle persists here)
3. **Default `"live"`**

**UI**: `/study#settings` → "Agent autonomy" section, 3 toggles. Calls
`GET/PUT /api/v1/settings[/:key]` (ctrl-api `routes/settings.ts`).

---

## 9. Hermes runtime

OpenClaw is replaced by **Hermes**. In ctrl-api code:

- Runtime container is `hermes` (compose service)
- In-container CLI: `hermes` (`HERMES_CMD` / `HERMES_CONTAINER` in `helpers.ts`)
- **Supervised profiles** (per `packages/hermes/docker/supervisor.sh`) — three
  static plus dynamic per-slug profiles provisioned from
  `$HERMES_HOME/profiles/_registry.json` (optional codex-builder among them):
  - `main` profile, API port **18789** — user-facing chat, memory enabled
  - `workers` profile, API port **18790** — background agents (clerk, curator, janitor, distiller, ephemeral runs), concurrency capped
  - `heavy` profile, API port **18791** — heavy reasoning (Opus / GPT-5.5-class) for onboarding + Reflection
- Each profile has its own `config.yaml`, `.env`, SQLite SessionStore, MCP
  server registrations under `$HERMES_HOME/profiles/<name>/`
- The init container renders profile config + writes `/alfred-data/.gateway-token`
- `auth.json` is generated for the `main` profile and propagated to
  workers + heavy at supervisor startup (idempotent, one OAuth identity)
- The `main` profile's `SOUL.md` is consolidated to `$HERMES_HOME/SOUL.md`
  at supervisor boot so Hermes loads the Alfred persona (NOT the stock
  Nous identity)
- `hermes-lcm` plugin is baked at `/opt/hermes-lcm` and installed into
  the `main` profile's `plugins/` dir (verified via `verify_lcm()` background probe)

### 9.0 Install shape — read this before any version bump

The runtime is **0.20.4**, installed from a **pinned git commit, not PyPI** —
0.20.x ships no wheel. The image keeps the pip install as a base layer and
overlays the vendor installer into `/usr/local/lib/hermes-agent`.

**That tree has its own venv, and this is a trap.** `/usr/local/bin/hermes`
execs `/usr/local/lib/hermes-agent/venv/bin/python` with `PYTHONPATH` and
`PYTHONHOME` unset, and the tree carries its own copies of `utils.py`,
`hermes_constants.py` and `openai`. A patch applied to
`/usr/local/lib/python3.12/site-packages` therefore **never reaches the code
that runs**, and nothing says so. That is how the GH #222 fd-leak fix quietly
stopped applying: `hermes --version` was right, the patch was present in
site-packages, and nothing failed until the fd cliff. The three `patch_*`
scripts now take an optional target path and are applied to BOTH trees, with
their tripwires intact. **Re-check this on every bump** — it is the most
expensive thing in this file to rediscover.

Two further consequences of the git install:

- It ships **no `web_dist`** (the reason the wheel was originally pinned), so
  the dashboard bundle is built at image time — `cd /usr/local/lib/hermes-agent/web
  && npm run build`, exactly as `hermes dashboard --skip-build` documents.
- **`hermes-live` is a separate npm package** (`hermes-live-voice`), not part of
  Hermes. Its *plugin* half lives in the hermes volume and survives; the
  *binary* is an image artifact and disappears on any container recreate unless
  baked. Same class of loss as an unbaked runtime.

### 9.1 API contract

Hermes speaks the **OpenAI Responses API natively** — no shim:
- `POST http://hermes:18789/v1/responses` (main)
- `POST http://hermes:18790/v1/responses` (workers — the `/v1/runs` poll loop
  was removed in #46; learn dispatches responses with `X-Hermes-Session-Key`)
- `POST http://hermes:18791/v1/responses` (heavy)

All calls carry `Authorization: Bearer ${HERMES_API_SERVER_KEY}` (the
gateway token from `/alfred-data/.gateway-token`).

### 9.2 MCP servers

Each Hermes profile registers up to 8 MCP servers in its `config.yaml`
(the last three are profile-conditional):

| Name | Type | What it surfaces |
|------|------|------------------|
| `alfred-ctrl` | HTTP | The ctrl-api itself (40+ routes) |
| `alfred` | stdio (Node) | Vault read/write + agent delegation + workflow orchestration |
| `sure` | stdio (Node) | Sure personal-finance ~80 tools |
| `vaultwarden` | stdio (Node) | Vault items list/search/get/CRUD + vault_refresh |
| `execute` | stdio (Node) | Composio surface — every connected third-party app via one execute primitive |
| `hass` | stdio (Node) | Home Assistant (profile-conditional) |
| `paperclip` | stdio (Node) | Paperclip adapter (profile-conditional) |
| `files` | stdio (Node) | Store-5 file/blob surface (profile-conditional) |

**`plane` is GONE** — Plane was removed from the compose stack fleet-wide
(PR #279). `packages/ctrl/src/api/routes/plane.ts` is dormant, not deployed.

Source for the 5 stdio apps: `packages/mcp-server/src/` (compiled bundle
copied into the Hermes image at build time). The 6th `alfred-ctrl` is an
HTTP proxy to ctrl-api.

### 9.3 NOT used

- ~~Hermes web dashboard unusable~~ **twice stale.** It ships a bundle and is
  now served on `:9121` by the `hermes-dashboard` sidecar under the
  `live-voice` compose profile (off by default; loopback-only, reach it with
  `ssh -L 9121:127.0.0.1:9121`). Note the git install has no `web_dist` of its
  own — see §9.0. The 2026-05-24 "Frontend not built" revert (`ce6c177`)
  predates all of this. CLI (`hermes config` / `profile` / `auth`) still works.

---

## 10. ctrl-api — the dashboard backend (`:3100`)

Zero-dependency Node 22 app, dual role: CLI/TUI (pre-merge) AND HTTP API
(now). On `alfred-black` only the API role remains (`packages/ctrl/src/api/`).

### 10.1 Build

esbuild bundles `src/api/standalone.ts` → `dist/api.mjs` (single ESM
file). `.sql` / `.njk` / `.md` / `.yaml` files load as text strings via
the esbuild loader config in `build.mjs`. `ssh2` is external.

```sh
cd packages/ctrl
npm ci                 # required first time + if you've cd'd around
npm run build          # → dist/api.mjs
npm test               # node:test suite (~440 tests)
```

### 10.2 Route layout

`src/api/routes/` — ~70 files (incl. `webhooks/`), one per surface. Notable:

| Route file | Surface |
|------------|---------|
| `vault.ts` | The promotion-contract-enforced vault PATCH/POST/GET. Body must wrap in `{set: {…}}` / `{append: {…}}` / `{body_append: …}` — bare field-keyed bodies are silently no-op'd (see §15). |
| `attention.ts` | Legacy needs_attention surface; mirrors decisions when `decision_origin` is unset (`mintDecisionMirror`) — see §15 for the recursion guard. |
| `decisions.ts` | New unified decision write path. Mints `state: open` always; the router closes the loop. |
| `settings.ts` | `GET/PUT /api/v1/settings[/:key]` for the 3 mode flags. Atomic write via temp+rename to `/alfred-data/settings.json`. |
| `system.ts` | `GET /api/v1/system/ssh-info` (SSH pubkey for the /channels Terminal card). |
| `chores.ts` | List/get/pause/resume/delete/trigger; list omits `quarantine_remaining` (#229 — file followup if you want it). |
| `matters.ts` | The matter aggregator. Reads `parent_matter`/`matter_ref`/`project` from task fm. List endpoint at line 757; detail endpoint may diverge from list (filed #229). |

### 10.3 `state.db` migrations

Numbered SQL files in `packages/ctrl/src/db/migrations/`, applied
transactionally on ctrl-api boot. **Never edit a migration after it has
merged — append a new one.** Migrations are forbidden-zone: only the
orchestrator (phase0) lands them.

---

## 11. The bug-fixing protocol (SOURCE OF TRUTH — this is how bugs get fixed here)

Two modes: **investigate** (read-only fan-out → reports) then **fix**
(gate-protected lane fan-out). The point is to run as many parallel agents
as the work allows **without conflicts or contract violations** — by making
a bad commit *impossible to land*, not by trusting agents to behave.

### 11.1 Mode A — Investigation fan-out (read-only)

For mapping unknown breakage (e.g. a sweep over the live product):

- **One agent per issue**, scoped narrowly, run as parallel background agents
- **Strictly read-only**: no code edits, no live writes. Say so explicitly
  ("no POST/PUT/DELETE, no `docker` writes"); require each agent to **disclose
  any unavoidable probe side-effect**
- Each writes ONE report to a git-ignored `debug/<MMDD>/<issue>-findings.md`:
  exact code path (`file:line`), live evidence, **root-cause vs environmental
  caveat** (separate real bugs from credit/quota/stale-deploy noise), a "desired
  happy path", and a prioritized list
- Track each as a task; surface each as it lands; then **synthesize** all
  reports into one plan grouped by **cross-cutting root cause** (most symptoms
  collapse into a few seams)
- Live access is read-only SSH; **inline the SSH options on every call** (a
  shell variable won't word-split under zsh)

### 11.2 Mode B — Fix fan-out (gate-protected, parallel-safe)

1. **Rank bugs in `FAILURE-MODES.md` with the exact code path. Failing-test-first:**
   write a red repro test, then fix to green — never fix against an assumption.

2. **Phase 0 first, sequentially (orchestrator only):** build shared
   foundations everything sits on (migration runner, the contracts, the gate).
   These are forbidden-zone files; nothing parallel starts until they land.

3. **Freeze the contracts** (`FIX-CONTRACTS.md`, C1…) *before any lane codes*.
   A consumer lane builds against the frozen shape and never needs the
   provider's code. **If a contract is wrong, the lane STOPs and reports — it
   never improvises across the boundary.**

4. **Package-scoped lanes**, non-overlapping glob territory (→ conflict-free
   merges by construction). Canonical source: `docs/lane-protocol.md` +
   `scripts/hooks/lanes.json` (v2 2026-07-15 — every package has exactly
   one owning lane):

   | Lane | Branch | Glob | Owns |
   |------|--------|------|------|
   | **I**·ctrl | `lane-1/` | `packages/ctrl/**` | ctrl-api routes (incl. channels), the 4-store layer, settings |
   | **II**·learn | `lane-2/` | `packages/learn/**` | Temporal activities, the intelligence layer, scoring |
   | **III**·web | `lane-3/` | `packages/web/**` | Wasp app, dashboard pages, operations.ts |
   | **IV**·alfred-vault | `lane-4/` | `packages/alfred-vault/**` | The Python vault daemon (separate package `alfred-vault` 1.0+) |
   | **V**·edges/infra | `lane-5/` | `packages/{hermes,mcp-server,vault-init,setup}/**`, `scripts/**`, `caddy/**`, `docker-compose.yaml`, `.env.example`, `Makefile`, `docs/**`, `design-system/**` | All non-package config + the brand system |
   | **VI**·voice-bridge | `lane-6/` | `packages/voice-bridge/**` | Twilio/telephony bridge |
   | **VII**·paperclip | `lane-7/` | `packages/paperclip/**` | Paperclip adapter |
   | **VIII**·alfred-mac | `lane-8/` | `packages/alfred-mac/**` | The macOS companion app (one-Alfred continuity for Claude Cowork) |

   These are the ONLY valid lane IDs — never invent one ("CTRL"/"HERMES"
   inventions are how the 2026-06 ungated commits happened). `.github/**`
   is phase0-only. **At most one agent per lane at a time** — lanes
   parallel, tasks within a lane serial.

5. **The gate makes violations impossible to land — twice.**
   - **Local pre-commit** (`scripts/hooks/`, `bash scripts/hooks/install.sh`):
     on `git commit`, `check_lane.py` rejects the diff if it
     - (a) leaves the lane's `allowed` globs (lane-jumping) — deletions
       and rename-sources count too,
     - (b) touches the **forbidden zone** (`schema.sql`, `db/migrations/**`,
       `migrate.ts`, `api/server.ts`, `**/CONTRACT.md`, the `FIX-*` /
       `FAILURE-MODES` docs, `docs/lane-protocol.md`, `scripts/hooks/**`,
       `.github/**`, `CLAUDE.md`),
     - (c) exceeds **~200 net LOC**, or
     - (d) fails the lane **VERIFY** (build / `tsc` / pytest / `compose
       config` — the regression gate).
   - **Server-side CI replay** (`.github/workflows/lane-gate.yml`): every
     PR from a `lane-N/*` branch re-runs rules (a)–(c) against the full PR
     diff. This copy is authoritative — local hook removal or the harness
     clobbering `core.hooksPath` (see §11.3) does not bypass it.

   The lane is declared by a `.lane` manifest at the worktree root:
   `{"lane":"II","verify":"…","scope_limit":300}`, and by the branch name
   in CI (`lane-2/… → II`; non-lane branches are phase0/operator).
   The **main checkout (no `.lane`) is `phase0`** — orchestrator, allow-all.
   A linked worktree with **no `.lane` is rejected**, and **`phase0` is not
   self-declarable from a linked worktree** (fail-safe).
   **Never use `ALFRED_SKIP_VERIFY`.**
   Gate unit tests: `python3 scripts/hooks/test_check_lane.py`.

6. **Agent brief** = LANE / GOAL (one sentence) / ALLOWED + FORBIDDEN globs
   / VERIFY / CONTRACT (the package `CONTRACT.md` + the relevant
   `FIX-CONTRACTS.md` clause) / SCOPE ~200 LOC (if bigger, STOP and report)
   / WHEN DONE: 3-line PR note, start nothing else. Standing preamble:
   *first action — write `.lane`; read your contracts; touch only ALLOWED;
   code against the frozen contracts; a blocked commit means re-scope, not override.*

7. **Sequence vs parallelize**. Fan out lanes **in parallel** when their
   globs are disjoint **and** the boundary contract is frozen. **Sequence**
   (provider PR → consumer PR) when a consumer needs a provider's new
   shape, or when a "disjoint" file turns out shared (move it to the
   forbidden zone, Phase-0-owned, and lanes consume it). Merge order =
   **providers before consumers**. The gate surfaces any cross-lane
   collision *immediately* as a blocked commit, never as a tangled merge.

8. **One PR per logical change → build → deploy → smoke → only then the
   next PR.** Push to `main` lets CI build `:latest`; never clobber a
   production `:latest` or push public `main` without explicit confirmation
   — verify on a throwaway tag/VM first.

### 11.3 Hard-won rules (these bit me — do not relearn them)

- **The Claude Code worktree harness disarms local hooks.** At every
  worktree creation it rewrites `core.hooksPath` back to `.git/hooks`
  (shared config AND per-worktree `config.worktree`) — this silently
  killed the lane gate for ~6 weeks (2026-06 → 2026-07-15 audit).
  `install.sh` now also symlinks `.git/hooks/pre-commit → scripts/hooks/
  pre-commit` so the gate fires under either config value, and strips
  stale per-worktree overrides — re-run it whenever in doubt. The CI
  `lane-gate` workflow is the authoritative backstop either way.
  **Status 2026-08-06: the local gate IS firing.** It blocked commits
  repeatedly during the #445–#454 campaign (scope-limit and VERIFY
  rejections), so the symlink fix holds. Do not assume it is off — but do
  keep the CI backstop, it is what makes the guarantee unconditional.
- **`isolation: worktree` does NOT guarantee isolation.** Agents have
  shared the working tree and overwritten each other's `.lane`. Either
  confirm each agent got a real separate worktree, **or** run coordinated
  cross-package work yourself in the main checkout (phase0), one commit at
  a time. **Always `git show --stat` each agent's commit** to confirm it
  touched only its own files before trusting it.
- **Agents must never run `npm install/ci/prune`** — it corrupts the
  shared symlinked `node_modules`. VERIFY uses existing deps.
  Orchestrator-only: `npm ci` if needed for a fresh worktree.
- **Stage only your own files** (`git add <paths>`, never `git add -A`) —
  never sweep up `node_modules`/lockfile churn or another lane's work.
- **Clean up a stale `.lane`** before an orchestrator (phase0) commit — a
  leftover lane marker blocks a legitimate cross-cutting commit.
- Forbidden-zone files (contracts, migrations, `schema.sql`, `server.ts`,
  `scripts/hooks/**`, `CLAUDE.md`) are **orchestrator-only**, edited
  centrally — never inside a lane.
- **Hot-patch + `force-recreate` destroys the patch** — `docker compose up
  -d --force-recreate` creates a new container from the image, losing any
  `docker cp` overlays. Use `docker restart` (preserves) when you've
  hot-patched files into a running container.
- **The lane gate's regression VERIFY must actually pass.** Don't push
  failing tests to fix them in a follow-up — the gate exists to catch this.
  If you broke an existing test by changing the contract, **update the
  test as part of the same commit** (commit `e3c1ad2` is the lesson).

---

## 12. CI workflows (`.github/workflows/`)

Path-filtered, push-to-main:

| Workflow | Trigger paths | Output |
|----------|--------------|--------|
| `build-web.yml` | `packages/web/**` | `ssdavidai00/alfred-web:latest` + `alfred-web-client:latest` |
| `build-ctrl-api.yml` | `packages/ctrl/**` | `ssdavidai00/alfred-ctrl-api:latest` |
| `build-learn.yml` | `packages/learn/**` | `ssdavidai00/alfred-learn:latest` (longest pole, ~25 min) |
| `build-hermes.yml` | `packages/hermes/**` (Dockerfile, supervisor.sh, configs) | `ssdavidai00/alfred-black-hermes:latest` |
| `build-init.yml` | `packages/hermes/init/**`, `packages/ctrl/src/templates/**`, hermes-config templates | `ssdavidai00/alfred-init:latest` |
| `build-mcp-server.yml` | `packages/mcp-server/**` | `ssdavidai00/alfred-mcp-server:latest` |
| `build-voice-bridge.yml` | `packages/voice-bridge/**` | voice-bridge image |
| `build-paperclip.yml` | `packages/paperclip/**` | paperclip image |
| `build-setup.yml` | `packages/setup/**` | setup image |
| `build-alfred-worker.yml` | `packages/alfred-vault/**`, `packages/hermes/*` | `ssdavidai00/alfred-worker:latest` — the vault daemon/curator image; **runs on every tenant** as the `alfred` compose service |
| `deploy-compose.yml` | compose/Caddy/env | rsyncs compose + Caddyfile to tenants |
| `deploy-fleet.yml` | manual | fleet-wide pull + up |
| `release-alfred-vault.yml` | tag `alfred-vault-v*` | publishes `alfred-vault` to PyPI |
| `issue-taxonomy.yml` | issues | issue labelling |
| `notify-telegram.yml` | * | build/deploy notifications |
| `ci-check.yml` | * (all) | `tsc --noEmit` + `pytest` (learn only) + `docker compose config` |
| `lane-gate.yml` | PRs | server-side replay of the lane gate on the PR diff (see §11.2.5) |
| `pr-review-gate.yml` | PRs | `smoke-evidence-check` — PR body must carry `## Smoke evidence` |
| `gitleaks.yml` | * (all) | Secret scanning |

`docker compose up` **never builds** — it pulls `:latest` for every
service. CI is the only path that publishes new images.

---

## 13. Deploy paths

On the VM:

| Path | What |
|------|------|
| `/opt/alfred/docker-compose.yaml` | The active compose file (rsync'd from repo on deploys, or `git pull` for clones) |
| `/opt/alfred/caddy/Caddyfile` | Caddy reverse-proxy config |
| `/opt/alfred/.env` | Required + auto-generated env vars (bootstrap.sh manages this) |
| `/var/lib/docker/volumes/alfred-black_vault_data/_data/` | The vault (markdown files) |
| `/var/lib/docker/volumes/alfred-black_state_data/_data/` | alfred-state.db + WAL |
| `/var/lib/docker/volumes/alfred-black_ingest_data/_data/` | ingest.db + WAL |
| `/var/lib/docker/volumes/alfred-black_cold_data/_data/` | cold.db — Store 3 forensic archive |
| `/var/lib/docker/volumes/alfred-black_files_cold_data/_data/` | Store 5 cold file/blob archive |
| `/var/lib/docker/volumes/alfred-black_alfred_data/_data/` | Shared scratch (.gateway-token, settings.json, .hermes-* etc.) |
| `/var/lib/docker/volumes/alfred-black_hermes_data/_data/` | $HERMES_HOME (profiles, SOUL.md, sessions, plugins) |
| `/var/lib/docker/volumes/alfred-black_caddy_data/_data/` | LE certs (PRESERVE across redeploys to avoid rate limits) |

**Deploy via**: `docker compose pull && docker compose up -d` after a
relevant image rebuilds in CI. Rsync the Caddyfile / compose file from
the repo when they change (those aren't in any image).

---

## 14. Onboarding (the principal's first session)

Sequential ritual at `/awaken → … → /first-brief → /desk`. Behind the
scenes:

1. **Gmail OAuth + Composio account creation** (steps `/composing` /
   `/preparing`) — backfilled via `alfred-learn` activities.
2. **Stream pull** — `composio_pull` activity pulls ~100 days of email
   (chunked + paginated to stay under Temporal's 4MB gRPC limit; #180).
3. **Fact extraction** — `extract_facts_opus` runs **chunked**
   (chunk_threshold=500, chunk_size=400) so it doesn't hit Hermes' "max
   compression attempts" context overflow (#193).
4. **Pattern discovery** — `discover_patterns_opus` (LLM proposes instinct
   templates from the extracted facts).
5. **Personalization** — `personalize_opus` writes:
   - `/vault/USER.md` (~1375 chars cap; sentence-boundary truncate)
   - `/vault/SOUL.md` (the Alfred persona, consolidated to `$HERMES_HOME/SOUL.md` by hermes supervisor)
   - `/vault/RULES.md` (standing rules — editable on `/household`)
   - `/hermes-state/memories/MEMORY.md` (~2200 chars cap)
   - `/hermes-state/memories/USER.md` (~1375 chars cap)
6. **Pack materialization** — `generate_matter_pack_opus`,
   `generate_errand_pack_opus`, `generate_chore_template_code` write the
   vault records. New tasks born via `_build_rich_errand_content` carry
   `parent_matter`, `matter_ref`, `state: pending`, `status: todo`,
   `signal_sources`, `closure_predicate`.
7. **Day-one seeding** — `seed_day_one_desk_cards` activity picks
   time-anchored matters + `activity_score` + key_people count for
   the principal's first /desk landing (#196).
8. **Brief composition** — `write_brief_opus` writes the first brief
   (intro paragraph + "This week, on your plate" actionable bulleted list
   pulled from matters with `next_action_due` + open chores + payment-failure signals).

---

## 15. Common gotchas (concrete; you'll hit these)

### 15.1 vault PATCH body shape

`PATCH /api/v1/vault/records/<path>` requires the body to wrap fields in
`{set: {…}}` / `{append: {…}}` / `{body_append: …}` / `{json_set: {…}}` /
`{body_set: …}`. **A bare field-keyed body returns 200 with no-op** (the
`hasCliArgs` check at `vault.ts:976` short-circuits before
`dockerExec`). Lost an hour on this 2026-05-24.

### 15.2 task `status` vs `state`

Different fields, different vocabularies:
- `status`: alfred-vault validator vocab — `active|blocked|cancelled|done|todo`
- `state`: matters-aggregator vocab — `pending|in_progress|done|archived`

**Writers must set BOTH**. `status: queued` was an aspirational comment
in `tasks.py:23` — the validator rejects it with HTTP 500. Use
`status: todo` (canonical "not yet started") and `state: pending`.

### 15.3 The decision-mirror recursion

The legacy `/admin/needs-attention/:id/dispatch` endpoint mints a mirror
`decision/<ts>.md` (Sir #4 from 2026-05-24 morning), useful for UI clicks.
But DecisionRouter ALSO calls `/dispatch` as part of processing delegate
decisions — without a guard, this creates a fresh decision every minute
forever, each one firing the agent.

**Guard**: `attention.ts` skips `mintDecisionMirror` if
`body.decision_origin` is set (which DecisionRouter passes; UI clicks
don't). See commit `4466c68` and §6.3.

### 15.4 Web client deploy

The web is **two containers**, not one:
- `web` — the Wasp server (auth + API + operations at `:3000`)
- `web-client` — the static SPA nginx serves it from a separate container

UI changes need `web-client` redeployed too, plus a hard browser refresh.
This bit Sir hard on 2026-05-22.

### 15.5 Onboarding's `_resolve_parent_matter_path`

4-tier matter resolution (Lane II sir-fresh-deploy #2):
1. Exact slug match (`matter/<slugified(related_matter)>.md` exists in matter_index)
2. Fuzzy `related_matter` text vs matter names (overlap coefficient ≥ 0.40)
3. Fuzzy task `name` vs matter names (same threshold) — for when `related_matter` is empty
4. **`matter/inbox.md` fallback** — auto-seeded by the init container (Lane V sir-fresh-deploy #1)

If you skip the validation step, you get phantom matter paths and the
matters aggregator can't find tasks. Fixed 2026-05-24.

### 15.6 Hermes dashboard ≠ usable

The pip wheel ships no `web_dist/` and no `web/` source. The dashboard
backend runs fine but returns `{"error":"Frontend not built"}` for every
request. We hooked it up, then reverted (commit `ce6c177`). Use the
`hermes config` / `hermes profile` / `hermes auth` CLI inside the container
instead.

### 15.7 Cron-DOW autocorrect on chores

`chore_generation._autocorrect_cron_dow_for_description` rewrites
weekdays→1-5 in the cron before validation (#181 fix). Don't fight the
validator — let the autocorrect run.

### 15.8 The instinct scorer's tokenization

Lane II's Gap 5b fix: `_score_keyword_overlap` was doing set intersection
between SINGLE-WORD input tokens and MULTI-WORD pattern phrases. Result:
ALWAYS 0.0 for every live instinct. No threshold could rescue it.
**Fix**: substring of full text + all-pattern-tokens-in-keyword-set +
legacy single-word, MATCH_THRESHOLD = 0.05. Live signal scores jumped
0.0 → 0.20. Same root cause is structurally possible elsewhere — if
you're doing token overlap, **check the tokenizers on both sides match**.

### 15.9 SSH to the box

```sh
ssh -o ConnectTimeout=15 -o ServerAliveInterval=10 -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new -o IdentityAgent=none \
    -i ~/.ssh/alfred-black-verify root@<VM-IP>
```

`-o IdentityAgent=none` is **required** if you have 1Password's SSH agent
running — it hijacks identity selection. The `-i` arg won't help without
the `IdentityAgent=none` opt.

### 15.10 Backups

`vault_data` is the principal's published surface — back it up.
`caddy_data` holds LE certs — back it up to avoid rate limits on rebuild.
`state_data` / `ingest_data` / `alfred_data` / `hermes_data` are
recoverable but contain history — back them up if you care about the
audit trail / observations / instinct training data.
`cold_data` / `files_cold_data` hold everything aged OUT of state.db —
if you care about the long tail, they are the only copy.
`tailscale_data` (when the optional Tailscale sidecar is on — §15.11)
holds the `tailscaled.state` node identity; lose it and the principal
has to re-approve the device on `login.tailscale.com`.

### 15.11 Optional Tailscale opt-in (#109)

There IS a Tailscale sidecar in `docker-compose.yaml`, but it is
**gated by `profiles: [tailscale]` and off by default**. `docker compose
up -d` (the default) never starts it. The model is: the principal joins
**their own** tailnet from the dashboard (`/channels` → Tailscale card).
The operator owns nothing here — no Sir-side tailnet, no shared keys.

Flip on for an existing tenant:

```bash
# 1. Edit /opt/alfred/.env
TAILSCALE_ENABLED=true

# 2. Bring the sidecar up
docker compose --profile tailscale up -d tailscale

# 3. Principal goes to /channels, clicks Connect on the Tailscale card,
#    either pastes a tskey-auth-… key OR uses the device-auth URL the
#    card surfaces (login.tailscale.com/a/<code>).

# 4. Once the card shows "Connected", ctrl-api can mint the tailnet
#    LE cert + bind it into Caddy:
#    POST /api/v1/channels/tailscale/cert  {"domain":"<tailnet-hostname>"}
#    Reach the dashboard at https://<tailnet-hostname> from any device
#    on the principal's tailnet.
```

Key files:
- `docker-compose.yaml` — `tailscale` service under `profiles: [tailscale]`.
- `packages/ctrl/src/api/routes/channels_tailscale.ts` — status/connect/
  disconnect/peers/cert/serve/funnel.
- `packages/web/src/dashboard/tailscaleCardCore.ts` — pure card state
  derivation + 18 tests under `node:test`.
- `packages/web/src/dashboard/ChannelsPage.tsx` (`<TailscaleCard />`) —
  the principal-facing surface.
- `caddy/Caddyfile` — `import /tailscale-snippets/*.caddy` hot-loads the
  per-domain stanza the cert route drops in.

The public `<tenant>.alfred.black` hostname keeps working unchanged.
Tailscale is **additive**, never a replacement. Webhook ingress (Composio,
Paperclip, OMI, …) stays on the public Caddy hostname.

Caveat: outbound MagicDNS (e.g. `curl http://homeassistant.tail-xxxx.ts.net`
from inside the Hermes container) requires either (a) `network_mode:
service:tailscale` on the consumer service, or (b) explicit `dns:`
pointing at the sidecar. Neither is wired by default — flag a follow-up
issue if the principal needs Alfred to reach their tailnet from inside
containers.

### 15.12 compose splits a string `command:` — silently

With `entrypoint: ["/bin/sh", "-lc"]`, a **plain-string `command:`** is
shlex-split by compose, so `sh -lc` receives only the FIRST token as its script
and the rest as positional parameters. `command: exec hermes dashboard …`
becomes `sh -lc exec` — the bare builtin — and the container **exits 0 with no
log output at all**. The folded form (`command: >`) has the identical problem;
it also yields a string. Use a single-element list:

```yaml
command: ["… ; exec …"]
```

### 15.13 `network_mode: service:X` orphans on recreate

Anything sharing another container's network namespace (the live-voice
sidecars share hermes') stays attached to the **old, dead namespace** when that
container is recreated — which is what any image roll does. The processes keep
running, every port is unreachable, and Docker does not restart them for it. So
they sat reporting `Up (healthy)` while answering nothing.

Two rules: give such a service a healthcheck that probes **the dependency, not
just its own port** (a local probe passes while the namespace is dead, because
it is talking to itself), and recreate the dependents after the target:

```bash
docker compose --profile live-voice up -d --force-recreate hermes-dashboard hermes-live
```

### 15.14 supervisor boot checks must not use the `hermes` CLI

`supervisor.sh` runs before any gateway is up, and the CLI yields nothing
usable at that point. A guard written as `hermes -p X cron list | grep …`
therefore *passes* at boot and fails only later — which is exactly backwards.
It registered a duplicate cron on the first boot after rollout, and every boot
after would have stacked another. Read the state **file** instead; it is plain
JSON and readable whether or not a gateway is running. Replayed by hand once
the gateways are up, the CLI guard looks perfect — which is why this one is
easy to test wrong.

### 15.15 Hermes cron reads its store, not `cron.jobs`

Jobs declared under `cron.jobs` in a profile's `config.yaml` are **not what the
scheduler runs**. It schedules from `<profile>/cron/jobs.json`. A retention pair
declared the config way shipped in July and never fired once: both jobs present
in the config, `cron list` empty, and session files two months past a seven-day
policy still on disk. Register real jobs with
`hermes -p <profile> cron create --no-agent --script <name>.py --name <name> '<cron>'`.

### 15.16 A large workers `state.db` cannot cold-start

Measured across the fleet: ~0 GB starts in 10s, 6.7 GB in 80s, 11 GB in 100s,
and **16 GB and 53–55 GB never start at all**. Pause/resume hides this because
it preserves memory — you only meet it on a genuine cold boot, which is to say
during provisioning, upgrade, restore or crash recovery, i.e. when you are
already having a bad day. `state_retention.py` (nightly, workers + heavy) is
what keeps it bounded; deleting rows is the mechanism, since `VACUUM` reclaims
free pages and cannot shrink what was never deleted. Wait **at least 180s**
before concluding a workers gateway is dead — 11 GB legitimately takes 100.

---

## 16. Recent incident history (the why behind quirky code)

| Date | Incident | Fix commit(s) |
|------|----------|---------------|
| 2026-08-19 | **Hermes 0.20.4 ran unpatched for hours without a symptom.** 0.20.x installs to its own tree with its own venv, so every patch applied to site-packages — including the GH #222 fd-leak fix — stopped reaching the running code. Nothing fails until the fd cliff. | `#694` (patch both trees, tripwires intact); see §9.0 |
| 2026-08-19 | **Two sidecars reported `Up (healthy)` while answering nothing** — a string `command:` was shlex-split into `sh -lc exec` (exit 0, no logs), and after a hermes recreate both were attached to a dead network namespace. | `#696` (list-form command), `#698` (dependency-probing healthchecks); §15.12, §15.13 |
| 2026-08-19 | **Session storage was never actually bounded.** #266's retention jobs were declared in a config key the scheduler does not read, and the one that did run was a `VACUUM`, which cannot shrink what is never deleted. Two tenants reached 53–55 GB; a 16 GB one could not cold-start its gateway. | `#699` (store-registered job, row TTL, batched), `#700` (guard on the file, not the CLI); §15.15, §15.16 |
| 2026-08-06 | **Alfred emailed a vendor to cancel a subscription, unattended** — an `Asking`-tier instinct (1 stored observation) cleared the numeric bar and dispatched an executor that mailed team@elevenlabs.io from Sir's Gmail, 4 min after he'd been setting the service up. The ladder was decorative: no gate read `tier`. | #445 → `#446` (tier ceiling on the router), `#448`/`#449` (/instincts renders the real tier), `#453` (noise gate too), `#452`/`#458` (Acting needs Sir's approval) |
| 2026-08-06 | **Clicking Done taught Alfred to silence senders.** A 23-min backlog clear-out on 2026-07-15 (28 × `intent: done`) became a suppression rule whose `sender_domains` were harvested from that batch — including Sir's primary client. It sat in the pre-extraction noise gate, which consulted no tier and wrote no audit row. | `#454` (done ≠ noise; burst-weighting), `#453` (gate obeys the ladder + audits), instinct data cleaned by hand |
| 2026-08-06 | Reflection had never actually run on the `heavy` profile despite §9 saying so — `clerk.py` hard-coded the workers gateway (luna) | `#451` + `#450` (heavy = gpt-5.6-sol) |
| 2026-08-06 | `.env.example` still shipped OpenRouter-era model IDs (incl. an Anthropic model) that OVERRIDE the code defaults — a fresh deploy would have provisioned a non-Codex fleet | `#450` |
| 2026-08-05 | Instinct promotion silently no-op'd for ~2 months: `apply_instinct_change` body-appended instead of patching frontmatter, so all 35 instincts froze at `Asking` while audit rows claimed promotions | `#442` → `#443`, `#444` |
| 2026-05-24 | Hermes web dashboard at hermes.{$DOMAIN} (Sir reverted; upstream wheel ships no web bundle) | `fc91b16`, `9f40199` → reverted `ce6c177` |
| 2026-05-24 | `_resolve_parent_matter_path` was slugifying blindly + `matter/inbox.md` not auto-seeded → 33 orphan tasks on live tenant | Lane V `b0bc0cc` (inbox seed) + Lane II `935692f` (4-tier resolver) |
| 2026-05-24 | Task `status: queued` rejected by alfred-vault validator → backfill 100% errored | orchestrator `eed3799` + tests `e3c1ad2` |
| 2026-05-24 | Onboarding wrote degenerate task shape (no `parent_matter`/`state`/`closure_predicate`) → 32 tasks orphaned from matters; state_mutator silent; auto-task-create silent | Lane II `dbaca81` (5 commits: onboarding rich shape + backfill activity + state_mutator default-live + auto-task-create default-live + Gap 5b scorer root cause) + Lane I `8affe83` (settings multi-key) + Lane III `a025357` (3-toggle UI) |
| 2026-05-24 | DecisionRouter delegate path mints fresh mirror decision every cycle → recursive loop, agent fires each minute | orchestrator `4466c68` (`/dispatch` skips mirror when `decision_origin` set) |
| 2026-05-24 | Lane I #216 fix severed signal-router's `principal_delegate_override` → Delegate clicks never fire the agent | Lane II `6a8052f` (DecisionRouter calls `dispatch_action_to_agent` directly) |
| 2026-05-24 | Delegate dispatch creates `status=unrouted` signal → SignalRouter re-dispatches every cycle (Sir's 1 click → 10 dispatches) | Lane I `c551c00` (#216: mint signal `status=routed_agent` terminal) |
| 2026-05-24 | DeskPage `POST /api/v1/decisions` minted `state=completed` for done/noise/take_mine → DecisionRouter skipped → 0 `kind=decision` observations | orchestrator `31fa11f` (always mint `state=open`) + `e8905e4` (same for legacy attention mirror) |
| 2026-05-24 | Signal pipeline loop broken: instinct filter on `status=active` (none live), `state_mutator` default shadow, scorer structurally 0, chore-obs to wrong store | Lane II `c27e6e3` + Lane I `8affe83` + Lane III `de34f6d` |
| 2026-05-24 | 5 Sir-listed UX bugs (brief shape, /desk dups, /chores truncate, /connections icons, /channels Terminal card, Plane blank, Vault→Vaultwarden, ssh-info endpoint) | Lanes I/II/III/V — 4 PRs across 1,978 LOC + 30 tests |
| 2026-05-24 | test.alfred.black → home.alfred.black domain swap | one `.env` flip; Caddy auto-reissued 6 LE certs |
| 2026-05-23 | Onboarding personalize_opus truncated USER.md from 1407 → 53 chars (rfind-first bug) | sentence-boundary truncate with floor_fraction |
| 2026-05-23 | hermes-lcm plugin baked but not loaded | `verify_lcm()` background probe in supervisor + per-profile plugin dir |
| 2026-05-22+ | The 21-finding fix-fan-out pass (debug/0522 reports → 8 image deploys → fixes-as-PRs) | The :harden campaign — see GH #128/#129/#118 |

---

## 17. References — read these when you touch the relevant area

- `docs/lane-protocol.md` — the canonical lane protocol (lanes, gate, contracts file)
- `docs/FAILURE-MODES.md` — ranked bug catalogue
- `docs/FIX-PLAN.md` — lane fan-out plan
- `docs/FIX-CONTRACTS.md` — frozen cross-lane interfaces
- `docs/PAPERCLIP-BOOTSTRAP-CONTRACT.md` — paperclip cross-lane contract
- `packages/ctrl/docs/STORAGE-ARCHITECTURE.md` — the 4-store model
- `packages/ctrl/CONTRACT.md` — what ctrl-api provides + requires
- `packages/learn/CONTRACT.md` — what alfred-learn provides + requires
- `packages/learn/CONTRACT.md` — CURRENT intelligence-layer contract (workflows, activities, env). Use this.
- `packages/learn/SPEC.md` — HISTORICAL day-1 design doc (describes 6 workflows + JudgmentWorkflow/SessionTracker, both deleted; ~46 workflow classes exist now). Do not treat as current.
- `packages/learn/docs/STATE-MUTATION.md` — state-mutator contract (#889 spec §5.2)
- `packages/learn/CLAUDE.md` — terminology constraints (observation/instinct/intuition/reflection/judgment/discretion/clerk)
- `packages/web/main.wasp` — the Wasp app config (routes, queries, actions, jobs, entities)
- `packages/hermes/Dockerfile` — runtime image build
- `packages/hermes/docker/supervisor.sh` — the 3-process supervisor
- `packages/hermes/init/entrypoint.sh` — vault scaffold, Hermes profile rendering, password generation
- `caddy/Caddyfile` — Caddy ingress with `{$DOMAIN}` substitution
- `scripts/hooks/check_lane.py` — the commit gate (read this before opening a PR); tests in `scripts/hooks/test_check_lane.py`
- `.github/workflows/lane-gate.yml` — the server-side gate replay
- `CHANGELOG.md` — bare-date release tags

---

## 18. Engineering principles (the why behind the structure)

- **Markdown is wrong for a database.** The four-store split (vault for the
  principal, alfred-state.db for the machine, ingest.db for raw, cold for
  forensics) is not a refactor — it's the foundational design. Never add a
  vault directory to "make a thing easier."
- **One writer per store.** ctrl-api is the only process with write
  handles to alfred-state.db / ingest.db. Other services HTTP-POST.
- **The promotion contract is enforced at the gate** (`assertCanonicalVaultPath`),
  not by convention. Adding a non-canonical vault dir is a 422 + a code
  smell.
- **Lanes parallel; gate enforces.** Don't trust agents to behave — make
  bad commits impossible to land.
- **Failing-test-first.** A test asserting the current (broken) behavior
  is not a regression — it's a baseline. Update assertions in the same
  commit that updates contracts.
- **Hot-patch is a tool; reproducible builds are the home.** Push the same
  fix as a CI commit before you go to bed — `docker compose up
  --force-recreate` will eat your overlay otherwise.
- **The principal reads markdown; the machine reads SQLite.** If a UI
  surface only renders aggregations, those tables live in alfred-state.db.
  If the principal will open it in Obsidian and tweak the wording, it's a
  vault record.
- **Reflection closes the loop.** The whole point of the signal pipeline
  is that human decisions on /desk become observations become tier
  promotions. If observations aren't landing in `state.db`, the system
  isn't learning — and that's a bug to fix urgently, not a "we'll iterate" item.

---

---

## 19. The design system — read this before touching any surface

`design-system/` holds the **Alfred Black brand system**. It is not decoration and it
is not optional: every principal-facing surface is expected to be derived from it.

**`design-system/readme.md` is the authoritative document.** Read it before designing
anything. `design-system/IMPORTED.md` records where the snapshot came from, what was
left out, and the one place the older `_brandpack/` layer contradicts the readme.

### The identity in one paragraph

**Letterpress meets terminal.** Ivory paper `#F4EFE6`, wool black `#0B0B0B`, ink
`#1A1A1A`, and **one** antique-brass accent `#A8843A`. Playfair Display (Didone) for
display, frequently italic. EB Garamond for running text, oldstyle numerals. JetBrains
Mono for everything machine — labels, ledgers, marginalia — uppercase, 0.18–0.32em
tracking. The product is a *private command room*, not a SaaS dashboard.

### Non-negotiables

- **One brass accent per screen.** No second accent, ever. Brass is punctuation: it
  marks the single most important thing, then falls silent. If a chart needs a second
  series colour, use tints of brass or the marginalia grey — **not a new hue**.
- **`--radius: 0`.** Corners are sharp. Only tiny chips earn 2px.
- **Hairline rules, not cards.** Structure is drawn with `--ab-rule`; there are no
  filled cards, no drop shadows, no glassmorphism, no blur. Print does not float.
- **Serif for what Alfred says; mono for machine truth.** Prose in EB Garamond, signed
  *"— Alfred."* Labels, statuses and ledger figures in mono caps.
- **No emoji. Ever.** The only non-icon glyphs are `● → ↓ · ✕` and roman numerals.
- **No ASCII / dot-matrix art.** The engraved icon set carries the whole iconographic
  load, including empty states. (`_brandpack/` says otherwise; it is the older layer —
  see `IMPORTED.md`.)
- **Calm copy.** No hype, no exclamation marks, no "Oops!". *"No urgent action is
  required."* is the register.

### Where things live

| path | what |
|---|---|
| `design-system/readme.md` | **authoritative** — voice, palette, type, surfaces, iconography |
| `design-system/styles.css` | single entry point; `@import`s the tokens in order |
| `design-system/tokens/` | `colors` · `typography` · `spacing` · `surfaces` · `fonts` |
| `design-system/templates/attention-statement/` | the canonical statement layout |
| `design-system/SKILL.md` | portable Agent-Skill wrapper |

### The token values are the product's, not a mockup's

`design-system/tokens/*.css` is lifted verbatim from `packages/web/src/client/Main.css`.
That file remains the source of truth for the running app. If the two ever drift,
**the product theme wins and the snapshot is stale** — re-import rather than editing
`Main.css` to match a mockup.

### Snapshot, not sync

This is a point-in-time copy of a Claude Design project (id in `IMPORTED.md`). Editing
files here does not change the design project. The React components, the 17 engraved
SVG icons, brand marks and textures are **not yet imported** — `readme.md` describes
assets that this directory does not yet contain.

### Never commit the source project's `uploads/`

The design project carries client PDFs, a competitive-landscape report and personal
travel documents. **This repository is public.** Sample data in the templates has also
carried real client names — scrub before committing, and never put a real name in a
commit message, PR body or comment.

---

*This file is forbidden-zone (lane gate rejects edits inside any lane).
Update via orchestrator (phase0) commit when the architecture or
contracts change.*
