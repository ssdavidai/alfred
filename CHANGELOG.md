# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the `alfred-vault` package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- An `onboarding_golden` fixture + `MANIFEST` is checked in as the
  reproducible input corpus (Phase 0).
- A golden-assertion suite asserts post-onboarding vault quality
  (Phase 0).
- An inventory of every onboarding vault-write generator is documented.
- Phase-0 frozen-fixture spec assertions are `xfail`ed in Phase 5 to keep
  the suite green during the transition without losing the signal.
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
