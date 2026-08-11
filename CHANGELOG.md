# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the `alfred-vault` package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2026-08-11]

47 commits since `v2026.08.07`, across 24 closed issues. One theme, and it is
not a feature: **the system stopped claiming things that were not true.**

Nearly every fix in this release is the same shape. A write path worked and a
read path did not know about it. A check passed and the thing it checked never
happened. A record said an instruction was carried out when nothing had been.
None of these failed loudly. Several had been quietly wrong for weeks.

---

### Finance surfaces stopped presenting stale balances as current (#318)

The principal looked at his net worth and said the numbers were wrong. They
were nine days old: the provider token had expired and Sure was serving cached
balances with nothing on any surface indicating it.

Six changes across three lanes now make staleness visible:

- **Sure exposes ground truth** (#527, #528) — a read-only Rails initializer
  reporting per-account provider anchor state, because nothing in Sure's REST
  API can answer the question.
- **ctrl-api stamps provenance** (#529) — per-account `balance_provenance`
  with `source`, `observed_at`, `freshness`, `fallback_reason`.
- **Aggregates carry quality** (#536) — `data_quality` on the balance sheet
  plus `GET /api/v1/sure/sync-health` with per-account remediation hints.
- **Alfred can see it** (#537) — a `get_sync_health` MCP tool whose description
  tells the model what `partial: true` obliges.

Live on the dev tenant: 1 fresh, 12 stale, 7 unknown, `partial: true`.

The design nearly shipped a lie. Deriving freshness from Sure's REST fields
would have marked **nine of twelve stale accounts as fresh**, because both
candidate timestamps only record that *a write occurred* and the cached-fallback
path is itself a write. For a trust feature that is worse than shipping nothing.
Hence the vendor-side patch.

Two rules held throughout: `unknown` never renders as `fresh` (an unverifiable
value is not a current one), and `observed_at` is never `now()` (that records
when we asked, not when the fact was seen).

### Foreign-currency balances stopped resetting to USD (#340)

The Lunchflow adapter defaulted absent currencies to USD and re-stamped it on
every sync, so foreign accounts computed to zero and reverted after any manual
correction. A mounted Rails initializer now preserves a known currency when the
payload omits one. Verified against a real sync: the corrected currencies
survived it, with zero rows disagreeing between the two tables.

### Webhook deliveries stopped vanishing (#465)

Fathom deliveries were written to a vault directory nothing reads, and returned
202. Four layers had to be fixed, each correct in itself and each hiding the
next:

1. The route never enqueued the event (#508).
2. `_infer_source_type` did not recognise `webhook:` (#520).
3. The ingest adapter read `row.kind` before `payload.source_type`, collapsing
   the label to the bare word `webhook` so fix 2 could not match (#522).
4. The same adapter built the body from composio-shaped keys only, so the body
   was empty and every event was dropped as too short (#523).

Plus recovery: an idempotent backfill (#512) and a `requeue` route that can now
re-flow events **consumed** under a bug, not only failed ones (#525).

End result — a delivery becomes a routed signal on the Desk, salience 0.8,
linked to a matter. First time that path has ever completed.

Four of those five had passing tests over broken code, because each fixture
began downstream of the defect or invented the shape it was meant to verify.

### Decisions stopped retrying forever, and stopped lying about it (#414)

`route_decision`'s `done`/`dispatch`/`skip` branches raised on a 404 from a
deleted source card, so Temporal retried every tick, indefinitely. A deleted
card is not transient.

Now terminal — as **`failed`**, not `completed`. `completed` means "no async
work was needed, or the outcome arrived"; neither is true when the card is gone
and the principal's instruction was never applied. Recording it as completed
would assert the system did something it did not. Only 404 is terminal; 5xx and
timeouts still retry.

### Notifications go where they are meant to (#498, #288, #304)

Chores can declare `notify_channel` as `platform:destination`, parsed into the
two fields ctrl-api actually takes. Absent or unparseable falls back to the home
channel — inferring a platform from an id's shape is how a Telegram id ends up
in Slack. The resolved destination is recorded in the run notes, so a
misdelivery is auditable after the fact.

Zero active crons now resolve delivery by "wherever the principal last spoke".

### Progressive autonomy got its approval gate (#452, #459)

Reflection may propose an `Acting` promotion; it can no longer grant one.
`resolve_instinct_promotion` is the sole tier writer, reached through a new
ctrl-api endpoint and an Approve/Decline surface on `/instincts`. The invariant
is pinned as a test: tier `Confirming` with `pending_promotion: Acting` reads as
`Confirming`, shows as pending, and does not act unattended.

### Hermes session stores: 242 GB reclaimed

A retention tool with per-profile windows, dry-run by default, batched resumable
deletes, and checkpoint/vacuum as separate opt-in steps (#515, #516, #517).

Running it against the real store found four defects the fixtures could not
(#518, #521), including one that made the whole feature a no-op: the eligibility
predicate keyed on `ended_at`, which **100% of that profile's sessions never
write**. It would have pruned 188 sessions out of 141,443 and reported success.

Live result: 138,064 sessions and 637,673 messages deleted, the store 14.05 GB →
6.18 GB. Combined with a dangling-image prune, the dev tenant went from 85% disk
to 29%.

Also learned: VACUUM in WAL mode writes through the WAL, so a checkpoint must run
**after** the vacuum, not only before.

### Deploys stopped going further than intended

`deploy-fleet` resolved its targets as `vars.ALFRED_FLEET_HOSTS || <every
tenant>`. The variable was unset, so six merges rolled fleet-wide against a
dev-tenant-only instruction. The default is now the dev tenant; widening is a
deliberate act (#519).

And `deploy-compose` now ships the host-side files the compose file bind-mounts
(#544). It did not, so a tenant received a compose referencing paths it lacked,
Docker created them as directories, and Rails crash-looped loading a directory
as an initializer — four minutes of downtime on the finance app, and it would
have hit every remaining tenant on the next rollout.

### Codex-only, enforced where the model reads (#436, #437, #438, #535)

OpenRouter relics removed from `alfred-vault`, `ctrl` and `learn`. Separately,
the `run` tool advertised `claude-opus-4-5` and `claude-haiku-4-5` as example
models — a recommendation, in the one place the model looks, to do the single
forbidden thing. Replaced with the real Codex IDs.

### Stale descriptions corrected (#533)

Tool descriptions are what the model reads when choosing arguments, so a stale
one is a live defect. `delegate_to_focused_agent` still advertised the 60s
timeout five months after it became 300s. Three descriptions promised Plane sync
for a service removed fleet-wide in #279.

Most consequentially, `create_vault_record` omitted `commitment` from its Zod
enum — so Alfred **could not create the record type this project shipped in the
previous release**. Written, migrated, documented, and unreachable through the
tool that matters.

### Smaller, and worth naming

- `promote_triage_to_task` emitted `status: queued`, which the validator rejects
  with HTTP 500; the same bad value sat in the Obsidian task template (#534).
- `healthcheck.sh` had **never been tracked in this repo** — imported from the
  SaaS era where cloud-init provisioned it per VM, so admin health had reported
  `degraded` on every healthy stack since the cutover (#531). It now ships in the
  image with a build-time assertion, and reported 86% disk on its first day.
- `delegate_to_focused_agent`'s untested fetch-throws branch — the one deciding
  timeout versus unreachable — got coverage (#532).
- `?fields=` projection on vault list, after a 372 KB response broke a job three
  runs running (#496).

---

### Three that were already fixed

#310, #312 and #325 were verified fixed and closed. Half the bugs examined this
cycle were already resolved and simply never closed. Check before building.

### The backlog

37 issues closed, 46 → 17. Thirteen of the 2026-07-17 platform block closed as
superseded or unfounded; six narrow, evidence-backed slices filed in their place.
Each of those thirteen carried ~30 machine-generated `## Alfred Code spec`
comments — roughly 380 across the block — which had buried their real status.

---

## [2026-08-07]

10 commits since `v2026.08.06`, across 8 issues. One theme: **commitments
became a thing the platform knows about**, rather than a thing one tenant's
hand-written skills happened to maintain.

A commitment is a promise with an accountable party and an evidence handle —
one Sir made, or one made to him. Holding all of them is the "continuity" half
of the operator's job: it is what stops context reconstruction from being a
recurring category of work. Until this release the machinery for it existed
only as a skill directory on a single VM, versioned nowhere, tested nowhere,
and available to nobody else.

---

### `commitment` is a canonical vault record type

Phase 0 of #467, landed as three provider-first changes so nothing built on a
type that did not yet exist:

- **The vault schema knows it** (#469 → #472). Added to `KNOWN_TYPES` and
  `TYPE_DIRECTORY`, with `STATUS_BY_TYPE["commitment"]` holding only the coarse
  four-value vocabulary. Deliberately **not** in `LEARN_TYPES`: a commitment is
  Sir's record, not a distiller artifact.
- **ctrl-api accepts it** (#470 → #473). Added to `CANONICAL_RECORD_TYPES`, so
  `assertCanonicalVaultPath()` permits `commitment/` — including
  `commitment/_closed/` — while every demoted type stays rejected. Widening a
  canonical set risks widening it too far, so the tests pin the exemption list
  (`_templates`, `needs_attention`) as much as the addition.
- **The existing records moved onto it** (#471 → #474, fixed by #476). 64
  records migrated from `task/` to `commitment/`.

The coarse `status` and the 11-state `commitment_state` coexist on purpose. The
four-value vocabulary cannot express `delivered_awaiting_acceptance`, and
collapsing it into `done` would assert a closure that has not happened.

#### The migration failed first, safely

Its first live run failed all 64 records and wrote nothing. It read
`source["content"]`; the API returns `{path, frontmatter, body}`. The `content`
key belonged to a **test fake** — the script had been written against the mock,
and its tests agreed with it because they only exercised pure helpers and never
touched the read shape (#476).

Nothing was at risk, because the ordering is **write → verify → delete**: a
failed read aborts before anything is written, so a failure leaves a detectable
duplicate rather than a lost record. All 64 originals were intact and the re-run
after the fix moved 64 with 0 failures.

The lesson is the one this codebase keeps re-teaching, and it is now recorded
at the top of that test file: **a test that agrees with your mock proves
nothing about the system.**

### Two capabilities you switch on with one word

```yaml
commitment_register: true     # #466
hours_tracking: true          # #468
```

Both ship in `packages/hermes/workspace-template/skills/`, which
`init/entrypoint.sh` already distributes to every profile on every tenant,
hash-gated so it re-syncs on change. No new plumbing was needed — the
distribution channel existed.

- **`alfred-commitment-register`** (#466 → #477, #478). The framework,
  generalised: prefix derives from the matter slug, participants from its
  related persons and orgs, sources from whatever the tenant has connected,
  projection paths from the slug. The object form exists only to override a
  derived value that is wrong.
- **`alfred-hours-reconstruction`** (#468 → #479). Reconstructs work from
  bounded cross-source evidence and **proposes** it. Two rules sit above
  everything else: nothing enters the ledger without Sir's explicit approval,
  and the accepted ledger — not the calendar, not the schedule — is the cursor
  for the next window. Keyed to the schedule, a missed Friday silently loses a
  week's work; keyed to the ledger, a missed run widens the next window and
  self-heals.

Both default to working on a tenant with **no integrations at all**: the
register projects to a vault note, and Slack is opt-in. The original made a
Slack Canvas the happy path, which would have baked an external dependency into
a default capability.

Each acts only on matters carrying its block, so existing per-tenant wrapper
skills keep running untouched. Migration is per matter: add the block, delete
the wrapper, verify one reconciliation.

#### The convention, named once (#480)

> **A capability is a shipped skill, switched on by a boolean on the matter,
> with an object form as the escape hatch.**

#466 and #468 arrived at this shape independently. Recording it in `CLAUDE.md`
§6.1 makes the next per-matter capability an instance of a documented
convention rather than a third bespoke thing — cheaper to state than to
rediscover. Two properties are recorded as non-negotiable rather than default:
no external sends during reconciliation, and no hours accepted without explicit
approval **at any confidence level**.

### Documentation

- `CLAUDE.md` §5.1 — 12 canonical record types became 13 (#480).
- `README.md` rewritten around attentionmaxxing (#464).
- The 2026-08-06 changelog entry rewritten to actually cover its release
  (#463) — the first draft cited 38 of ~213 issues.

---

## [2026-08-06]

178 commits since `v2026.05.30`, across ~213 issues. Two months of work, with
one headline: **the Asking → Confirming → Acting ladder became an enforced
safety control**, and Alfred lost the ability to grant himself autonomy.

---

### The incident that named the release

On 2026-08-06 an instinct the dashboard displayed as **Asking** — one stored
observation — cleared the numeric confidence bar, dispatched an executor
agent, and sent a subscription-cancellation email to a vendor from the
principal's own Gmail. Four minutes earlier he had been in Slack setting that
same service up. A second instinct fired autonomously the same day.

Nothing failed mechanically. The ladder simply wasn't wired to anything: no
gate read `tier`. Autonomy came from observation counts alone, and the page
that said "Asking" was computing its own answer from confidence.

#### Progressive autonomy, now enforced

- **The signal router gates on tier** (#445 → #446). `tier` is a *ceiling*
  checked **before** confidence: only `Acting` dispatches unattended, and no
  amount of confidence promotes an `Asking`/`Confirming` instinct. Fails
  closed on missing/malformed/unknown tier and on no-match. An explicit
  Delegate click is unaffected — that is instruction, not autonomy.
- **The pre-extraction noise gate gates on tier too** (#453) — the stage that
  decides whether an email becomes a signal *at all*. It consulted no tier and
  wrote no audit row. Below `Acting` a match is now recorded and the email
  still reaches the Desk. This gate deliberately fails toward *visibility*,
  the inverse of the router, because a false positive here loses mail.
- **Every noise-gate match is audited** (#453). A suppressed email previously
  left one line in a rotating log — there was no way to ask "what did Alfred
  hide from me last week?"
- **Sender domains are suffix-anchored** (#453); the old substring match meant
  a `google.com` rule also matched `notgoogle.community`.
- **Reaching `Acting` requires the principal's approval** (#452). Reflection
  proposes; `pending_promotion` records the request on the instinct;
  `resolve_instinct_promotion` is the only writer. Demotions and
  `Asking → Confirming` still apply immediately.
- **`/instincts` shows the real tier** (#447 → #448, #449), states what each
  tier means for unattended action, and demotes the discretion bar to
  evidence.

---

### Multi-profile Alfred

The largest feature of the cycle: one VM can now run several distinct
principals/agents side by side.

- **Agent-profile registry + CRUD** and per-profile Hermes activation
  (#120) — the supervisor self-renders missing profile dirs, and ports are
  allocated from the registry.
- **`/profiles` UI + ProfileSwitcher** (#120 Lane III).
- **Per-profile channels** (#120 Lane V) — the full channel surface, with
  channel routes resolving the target profile.
- **Per-profile AgentMail inboxes** (#120 Lane Vb2) and **per-profile voice**
  (#120 Lane Vb) — a Twilio number per profile, resolved at TwiML time.
- **Per-profile MCP catalogue** (#204) and **skill catalogue** (#205) with
  their `/profiles/:slug` sections.
- **Per-profile channel identity** (#206) — a `channel_identity` table and
  adapters that apply the override.

### Files — Store 5

- **Content-extraction pipeline** with an "Alfred read it" badge (#114 Lane B).
- **Restore route + audit-ledger writes** (#114 Lane C).
- **MCP file completeness** — move, describe, hard_delete (#114 Lane D₁).
- Cold archive for files (`files_cold_data`) alongside the Store 3 archive.

### The learning loop

- **Instinct promotion had silently no-op'd for ~2 months** (#442 → #443).
  `apply_instinct_change` used a body-append verb that cannot touch
  frontmatter: every promotion returned 200, wrote an audit row claiming
  success, and changed nothing. All 35 instincts were frozen at `Asking`.
- **Clicking Done taught Alfred to silence the sender** (#454). `hold` was
  overloaded across noise/done/defer and the noise gate enrolled on all of
  them, so a 23-minute backlog clear-out became a permanent suppression rule
  whose domains were whoever happened to be in the batch.
- **Bulk dismissals now count as one lesson** (#454) — runs of same-intent
  decisions get a `burst_id` and Reflection weighs them as a single gesture.
- **Reflection runs on the heavy profile** (#451). The docs had claimed this
  since the cutover; only onboarding honoured it. The most judgement-bound
  call in the system had been running on the workers tier all along.
- **The instinct scorer's Jaccard replaced with pattern coverage** (#365), plus
  matcher-input widening and matter-ref normalisation (#365/#367 fast-follows).
- **`derive_signature` maps `source_type=email` to gmail semantics** (#333) —
  until this, sender-domain matching was structurally inert on every
  Composio-fed tenant, i.e. all of them.
- **Instincts always carry a tier**, and Reflection understands the ladder
  (#330). `instinct` added to the alfred-vault schema, ending a stream of
  `FM002 Unknown type` janitor noise (#444).
- **The observation→instinct loop relit** (#233) and **repaired** (#276) —
  reflection wedge, click→instinct linkage, noise suppression.
- **Flywheel loop-health telemetry** — daily rollup + Sunday digest (#332).
- **Judgment retirement completed**, stuck-signal recovery, structured
  auto-task predicates, steward shadow mode documented (#373/#374/#378/#379).
- **Orphaned decisions retired**, briefing type key, dead-letter net holes
  (#368/#369/#371), and canonical `state` beating the stale `status` mirror in
  the decisions list (#369 completion).

### Durable maintenance runs

Vault maintenance workers used to fail synchronously while reporting healthy.
A full durable-run subsystem replaced that (#316):

- Frozen contract for the durable maintenance run and the janitor
  scheduled-consumer.
- **Atomic worker-run ledger I/O**, concurrency-safe idempotent enqueueing,
  canonical queued records from normalised trigger inputs.
- **Freshness + terminal status derivation**, reliability/throughput
  summaries, non-blocking trigger routes, and a served `status_url`.
- **Structured worker status with stall detection.**
- **A durable run-claimant** (#407) — the ledger finally has an executor —
  plus its `ALFRED_DATA_DIR` fix (#407 follow-up).
- **Janitor agentic stages now propose JSON and Python applies it** (#288
  L3+L4), so repairs can actually land.

### Reliability under provider limits

- **Codex usage-cap-aware backoff** in signal-extract and decision-router.
- **Signal-extract pacing** under the per-minute burst limit, and exemption
  from the `per_matter_per_day` cap.
- **Curator cap-burn hardening** — honour `enabled`, shared 429 backoff,
  poison quarantine.
- **Rate guard honours the full provider reset horizon** plus a recent-429
  grace window.
- **Permanent HTTP failures are classified** so activities stop retrying
  forever (#296).
- **The workers gateway is probed before spending a delegation budget** (#297).
- **Poison ingest events dead-letter** instead of jamming the pipeline (#311,
  provider + consumer halves), with extraction failures reported.
- **Bounded recovery for transient-error-blocked tasks** (#399).
- **`recover_stuck_dispatching` resurrection capped**, dead-lettering to a new
  terminal `failed` decision state (#282). An uncapped recovery loop on a
  stuck delegate decision had spammed a principal's channel indefinitely.
- **`blocked_by` written as a list** (#394) — bare strings had poisoned records
  against every subsequent PATCH.

### Hermes runtime

- **Codex-only, permanently** (#433 → #435, #450). OpenRouter purged from the
  runtime, the render defaults and `.env.example` — the last mattering most,
  since those values *override* the code defaults and would have provisioned a
  non-Codex fleet on any fresh deploy.
- Model tiers: `main=gpt-5.6-terra`, `workers=gpt-5.6-luna`,
  `heavy=gpt-5.6-sol`.
- **~3× faster interactive turns** — `tool_search: on` (defers 169 tool schemas
  behind three bridge tools), `reasoning_effort: low` on main, parallel tool
  execution on read-mostly MCP servers, hard stop on runaway tool loops. A
  trivial turn went from 4–8s and wildly variable to a steady ~2s.
- **Hermes 0.14 → 0.17 → 0.19** (#422), a four-canary upgrade: re-authored
  upstream patches, pinned `openai==2.24.0`, negative-assertion patch verify,
  and dropping an obsolete HTML-attachment patch that broke the 0.19 build.
- **Relay (:8767) + dashboard (:9119)** supervised; hermes-relay vendored.
- **Kanban dispatcher disabled** with a migration for existing tenants — it was
  crashing the workers gateway.
- **MCP tool catalogue trimmed** 321 → 170 tools on main (#175); retired MCP
  registrations removed from deployed profiles (#314).
- **`auth.json` mirrors no longer go stale forever** when a token refresh
  shrinks the file (#395).
- **Session prune + `VACUUM` on a nightly cron** (#266), plus a 30-day
  retention policy (#430).
- Main gateway published on host loopback; `edge-tts` baked into the image.

### Channels, integrations, security

- **Background workers can no longer reach the principal's channels** (#288),
  applied to deployed tenants too (#358) — after a janitor repair loop
  delivered 13 failure dumps to Slack.
- **One-reply-path guardrail** — a request maps to exactly one
  channel-delivering task (#417) — and **schedule-time dedup for
  `announce:true` agent-task spawns** (#416).
- **Per-app scoped bearer tokens for MCP clients** + management UI (#278).
- **MCP reverse-proxy trust contract** — bounded proxy hop validation and a
  trust resolver, with a documented contract.
- **Paperclip**: agent-driven company bootstrap (#242), principal company
  access on bootstrap (#246), Hermes skill set surfaced in the adapter (#248),
  Vaultwarden → Paperclip secret sync (#253), and a GitHub evidence-packet
  generator.
- **Voice**: outbound calls use the local Twilio originator, per-call timezone
  anchoring (#226), and a TwiML-inbound route matched on pathname (#263).
- **Home Assistant**: `GET /channels/ha/state/:entity_id` (#110), and the HA
  WS client LLAT shape fixed to unblock `HaBootstrapWorkflow` (#155).
- **Tailscale opt-in**: privacy/ToS, operator runbook, and live
  `tailscaleHostname` population (#109 PR5).
- **Live MCP-server tool enumeration** on `/tools`, with real per-server counts
  (#185).

### Storage and data integrity

- **Daemon canonical-record writes route through ctrl-api** (#327) — closing
  the direct-filesystem writer seam.
- **Matter completion routes through `apply_state_change_v2`** with
  `STATE_CHANGE_ENFORCEMENT=reject` (#328).
- **Audit retention sweep at boot** (#380).
- **`observations status=unprocessed` now means "not yet processed"** (#232) —
  it previously did not, so Reflection's input set was wrong.
- **Sure balance freshness provenance + sync-health endpoint** frozen into the
  contracts (#318).
- **Self-generated deliveries no longer pollute the signal feed**;
  dead-letters reaped (#372).
- **Silently-dropped records now surface** — chore failures, unparseable vault
  frontmatter, uncovered closure predicates (#397).
- **Dead `SessionTracker` deleted**, `ledger_entry` demoted to audit (#364),
  and chore/task LLM calls migrated off the retired OpenClaw
  `/tools/invoke` envelope (#366).
- **Backup and restore contract** with a restore drill (#237/#238).

### Infrastructure and operations

- **Plane removed fleet-wide**; hermes memory raised to 12g with swap (#279).
  The prose-less-briefs symptom was the VM OOM-killing the workers gateway.
- **Hermes worker sessions had no retention** and filled a 300 GB disk in six
  days, taking a tenant's whole stack down (#335/#336), with a disk-bloat
  runbook and `FAILURE-MODES` S1 marked realized (#267).
- **Container log size capped fleet-wide** (json-file 50m × 5).
- **fd-pressure**: raised the hermes `nofile` ceiling with an early
  fd-pressure healthcheck (#222), and an fd-safe atomic write.
- **`spawn_alfred_task` migrated** to the current `hermes cron create` CLI.
- **Sibling-container profiles route to `hermes-<slug>`** (#262).
- `rami` added to the deploy-compose fleet (#280).

### Developer experience

- **The lane gate hardened** (#285): CI replay of the gate on every PR, full
  package coverage, and audit fixes — it is now a required status check, not
  an advisory local hook.
- **The ctrl test suite runs in CI** (#290).
- **Contract layer regenerated from code** (#287).
- **Prioritization taxonomy enforced** on every open issue (#309).
- **alfred-code Tier 2 wired** — notify, PR review gate, fleet deploy.
- Deterministic `compose-lint` + `test-voice-bridge` (killed recurring
  false-reds); Markdown escaped in Telegram notifications.
- **A deterministic dashboard fast path** (#425) answers simple questions
  ("my chores", "open decisions") from ctrl-api in ~73ms instead of a full
  agent turn, failing open to the agent on anything nuanced — plus a working
  indicator, since Codex doesn't stream token deltas and the bubble looked
  frozen (#429).
- Batch of five minimum-diff bug fixes (#310/#312/#313/#315/#325); admin
  activity feed no longer empty despite active workflows (#322/#324).

### Documentation

A forensic audit checked every claim against the code and a live tenant rather
than against other docs, and found eight that would actively mislead. Most
consequential: `README` still told new operators to get an OpenRouter key and
advertised Plane as a shipped sidecar; `CLAUDE.md` listed the cold archive as
deferred when it is built and live, listed a removed MCP server, and claimed
*every* vault write route enforces the promotion contract when two deliberately
bypass it. `packages/learn/CLAUDE.md` and `SPEC.md` described an architecture —
the OpenClaw gateway, a `packages/saas`, six workflows — that no longer exists.

### Known gaps

- Approving a pending `Acting` promotion has no one-click surface yet; it goes
  through `resolve_instinct_promotion` (#459).
- `deploy-compose` still ships `caddy/plane-proxy.Caddyfile` to every tenant
  for a service that no longer exists (#462).
- Older tenants carry inert vault directories for demoted record types
  (`assumption/`, `synthesis/`, `constraint/`, …).
- `packages/alfred-vault`'s tests are not wired into the push-to-main gate, and
  the web `node:test` core suites are not run by CI at all.
- Deep `plane_sync` code in learn/ctrl remains dormant rather than deleted.

## [2026-05-31]

**Lane Vb** (this release) makes **voice (Twilio phone)** per-profile.
Lane V's earlier punt — "voice-bridge is a single compose sibling per
VM, not a Hermes profile" — was a punt, not a constraint. The container
stays singular but its routing becomes multi-tenant: the Twilio webhook
URL the principal pastes into the Twilio Console for a profile-specific
number is now `https://voice.<domain>/twiml/inbound?profile=<slug>`, and
voice-bridge resolves the slug at TwiML-emission time. The WSS endpoint
`/voice/<slug>` carries the routing key downstream into VoiceCall;
`fetchTenantContext` queries ctrl-api's per-profile voice status to
learn the calling number, and a new scoped-bearer endpoint
`GET /api/v1/channels/voice/internal/openai-key?profile=<slug>` returns
the profile's OPENAI key (when set) so the Realtime session bills
against the right account. Falls back to main's instance-shared
`OPENAI_API_KEY` when a non-main profile leaves the key blank. Sir's
spec: *"voice MUST be per profile. it isn't realistic that I would
interact with multiple profiles and want them in separate channels."*

Per-profile credentials in the profile's `.env`: `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_VOICE_FROM_NUMBER`, optional
`OPENAI_API_KEY`, plus the existing `VOICE_ALLOWED_CALLERS` /
`VOICE_ALLOW_ALL_CALLERS` allowlist toggles. Five new ctrl-api routes
under `/api/v1/channels/voice/*` — `status` / `credentials` (PUT/DELETE)
/ `test` / `allowlist` / `inbound` / `internal/openai-key` — all accept
`?profile=<slug>`, all run through `assertWritableProfile`, all append
`channel_token_set` / `channel_token_cleared` audit rows with
`profile_slug` in the payload (matching Lane V's Telegram / Slack / SMS
shape verbatim). voice-bridge does NOT need a restart on credential
rotation: it reads per-call. The `restart_scope: "per-profile"` shape
on the response is honest about that — the next inbound call picks up
the new creds. The `/profiles/:slug/channels` Voice card is now a real
configuration form (matching the SMS card's Twilio triple + an optional
OpenAI override) with the per-profile webhook URL displayed for the
operator to paste into Twilio. Two new explicit Wasp ops
(`setProfileVoiceCredentials` / `clearProfileVoiceCredentials`) layer on
top of Lane V's `setProfileChannelToken` consolidator so call sites that
only need voice have a named entry point. References #120; closes the
Lane V voice honest-partial. 10 new ctrl-api unit tests (PUT validation,
DELETE wipe, audit-row shape, TwiML routing, internal-key fallback) all
green.

The operator step Sir owns: in the Twilio Console, set each profile's
phone number's "A call comes in" webhook to that profile's URL surfaced
on its `/profiles/:slug/channels` Voice card (copy-button included).
That's the routing key — voice-bridge reads it off the URL query.

**Lane Vb2** (follow-on to Lane V) closes the email half of the
per-profile-channels promise. Lane V shipped the FULL per-profile
channels page but explicitly punted **Email (AgentMail)** with the note
"AgentMail provisions one inbox per VM today; per-profile addressing is
a follow-up." Sir's clarification — *"email MUST be per profile.
AgentMail's API provisions inboxes; that's an API call, not a manual
provisioning step. Just call it."* — is exactly the work this lane does.
ctrl-api now exposes four new routes (`GET /channels/email/status`,
`POST /channels/email/provision`, `DELETE /channels/email/inbox`, `POST
/channels/email/test`), all scoped by `?profile=<slug>`. The provision
route calls AgentMail's real API (`POST /pods/<pod>/inboxes` then `POST
/inboxes/<id>/api-keys`) using `AGENTMAIL_MASTER_API_KEY` from the
tenant `.env`; on success the inbox creds (`AGENTMAIL_INBOX_ID`,
`AGENTMAIL_INBOX_ADDRESS`, `AGENTMAIL_API_KEY`) land in the profile's
`/hermes-state/profiles/<slug>/.env` and a
`(channel_kind=email, channel_identity=<address>, profile=<slug>)` row
is written to `channel_profile_binding`. Inbound mail to that address
arrives at the existing AgentMail webhook → the recipient-based
resolver picks the right profile; the only thing that was missing was
the binding row. Outbound `/api/v1/email/{send,reply,forward,…}` now
honour `?profile=<slug>` and pull credentials from the profile's `.env`
rather than the tenant-wide env — so Sentinel's replies go from
Sentinel's "From:" address with Sentinel's inbox-scoped key. DELETE
releases the inbox at AgentMail (best-effort upstream delete; binding +
.env keys wiped unconditionally so routing falls back to main cleanly).
The `/profiles/:slug/channels` Email card flips from the Lane V
"instance-level notice" to a real provision / test / disconnect form. A
new `getProfileEmailStatus` query plus three new actions
(`provisionProfileEmailInbox`, `clearProfileEmailInbox`,
`sendProfileEmailTest`) wire the UI to the routes. 14 new helper +
route unit tests covering the happy path, the no-master-key honest
failure, the archived-profile guard, idempotent DELETE, and the
inbound-routing decision (provisioned address → sentinel, unbound
address → main fallback). **Operator step**: tenants that want
per-profile email must set `AGENTMAIL_MASTER_API_KEY` +
`AGENTMAIL_SHARED_POD_ID` in `/opt/alfred/.env` and restart ctrl-api;
without the master key the route returns a clean 400 with code
`master_key_missing` and the UI shows the operator hint instead of the
provision button.

**Lane V** (this release) lands the per-profile FULL channels surface.
Until tonight, the new `/profiles/:slug` page from Lane III could bind a
channel to a profile (the inbound side — "this Telegram chat speaks to
Sentinel") but had no way to configure the OUTBOUND credentials per
profile. The bot token, Slack workspace, Twilio creds and Paperclip key
all lived in main's `.env`; a second profile spoke to its own channels
through main's tokens. Lane V closes the loop: every per-profile-aware
channel route on ctrl-api now writes to `/hermes-state/profiles/<slug>/
.env` (Lane IV gave the routes the `?profile=<slug>` query, this lane
adds `assertWritableProfile` validation + per-profile Vaultwarden item
names + scoped restarts + audit-row mirroring), and a new
`/profiles/:slug/channels` page renders one card per per-profile
channel with explicit "for <slug>" copy, plus an honest "configured on
/channels" notice for the five channels that are still single-instance
by design (voice-bridge sibling, OMI device, HA household, Recall
account, AgentMail inbox). One new ctrl-api helper —
`restartProfile(slug)` — drops a per-profile flag-file under the
profile's dir so the supervisor can scope its respawn to one gateway; on
fallback it logs the wider scope via `restart_scope: 'compose-restart'`
in the API response so the UI surfaces the warning. Three new Wasp ops
(`getProfileChannelStatuses`, `setProfileChannelToken`,
`clearProfileChannelToken`) consolidate the per-kind operations so the
page can fetch all four in one round-trip. References #120 (which Lane
III closed). 9 new helper unit tests; existing telegram/slack/sms/
paperclip route tests still green.

Alfred Black becomes a **household of personas**, not just one butler.
Until tonight, Hermes ran exactly four sealed profiles that the
principal could neither name nor manage from the dashboard — `main`
(the conversational butler), `workers` (the background sub-agents),
`heavy` (Opus when Sonnet wasn't enough), and `codex-builder`
(the isolated PR-author runtime). If Sir wanted a second persona — a
`cratchit` bookkeeper, a `field-foreman` site lead, an evening reading
companion — the only path was the same one Joe took on
`joe.alfred.black`: ssh in, write a sibling container into
`/opt/alfred/docker-compose.override.yaml` by hand, and live with the
fact that `docker compose pull` could overwrite the persona file on
the next image refresh. After this release the principal can spin up a
new persona from `/profiles` in 30 seconds, bind a Telegram chat or a
phone number directly to it, archive it when its season is done, and
restore it later without losing the slug — and every gateway sits in
the same supervised Hermes process so a `compose pull` no longer touches
the persona dir.

The cutover landed across four lanes over two days. **Lane I** (PR
#196) added the `agent_profile` + `channel_profile_binding` registry
to `state.db` (migration `0017`) and the eight `/api/v1/agent-profiles`
CRUD routes — slug regex `^[a-z][a-z0-9-]{1,30}$`, port allocator
pinned to `18794..18799` for six user-facing slots, the four reserved
infra profiles seeded with the right port and the right
`is_user_facing=0` flag so they stay invisible to the manager UI.
**Lane II** (PR #198, with hotfixes in #199 / #200 / #201) hooked the
registry to the Hermes side: a new
`/hermes-state/profiles/_registry.json` is written atomically by
ctrl-api on every create/archive/restore, `supervisor.sh` reads it on
boot + `SIGUSR1` to decide which gateway processes to keep alive, and
the supervisor self-renders any profile dir that's in the registry
but missing on disk so a fresh tenant's first POST lands on a real
gateway in ~17s rather than `docker compose down/up`-cycling.
**Lane IV** (PR #197) rewired every channel route — Telegram, Slack,
SMS, voice, email, Paperclip, Omi, HA, Recall, Terminal, Tailscale —
to resolve the target profile via `resolveProfileForChannel(kind,
identity)` instead of the hard-coded `"main"` literal that lived in
each of them, with a graceful archived-target cascade so a stale
binding to a deleted profile still answers via `main` rather than
404'ing on inbound.

**Lane III** (PR #202, this release) is the principal-visible
surface. Three new pages live at `/profiles`, `/profiles/new`,
`/profiles/:slug` — the list with initials avatars, status pills,
port + model + free-slots meter and a "show archived" toggle; the
wizard with auto-derived slug, model dropdown, and an optional persona
seed for SOUL.md; the detail page with grouped channel bindings, an
inline bind/unbind form, a read-only persona preview, and the
lifecycle controls (archive with a confirmation modal that explains
the port will go quiet, restore that brings the gateway back on the
same port). Seven new Wasp ops (`getAgentProfiles`, `getAgentProfile`,
`createAgentProfile`, `archiveAgentProfile`, `restoreAgentProfile`,
`bindChannelToProfile`, `unbindChannelFromProfile`) proxy through
ctrl-api with the plain-async `Promise<any>` shape the dashboard
requires — the Wasp Payload-trap from PRs #139/#145/#182/#184/#186
catches a typed return at the SDK-compile step and kills the
build-web cycle, and the rule is now load-bearing enough to belong in
the lane comment header. A new
`POST /api/v1/agent-profiles/:slug/restore` route closes the namespace
UX bug Lane IIb flagged: an archived slug no longer stays reserved
forever, and the same supervisor nudge that brought the profile up the
first time re-renders the dir and relaunches the gateway in ~30s.
The detail page polls `getAgentProfile` every 3 s while
`status='pending'` so the wizard's "Sentinel coming up" promise lands
without a manual refresh. A small "Profiles" link in the More menu of
the Frame nav makes the manager one click away from every dashboard
page. Five Lane-III-shaped questions Sir flagged on the issue (cost
surface per profile, per-profile MCP catalog UI, per-profile skill
catalog UI, per-profile bootstrap form with RULES.md seeding,
per-channel avatar / @handle picker) are deferred to follow-up issues
filed against #120 — the lane that closed #120 ships the registry, the
gateway, the channel routing and the manager; the polish lives in its
own queue.

### Added

**Lane III — UI surface (#202)**
- `packages/web/src/dashboard/ProfilesPage.tsx` — list page at
  `/profiles`. Reads `getAgentProfiles`; renders one row per
  user-facing non-archived profile (initials avatar, label, slug
  marginalia, model + port, status pill, reserved chip on `main`);
  a "show archived" toggle that flips the client-side filter; a
  free-slots meter ("N of 6 user-profile slots free"); empty-state copy
  pointing at `/profiles/new`.
- `packages/web/src/dashboard/ProfileNewPage.tsx` — single-form wizard
  at `/profiles/new`. Label auto-derives the slug
  (`/[^a-z0-9]+/` → `-`, trimmed to 31 chars); the slug is editable
  but client-side validated against the server's
  `^[a-z][a-z0-9-]{1,30}$`. Model dropdown is a six-entry whitelist
  matching what Hermes' OpenRouter resolver accepts. Optional
  description + persona template (textarea seeds SOUL.md). On Save
  posts `createAgentProfile` and routes to `/profiles/<slug>` with the
  detail page's polling kicking in.
- `packages/web/src/dashboard/ProfileDetailPage.tsx` — single page
  at `/profiles/:slug`. Header strip (status pill, port, model,
  updated-relative). Channels section groups bindings by kind, shows
  the per-kind defaults as a locked "default" chip (Lane I's protected
  `binding-default-*` ids), inline bind form with channel-kind dropdown
  + identity input (placeholder per kind: `chat_id`, `workspace:channel`,
  E.164, etc.), unbind on every non-default row. Persona section renders
  `persona_template` read-only when non-empty. Lifecycle section
  surfaces Archive (with a confirmation modal that names the port that
  will go quiet) for user-facing non-reserved live profiles, and
  Restore for archived non-reserved ones. Status polling: ticks
  `getAgentProfile` every 3 s for up to 90 s while `status='pending'`.
- `packages/web/src/client/components/ab/Frame.tsx` — adds "Profiles"
  to the More menu so the manager is one click away from every
  dashboard page.
- `packages/web/main.wasp` — three new routes (`ProfilesRoute`,
  `ProfileNewRoute`, `ProfileDetailRoute`), two new queries, five new
  actions wired through `@src/dashboard/operations`.

**Lane III — Wasp ops (#202)**
- `packages/web/src/dashboard/operations.ts` — seven plain-async
  `Promise<any>` operations: `getAgentProfiles`, `getAgentProfile`,
  `createAgentProfile`, `archiveAgentProfile`, `restoreAgentProfile`,
  `bindChannelToProfile`, `unbindChannelFromProfile`. Each proxies to
  ctrl-api's `/api/v1/agent-profiles*` surface. Header comment names
  the Wasp Payload-trap explicitly so the next author doesn't add a
  typed return.

**Lane III — ctrl-api restore route (#202)**
- `POST /api/v1/agent-profiles/:slug/restore` — bring an archived
  profile back. 404 on unknown slug; 400 on "is not archived" so the
  UI distinguishes "already live" from "restored"; 409 on the
  defensive reserved-row branch. On success the supervisor registry
  is rewritten and a SIGUSR1 nudge re-renders the profile dir +
  relaunches the gateway on the original port. Lib-side helper
  `restoreProfile(db, slug)` covers the same contract for callers
  outside the route layer; 5 new unit tests in
  `packages/ctrl/tests/agent-profiles.test.ts` (39 pass total).

### Changed

- The Frame nav's More menu now lists "Apps, Profiles, Settings" (was
  "Apps, Settings"). The primary nav is unchanged so the dashboard's
  habitual surface stays the same.

### Deferred to follow-up issues

The five "Q-deferred" items Sir flagged on #120 are filed as separate
issues against the multi-profile epic:

- Cost surface per profile (Q2)
- Per-profile MCP catalog UI (Q3)
- Per-profile skill catalog UI (Q4)
- Per-profile bootstrap form + RULES.md seeding (Q5) + per-channel
  avatar / @handle picker (Q6)

Each follow-up has its own acceptance criteria; this CHANGELOG entry
intentionally doesn't promise them in v2026.05.31.

## [2026-05-30]

Alfred Black becomes **budget-aware**. Before this release, every turn
Alfred took on Voice PE / Telegram / Slack / SMS / Paperclip sent the
full catalogue of every connected MCP server's tools to the model on
every call — 42k input tokens of schemas before the user's question
even got read, and a Composio call cost ~4.5 seconds of Python
cold-start on top. A calendar query through Voice PE consistently hit
~130 seconds and ended in "Alfred timed out". After this release the
same query returns a real answer in under fifteen seconds, **and the
principal can dial the tool catalogue Alfred carries on every turn with
a single click per server.**

The centrepiece is the **three-phase Composio latency program** that
shipped end-to-end on `home.alfred.black` between 11:53 and 12:48 UTC,
followed by a `/tools` UI cutover at 14:28 UTC.

**Phase A — HTTP sidecar** (#177). alfred-learn now runs a FastAPI
sidecar on port `:8788` (`packages/learn/src/composio_server.py`)
listening for `POST /composio/execute`. ctrl-api's
`/api/v1/integrations/execute` route (which every Composio action
takes — Gmail label list, calendar event read, Notion page create,
~300 actions total) switched from `docker exec alfred-learn python3 -c
<script>` to a service-DNS HTTP call. Per-call latency drops from
~4.5 s to ~500 ms — the SDK and Composio client now live as a
singleton in module scope, no per-request init. A `COMPOSIO_EXECUTOR=docker|http`
env flag preserves the old path for emergency rollback. The Composio
fix is the single largest contributor to the wall-time win.

**Phase B — runtime-flippable tool dispositions** (#178). A new
`tool_disposition` table in state.db (migration `0014`) records, per
MCP server, whether its tools are exposed inline (**DIRECT** — Alfred
sees them every turn, fastest, costs tokens) or hidden behind a
delegation gateway (**DELEGATED** — tools available only on the workers
profile, accessed via `delegate_to_focused_agent`, cheaper model
+3–5 s per use). Defaults are all-`direct` so existing tenants
behave unchanged on upgrade. Three new MCP tools on the `alfred`
server give Alfred himself the lever: `list_tool_dispositions` (cached
60s, read at session start so he knows whether to call native or
delegate), `set_tool_disposition` (Sir says "demote sure to delegated"
or "promote vault to direct"), and `delegate_to_focused_agent` (spawns
an ephemeral focused subagent on the workers profile with the same
identity + journal). Three servers are **self-protected** — `alfred`,
`alfred-ctrl`, and `execute` — because delegating them would break
Alfred's ability to reach his own ctrl-api, his own briefing/decision
tools, or the Composio progressive-disclosure surface that Phase A
optimised. The backend accepts a self-protected flip if Sir is
deliberate (via the MCP tool); the UI surfaces it as `locked` so an
accidental click doesn't cost a 10-second restart for nothing. Hermes
init's `render_mcp_servers.py` reads the disposition table at boot and
writes `tools.include: []` on delegated servers so the LLM never sees
their schemas, while the spawned MCP process still serves the workers
profile. A debounced restart cycle (10s window) coalesces a flurry of
flips into one Hermes reload.

**Phase C — primary-entity defaults cache** (#179, with hotfixes #180
and #181). A second new state.db table (`composio_user_defaults`,
migration `0015`) caches each user's "primary entity" per toolkit. At
Composio OAuth-completion, ctrl-api fetches Sir's `primary === true`
calendar from `GOOGLECALENDAR_LIST_CALENDARS` and persists `{calendarId:
<id>}`. The Phase-A sidecar injects those defaults *under* the LLM's
args before dispatching to Composio so an explicit calendarId still
wins — the model can call `GOOGLECALENDAR_EVENTS_LIST` with empty
`calendarId` and the primary fills in automatically. The new
`generateComposioSkill()` call-out surfaces "Sir's primary calendar
(`<id>`) is the default. Pass only `timeMin` + `timeMax` — calendarId
fills in automatically." in `alfred-composio-googlecalendar/SKILL.md`
once the cache is populated. Gmail primary inbox and Notion default
workspace are TODOed with the same shape. Direct sidecar test of
`GOOGLECALENDAR_EVENTS_LIST` with the defaults injected: **1.98
seconds end-to-end.** The honest caveat: the end-to-end Voice PE
calendar smoke still came in at 67s on first iteration because the
LLM, by training-data bias, fans out across `LIST_CALENDARS` + 7
per-calendar `EVENTS_LIST` calls before trusting the shortcut.
Further prompt-side tuning (or a Phase-D forced-delegation gate) is
left as follow-up; the architecture and the cache are in place and
proven.

**`/tools` becomes the disposition console** (#182). The page now
groups MCP tools **by server** rather than as a flat list. Each
server is a card showing its name, tool count, current
DIRECT/DELEGATED state, audit trail (`last flipped <when> by <who>`),
and a one-click "flip to delegated" / "flip to direct" button. After a
flip the UI shows "hermes restarting…" for ~12 seconds then refetches
the live row. The three self-protected servers (`alfred`,
`alfred-ctrl`, `execute`) render with a `locked` chip instead of a
toggle, with a tooltip explaining the self-protection. The lever moves
across **every channel Alfred-main serves at once** — Telegram, Slack,
SMS, Voice PE (via the HA conversation agent), Paperclip, OMI, and
inbound email. The two channels that *don't* pick it up are
voice-bridge (gpt-realtime-2 with its own curated `VOICE_BRIDGE_ALLOWLIST`)
and `claude.ai/code` (which consumes Hermes' MCP tools directly without
a Hermes LLM turn).

**Around the latency program**, two HA-side guards landed:
`ha__integration_remove` now requires the exact phrase `"yes, sever my
own connection to Home Assistant"` before it'll act on the `alfred`
domain (#173), after Alfred accidentally deleted his own HA integration
during a 2026-05-29 session. The `/channels/ha/turn` route now
short-circuits when alfred-ha sends the `__alfred_ha_preflight__`
sentinel text (#174), avoiding the 30s Hermes cold-start that was
firing false `cannot_connect` on the integration's connection test.
The `alfred-ha` HACS custom_component bumped to v1.1.3 with
`DEFAULT_TIMEOUT` 30 → 90s and a per-entry OptionsFlow so the timeout
is tunable without re-installing.

**Recall.ai in-meeting two-way voice goes live** (#113 PR5 / #171,
with card polish in #170 and #172). Alfred can now talk back in a
meeting bot's transcript, not just listen. The persona is locked: the
bot speaks **as Alfred, never as the principal** — four guards
enforce this from the prompt down through the Twilio Streams layer.

**New fleet member: `rami.alfred.black`** provisioned to a fresh
Hetzner cx53 in nbg1-dc3 (178.105.224.71) with the full 23/31 container
stack healthy and all nine Let's Encrypt certs valid. Eight provider
keys (Hetzner, Cloudflare Global API Key, OpenRouter, Composio, OpenAI,
DockerHub, Recall.ai, Groq) were lifted out of conversation/.env
plaintext and stored encrypted in `home.alfred.black`'s Vaultwarden
under the new **"Provider API Keys"** folder
(`aa794a95-fb7b-4889-a5a9-6dc34ecf70c2`) so future tenant
provisioning runs read from there rather than from operator memory.

This is the first release where Alfred's runtime model is *tunable by
the principal at runtime*. The lever exists.

### Added

**Phase A — Composio HTTP sidecar (#177)**
- `packages/learn/src/composio_server.py` — FastAPI app on `:8788`
  with `POST /composio/execute {action, arguments, user_id,
  connected_account_id} → result` and `GET /health`. Composio SDK
  client is a module-scope singleton; no per-request init.
- `packages/learn/entrypoint.sh` starts the sidecar in the background
  before `exec python -m src.worker` so the Temporal worker stays
  foreground and the sidecar restarts with the container.
- `packages/ctrl/src/api/routes/integrations.ts:3055-3135` —
  `executeComposioAction` now POSTs to `http://alfred-learn:8788/composio/execute`.
  Behind `COMPOSIO_EXECUTOR=docker|http` (default `http`); the
  dockerExec path stays as one-line emergency rollback.

**Phase B — tool_disposition runtime model (#178)**
- `state.db` migration `0014_tool_disposition.sql` — table seeded
  with all 9 MCP servers (`alfred`, `alfred-ctrl`, `sure`, `plane`,
  `vaultwarden`, `paperclip`, `execute`, `hass`, `files`) at
  `disposition='direct'`, `updated_by='init'`. Backwards-compatible:
  pre-existing tenants get the same behaviour as before until they
  flip something.
- `GET /api/v1/agents/tool-disposition` returns the 9-row map with
  `{server, disposition, updated_at, updated_by}`.
- `POST /api/v1/agents/tool-disposition` flips one row, queues a
  debounced `docker compose restart hermes` (10s window so a flurry
  coalesces), returns the new state + `restart_scheduled` boolean.
- `POST /api/v1/agents/focused-subagent` — the focused-subagent
  execution route. Session key `focus-<domain>-<short-hash>`, builds
  a persona+task+context prompt, calls Hermes workers `:18790/v1/responses`
  with that session key (mirrors the existing `_call_clerk` pattern),
  returns the subagent's plain-text answer verbatim. 60s default
  timeout.
- Three new MCP tools on the `alfred` server (`packages/mcp-server/src/tools/alfred.ts`):
  - `list_tool_dispositions` — live map, cached 60s.
  - `set_tool_disposition` — `{server, disposition, updated_by='alfred'}`.
    Self-protected `alfred-ctrl` / `alfred` / `execute` write a warning
    note in the audit row but the backend accepts the flip if Sir is
    deliberate.
  - `delegate_to_focused_agent` — `{task, domain, context?}`. The
    delegation gateway. Use when the target server is DELEGATED or
    when fanning out across many calls (gmail batch, calendar
    multi-account).
- `packages/hermes/init/render_mcp_servers.py` reads
  `tool_disposition` at render time and writes `tools.include: []` for
  servers with `disposition='delegated'`, preserving operator-owned
  blocks (same pattern as `migrate_main_profile_tool_trim.py` from
  PR #176).
- `packages/mcp-server/skills/alfred-mcp-skill.md` — new "How to use
  the disposition map" section near the top: glance at
  `list_tool_dispositions` at session start (cached 60s, cheap), pick
  DIRECT or DELEGATED per server, relay subagent replies verbatim, ask
  Sir before promoting a sensitive server.

**Phase C — primary-entity defaults cache (#179, #180, #181)**
- `state.db` migration `0015_composio_user_defaults.sql` — composite-PK
  table on `(toolkit, user_id)`, JSON `default_args` payload, `source`
  provenance (`oauth_completion` / `manual` / `backfill`),
  `updated_at` index.
- OAuth-completion hook in `auto-config` (`packages/ctrl/src/api/routes/integrations.ts`)
  — on `googlecalendar` connection, fires `GOOGLECALENDAR_LIST_CALENDARS`
  via the Phase A sidecar, picks `primary === true`, persists
  `{calendarId: <id>}` with `source='oauth_completion'`. Gmail + Notion
  TODOed with the same shape inside `cacheComposioPrimaryDefaults()`.
- `GET /api/v1/integrations/defaults?toolkit=…&user_id=…` — lookup
  surface for the sidecar.
- `POST /api/v1/integrations/:toolkit/refresh-defaults` — manual
  re-resolution / backfill.
- Sidecar (`packages/learn/src/composio_server.py`) — 5-minute
  in-process TTL cache on defaults; merges defaults *under* LLM args
  so explicit `calendarId` still wins.
- `generateComposioSkill()` — adds a "Primary calendar shortcut"
  callout to `alfred-composio-googlecalendar/SKILL.md` when a cached
  id exists, with a worked example.

**`/tools` disposition console (#182)**
- `packages/web/src/tools/operations.ts` — two new Wasp ops:
  `getToolDispositions` (query) and `setToolDisposition` (action,
  `updated_by='sir'`). Plain async-function shape with `Promise<any>`
  return — the Wasp `Promise<T>` trap from PRs #139 and #145 caught
  us a third time; the convention is documented in the file header
  to prevent a fourth.
- `packages/web/src/tools/ToolsPage2.tsx` — MCP section regrouped by
  server. New `McpServerCard` component carries the disposition badge,
  audit line, flip button (or `locked` chip for self-protected
  servers), and a collapsible per-tool detail list (the previous flat
  view, now expandable per server).
- Live verified: home.alfred.black `/tools` returns HTTP 200 in 62 ms,
  `setToolDisposition` round-trips through ctrl-api with debounced
  Hermes restart firing as advertised.

**Recall.ai in-meeting two-way voice (#171)**
- Alfred speaks **as Alfred, never as the principal**. Persona
  enforced at four points: the bot's input transcript prompt, the
  realtime persona seed, the Streams layer's voice anchor, and the
  reply post-processor.
- `/channels` Recall card surfaces API key + webhook secret inputs
  with correct status text (#170) and the real webhook event names
  Recall publishes (`bot.in_call_recording`, `bot.done`,
  `bot.fatal`) (#172).

**Operational**
- `rami.alfred.black` fleet tenant — full provisioning landed on
  Hetzner cx53 nbg1-dc3 IPv4 178.105.224.71, 9 Cloudflare A-records,
  all 9 LE certs valid, 23/31 healthy services.
- 8 provider API keys lifted into `home.alfred.black` Vaultwarden
  (folder `aa794a95-fb7b-4889-a5a9-6dc34ecf70c2`, "Provider API
  Keys") with `david@sabo.tech` paired to the Cloudflare Global Key.
  The plaintext-in-env era ends here for tenant provisioning.

### Changed

- `ha__integration_remove` requires the exact phrase `"yes, sever my
  own connection to Home Assistant"` before acting on the `alfred`
  domain (#173). Live-tested after a 2026-05-29 incident where Alfred
  removed his own HA integration mid-session.
- `/api/v1/channels/ha/turn` short-circuits the `__alfred_ha_preflight__`
  sentinel text instantly instead of routing through Hermes — kills the
  30-second `cannot_connect` false-positive during integration setup
  (#174).
- `alfred-ha` HACS custom_component v1.1.3 — `DEFAULT_TIMEOUT` 30 →
  90 s + per-entry OptionsFlow so the timeout is tunable without
  re-install. v1.1.2 was the docs-only follow-up.
- Composio tool-catalogue trim (#176, retroactively rolled into Phase
  A's input-token win). Per-profile `tools.include` whitelists:
  `sure` 95 → 23, `hass` 85 → 28, `paperclip` 40 → 18. Trims ~40s
  off LLM time-to-first-token per voice/chat turn before Phase A even
  starts work.

### Fixed

- Phase C hotfix #180: `GOOGLECALENDAR_LIST_CALENDARS` response shape
  is `data.calendars`, not `data.items` — the OAuth-completion cache
  was silently writing nothing for the first hour of Phase C being live.
- Phase C hotfix #181: the sidecar's defaults lookup was pointed at
  `alfred-ctrl-api` (the legacy hostname); switched to `ctrl-api` via
  the `ALFRED_CTRL_URL` env var so the cache hit on every call.

### Build & CI

- Three iterations to land PR #182 — the same Wasp `Promise<T>` trap
  that bit #139 and #145 fires when an op's return type is a concrete
  object literal (not assignable to Wasp's `Payload` constraint). The
  fix is an explicit `Promise<any>` annotation on the function
  signature; the file header now documents the rule so a fourth
  occurrence is caught at review.

### Memory

- New `docker-cp-tmpfs-quirk` — `docker cp` into
  `alfred-black-hermes-1:/tmp/...` silently fails (rc=0, file never
  appears) because /tmp is a compose tmpfs. Use `docker exec -i ...
  sh -c 'cat > /tmp/x'` instead.
- New `never-env-dump` — Sir's standing rule: never `env` (full dump)
  with a grep filter; name each var explicitly via `printenv VARNAME`
  or strip values with `awk -F= '{print $1}'` for names-only.
- New `hacs-restart-needed` — HACS-installed component upgrades need
  a full HA Core restart, not just `config_entries/reload`. The
  reload runs the old code from Python's `sys.modules` cache.

## [2026-05-29]

Alfred Black becomes **the principal's house operator**. Before this
release, "Alfred can control my home" was a vibes claim — he could read a
few states through Home Assistant if everything was already configured,
and that was it. After this release he is a full Tier-4 superuser on
Home Assistant: he can install Hue with the IP you tell him, install a
HACS theme, restart Core (auto-snapshotting first), provision a child
account with restricted access, rename an entity, write a wake-word
model into `/share/openwakeword/`, SSH into the host to tail a log, and
log every destructive verb against a Desk decision so you can audit
who-did-what-and-why a week later. The whole **Tier 4 HA Autonomy**
project (GH #115/#158) shipped tonight in eight phased PRs (#161-#168)
with locked defaults: destructive verbs require a `decision_ref`, every
backup-needing verb auto-snapshots first via `triggerBackupBeforeAction`,
and every non-trivial write lands a daybook entry. The hass MCP tool
catalogue grew from **16 to 85** in one session.

The structural enabler is **the alfred-ha Supervisor bridge** (v1.1.1)
— a HACS-installed custom component that exposes nine LLAT-callable HA
services (`alfred.supervisor_call`, `supervisor_addon_info`,
`supervisor_addon_options_update`, `supervisor_host_info`,
`supervisor_os_info`, and four `supervisor_share_*` for file CRUD under
`/share/`). HA's own LLATs are Core-scoped by design; this bridge gives
LLAT callers full Supervisor scope through a path-safety-guarded
proxy, which means Alfred no longer needs SSH for any addon-management
or shared-file write. The wake-word `.tflite` upload that motivated the
bridge proved the path end-to-end — a single
`POST /api/services/alfred/supervisor_share_write` landed
`alfred.tflite` at `/share/openwakeword/alfred.tflite` and openWakeWord
picked it up after one addon restart.

**HA conversation agent live.** `conversation.alfred` is now the default
engine on the principal's Assist pipeline
(`01k4qpm8fz8r1nx59zjdrxtasp`). Channel-token mint (#140) +
`/api/v1/channels/ha/turn` (#122) + a v1.1.1 HACS install land the
custom component on the principal's HA via WebSocket; pipeline updates
via `assist_pipeline/pipeline/update` route every Assist turn through
the same Hermes-main session store as Slack / Telegram / email / web
chat, so the kitchen voice satellite and the dashboard typed chat are
the same Alfred with the same memory. Voice bridges still own the
realtime audio path for phone calls; the HA-side text path uses HA
Cloud STT + ElevenLabs TTS at the edges.

**Wake word: the truth, with sources.** The `alfred` openWakeWord model
(from `fwartner/home-assistant-wakewords-collection`) is loaded on the
host. **It will fire on Wyoming-protocol satellites** that stream
audio to HA. **It will NOT fire on the Home Assistant Voice PE**
because that device runs `microWakeWord` (a different runtime, model
format not interchangeable) on the on-device ESP32-S3, with a fixed
firmware model list (`Hey Jarvis` / `Hey Mycroft` / `Okay Nabu`). To get
"Alfred" on Voice PE means either training a `microWakeWord` model and
flashing custom firmware via ESPHome Builder, or using the experimental
community firmware fork that flips `use_wake_word: true` to enable
streaming. Tracked upstream at
[`esphome/home-assistant-voice-pe#334`](https://github.com/esphome/home-assistant-voice-pe/issues/334).

**SSH wired both ways.** The principal's `~/.ssh/id_ed25519` and a
freshly-generated `alfred-hermes@home.alfred.black` ed25519 key were
written to the `core_ssh` addon's `authorized_keys` via the new bridge
(`alfred.supervisor_addon_options_update`). Both keys verified
end-to-end — Alfred can `ssh root@100.70.124.6 -p 22` from inside the
Hermes container, the principal can do the same from their Mac (LAN or
Tailscale). Alfred's private key is stored in Vaultwarden as
**"HA SSH (Alfred Hermes)"** in the `Home Assistant` folder, with the
connection card (host / port / fingerprint / pubkey) as custom fields
so Alfred can read individual values cleanly. The new skill doc (#169)
teaches Alfred the **decision tree** — SSH only when MCP and the
bridge can't cover the job (live log tail, `/config/configuration.yaml`
edits, `df -h`), because SSH bypasses the gate-and-audit machinery
that Tier-4 defaults require.

**Operational cleanups that bit us and got fixed:**
`channels_ha`'s `vault-cli` response parser was reading the
double-wrapped LIST shape against single-object responses, causing
`VAULT_LLAT_MISSING` 502s once any single-object endpoint was hit
(#157). The `deploy-compose` workflow that was supposed to auto-roll
docker-compose.yaml + Caddyfile to the fleet on every main push shipped
in #156 but its `FLEET_SSH_KEY` repo secret was never set, so #156 and
#159 both failed silently at `Configure SSH` until I noticed and added
the secret. The Caddyfile's `@public_webhooks` matcher omitted
`/api/v1/channels/ha/*`, so HA's preflight POST to `/turn` hit the SPA's
nginx and got a misleading 405 — same pattern as the May-28 Composio
webhook fix, broadened in #159 along with a `caddy` `pids_limit` bump
from 256 → 1024 (after a runtime `errno=11` saturation event during the
HA setup run) and a `deploy/README.md` note that `sed -i` on the
Caddyfile changes the host inode and requires `docker restart` to
re-mount. The `mcp-stdio` bundle on `home`'s `/hermes-state/` was a week
stale (chat-Alfred missing the `hass` and `files` MCP servers entirely
because the operator-owned-config preservation pattern was incorrectly
applied to a build artifact); #160 makes the rsync unconditional on
every init and adds an ADD-only mutator that grafts required
`mcp_servers` entries into the operator-owned `config.yaml`.

**State.db migrations 0011-0013** add `ha_event`, `ha_backup_ref`
(with `triggered_by` provenance: `user` / `auto:<verb>` /
`strategy:auto`), `ha_integration_ref` (with `removed_at` soft-delete so
"Alfred installed and removed this" survives), and `ha_user_ref` (with
`llat_vw_id` mapping each HA user account to its Vaultwarden item).

The full new tool catalogue + decision tree is documented in
`packages/mcp-server/skills/alfred-mcp-skill.md` (#169); the live Hermes
runtime on the principal's tenant has the new bundle as of this release.

## [2026-05-25]

Alfred Black becomes **one Alfred**. Until this release, a "delegate" from
the Desk and a Telegram DM and the morning brief were three different
sessions in three different worlds — when the principal replied to a
reminder, the agent that received the reply had no memory of having sent
it. This release lands the **One-Alfred continuity layer**: an append-only
`alfred_journal` in `state.db`, a unified outbound endpoint that delivers
every Alfred-spoken message in the same butler voice through the same
channel adapter, and a Hermes plugin that injects recent journal entries
as authoritative context on the next inbound turn. From the principal's
seat there is now one Alfred who remembers the things he just said,
across channels and across sessions.

Around that centrepiece, **`/channels` Telegram and Slack go live** with
parity surfaces: manifest-paste / token-paste setup, paired-chat
management, send-test, disconnect, and runtime workspace info — all
backed by `/api/v1/channels/{telegram,slack}/*` routes on ctrl-api that
write directly to the per-profile Hermes `.env` (not the compose env)
so changes actually reach the runtime. The init container preserves these
runtime-managed keys (`TELEGRAM_*`, `SLACK_*`, `DISCORD_BOT_*`, …) across
every `.env` re-render so a restart can no longer wipe a manually-set
bot token.

The **delegate pipeline** is wired end-to-end. `DecisionRouter` now
fires `dispatch_action_to_agent` for `intent=delegate`; the
`delegate-dispatch` path mints a re-routed signal terminal so the
`SignalRouter` cannot loop on its own output; both the legacy and the
ephemeral dispatch paths now honor `principal_note` as the canonical
task (with `action_what` demoted to context) and the ephemeral path is
on by default; `route_decision` budget grows from 60s to 1000s with a
`recover_stuck_dispatching` safety net. The pre-existing
`alfred__notify_principal` tool keeps working but the
`/api/v1/notifications` endpoint is now a thin forwarder to the unified
`/api/v1/alfred-deliver` so every outbound Alfred message goes through
the same journal-aware writer.

The Desk side of the loop closes too: every needs-attention action mints
a `decision/<ts>.md` in `state=open` so observation extraction fires,
the `/study#settings` page exposes **three Agent-autonomy toggles**
(signal-action, state-mutator, auto-task-create) — defaulted to `live`
and read from `state.db` settings — and the instinct scorer matches
multi-word patterns at a lower `MATCH_THRESHOLD` so the loop actually
closes. The signal→instinct path persists `matched_instinct` end-to-end
and `/chores` chore-run observations land in `state.db` (not the vault).

Fresh-deploy work continues: onboarding writes tasks in their rich shape
with `parent_matter` linkage, status vocab is harmonised to the
validator (`'queued' → 'todo'`), `matter/inbox.md` seeds on first boot
as the orphan-fallback target, and `_resolve_parent_matter_path` now
validates against real matters with a fuzzy 4-tier fallback so brand-new
tenants don't write to a non-existent parent. The CLAUDE.md gets a full
context rewrite for fresh clones.

This is the second release under the post-`0522` lane protocol; the
narrative continues to be: every loose end becomes a contract.

### Added

**One-Alfred continuity layer (the centrepiece)**
- `state.db` gains an append-only `alfred_journal` (migration `0002`)
  plus `alfred_principal` and `alfred_principal_channel` tables; every
  outbound Alfred message and every inbound principal turn becomes a
  journal row keyed by `principal_id × channel × chat_id` with a stable
  `(ts, rowid)` ordering.
- `POST /api/v1/alfred-journal` / `GET /api/v1/alfred-journal/recent` /
  `POST /api/v1/alfred-journal/principal/bind` — the ctrl-api writer
  surface for the journal, with helpers split into
  `packages/ctrl/src/db/alfredJournal.ts` so the DB layer is
  unit-testable without booting `server.ts`.
- `POST /api/v1/alfred-deliver` — the **single butler-voiced outbound**.
  Used by `notify_principal`, by the delegate handoff, and by the Desk
  "Hand it to Alfred" action; speaks directly to `api.telegram.org` and
  to `slack.com/api/chat.postMessage` (no Hermes webhook roundtrip),
  records every send in `alfred_journal`, and includes a small
  retry-with-backoff envelope.
- `packages/hermes/plugins/one-alfred/` — a Hermes plugin with three
  hooks: `pre_gateway_dispatch` rewrites inbound principal turns,
  `pre_llm_call` journals the principal's text and injects recent
  journal entries as **authoritative** continuity (`[ALFRED-CONTINUITY
  — authoritative]` + "these DID happen"), `post_llm_call` journals
  Alfred's reply. 5-second dedupe latch. Per-(user, channel) Hermes
  session keys (`agent:main:telegram:dm:<chat_id>`).
- `packages/hermes/Dockerfile` bakes the plugin in;
  `packages/hermes/docker/supervisor.sh` refreshes it on every container
  boot with an mtime check; `hermes-config.yaml.njk` enables the plugin
  on the `main` profile only.
- `docs/design/one-alfred.md` — the architecture document, with verified
  Hermes hook citations.

**Channels — Telegram (`/channels` Telegram card)**
- `GET /api/v1/channels/telegram/status` — running-state, paired chats,
  workspace info, error strings.
- `PUT /api/v1/channels/telegram/token` / `DELETE …/token` — token
  paste-and-save, writes to the per-profile Hermes `.env` (not the
  compose env), debounced restart.
- `POST /api/v1/channels/telegram/test` — sends a real test message via
  the Bot API so the principal can prove the link works.
- `DELETE /api/v1/channels/telegram/chats/:user_id` — revoke a paired
  chat in place.
- `packages/web/src/dashboard/ChannelsPage.tsx` Telegram card: paired-chat
  list with revoke, send-test, disconnect, copy-link-to-bot, valid-token
  preflight (`isProbablyValidTelegramBotToken` mirrored on both sides).
- 6-case `tests/telegram-routes.test.ts` covers status / token / test /
  chats / revoke.
- Bot-token regex relaxed from `^\d{8,12}:[A-Za-z0-9_-]{35}$` to
  `^\d{8,15}:[A-Za-z0-9_-]{30,}$` so modern Telegram tokens stop
  bouncing at the gate (matches Hermes' own `hermes_cli/setup.py`).

**Channels — Slack (`/channels` Slack card)**
- Six surfaces on ctrl-api: `GET /api/v1/channels/slack/status`,
  `GET …/manifest` (from `hermes slack manifest`), `PUT …/tokens`,
  `DELETE …/tokens`, `POST …/test`, plus an exported
  `slackPostMessage()` used by `/api/v1/alfred-deliver`.
- 5-step manifest-paste setup wizard, two-token save (`xoxb-` bot +
  `xapp-` app for socket mode), running-state workspace card (team /
  bot user / URL), Phase-2 options fold-out (`SLACK_ALLOWED_USERS`,
  `SLACK_HOME_CHANNEL`, `SLACK_ALLOWED_CHANNELS`).
- `packages/web/src/dashboard/slackCardCore.ts` — pure derivation,
  8/8 unit tests; isolated from React so the four card states
  (unconfigured / starting / running / error) verify under `node:test`.
- Token validators (`BOT_TOKEN_RE`, `APP_TOKEN_RE`) shared in spirit
  between ctrl-api and the web card.

**Agent-autonomy toggles**
- `GET / PUT /api/v1/settings` with a `SETTINGS_KEYS` registry; handles
  `signal_action_mode`, `state_mutator_mode`, `auto_task_create_mode`
  (`live | shadow | off`).
- `/study#settings` UI renders the three toggles with provenance and a
  shadow-mode explainer; defaults are `live`.
- `alfred-learn` reads each mode from the settings file at activity
  time and falls through to `live` when unset.

**Telegram + Slack delivery in the same butler voice**
- `legacy_prompt` in `dispatch_action_to_agent` now honors
  `principal_note` as the canonical task and demotes `action_what` to
  `"Signal: …"` context; names `alfred__notify_principal` explicitly so
  the agent knows the tool exists.
- `DISPATCH_USE_EPHEMERAL_EXECUTOR=1` is the default in
  `docker-compose.yaml` so the ephemeral path is on for fresh deploys.
- `recover_stuck_dispatching` activity sweeps in-flight delegations on
  worker boot.

**Onboarding / fresh-deploy correctness**
- `matter/inbox.md` is seeded on first boot as the orphan-fallback
  target (sir-fresh-deploy #1).
- `_resolve_parent_matter_path` validates against real matters with a
  4-tier fuzzy fallback (sir-fresh-deploy #2).
- `backfill_orphan_task_matter_refs` one-shot activity for the existing
  32 tasks that landed without `parent_matter` (sir-matter-task #2).
- Onboarding writes tasks in their rich shape with `parent_matter`
  linkage (sir-matter-task #1).
- New tasks created by the auto-task path always carry `parent_matter`
  (sir-matter-task #4).

**Sir-8 / earlier loose ends folded in**
- `/channels` **Terminal card** with `GET /api/v1/system/ssh-info`,
  `docker exec` quick-actions, and host `authorized_keys` mounted into
  ctrl-api so the principal can SSH in.
- `/connections` app icons render as `<img>` from the apps endpoint.
- `/chores` description full-render; "what this chore does" summary on
  the list and on the detail.
- `/household` reads `RULES.md` from vault records (not workspace
  files) — single source of truth.
- Hermes auth-unhealthy banner with a re-auth CTA on `/connections`.
- C-OB1 person/org gate is Unicode-aware (accepts e.g. "Üveges Gábor")
  with a red repro test in `packages/ctrl/tests/`.

### Changed

**Delegate pipeline (end-to-end)**
- `DecisionRouter` fires `dispatch_action_to_agent` for
  `intent=delegate` (post-#216); the dispatch handler suppresses its
  own decision-mirror when invoked from the router so the Desk doesn't
  see a duplicate (#218 round 2).
- `delegate-dispatch` mints the re-routed signal in **terminal** state
  so the `SignalRouter` cannot loop on its own output (#216).
- Every legacy needs-attention action also mints a `decision/<ts>.md`
  in `state=open` so observation extraction fires (Gap 4 / Gap 5).
- `/api/v1/notifications` is now a thin forwarder to
  `/api/v1/alfred-deliver` — hard switch, no parallel path.
- `route_decision` Temporal budget grows from 60s to 1000s; a
  `recover_stuck_dispatching` activity catches the long tail
  (sir-incident 2026-05-25).

**Init container & runtime config**
- `_RUNTIME_KEY_PREFIXES = ("TELEGRAM_", "SLACK_", "DISCORD_BOT_",
  "WHATSAPP_", "SIGNAL_", "MATRIX_", "MATTERMOST_", "BLUEBUBBLES_")`
  in `packages/hermes/init/render_hermes.py`; the renderer now uses
  `_merge_preserve_runtime_keys()` to keep any value the ctrl-api
  channel routes have written, across re-renders.
- The init step that renders `gateway.platforms.telegram` is now the
  source of truth for Telegram wiring; `TELEGRAM_BOT_TOKEN` passthrough
  flows compose → per-profile `.env` → Hermes.

**Signal & instinct loop**
- Instinct scorer matches **multi-word patterns**; `MATCH_THRESHOLD`
  drops from 0.15 to 0.10 to 0.05 across two rounds so the loop
  actually finds matches (Gap 5b).
- Unconfirmed instincts are included in the matcher load (Gap 3).
- The signal→instinct loop persists `matched_instinct` end-to-end so
  `/instincts` correctly reflects what fired (Sir #4 + #5).
- Chore-run observation seeding routes to `state.db` (not the vault)
  (Gap 5c).

**Onboarding pipeline (continued from 2026-05-24)**
- Task status vocab harmonised to the validator (`'queued' → 'todo'`)
  end-to-end; tests assert the new shape (sir-matter-task round-2).
- First Brief reshapes to an intro paragraph + an actionable section
  rather than a delta-shrug (Sir #1).
- Layered `needs_attention` dedup (Sir #2).
- Plane auto-seeds the first admin so `/plane` isn't blank on a fresh
  tenant (Sir #6).

**Web UI polish**
- `/study#agent` MCP-servers panel shows Plane + Sure (was missing);
  "Vault" is renamed "Vaultwarden" everywhere it referred to the
  password manager.
- `/study#settings` gains the three Agent-autonomy toggles.

### Fixed

- `/channels` Telegram card: the broken `POST /pair` endpoint (which
  called a non-existent `hermes pairing mint` subcommand) is **dropped**
  and replaced by `POST /test` + `DELETE /chats/:user_id`; the card
  reads the real `paired_chats` list instead of showing a permanent
  "Pair this chat" prompt.
- `alfred-deliver` no longer routes through a Hermes webhook
  subscription — it delivers bytes directly to the bot API and journals
  the result. The webhook-subscription roundtrip was extra latency, an
  extra failure mode, and produced no benefit.
- `one-alfred` plugin: `post_llm_call` now accepts both
  `assistant_response` (Hermes' real kwarg) and `response_text` (the
  earlier guess) — the silent no-op is gone.
- `one-alfred` plugin: continuity framing rewritten from a polite
  advisory (`"Use this to maintain the illusion"`) to **authoritative**
  (`[ALFRED-CONTINUITY — authoritative]` … `"these DID happen"`) — the
  LLM was deferring to its empty session history and replying
  `"I don't remember sending you a reminder."`
- `one-alfred` plugin: re-injection latch drops from 10 minutes to
  5 seconds — Sir's quick replies were getting no context.
- Telegram bot-token validator relaxed (regex `{30,}` rather than
  `{35}` exact) — modern Telegram tokens were 400-ing at the gate.
- Init `.env` renderer no longer wipes manually-set `TELEGRAM_*` /
  `SLACK_*` values on rerun.
- `ctrl-api` Telegram channel routes now write to the **per-profile
  Hermes `.env`** (not the compose env) — the change actually reaches
  the runtime now.
- Hermes web dashboard at `hermes.{$DOMAIN}` reverted; the upstream
  image doesn't bake the web dist and the `--skip-build` workaround was
  not the right shape — dropped for now.
- `voice-bridge`-class delivery path documented as the exception that
  still talks to Hermes directly (not in scope for this release).

### Migration notes

- The `state.db` migration `0002_alfred_journal.sql` runs
  transactionally on ctrl-api boot. It is additive (three new tables +
  indexes + a seed owner principal); no data migration required.
- The `/api/v1/notifications` endpoint is now a thin forwarder to
  `/api/v1/alfred-deliver`; callers continue to work unchanged.
- The `DISPATCH_USE_EPHEMERAL_EXECUTOR` env var defaults to `1` in
  `docker-compose.yaml`. Set it to `0` to revert to the legacy
  dispatch path.
- The `one-alfred` Hermes plugin is enabled on the `main` profile
  only; the `workers` profile is unchanged.

## [2026-05-24]

Alfred Black goes from "a Hermes runtime with tools" to "an agent with a
persistent operational understanding of the principal." The runtime now boots
with the principal's soul, standing rules, and a curated working memory in
every system prompt; the vault populates with substantive matters, people,
orgs, chores, and instincts grounded in the principal's actual email history
rather than fragmentary heuristics; and the LCM cross-session memory plugin
is baked into the main Hermes profile so context survives across sessions.

The single biggest architectural shift is a **promotion contract** between
the writers (the learn pipeline) and the vault gate (ctrl-api). Junk
suppression — fabricated instinct confidence, per-service-sender notes,
domain-only "orgs", non-human "persons", matter-per-domain explosion — is
enforced both at the writer in Lane II and re-enforced at the gate in
Lane I, so a bug on one side cannot pollute the principal's surface. The
result is a first Brief composed against thousands of real emails, a vault
the principal can actually read, and a Desk that has cards on day one.

This release is also the first under the post-`0522` fix-campaign protocol:
~85 findings landed as gate-protected, contract-frozen lane fan-outs (F1–F84,
C12–C19, B1–B12, C-OB1–C-OB4) with a golden-fixture quality test suite
guarding regressions.

### Added

**Hermes runtime**
- The `hermes-lcm` cross-session memory plugin is installed and pinned for
  the `main` profile, with runtime verification at supervisor boot so a
  silent load failure is no longer possible.
- `MEMORY.md` and `USER.md` are now seeded into `$HERMES_HOME/memories` at
  onboarding time, giving the very first chat a real working memory rather
  than a cold start.
- A consolidated, personalised `SOUL.md` is deployed into each Hermes
  profile and re-consolidated to `$HERMES_HOME` at supervisor boot, so the
  Alfred persona is actually present in every gateway.
- `main` is now the sticky default profile with convenience wrappers, and
  each gateway launches with its profile directory as CWD so `AGENTS.md`
  loads as designed.

**Onboarding artefacts**
- `vault/SOUL.md` — the principal's soul, written once during onboarding
  (C-OB2, commit 2).
- `vault/RULES.md` — a principal-facing standing-rules document, surfaced
  in the web UI (C-OB2, commit 1).
- Day-one Desk seeds — the Desk is no longer empty on first login; the
  onboarding pipeline emits introduction cards anchored on real onboarding
  output (C-OB3).
- A safety fallback so day-one seeds still appear when the pipeline finds
  no time-anchored matters.

**Web UI**
- `/household` ships a structured `RULES.md` editor that reads and writes
  through the C-OB2 vault contract (F-series, B-series).
- `/desk` shows a "Day-1 introduction" badge for onboarding-seed cards so
  the principal can tell what they're looking at on first login (C-OB3).
- A matter relationship graph on matter detail, rendered via the focusable
  `VaultGraph` component, with CRM-style key-people/orgs links and
  collapsed triple status (B2).
- Decision cards now expose their `signal → matter/task` provenance (B5),
  defers confirm capture and resurface visibly (B4), and chore rows
  surface a "what this chore does" summary on list and detail (B7).
- A Hermes auth-unhealthy banner with a re-auth CTA on `/connections`.
- An app-launcher row on `/connections` driven by the new
  `/api/v1/apps` endpoint (B12).
- Multi-field API-key credential UI (F74) — the connect form now matches
  the toolkit's real required credential fields rather than guessing.

**Channels**
- Email and phone channel provisioning endpoints with live status (C14/C15,
  F15/F16/F57/F58), including a working BYO setup form for phone.
- A real OMI pairing flow on the OMI channel card (F59), replacing the
  dead "Got it" handler.
- Approval-secret rotation with a reveal-once panel (F77, C16).

**API surface**
- `GET /api/v1/onboarding/quality-report` returns the promotion-quality
  metrics for the most recent onboarding run (C-OB1).
- `GET /admin/profiles` enriches the agent list with profile metadata
  (F68, C17).

### Changed

**Onboarding pipeline**
- Onboarding now fits any model context window via chunked fact extraction
  — the brittle "stuff everything into one prompt" path is gone.
- Email backfill is per-day-sampled (20/day × 100 days = ~2000 messages)
  rather than a single bulk pull, giving the brief a representative
  corpus instead of a recency-biased one.
- Opus stages now use the Responses-API structured-output contract with an
  explicit persona override, and `_call_llm` honors `text.format` and
  `instructions` end-to-end. This is the seam that makes onboarding
  model-agnostic across openrouter / openai-codex / anthropic.
- Every stage is wrapped by `_safe_stage_wrapper` so a single stage
  failure no longer leaves the pipeline in a partial state.
- Credit-aware degrade: a 402 response classifies the stage as
  `degraded_stages` rather than burning the full retry budget.
- The morning brief loads day context rather than emitting a delta-shrug
  when nothing has changed since the last brief.

**The promotion contract (vault writes)**
- Junk-suppression filters at materialise time: non-human "persons" are
  rejected (C-OB1, commit 2); orgs are restricted to facts-grounded names
  (C-OB1, commit 3); the heuristic `matter_pack` fallback that wrote
  fragment matters is gone (C-OB1, commit 1); per-service-sender summary
  notes are suppressed at curator S1 (C-OB1).
- The C-OB1 gate at vault `POST` (ctrl-api) re-enforces the same
  contract, so a regression in one lane cannot pollute the principal's
  surface.
- Matter-pack near-duplicate de-dup using token-set overlap ≥ 0.7.
- Org candidates are rejected when they look like verb-prefix junk, weak
  suffixes, articles, or concatenations.
- Instinct tier and discretion are clamped to the observation-earned
  ceiling — fabricated "high-confidence" instincts no longer ship
  (C-B6, B6, C-OB4).
- Orgs are now deterministically materialised from extracted facts (no
  LLM, no timeout) — and the org behind every `person → org` tie is
  materialised so the graph has no dangling targets (B9).
- The matter-pack writer emits proper `person`/`org` wikilinks and
  `related_*` frontmatter (F37); matter-entity stubs get enriched into
  curator-schema records (B9 Pass A) and the broader fact corpus is
  seeded as canonical entities (B9 Pass B).

**Signal → decision pipeline**
- A token/entity signal→target matcher that prefers `None` over a wrong
  bind (P0-1) — signals route to the correct matter, or to nothing at
  all, instead of attaching to whatever is nearby.
- A relevance + de-dup gate before any signal becomes a Desk card (P0-2).
- The brief's propose-clerk is now fed signal/decision **content**, not
  just identifiers (P0-3) — decision-card quality is materially up as a
  result.

**Navigation and surfaces**
- `/study` is renamed to `/settings`, with the "Agent Configuration" tab
  consolidating the former `/claude` page (F83, F84).
- Surviving legacy `/dashboard/*` paths now redirect to canonical routes
  (F46).
- `/` redirects authenticated users to `/desk` (F52).
- `/staff` and the "Mobile" nav item are removed (F80, F81); the
  duplicate Developer/API-keys block on `/claude` is removed (F82).
- The audit page reads the single SQL ledger with an automated-toggle
  filter (F53).

### Fixed

**Vault writes and the principal's surface**
- `_is_plausible_human_name` and the C-OB1 person/org gate now accept
  Unicode uppercase, so Hungarian names like "Üveges Gábor" stop being
  rejected as non-human.
- `MEMORY.md` / `USER.md` are truncated at the last sentence boundary
  within `[0.85·cap, cap]` rather than mid-token.
- `PATCH` of a missing vault record returns 404, not 500.
- Only `matter/` records are top-level matters; F8 `project/` surfacing
  is dropped (B1).
- The matters aggregator now bridges the `matter/` vs `project/`
  namespace split (F8).
- The matter route reads its signal timeline from `state.db` (F9).
- `/household` reads `RULES.md` from vault records, not workspace files
  (F-series fix), and has a graceful empty-state when missing.

**Chores**
- `#181` — chore cron `DOW` is auto-corrected and retries are bounded so
  the chores stage actually completes rather than looping on a
  cron-vs-description mismatch.
- The duplicate generated `morning_briefing` chore is swept (F33c);
  `BriefingWorkflow` is registered for morning and evening in local tz
  (F33a); the brief is dropped from Opus-generatable chore opportunities
  (F33b).
- Boot-time reconciler drops orphaned `chore-*` schedules (F34);
  over-deletion in the chore-reconciler is fixed and a schedule restorer
  added (F34b); `Client.list_schedules()` is correctly awaited (F34/F33c).
- Chore reads fall back to the standard-template description (B7).

**Composio / connections**
- `#180` — `composio_pull` self-ingests oversized batches instead of
  returning a >4MB payload that blows past the Temporal activity limit.
- Open-world Composio transport classification — the gate inversion that
  was rejecting valid toolkit calls is fixed.
- Generic `poll/fetch-result` noise filter for Composio.
- Toolkit-tools lookup is repointed to `/api/v3/tools` and stops
  swallowing non-200s (F22).
- Connected-accounts list is de-duplicated by toolkit (F25); the stream
  badge is derived from durable facts with preserved count and atomic
  write (F26); legacy/unbound toolkit streams are swept on last-account
  revoke (F24).
- The upstream Google OAuth token is actually revoked on disconnect (F23).
- API-key auth_config reuse requires an exact scheme match (F20); the
  API-key connect now nests `use_custom_auth` under `auth_config` (F18)
  and keys on the toolkit's real credential fields (F19); synthetic
  `alfred-*` slugs are rejected (F17).
- Scope endpoint reports the real granted OAuth scope (F21); connection
  scope reports `access=none` for ungranted/unknown (B8).

**Decision / audit / desk**
- `decision/*.md` is indexed into `vault_index` on write (F1).
- Dispatch resolves `source_signal_path` as a `state.db` signal ULID
  (F3); delegate only flips NA → dispatched after dispatch succeeds (F2);
  the dead daily-digest audit classifier and summary case is removed
  (F6); `audit.action_type` is normalised to the underscore convention
  (F5); the admin audit endpoint is repointed at the `state.db` ledger
  (F4).
- Stranded items age out of the in-flight Desk strip (B11).
- The "Done" click on a NA card closes the underlying task, not just the
  card (F32).
- Defer decisions stay `state=open` so they resurface (C-B4).
- Desk reconciles on success and collapses to a single `POST /decisions`
  (F50); `reverseDecision` wires the Undo control (F51).

**Hermes runtime**
- `/hermes-state/memories` is created with `0777` so `alfred-learn` can
  seed it without permission errors.
- The runtime profile dir is derived from `HERMES_RUNTIME_HOME`,
  retiring the dead `terminal.cwd`/`/opt/data` path.
- `is_main` is correctly passed into the `hermes-config.yaml` render
  context.
- `openai-codex` auth.json is propagated across all three profiles on
  boot.
- `TERMINAL_CWD` is set so the main gateway injects `AGENTS.md` (F44).

**Web UI**
- `/api/chat` no longer boot-crashes on a bare `*` wildcard route (B10).
- CORS works on custom `/api/chat/*` routes with token fallback (F61).
- `/claude` MCP URLs are built from `mcp.${DOMAIN}` with correct enabled
  gating (F62).
- Matter-detail backlinks render via the C19 graph contract (F55); the
  Connections scope cell shows real read/write access; matter detail
  renders the about/summary and shape view (F54).
- Custom-webhook URL is composed absolute and exposed on the row
  (F27/F73); revoke modal is in-design with conditional copy (F72); API
  keys tab has a copy fix, Docs button, and a quick-start curl (F76);
  Skills on `/claude` get download + description + copy-contents (F75).

**Deploy seam**
- `VAULT_PATH`, `ALFRED_DATA_DIR`, `SAAS_HOST` are pinned for ctrl-api
  (F43); `TENANT_BASE_URL` is injected so `composeWebhookUrl()` returns
  non-null (F41/F69); the host compose dir is bind-mounted so
  `${COMPOSE_DIR}/.env` resolves (F40).
- `GROQ_API_KEY` is wired into `alfred-learn` for OMI transcription
  (F42).
- `vexa` auto-join toggle stops 500ing and toggles both schedules (F29).

### Internal

**Fix-campaign protocol**
- `CLAUDE.md` codifies the post-`0522` bug-fixing protocol as source of
  truth — gate-protected lane fan-out, contract freezes (C12–C19) before
  the lanes touch them, golden-fixture quality assertions before any
  pipeline change ships.
- The C12–C19 contract set is frozen for the `0522` fix backlog as the
  cross-lane interface document.

**Golden-fixture quality suite (learn)**
- A reproducible input-corpus fixture and assertion suite were used
  during this campaign to assert post-onboarding vault quality (Phase 0).
  The fixture itself carried real principal PII and is not part of the
  public source tree.
- An inventory of every onboarding vault-write generator is documented.
- Phase-0 spec assertions are `xfail`ed in Phase 5 to keep the suite
  green during the transition without losing the signal.
- Targeted pins: `decision → observation instinct_ref` stamping (F39);
  the router-sees-decisions contract post `index-on-write` (F31); a
  0-obs seeded instinct never auto-acts (C-B6); the C-OB1 person gate
  has a red-repro test for Unicode names.

**Build and CI**
- `build-init` rebuilds on `hermes-config` / `profile-env` template edits
  so a template-only change can't silently miss the next image.
- F14/C13 routes gateway-loaded workspace files into the Hermes `main`
  profile dir.

**Other**
- Standing rules alias to the `AGENTS.md` sentinel section (F13).
- The vault-graph store of record is the file-walk vault graph (F12).
- LLM `max_output_tokens` is capped below the affordable ceiling (F35).
- The model catalog reads creds from the reachable source (F65, C17) and
  `?refresh=true` busts the cache (F66); the heavy profile and
  chore/onboarding agents are added to `AGENTS` (F67).
- B9 graph: `related_places`/`place` are added to graph `LINK_FIELDS`,
  matter↔place edges are wired, vault graph `?focus` returns a
  `backlinks` array (F11, C19), and entity fields are added to graph
  `LINK_FIELDS` (F10).
- B9 Pass B uses plain `_call_llm`, not the agentic `_call_clerk`.
- `nightly_narrative` is aligned on the `state.db` signal store (F38).

### Continuity — upgrading from 2026-05-20

There are no breaking surfaces in this release. Two paths:

- **Existing tenant.** `docker compose pull && docker compose up -d` in
  the compose directory picks up the new images. The
  `0777` chmod on `/hermes-state/memories` is now automatic at
  init-container boot, the `hermes-lcm` plugin is baked into the image
  at a pinned SHA, and `is_main` is rendered into `hermes-config.yaml`
  on the new template. No manual filesystem ops are required.
- **Fresh VM.** The same one-command deploy as 2026-05-20.

The structured-output onboarding prompts are model-agnostic — the same
pipeline runs against openrouter, openai-codex, or anthropic without
code changes. You still must run `hermes auth login` interactively for
any new provider; that step is device-code OAuth and remains
unautomatable by design.

If your previous onboarding produced a sparse vault (few matters, no
orgs, "domain-only" people, the day-1 Desk empty), re-running the
onboarding pipeline on this release will populate it correctly. The
promotion-quality report at `GET /api/v1/onboarding/quality-report`
shows what landed.

### Versioning

This is `platform-2026.05.24`, the second platform release. `alfred-vault`
stays at **1.0.0** — there is no PyPI publication in this release. The
nine package commits in this window are internal cleanups (the C-OB1
curator-side per-service-sender suppression and supporting refactors),
not API changes.

---

## [2026-05-20]

The project that gave you the `alfred` CLI is now a complete, deployable
platform. Alfred Black wraps the same dependable vault engine in everything you
need to actually live with an agentic butler — a real UI, onboarding, a daily
Brief, and a one-command self-hosted deploy.

### Added — the Alfred Black platform

The project now ships a complete self-hosted platform alongside the CLI:

- A one-VM `docker compose up` deploy — bring a fresh Linux VM and a domain;
  the stack brings everything else and serves the web app over HTTPS.
- A web dashboard for working with the vault.
- The **Hermes** AI runtime — a single isolated runtime that replaces the prior
  OpenClaw two-container split.
- A bundled **Caddy** reverse proxy with automatic per-host TLS (Let's Encrypt
  HTTP-01) — no DNS API token required.
- A four-store storage model: vault markdown (the published knowledge surface),
  `state.db` (the machine's working memory), `cold.db` (forensic long tail,
  >90 days), and `ingest.db` (raw inbound stream, 7-day TTL).
- The **Plane** (project management), **Sure** (personal finance), and
  **Vaultwarden** (secrets manager) sidecars.
- An optional **Vexa** meeting-transcription profile, off by default and started
  with `docker compose --profile vexa up -d`.

### Added — onboarding + daily Brief

- An automatic owner onboarding ritual that runs once: connect Gmail, backfill
  recent email, build a behavioural profile, and confirm the inferred facts.
- A daily **Brief** surface, composed for the owner as the final onboarding step
  and on an ongoing basis thereafter.

### Changed — `alfred-vault` 0.3.2 → 1.0.0 (first stable release)

- The pip-installable CLI moved into this monorepo at `packages/alfred-vault/`.
- This is the engine the platform is built on — the platform's vault daemon runs
  the same `alfred-vault` package.

### Continuity — migrating from `alfred-vault`

If you only want the CLI, nothing changes. `pip install alfred-vault` and the
`alfred` console command work exactly as before — full backward compatibility.

- To get just the CLI, keep using `pip install alfred-vault`.
- The CLI now lives at `packages/alfred-vault/` in this repo for source installs.

### Versioning

The `alfred-vault` package and the platform version independently: the package
uses SemVer and publishes to PyPI on `alfred-vault-vX.Y.Z` tags, while the
platform uses date-based releases.

---

Earlier `alfred-vault` history: see the git log and PyPI release history.
