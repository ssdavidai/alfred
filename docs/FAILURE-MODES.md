# Alfred Black — Lanes, Failure Modes & Resilience Stories

> ---
> **CATALOGUE STATUS (stamped 2026-07-15).** This document is a FROZEN audit
> artifact: Part 1 is the 2026-05-20 lane map; Parts 2–4 are the 2026-05-20/21
> code-audit waves. The body text below is preserved as written and is NOT
> updated as bugs get fixed. Per-section resolution stamps (the
> `[STAMP 2026-07-15]` blockquotes under each heading) record what has since
> been RESOLVED, what is SUPERSEDED-STACK (the subsystem was removed from the
> deployed compose stack), and what is STILL-OPEN. File-and-line references in
> the original text are as-of the audit date and may no longer match `main`.
> **Do not add new bugs here — new bugs go to GitHub issues.** Stamps are
> forbidden-zone edits (orchestrator/phase0 only), same as the rest of this file.
>
> Stamp vocabulary:
> * **RESOLVED** — the named defect is fixed on `main` (fixing commit or current
>   code line cited). "RESOLVED (residuals: …)" = the headline item is fixed,
>   listed leftovers are not.
> * **SUPERSEDED-STACK** — the subsystem no longer ships (Plane and Vexa were
>   removed from `docker-compose.yaml`; dormant code remains in-tree). Bugs in
>   these sections are moot in production; revisit only if the code is revived.
> * **STILL-OPEN** — re-verified 2026-07-15 as genuinely unfixed on `main`.
> * Items marked *unverified* inside a stamp were not re-checked in the
>   2026-07-15 pass; treat them as historical claims, not current facts.
> ---

A working map of where this system can fail, organized by the **lanes** a user's
intent flows through. Each lane lists user stories ("I want to… / I expect…"),
the **under-the-hood** path, and the **failure modes** with a marker:

- **⚠ PROVEN** — we hit this live on `test.alfred.black` during the 2026-05-20
  shake-out. It is not hypothetical.
- **☣ LATENT** — derived from the architecture, the contracts, or prior
  production scars (the memory notes). Plausible, not yet observed here.
- Severity: **[S1]** silent/dangerous · **[S2]** breaks a flow · **[S3]** ugly
  but recoverable.

The throughline: **most of these fail silently.** Alfred's whole promise is to
be "seen, not heard" — which means a broken Alfred and a quiet Alfred look
identical to the user. That is the central resilience problem.

---

## 0. The spine — cross-cutting dependencies

> **[STAMP 2026-07-15] STILL-OPEN (structural), table partially stale.** The
> no-HA single-VM posture is unchanged and remains the honest risk. Stale rows:
> Plane was removed from the deployed stack (PR #279, `4a83de87`) and Vexa has
> no compose services on `main` (verify: `docker-compose.yaml` service list —
> caddy/web-db/web/web-client/init/temporal/ollama/hermes/alfred/ctrl-api/
> alfred-learn/voice-bridge/mcp-server/vaultwarden/vault-signup/vault-cli/
> sure-*/paperclip*/tailscale — no plane, no vexa). Hermes now runs
> THREE profiles (main :18789 / workers :18790 / heavy :18791, per
> `packages/hermes/docker/supervisor.sh`). Minimum RAM guidance is now 48 GB
> (CLAUDE.md §3), with hermes capped at 12g + swap (PR #279). ctrl-api still
> mounts the Docker socket RW (`docker-compose.yaml:579`) — acknowledged as the
> VM trust-root at `:596`; the S1 stands.

Every story below rides on some subset of these. A failure here is a failure
everywhere downstream.

| Dependency | Role | If it's down… |
|---|---|---|
| **ctrl-api** (:3100) | the ONLY writer to the vault + `state.db`; every web data call proxies here; enforces the promotion contract | the whole product is read-only / blank |
| **Hermes** (main :18789, workers :18790) | ALL LLM traffic — chat, clerk, onboarding narration, signal extraction | no reasoning, no chat, no learning |
| **Temporal** | every background workflow (onboarding, signal pipeline, steward, chores, curator) | nothing autonomous happens; UI looks alive, brain is dead |
| **Composio** | every third-party integration (Gmail, Slack, Notion…) | no inbound data, no actions |
| **OpenRouter** | the model provider behind Hermes | every LLM call errors or stalls |
| **`.env` secrets** (bootstrap-generated) | gateway token, AAS key, column key, DB creds | services 401 each other / can't boot |
| **the 4 stores** (vault md / `state.db` / `ingest.db` / `cold.db`) | the memory model + the promotion contract | drift, 422s, lost context |
| **Caddy** | TLS + ingress | no HTTPS, no access |
| **disk / RAM** (single VM) | one box runs ~30 containers | OOM/disk-fill takes EVERYTHING down at once |

There is **no HA**. One OOM, one full disk, one wedged Temporal, and the entire
butler goes dark — quietly.

---

## Lane 1 — Deploy & first boot

> **[STAMP 2026-07-15] RESOLVED (residuals: docker-socket S1).** The
> missing-identity class is closed: `OWNER_EMAIL` is defined in `.env.example:95`
> and compose sets BOTH `OWNER_EMAIL` and `ALFRED_OWNER_EMAIL` from it (C9,
> `docker-compose.yaml:730–736`); `COMPOSIO_USER_ID` was cleared by the Part-3
> audit itself. RAM exhaustion addressed: Plane removed + hermes 12g + swap
> (PR #279 `4a83de87`), 48 GB min documented. Vexa profile gone
> (SUPERSEDED-STACK). STILL-OPEN: ctrl-api holds the Docker socket RW
> (`docker-compose.yaml:579`) — by design, but still root-equivalent. ACME/DNS
> ordering and init partial-failure remain inherent deploy risks (unverified).

> *"I clone the repo, fill `.env`, run `docker compose up`, and in a few minutes
> my butler is live on my domain over HTTPS."*

**Under the hood:** `bootstrap.sh` (validate + generate ~21 secrets) → compose
*pulls* images → `init` one-shot (scaffold vault, gateway token, render Hermes
configs, composio uid) → `web` runs Prisma migrate → Caddy requests LE certs.

**Failure modes**
- **⚠ [S2] A required identity/secret is unset.** `COMPOSIO_USER_ID` had no
  single-VM equivalent → onboarding's Gmail connect 400'd. *The whole class:*
  any var the old multi-tenant provisioner injected that bootstrap doesn't.
  (`OWNER_EMAIL` is the next one — see Lane 6.)
- **☣ [S2] ACME before DNS.** Caddy can't issue certs until the 6 A-records
  resolve + `:80` is reachable; if `caddy_data` isn't persisted, restart loops
  hit LE rate limits → locked out of TLS for hours.
- **☣ [S1] RAM exhaustion.** 32 GB is *tight* for web + ctrl-api + Temporal +
  Ollama + Hermes + Plane (~13) + Sure (~5) + Vaultwarden; `--profile vexa` adds
  ~3 GB. Under memory pressure the kernel OOM-kills *something* — and which one
  is non-deterministic. Looks like "random container keeps restarting."
- **☣ [S2] `init` partial failure.** If the one-shot dies after scaffolding but
  before writing the gateway token (or vice-versa), downstream services boot
  mis-configured and 401 each other with no obvious cause.
- **☣ [S3] Image arch / pull.** Multi-arch holds only if every sidecar
  (Plane/Sure/Vexa upstreams) ships the VM's arch; an arm VM can hit a
  missing-image wall.
- **☣ [S1] ctrl-api holds the Docker socket** (to restart siblings) — a
  compromise of ctrl-api is root on the box.

**Deps:** DNS, Docker 24+/compose v2, OpenRouter+Composio keys, disk/RAM, the LE
endpoint.

---

## Lane 2 — Become the owner / auth

> **[STAMP 2026-07-15] RESOLVED (top items).** Open registration is closed:
> `onBeforeSignup` rejects any signup once a user exists, override via
> `ALLOW_SIGNUP_AFTER_OWNER=true` (`packages/web/src/auth/hooks.ts`, comment
> cites "FAILURE-MODES web bug #1"). The Google refresh-token drop is fixed:
> re-auth preserves the stored token when Google omits it
> (`packages/web/src/server/oauth2.ts:385–390`, conditional spread). Member
> email-verification still requires a mail provider (structural, unverified).

> *"The first account I create is the owner. My family can join as members."*

**Under the hood:** Wasp email/Google auth → `userSignupFields` (`User.count()===0
→ isOwner+isAdmin`) → `onAfterSignup` auto-verifies the owner's email.

**Failure modes**
- **☣ [S2] Members can't verify without a mail provider.** The owner is
  auto-verified; *everyone else* needs a working `MAILGUN_*`. Without it,
  household members hit a dead-end at "check your email."
- **☣ [S1] Registration is open.** Anyone who reaches the domain can create a
  member account. For a single-operator box exposed to the internet this is a
  standing exposure (flagged; no "lock signups after owner" gate yet).
- **☣ [S2] Google refresh-token drop.** Arctic 1.x can silently drop
  `accessType:offline`/`prompt:consent` → only a 1-hour access token → Gmail
  quietly stops working an hour after signup. (PostSignupPage works around it,
  but it's a fragile dance.)
- **☣ [S3] First-signup race.** Mitigated by the `count()` inside the signup
  transaction — but a parallel double-submit is the kind of thing that bites.

---

## Lane 3 — Connect Gmail / integrations

> **[STAMP 2026-07-15] RESOLVED (residuals: silent execute path).** Connection
> scoping was hardened: readiness and account enumeration now scope by
> `user_id` server-side AND re-filter client-side
> (`packages/ctrl/src/api/routes/integrations.ts:3288–3320`). Note Part 2 §E
> corrected this lane's "under the hood" (no allowlist/restart model exists).
> STILL-OPEN: `execute_action` still returns `{"error": …}` envelopes instead
> of raising (`packages/learn/src/integrations/composio_client.py:207ff`) —
> "connected + ACTIVE" can still coexist with "every call fails", silently.

> *"I click 'Connect Gmail' once and Alfred can read my mail."*

**Under the hood:** `initiate-connect` → Composio-managed Google OAuth popup →
connection lands ACTIVE → scoped by `COMPOSIO_USER_ID` → `GMAIL_FETCH_EMAILS`.

**Failure modes**
- **⚠ [S2] Multiple connections + non-deterministic routing → `403 restricted
  scope`.** Each "Start onboarding" re-initiates a connect → connection sprawl;
  the resolver picks "newest ACTIVE", and Composio's routing flakes between
  full-scope and a metadata-restricted view (#74). The 8-attempt retry rides
  through it, but it's noisy and *sometimes* loses the race.
- **⚠ [S1] `COMPOSIO_USER_ID` unset / `"default"`** → cross-tenant leakage guard
  *and* a hard 400 (proven).
- **☣ [S1] Wrong scope.** `gmail.readonly`/metadata can't fetch bodies; a
  connection made under the user's own narrow Google client silently can't do
  what onboarding needs.
- **☣ [S2] Quota / rate-limit retry storm** (memory: composio-gmail bug stack)
  → backfill stalls or partial.
- **☣ [S3] COOP popup warning** (`window.closed`) — benign noise, but erodes
  trust ("is it broken?").
- **☣ [S1] Token expiry with no refresh** → integrations die days later,
  silently.

---

## Lane 4 — Onboarding (the first impression)

> **[STAMP 2026-07-15] RESOLVED (top items), pipeline substantially rewritten.**
> LLM-truncation class: fact extraction is chunked (#193), stream pull is
> chunked/paginated (#180); the brief writer was replaced
> (`write_brief_and_opportunities_opus`, PR S2-2,
> `packages/learn/src/activities/onboarding_v3.py:2312`). Ritual routing was
> reworked; the /soul preset chooser now sits between /verify and /composing
> (#853, `packages/web/src/onboarding/SoulPresetPage.tsx`). Tasks are born with
> the rich shape + 4-tier matter resolution (`dbaca816`, `935692f`, CLAUDE.md
> §15.5). Generated-chore risk is MITIGATED, not closed: first 3 runs are
> quarantine dry-runs (CLAUDE.md §6.5), but there is still no sandbox/review
> gate on what generated code does — see the Part-3 Chores stamp.

> *"I watch Alfred read my last 100 days, I confirm what he learned, and I get a
> first brief that makes me feel known."*

**Under the hood:** `composio_fetch` (5000→cap 3000) → `extract_facts` (Opus) →
`patterns` (Opus) → `personalize` (USER/SOUL/MEMORY/TOOLS/RULES, Opus) →
`awaiting_verification` → **[user verifies]** → brief workflow → `brief` →
`packs` (matter/instinct/errand, Opus) → `chores` (per-chore Python codegen,
Opus) → `done`. The `/reading-the-room` theatre + per-stage narration ride on
top.

**Failure modes**
- **⚠ [S1] LLM JSON truncation → empty output.** `extract_facts` blew past
  `max_tokens` → unparseable → **0 facts → empty `/verify`** (proven). *The same
  class threatens patterns/personalize/packs* — any "be exhaustive" prompt vs a
  token cap. Salvage parsing + headroom now mitigate, but it's a recurring
  shape.
- **⚠ [S2] Ritual routing.** Gate sent `personalize`→`/composing` (pre-verify),
  `/composing`'s unconditional timer dumped the user on an **empty
  `/first-brief`**, and post-brief stages defaulted to `/awaken` → **a
  re-trigger loop that duplicated records** (matter 9→16, chore 7→14). Proven;
  fixed; but the ritual↔gate↔stage mapping is fragile by construction.
- **⚠ [S3] `restart_learn_worker` timeout.** Chore templates generate but the
  worker restart that loads them times out → chores exist as files but don't
  run until the next scheduled restart (proven; memory).
- **☣ [S1] Generated-code chores are LLM-written Python.** `assign_initial_chores`
  has Opus *write a workflow per chore*. Invalid code → silently doesn't
  register. *Worse:* plausible-but-wrong code that later mutates Sure/Plane/email
  on a schedule. This is the highest-blast-radius latent risk in the system.
- **☣ [S2] Empty/biased inbox** → a thin or skewed profile; Alfred "knows" a
  caricature.
- **☣ [S2] Opus stage stall/timeout** (StartToClose/heartbeat) — each stage is a
  multi-minute call; a provider hiccup strands the user mid-ritual.
- **☣ [S2] No clean re-onboard.** Onboarding is once-per-owner; re-running needs
  a manual vault/state wipe (we had to script it). A user who wants a redo is
  stuck or duplicates.
- **☣ [S1] PII in the brief/records is real and unguarded** — correct for a
  single-owner box, but any future sharing/export surface inherits it.

---

## Lane 5 — The signal pipeline (the core promise)

> **[STAMP 2026-07-15] RESOLVED (plumbing), STILL-OPEN (model risk).** The
> silent-zero seams are closed: extract/router schedules default ON
> (`packages/learn/scripts/register_schedules.py:810,826`, comments cite
> "#6"); absent signal status defaults to `unrouted` not `open`
> (`packages/ctrl/src/api/routes/state.ts:191–193`, cites C2); the ingest TTL no longer
> deletes unprocessed rows (`packages/ctrl/src/db/ingest.ts:20,72`, cites #17);
> OWNER_EMAIL guard is armed (see Lane 1 stamp). Under-extraction by the cheap
> model remains inherent — source-type handling was rewritten with trust tiers
> + an unknown-source retry valve (`packages/learn/src/activities/signals.py:193,268ff`),
> but "the model misses the one email that mattered" is unfixable by plumbing;
> STILL-OPEN as a standing risk.

> *"200 emails land on Tuesday; Alfred surfaces the 1 that actually needs me as a
> card on my Desk — and never invents one."*

**Under the hood:** `StreamSweep` (pull → `ingest.db`) → `SignalExtract`
(ingest rows → scored signals via gpt-4.1-nano) → match to matters/tasks →
`needs_attention` → Desk decision card. Rolling state keeps context lean.

**Failure modes** (the "6 silent killers" from the signal-pipeline memory, plus)
- **☣ [S1] Under-extraction by the cheap model.** gpt-4.1-nano *misses* a real
  signal (#79) → the contract that needed a signature never surfaces. **This is
  the single worst failure in the product:** Alfred looks calm and competent
  while having dropped the one thing that mattered. No error, no card, no clue.
- **☣ [S2] EventProcessor / StreamSweep wedge** → nothing flows; Desk goes quiet
  and stays quiet.
- **☣ [S2] Feature flags off / mis-set** → extraction disabled silently.
- **☣ [S2] vault-vs-ingest read mismatch** (#78 Design-B), **`payload_json`
  string-vs-dict parse**, **token perms**, **`needs_attention` contract drift** —
  each independently zeroes the pipeline with a 200 OK and an empty result.
- **⚠ [S2] `OWNER_EMAIL` unset → cross-tenant guard disabled.** We saw the
  warning live; on a shared Composio account this could accept foreign events.
- **☣ [S2] `ingest.db` 7-day TTL.** If extraction stalls >7 days, raw events are
  purged before they're ever turned into signals — permanent silent loss.
- **☣ [S1] Mismatch → context pollution.** A signal filed against the *wrong*
  matter quietly corrupts that matter's rolling state and every future brief
  about it.

---

## Lane 6 — Matters, Decisions & progressive autonomy

> **[STAMP 2026-07-15] RESOLVED.** The wrong-store writer class is gated in
> code: POST, PATCH and move on `/vault/records` all call
> `assertCanonicalVaultPath` (`packages/ctrl/src/api/routes/vault.ts:759,899,1178`).
> Progressive autonomy's frozen counter is fixed (Part 2 bugs #1/#2, see that
> stamp) and the whole learning loop was re-repaired 2026-07-03 (#276,
> `ef33909e`: reflection wedge + click→instinct link + noise suppression),
> deployed to home. Mis-calibrated autonomous fire remains a designed risk
> managed by the discretion gate + the 3 mode flags (CLAUDE.md §8).

> *"Alfred files everything under the right Matter, learns how I decide, and
> slowly starts acting for me — earning trust, not assuming it."*

**Under the hood:** signals → matter matching + rolling state; decisions
(HANDLED/HELD/ASKED) → instincts (Asking→Confirming→Acting); the **steward**
sweeps matters/tasks and evaluates state changes.

**Failure modes**
- **⚠ [S2] Steward audit → vault `event/` write → `422 PROMOTION_CONTRACT_VIOLATION`**
  (proven). `steward-action` is audit-class; it belonged in `state.db` not the
  vault. *Fixed* — but it reveals a **whole class:** every writer (steward,
  signal_actions, desk-action, needs_attention, chores) must hit the *right*
  store, and any one that didn't get the storage cutover 422s silently and
  loses its audit trail.
- **☣ [S1] Progressive autonomy mis-fires.** The Acting tier acts on a learned
  instinct that's subtly wrong → Alfred does the wrong thing *confidently and
  autonomously*. The confidence gate + shadow mode exist precisely for this; a
  mis-calibrated threshold is dangerous.
- **☣ [S2] Rolling-state drift** (`state.db` vs vault) → the Matter page shows a
  stale story.
- **☣ [S2] Steward / decay-watcher sweep stalls** → matters never get
  re-evaluated; they rot.

---

## Lane 7 — Chat & the Hermes runtime

> **[STAMP 2026-07-15] RESOLVED (the realized S1).** The 2026-06-19 workers
> disk-bloat incident (described in the body) has its fixes on `main`: nightly
> session-prune/vacuum rendering (`packages/hermes/init/render_workers_pruning.py`
> + `packages/hermes/tests/test_init_workers_pruning_mutator.py`) and the
> compose logging cap. The workers gateway :18790 is now health-checked
> alongside :18789 (`docker-compose.yaml:456`, `packages/hermes/Dockerfile:496–500`).
> Memory-parity, transport-seam and provider-outage entries are structural and
> unverified.

> *"I message Alfred on the web, or Telegram, or by email, and he answers like
> he knows my whole life."*

**Under the hood:** web chat → Hermes **main** gateway (`/v1/responses`) with
session + memory; vault semantic recall via an MCP tool → ctrl-api → sqlite-vec.
Channels via Hermes' native adapters. Background work uses the **workers**
gateway; `notify_principal` bridges ephemeral agents → main message tool.

**Failure modes**
- **☣ [S1] Session store growth / leak. ⟵ REALIZED 2026-06-19.** OpenClaw's
  per-agent `.jsonl` leak CPU-pegged the box (10k+ files, memory). Hermes' SQLite
  SessionStore *should* make that structurally impossible — but the **workers**
  profile does NOT use the SQLite SessionStore for transcripts: it writes one
  `sessions/session_*.json` (+ `request_dump_*.json` on tool error) file per run
  AND an unbounded `state.db`, and nothing pruned either. The exact "verify under
  load" failure landed: `a client tenant` hit 100% disk (workers state.db
  111G, sessions/ 140G across 312,875 files) and took the whole tenant down
  (docker exec failed → all healthchecks unhealthy → sure-web 500). Fleet-wide:
  joe state.db 52G, rj 59G, rami sessions 37G/92k files, home 19G/54k files.
  Compounded by (a) no Docker log rotation (a 19G `*-json.log` on rami) and (b) a
  cross-session curator retry loop the per-run `tool_loop_guardrails` can't stop.
  **Fixes:** nightly `prune-old-sessions` + `vacuum-state-db` cron on the
  background profiles (template + idempotent `render_workers_pruning.py`
  backfill) and an `x-default-logging` cap in compose; cleanup runbook +
  upstream loop follow-up at `debug/2026-06-19/workers-disk-bloat-runbook.md`.
- **☣ [S1] Retention guard failure + cross-profile auth divergence. ⟵ ISSUE
  #261, zsolt incident 2026-06-10.** The dated fleet capture/cleanup runbook
  was written on 2026-06-19, but issue #261 records the triggering zsolt
  incident on 2026-06-10. Unbounded `session_*.json`,
  `request_dump_*.json`, and workers/heavy `state.db` growth can fill the
  tenant disk before a nightly profile cron succeeds. Independently, the old
  boot-only, main-as-source `auth.json` copy lets workers/heavy retain an OAuth
  refresh token invalidated when another profile refreshes, turning an auth
  divergence into a retry storm that accelerates the same disk growth.
  **Current status at this phase-0 contract head:** the existing runtime has
  the nightly background-profile cron, but none of the following three #261
  guard families is implemented yet. **Layered guards frozen by #261 for the
  implementation lanes:** Lane V (Hermes/infra) adds the
  supervised `session-janitor`, separate session/request-dump TTLs + dump
  count cap, workers/heavy state.db TTL+VACUUM, and 900 s newest-
  `openai-codex.last_refresh` auth convergence; Lane II (learn) adds the
  default-on clerk breaker that opens only after sustained >=95%
  `max_retries_exhausted` and emits one
  needs-attention card per incident; Lane I (ctrl) adds 80% warn audit/card
  and 90% Hermes-main outbound page thresholds plus structured disk fields on
  `GET /api/v1/admin/system-info`. Once those lanes merge, any one layer can
  fail without returning to silent disk exhaustion.
- **☣ [S2] Memory parity gap.** Recall depends on the surveyor embedding the
  vault into sqlite-vec; if the embedder lags or the vector store drifts, Alfred
  "forgets" recent context and answers thinly.
- **☣ [S2] Web chat transport.** OpenClaw was raw WS; Hermes is HTTP/SSE — the
  widget + voice-bridge rework is a known seam.
- **☣ [S2] notify_principal bridge** broken → ephemeral agents can't reach you
  (memory) → autonomous work completes invisibly.
- **☣ [S3] Provider outage / rate-limit / cost blowup** on OpenRouter →
  everything LLM stalls; or the bill quietly explodes (onboarding Opus +
  per-chore codegen + narration + per-email extraction).
- **☣ [S2] Gateway token / config drift** → 401 between learn↔Hermes.

---

## Lane 8 — Chores (the standing automations)

> **[STAMP 2026-07-15] RESOLVED (top items).** The worst blast-radius item —
> one workflow-name collision crash-looping the whole learn worker — is fixed:
> the dynamic loader dedups against reserved + already-seen names and skips
> collisions with a log line
> (`packages/learn/src/workflows/chores/_dynamic_loader.py:601–706`).
> Generated-code review: quarantine dry-runs (first 3 runs) now exist
> (CLAUDE.md §6.5); a hard sandbox/enforced review gate still does not —
> STILL-OPEN as a designed-risk residual. Zombie-workflow / timezone / missing-
> dependency entries unverified.

> *"Alfred runs my recurring work — the Friday wind-down, the zombie-subscription
> audit — and only pings me when there's something to see."*

**Under the hood:** `assign_initial_chores` → Opus writes a Python Temporal
workflow per chore → deployed to `/alfred-data/user-chores/` → worker restart
registers them → cron schedule fires → run → `notify_principal`.

**Failure modes**
- **⚠ [S2] Worker-restart load failure** (proven) → chores written but inert.
- **☣ [S1] Generated workflow is wrong.** It's autonomous LLM-authored code on a
  schedule touching real systems (finance, mail, PM). Invalid → dead; *plausible
  but wrong* → acts incorrectly, repeatedly, unattended. **Needs a sandbox /
  dry-run / review gate.**
- **☣ [S2] Zombie Temporal workflows** ("max active children 5/5", memory) →
  chores + clerk starve; everything autonomous backs up behind stuck runs.
- **☣ [S2] Schedule/timezone drift** → chores fire at the wrong hour.
- **☣ [S2] Missing dependency** (a tool/connection the chore assumes) → fails
  every run, silently.

---

## Lane 9 — Channels & notifications

> **[STAMP 2026-07-15] RESOLVED (delivery), STILL-OPEN (noise).**
> `notify_principal`'s hard-broken default channel is fixed: "auto" resolves
> the most-recently-active delivery-capable Hermes session, never fabricating
> "webchat" (C8, `packages/ctrl/src/api/routes/notifications.ts:128–139`).
> Over-notification: noise suppression now enforces adopted noise instincts
> (#276 `ef33909e`), BUT a verified latent bug keeps part of it inert —
> `derive_signature` normalizes `composio-gmail*`/`gmail` but NOT
> `source_type="email"` (`packages/learn/src/activities/noise_patterns.py:109–113`),
> so sender-domain noise matching never fires for events stamped `email`.
> Workaround in production: anchor noise instincts on `subject_keywords`
> (2026-07 home fix). STILL-OPEN — file/keep a GitHub issue for the
> derive_signature gap.

> *"Alfred reaches me where I am, and only when it matters."*

**Under the hood:** `notify_principal` → ctrl-api → Hermes main message tool →
channel (Telegram/Slack/email).

**Failure modes**
- **☣ [S2] No channel configured** → notifications silently dropped; the user
  never learns Alfred wanted them.
- **☣ [S1] Over-notification.** The opposite failure: every signal pings →
  Alfred becomes noise → the user mutes it → defeats the entire "seen, not
  heard" thesis. The product *dies of being annoying*, not of erroring.
- **☣ [S2] Mailgun unset** → no email path.

---

## Lane 10 — Sidecars (Sure / Plane / Vaultwarden / Vexa)

> **[STAMP 2026-07-15] SUPERSEDED-STACK (Plane, Vexa) / RESOLVED (Sure).**
> Plane was removed fleet-wide (PR #279, `4a83de87`); Vexa has no compose
> services on `main`. Their sync/migration failure modes are moot in
> production; `plane_*`/`vexa`/`transcript` code remains in-tree DORMANT
> (deletion is an open follow-up). Sure is still deployed and its Part-4 S1s
> are fixed — see the Part 4 "New S1s" stamp. Vaultwarden entries: no known
> issues, unverified.

> *"Alfred manages my money in Sure and my projects in Plane."*

**Under the hood:** sidecar containers + their DBs; alfred-learn + the MCP stdio
apps drive them via init-rendered mutate scripts.

**Failure modes**
- **☣ [S2] Plane migration deadlock** (`plane-migrator`, #555) → Plane never
  comes healthy → matters↔issues sync dead.
- **☣ [S2] Sidecar DB cred drift / bootstrap failure** (Sure categories,
  accounts) → finance features blank.
- **☣ [S2] Sync drift** (matters↔Plane issues) → the two views disagree.
- **☣ [S3] Upstream version pin drift** — `makeplane/*`, `we-promise/sure` change
  shape and the mutate scripts break.
- **☣ [S1] Vexa profile** (+9 containers, ~3 GB) tips a 32 GB box into OOM.

---

## Lane 11 — Vault & memory integrity (the four stores)

> **[STAMP 2026-07-15] RESOLVED (top items).** Promotion-contract 422 class:
> enforcement now covers POST + PATCH + move (`vault.ts:759,899,1178`); the
> demoted-type writers were repointed at state.db (see Part 2 stamp). Worker
> misbehavior class: distiller can no longer create principal-facing
> `decision/` records (`packages/alfred-vault/src/alfred/vault/scope.py:41–43,126`,
> cites bug #12). The cold compactor is RUNNING (Part 4 corrected the
> "deferred" doc-rot) and cross-tier reads are now generic, not audit-only
> (`packages/ctrl/src/db/coldRead.ts:288,405` `queryCrossTier`/`getCrossTier`).
> `vault_index` drift is structurally prevented by single-writer discipline
> (CLAUDE.md §5.2). Janitor/curator specifics unverified.

> *"My vault is my second brain — and I can trust it."*

**Under the hood:** ctrl-api single-writer; the promotion contract; the
curator/janitor/distiller/surveyor workers; `vault_index` in `state.db`.

**Failure modes**
- **⚠ [S2] Promotion-contract 422s** when a writer targets the wrong store
  (steward, proven). A class, not an instance.
- **☣ [S2] `vault_index` drift** (state.db vs files) → search/recall returns
  stale or missing records.
- **☣ [S1] Worker misbehavior** — curator mis-files, janitor deletes a real
  record, distiller writes a confident-but-false inference into the graph. The
  vault is the source of truth; a bad write *poisons* downstream reasoning.
- **☣ [S2] `state.db` single-writer contention / WAL corruption** → the machine's
  working memory locks or loses data.
- **☣ [S3] `cold.db` compactor is deferred** → `state.db` grows unbounded over
  months.

---

## Lane 12 — MCP / the Claude connector

> **[STAMP 2026-07-15] RESOLVED.** Hermes registers the full MCP bundle per
> profile — the ctrl-api proxy (`alfred-ctrl`) plus stdio apps
> alfred/sure/vaultwarden/execute/hass/paperclip, with `files` added on
> main+workers (`packages/hermes/hermes-config.yaml.njk:460ff`; `plane` was
> dropped with PR #279, and CLAUDE.md §9.2's "6 servers" undercounts) — the
> "can Hermes spawn stdio children" risk did not materialize. Auth got a real
> model: per-app scoped bearer tokens + management UI shipped in PR #278
> (`12d02d21`). Connector-drift entries unverified.

> *"I use Alfred's tools from Claude (claude.ai connector)."*

**Failure modes**
- **☣ [S2] Hermes stdio MCP support** — must spawn the 5 `node` stdio children
  with custom `env` (flagged risk in the plan); if not, the tool catalog is
  empty.
- **☣ [S3] Connector name/contract drift** (`Alfred_Black`) → re-pairing pain.
- **☣ [S2] MCP approval secret / allowlist mismatch** → tools refused.

---

## Lane 13 — Day-2 operations

> **[STAMP 2026-07-15] STILL-OPEN (ops posture).** No backup wiring exists in
> the repo (no restic/backup hits under `scripts/` or `Makefile`;
> CLAUDE.md §15.10 is guidance only). `:latest`-drift and Temporal
> replay-discipline remain the standing update risks (structural). Disk fill
> is mitigated for the known offenders (workers session pruning + compose log
> caps — Lane 7 stamp) but has no general guard. At-rest encryption and
> secret-rotation flow: still absent (documented trade-offs).

> *"I restart, update, and back up, and nothing breaks."*

**Failure modes**
- **☣ [S1] No backups wired** → vault/`state.db` loss is permanent; restic is
  mentioned, not confirmed-on.
- **☣ [S2] Update breaks via `:latest` drift** — a freshly-pulled image expects
  a schema/contract the others don't have (exactly the steward/contract class).
- **☣ [S1] Temporal non-deterministic replay** — change/remove a workflow or
  activity in a deploy while runs are in-flight → replay failures wedge the
  intelligence layer (the plan calls this out; `workflow.patched()` discipline).
- **☣ [S2] Disk fill** — one onboarding left `ingest.db` at 56 MB; logs + Docker
  layers + cold data accumulate; a full disk silently corrupts SQLite WALs.
- **☣ [S2] At-rest encryption absent** (no LUKS) — documented trade-off, but a
  stolen disk is a full life dump.
- **☣ [S3] Secret rotation** — the gateway token, column key, and any
  chat-pasted tokens (PyPI/CF) need rotation; no rotation flow.

---

## The systemic class — "looks fine but isn't"

> **[STAMP 2026-07-15] MIXED.** Items 3 (promotion-contract gaps) and much of
> 4 (the specific wedges audited) are RESOLVED per the Part 2/3 stamps; item 5
> shrank with Plane's removal + memory re-sizing (PR #279). Items 1 (silent
> under-extraction), 2 (autonomous wrong action — see the 2026-07-15 office-AC
> runaway, stamped under Part 2 §A), and 6 (cost) are inherent and STILL-OPEN.
> The meta-finding — no unified "Alfred is degraded" surface / work-liveness
> heartbeat — remains the highest-leverage gap: compose healthchecks improved
> (Lane 7 stamp) but nothing yet proves the pipeline *worked*, only that
> processes are up.

Ranked by how badly they violate the user's trust:

1. **Silent under-extraction** (Lane 5) — Alfred misses the email that mattered
   and says nothing. *The product's core promise, inverted.*
2. **Autonomous wrong action** (Lanes 6, 8) — progressive autonomy or a generated
   chore acts incorrectly, on a schedule, on real systems.
3. **Promotion-contract gaps** (Lanes 6, 11) — a whole class of writers can 422
   and lose their audit/state silently after any storage change.
4. **Temporal stalls** (Lanes 4–8) — zombie/replay failures freeze everything
   autonomous while the UI stays bright and lifeless.
5. **Resource exhaustion** (Lanes 1, 10, 13) — 32 GB / one disk / no HA: a single
   pressure point drops the entire butler.
6. **Cost blowup** — Opus everywhere (onboarding, per-chore codegen, packs) +
   per-email extraction can quietly run up a large bill.

**The meta-finding:** nearly every failure here is *silent*. There is no
"Alfred is degraded" surface. The highest-leverage hardening isn't fixing any
one bug — it's **making failure loud**: a health/heartbeat surface that proves
the signal pipeline ran, the steward swept, chores fired, extraction isn't
zeroing, and the bill is sane — so a quiet Alfred and a *broken* Alfred stop
looking the same.

---
---

# Part 2 — Mechanism-level deep dives (2026-05-20 code audit)

> **[STAMP 2026-07-15]** Frozen audit wave. Per-bug resolution for the ranked
> table is stamped under the next heading; §A–§E each carry their own stamp.
> The "half-finished storage cutover" root cause (R1) is closed — see bugs
> #1/#2/#6/#7 below. R4 (no work-liveness heartbeat) is still the honest gap.

Part 1 above is the lane map. Part 2 is the result of a five-agent read-only
audit of the actual code, grounded in `file:line`. It promotes many Part-1
☣ LATENT entries to **⚠ CONFIRMED** — found in the source, not hypothesized.

## Confirmed bugs found in the audit (ranked)

> **[STAMP 2026-07-15] Per-bug resolution** (verified on `main` unless noted):
> * **#1 RESOLVED** — counts come from state.db, not the vault FS:
>   `packages/ctrl/src/api/instinctCounts.ts:1–37` (`SELECT instinct_ref,
>   COUNT(*) FROM observation`), comment cites "FAILURE-MODES bug #1".
> * **#2 RESOLVED** — `mark_observations_processed` PATCHes state.db via
>   `update_observation(obs_id, status="processed")`
>   (`packages/learn/src/activities/vault.py:851,868`). See also #232 `ce6773d2`.
> * **#3 PARTIALLY RESOLVED** — the dual-write race is gone (Desk runs ONE
>   decision POST, reconcile-on-success), but intent=done on an approval-source
>   card still flips its status to `approved`
>   (`packages/ctrl/src/api/routes/decisions.ts:462`). Whether anything
>   executes on that flip was not re-verified — if "Done ≠ approve" still
>   matters, file an issue.
> * **#4 RESOLVED** — DeskPage clears a card only after server confirmation
>   ("reconcile-on-success", `packages/web/src/dashboard/DeskPage.tsx:655–680`).
> * **#5 RESOLVED** — defer now carries a resurface contract in its 201 (C-B4,
>   `decisions.ts:538–546`) and the UI names the resurface time.
> * **#6 RESOLVED** — both flags default ON
>   (`packages/learn/scripts/register_schedules.py:810,826`, cites "#6").
> * **#7 RESOLVED** — absent status defaults `unrouted`
>   (`packages/ctrl/src/api/routes/state.ts:191–193`, cites C2).
> * **#8 unverified** (`mirrorEventToIngestDb` swallow) — not re-checked.
> * **#9 RESOLVED-BY-REWRITE** — source-type inference was replaced with
>   gmail trust tiers + an unknown-source retry valve
>   (`packages/learn/src/activities/signals.py:193,264–327`).
> * **#10 ANCHOR GONE** — `stream_puller.py` no longer exists on `main`; the
>   pull path was restructured (`activities/pull.py`, `streams.py`).
>   `resolve_active_connected_account_id` lives in `pull.py`/`composio_client.py`;
>   re-verify pinning only if reviving the concern.
> * **#11 unverified** (enable-tool no-op UI copy).
> * **#12 RESOLVED** — distiller may NOT create `decision`
>   (`packages/alfred-vault/src/alfred/vault/scope.py:41–43,126`, cites bug #12).
> * **#13 RESOLVED** — `matter` removed from the surveyor entity-type list
>   (`packages/alfred-vault/src/alfred/surveyor/labeler.py:120`, cites bug #13).
> * **#14 STILL-OPEN (likely)** — no health-gating/liveness strings found in
>   `surveyor/embedder.py`; Ollama-down still degrades recall silently.
> * **#15 STILL-OPEN** — `execute_action` still returns `{"error": …}`
>   envelopes, never raises (`packages/learn/src/integrations/composio_client.py:207ff`).
> * **#16 RESOLVED** — Undo is wired: F51 connects `reverseDecision` /
>   `undoStewardAction` to the ledger (`DeskPage.tsx:215–218,500`).
> * **#17 RESOLVED** — TTL retains unprocessed rows, reports `stale_dropped`
>   (`packages/ctrl/src/db/ingest.ts:20,50–105`, cites #17).
> * **#18 RESOLVED (docs)** — CLAUDE.md was rewritten (`f32aafa7`) with current
>   cadences (§7).

These are real defects in the merged tree, not "could happen." Severity: **S1**
silent/dangerous · **S2** breaks-flow · **S3** ugly. Most are S1 because they
fail with a 200 OK.

> **The root cause behind half of these is a half-finished storage cutover.**
> Observations, signals, and audit records were being moved from the markdown
> vault into `state.db`, but the *counters and readers* were never repointed.
> So writers write to `state.db` while readers still walk the vault filesystem —
> and find nothing. Bugs #1, #2, #6, #7, #8 are all this one seam.

| # | Bug | Sev | Where | Fix direction |
|---|---|---|---|---|
| 1 | **Observation count is structurally frozen at 0 → progressive autonomy never engages.** Decision observations write to `state.db` (`decision_observations.py:436`), but `getInstinctCounts` walks the `vault/observation/` *filesystem* (`instinctCounts.ts:44`) **and** requires `source_kind`+`instinct` fields the vault writer never stamps (`vault.py:259`). The discretion gate reads this count → `get_discretion_threshold(0)` = 0.95 always (`discretion.py:21`) → every instinct stuck "Asking" forever (`InstinctsPage.tsx:77`, `signal_actions.py:320`). **This is the count you flagged — and it's worse than cosmetic: it disables the entire trust gradient.** | **S1** | learn + ctrl + web | count from `state.db` (`SELECT instinct_ref, COUNT(*) … WHERE kind='decision'`) |
| 2 | **Reflection re-processes the same observations every night.** `mark_observations_processed` (`vault.py:840`) calls `read_record(<ulid>)`+`update_record` against the *vault*, but the id is a `state.db` ULID, not a vault path — the "processed" flag never lands. Every 2 a.m. run re-feeds the identical set to Opus → instinct churn + unbounded cost. | **S1** | learn | PATCH `state.db` via `update_observation` |
| 3 | **"Done" on an approval card silently approves & executes it.** `POST /decisions` sync-flip sets the approval `status=approved` for intent=done (`decisions.ts:422`) while the parallel `rejectAction` sets `cancelled` (`approvals.ts:100`). Final state is a write-order race; "Done" (meaning *I handled it*) can fire the proposed action. | **S1** | web + ctrl | one server call per action; don't dual-write status |
| 4 | **Optimistic UI hides backend failure on every Desk button.** `markHandled` clears the card before any server work; the `POST /decisions` sync-flip already moved the source status, so `revertHandled` re-adds a card the next refetch filters out (`status!="pending"`, `DeskPage.tsx:300`). A failed Delegate/Done/Do **looks successful** and the work silently doesn't happen. | **S1** | web | confirm server success before clearing; reconcile on refetch |
| 5 | **Defer can drop the card forever.** Sync-flip sets NA `status=skipped` unconditionally (`decisions.ts:312`); resurface scheduling runs later in a log-only try/except (`decision_router.py:236`). If the clerk resurface-time parse fails or yields nothing, the card is gone, no resurface. (`skipped` also poisons source-confidence calibration as a hard negative — `attention.ts:390`.) | **S1** | learn + ctrl | resurface-parse before the skip flip; distinguish defer from reject |
| 6 | **Three signal-pipeline flags default OFF and are registration-time only.** `STEWARD_SIGNAL_EXTRACT_ENABLED` / `STEWARD_SIGNAL_ROUTER_ENABLED` (`register_schedules.py:710,727`). extract-ON + router-OFF → signals pile in `state.db` `unrouted`, zero Desk cards. both-OFF + ingest filling → the 7-day TTL silently deletes the backlog. The workflow can't self-disable; flipping off needs a re-register. | **S1** | learn | default-on for a single-tenant box; surface the flag state |
| 7 | **`status` unrouted-vs-open default mismatch.** Python sends `status:"unrouted"` (`signal_state.py:181`); ctrl SQL defaults absent status to `"open"` (`state.ts:153`); the router filters strictly `status=unrouted`. Any signal created without an explicit status lands `open` → **never routed, never surfaced.** | **S1** | learn + ctrl | make the SQL default `unrouted`, or always pass it |
| 8 | **ingest mirror is best-effort and swallowed.** `mirrorEventToIngestDb` logs+swallows any non-UNIQUE error (`streams.ts:214`) while `/streams/ingest` still returns 201. The event shows in the UI (JSONL) but is **invisible to the extractor forever.** | **S1** | ctrl | fail the request or queue a retry on mirror failure |
| 9 | **`source_type → unknown/message` silent drop.** If a parser didn't stamp `metadata.event_type`/`from`, `_infer_source_type` collapses to `unknown`/`message` (`signals.py:443,593`) → not in `PRE_FILTER_ALLOWLIST` → dropped **and marked processed** (`signals.py:715`), never retried. Real inbox mail vanishes. (`slack`/`github` are also *hard-blocked* as garbage — `signals.py:107` — so the first real Slack stream is silently nuked.) | **S1** | learn | fix parser stamping; don't mark dropped-as-unknown processed |
| 10 | **Steady-state Gmail pull is NOT connection-pinned.** The #74 fix (`resolve_active_connected_account_id`) is applied only to the onboarding backfill. The recurring `_run_composio_pull` (`stream_puller.py:317`) and the agent execute path ("first ACTIVE match", `integrations.ts:2638`) don't pin → the restricted-scope/403 flake rides the two paths that run *forever.* | **S2** | learn + ctrl | pin the resolved account on every execute path |
| 11 | **Composio `enable-tool` is a no-op; the allowlist/restart model is gone.** Under Hermes, Composio is one MCP tool (`composio_execute`); action slugs are *arguments*, not allowlist entries. `enable-tool`/`disable-tool` always return `gateway_restart_triggered:false` (`integrations.ts:2491`). Capability is gated purely by connection ACTIVE status. **(Part 1 Lane 3's "under the hood" was wrong — corrected in §C below.)** | S3 | ctrl + web | update the UI copy ("waiting for composio_execute to be wired") that can never be true |
| 12 | **distiller writes principal-facing `decision/` records.** `learn_types_only` permits `create decision` because `decision ∈ LEARN_TYPES` (`scope.py:109`) → lands in `decision/` indistinguishable from a real decision. Plus mechanical confidence bumps (3 agreeing sources → `high`, `pipeline.py:544`) manufacture false certainty. | **S1** | alfred-vault | namespace learn-decisions (e.g. `learn/decision`) or gate creation |
| 13 | **surveyor targets a `matter` type that doesn't exist.** `ENTITY_RECORD_TYPES` includes `matter` (`labeler.py:21`) but `KNOWN_TYPES` has no `matter` (`schema.py:7`) → matter-linking is dead code / writes a `related_matters` pointing at a type the rest of the system rejects. Possible merge-introduced divergence — **verify.** | S2 | alfred-vault | reconcile the type list with the canonical schema |
| 14 | **surveyor: Ollama down → semantic recall silently dies.** Embeddings retry 5× then return `None` → file skipped → no tags/relationships/vectors → recall degrades to nothing while the daemon logs warnings and stays "running" (`embedder.py:348,451`). | **S1** | alfred-vault | health-gate the surveyor; surface embedder liveness |
| 15 | **`execute_action` never raises.** Every Composio SDK error becomes a `{"error":…}` 200-shaped envelope (`composio_client.py:244`). "Connected + ACTIVE" can coexist with "every call fails" (wrong scope, quota, expired) and nothing surfaces it. | **S1** | learn | record last-success/last-error per toolkit; raise on the stream path |
| 16 | **Undo is a dead capability on the Desk.** Decision rows are hardcoded `reversible:false` (`DeskPage.tsx:451`); `reverseDecision` is imported but wired to no control; `/decisions` has no reverse button either. You **cannot undo a delegate/defer/done** from the UI. | S2 | web | wire `reverseDecision` to a control or stop importing it |
| 17 | **The 7-day ingest TTL is a hard data-loss deadline** racing the whole downstream pipeline (`ingest.ts:21`). Any wedge upstream of `mark_stream_event_processed` becomes permanent loss at day 7, signalled only by an un-alerted `ingest_sweep_log.stale_dropped`. | **S1** | ctrl | don't TTL `processed_at IS NULL`; alert on stale_dropped |
| 18 | **Workflow cadence drifts from the docs.** Learning + Judgment actually run **every 15 min** (`register_schedules.py:168,173`), not the 5 min / 2 min CLAUDE.md & SPEC claim. Operators debugging "why is learning slow" start from a false premise. | S3 | docs | fix CLAUDE.md/SPEC |

**Four structural root causes** (fix once, kill many rows above):
- **R1 — the half-done storage cutover** (bugs 1, 2, 6, 7, 8): writers on `state.db`, readers on the vault filesystem.
- **R2 — scope is CLI-only** (`vault/scope.py` is invoked only by `vault/cli.py`): every in-process Python worker write (curator/janitor/distiller/surveyor) is unconstrained.
- **R3 — the mutation log doesn't cross the Hermes container boundary** (`ALFRED_VAULT_SESSION` is set in a subprocess env the agent never inherits): decision-grade audit under-reports every agent-side write.
- **R4 — there is no work-liveness heartbeat anywhere**: `workers.json` tracks PID liveness, not work liveness; a worker can be "running" and failing every call, invisibly. This is the same gap as Part 1's meta-finding.

---

## A — Streams → ingest → signals (the core pipeline)

> **[STAMP 2026-07-15] LARGELY SUPERSEDED-BY-REWRITE; one new STILL-OPEN.**
> `stream_puller.py` is gone (pull restructured into `pull.py`/`streams.py`);
> `signals.py` source-typing was rewritten (trust tiers + retry valve); TTL and
> status-default seams are fixed (bugs #7/#17 above). The "signal stuck in
> `dispatching`, nothing auto-sweeps it" entry inverted into a NEW bug: a
> recovery sweep now exists (`recover_stuck_dispatching`,
> `packages/learn/src/activities/decision_router.py:148`) but has NO attempt
> cap — it drove the 2026-07-15 office-AC channel-spam runaway (stuck delegate
> decision re-dispatched in a loop). **STILL-OPEN: recovery cap.** Remaining
> line items unverified.

```
Stream config (JSON on disk)  → StreamSweepWorkflow (2m) → /streams/ingest
  → ingest.db (Store 4, 7d TTL) → SignalExtractWorkflow (5m) → state.db signal (unrouted)
  → SignalRouterWorkflow (2m) → needs_attention/*.md (vault FS) → Desk card
```
Three stores on this path — JSONL (UI) vs `ingest.db` (extractor) vs `state.db`
(signals) vs vault FS (cards) — with no cross-checks. Most silent failures live
on those seams.

**S1 / S2 failure modes** (beyond confirmed bugs 6–9, 17 above):
- **⚠ [S1] "due=0 returned=0 forever."** `al-stream-sweep` schedule deleted/never-registered, or a single hung 120s composio pull blocks the next 2-min tick (SKIP-overlap). No pulls, no error, log line never emitted. (`stream_puller.py:394`, `register_schedules.py:1259`)
- **⚠ [S1] `last_pull_at` advances even on failure.** A stream stuck at `payload_too_large`/`tool_not_found` keeps re-deferring its window and ingests nothing; status is visible only if you GET the stream. (`stream_puller.py:343-373`)
- **⚠ [S1] Composio 200-wrapped error ingested as data** if a new error shape escapes `_classify_composio_response`'s token checks (`stream_puller.py:516`).
- **⚠ [S1] `payload_json` is a STRING on read.** Every consumer must `json.loads` it; a partial/truncated write → `payload={}` → "body too short" drop (`signals.py:577,719`). Same class bit signal rehydration (`signal_state.py:186`, #78).
- **⚠ [S1] 14-day age cutoff silently drops backfill.** `_is_too_old` (default 14d, `signals.py:129`) pre-filters a 100-day Gmail backfill down to ~14% before the LLM. Override `STEWARD_SIGNAL_MAX_EVENT_AGE_DAYS`.
- **⚠ [S1] gpt-4.1-nano UNDER-extraction** (#79): a genuinely actionable email classified `effect:"none"` → returns `[]`, event marked processed, the signal that mattered is gone. The single worst failure in the product.
- **⚠ [S1] Wrong-matter binding (context pollution).** `_resolve_target` uses difflib ratio on slug+name with a 0.30 floor + 0.05 ambiguity band (`signals.py:894-926`); a generic `target_hint` can bind a signal to an unrelated task — silent and permanent.
- **⚠ [S1] OWNER_EMAIL unset disables the cross-tenant guard** — `ingest_events` accepts ALL events (`pull.py:247`); during onboarding a misscoped token could ingest foreign mail.
- **⚠ [S1] needs_attention written to vault FS, read by `readdirSync`** — if `VAULT_PATH` differs between the learn writer and ctrl-api reader, cards are written but never listed (`signal_actions.py:806` vs `attention.ts:268`).
- **⚠ [S2] Over-extraction floods the Desk** — the multi-signal prompt has no per-event cap; a chatty transcript sprays cards (`signals.py:2044`).
- **⚠ [S2] Auto-created task on a no-match actionable signal** with `target_confidence=1.0` (`signals.py:2123`) — a hallucinated action spawns a real task.
- **⚠ [S2] Signal stuck in `dispatching`** after a crash between mark-and-dispatch (`signal_actions.py:1466`); nothing auto-sweeps it; the action never fires.
- **✔ Good guard:** terminal clerk failure *raises* (doesn't mark) so transient LLM outages don't bury events as noise (`signals.py:2004`) — keep this on any refactor.

## B — The four vault workers (curator / janitor / distiller / surveyor)

> **[STAMP 2026-07-15] MIXED.** Distiller decision-write and surveyor
> matter-type bugs are RESOLVED (see #12/#13 in the table stamp). Surveyor
> embedder liveness (#14) appears STILL-OPEN. The `openclaw-wrapper` is still
> referenced on `main` (janitor pipeline, hermes templates) — its
> timeout/premature-completion entries were not re-verified; treat as
> historical until someone re-audits the wrapper path.

All four run in one `alfred-worker` container; LLM workers shell to the
`openclaw-wrapper` (which speaks Hermes `/v1/runs` over HTTP); surveyor calls
Ollama + OpenRouter directly. Orchestrator restarts a dead child ≤5× then drops
it permanently (`orchestrator.py:255`).

**Cross-cutting** (beyond R2/R3/R4 above):
- **⚠ [S1] Worker dropped after 5 restarts, no surface** (`orchestrator.py:258`) — a wedged curator silently stops processing the inbox; a wedged surveyor silently kills recall.
- **⚠ [S2] Wrapper timeout (600s) > daemon timeout (300s)** → the daemon kills the wrapper mid-run; the agent's partial writes land but the file is reprocessed (`openclaw-wrapper:428` vs `curator/config.py:74`).
- **⚠ [S2] Gateway token only read at boot** — a Hermes token rotation 401s every worker until restart (`openclaw-wrapper:54`).

**Curator** (inbox → records): mis-classified `entity.type` trusted blindly (`pipeline.py:404`); empty-manifest "success" marks the file processed and never retries (C1/C6); name-normalization gaps spawn duplicate entities (C3); the legacy `HermesBackend` is **broken code** (abstract `process()` unimplemented + 4-vs-5-arg `build_prompt` — `backends/hermes.py`) that crashes the worker through its 5 restarts if anyone sets `backend: hermes`.

**Janitor** (cleanup): *can* delete (scope allows it) and the FS-fallback delete is a permanent unlink (`vault/ops.py:507`); ambiguous link-repair can rewrite a link to the *wrong* record (J2); the heuristic status/type "corrections" can rewrite intentionally-valid frontmatter (J3); ORPHAN001 false-positives spam fresh curator entities with `janitor_note` churn.

**Distiller** (evidence graph): **bug #12** (writes principal-facing `decision/`) + mechanical confidence bumps (D1/D2/D5); fuzzy dedup at 0.7 overlap can merge distinct constraints ("Budget Q1" + "Budget Q3", D3); Pass-B meta-records feed on their own output with no exclusion → unbounded higher-order growth (D4).

**Surveyor** (vectors/recall): **bugs #13, #14** + an embedding-dim mismatch **drops the whole collection and wipes file state** to force a re-embed (`embedder.py:136`); wrong clusters write permanent, never-retracted `related_*` links (S4f); the OpenRouter labeler retries only on 429 and gives up on any other error (`labeler.py:261`); runs only if a `surveyor:` config block exists — omit it and there's *no semantic layer at all*, zero error (S9f).

## C — Desk decision cards + the action buttons

> **[STAMP 2026-07-15] RESOLVED (residual: #3 semantics).** Every button now
> runs one decision POST with reconcile-on-success (#4), defer has a resurface
> contract (#5/C-B4), Undo is wired (#16/F51), and every decision mints
> `state: open` so observation extraction always fires (`31fa11f7`, `e8905e4`;
> see `decisions.ts:563` comment). Delegate's loop/recursion class was killed
> by `4466c68b` (mirror suppression) + `c551c00e` (terminal re-routed signal)
> + `6a8052f` (direct dispatch). Noise now feeds enforced noise instincts
> (#276 `ef33909e`) — subject to the derive_signature gap (Lane 9 stamp).
> Residual: intent=done still maps an approval card to `approved`
> (`decisions.ts:462`) — see bug #3 stamp.

**Construction:** a signal (`effect=action`) → `route_signal_action` → HUMAN path
→ `needs_attention/*.md` (`status:pending`). Cards are assembled *client-side* in
`DeskPage.tsx` by merging needs_attention + pending approvals + pattern proposals.
**The card carries no options array — the four verbs are hardcoded UI, identical
for every card regardless of source.** A click writes `decision/*.md` via `POST
/decisions`, which **synchronously flips the source record's status** (so the card
drops off immediately), then `DecisionRouterWorkflow` (60s) fans out side effects.

This synchronous flip is the mechanism behind **confirmed bugs #3, #4, #5, #16.**
Per-button specifics:

- **Delegate** → re-arms the signal as `unrouted` + stamps `decision_origin`; the signal-router later dispatches an ephemeral agent. **⚠ [S1] If the signal-router is wedged/disabled, the decision sits `executing` forever — UI shows "Delegating:" with no timeout** (`attention.ts:200`, `signal_actions.py:964`). **⚠ [S2] Outcome never matched** if the agent_outcome signal's `source_signal_path` is empty → `executing` is terminal-in-practice (`decision_router.py:763`). **⚠ [S2] No notify_principal** on this path — autonomous work completes invisibly.
- **Defer** → confirmed bug #5. Also: defer on an *approval/judgment* is a no-op that looks handled and the item silently dies (no resurface path) (`DeskPage.tsx:636`, `approvals.ts:65`).
- **Done** → confirmed bug #3. Also: **⚠ [S2] doesn't close the underlying task/matter** — only the delegate→outcome path does (`decision_router.py:875`); a plain "Done" leaves the task open.
- **Do** (`take_mine`) → `POST /todos` on the 60s tick. **⚠ [S1] If the router is wedged or `POST /todos` fails, the item is dropped off the Desk (sync-flip set `done`) AND never appears in Backstage — lost from both queues** (`decisions.ts:322`, `decision_router.py:378`). The 5s `refetchTodos` also races the 60s workflow → up to a minute invisible.
- **Noise** → **⚠ [S2] no longer suppresses anything immediately** — it only appends `noise.observation_pending` and relies on the full OBS-1→OBS-4 clustering chain + the user adopting a later proposal (`decision_router.py:377`). The button's promise ("don't surface things like this again") doesn't take effect now.

**The Decisions feed:** intent→outcome mapping is misleading — a **delegate (you handing work to Alfred) is labeled "Asked"** (`DecisionsPage.tsx:192`); steward/judgment rows classify differently and double-count in the 30-day chart; a decision stuck `open`/`dispatching` shows "ROUTING" forever (`:786`); all three source queries swallow errors → a ctrl-api 500 renders "Nothing on the ledger yet."

**Cross-cutting:** three audit stores written per click (`decision/*.md`, `state.db audit`, `event/*.md`) but **neither the Desk Ledger nor the /decisions feed reads the `state.db audit` table** the writes mirror into — the audit ledger is written but never surfaced.

## D — Learning, observations & progressive autonomy

> **[STAMP 2026-07-15] RESOLVED (the severed feedback arc).** The dead segment
> is reconnected: live counts from state.db (`instinctCounts.ts`, bug #1),
> processed-marking lands (bug #2), decisions always route (`31fa11f7`), and
> the loop was re-repaired end-to-end 2026-07-03 (#276 `ef33909e`: reflection
> index-422 wedge, click→instinct linkage, noise enforcement). CLAUDE.md §6.6
> documents the current contract (`live_observation_count` precedence,
> non-deprecated instinct matching, discretion gate as the safety belt).
> Pack-seeded threshold bypass, dual-scorer scale mismatch, and the gameable
> ≥3-observations gate were NOT re-verified — treat as open questions for a
> future issue, not confirmed-current facts.

The full chain and its dead segment:
```
Desk click → decision/*.md → route_decision → extract_observation_from_decision
  → state.db observation (✓ correct store)
  → OBS-4 clusters (✓ reads state.db) → pattern_proposal → adopt instinct
  ✗ observation_count → relax discretion gate   ← SEVERED by bugs #1/#2
```
The forward arc works; the **trust feedback is severed** — instincts form but
never earn autonomy (confirmed bugs #1, #2; A-1, A-7, I-1).

**Autonomy firing modes:**
- **⚠ [S1] NOT firing (the default reality):** frozen count → 0.95 threshold → the Jaccard live-fire scorer (`signal_actions.py:225`) realistically tops out well under 0.95 → `chosen_path="human"` always. The butler stays "Asking" forever.
- **⚠ [S1] Firing WRONGLY:** onboarding *packs* seed `discretion_threshold:0.85` (`packs.py:520`) which bypasses the obs-count formula (`discretion.py:42`) — a pack instinct + a short, high-token-overlap signal can clear the gate in `live` mode and dispatch a real action **on a pattern with zero observed decisions** (I-2, A-2).
- **⚠ [S1] No staged rollout:** the only live/shadow control is one global env (`STEWARD_SIGNAL_ACTION_LIVE_MODE`); flipping it turns autonomy on for *all* instincts at once, including freshly-seeded packs and any false instincts (A-6).
- **⚠ [S1] Two incompatible scorers feed one threshold** — the judge path uses weighted-glob (`scorer.py:91`), the live-fire path uses token-set Jaccard (`signal_actions.py:225`); the scores aren't on the same scale but share the discretion table (I-3).
- **⚠ [S1] "≥3 observations" gate is gameable** — `validate_instinct_proposal` counts the *wikilink list the clerk emitted* (`validators/instinct.py:128`), not real evidence; a hallucinated 3-element list mints a false instinct in one night (L-3).

**Observation hygiene:** clerk extraction failures drop the whole batch but still truncate the queue by count (`learning.py:131`) → silent loss (O-5); two observation schemas with disjoint required fields and no reconciliation (O-4); cross-store dedup absent → the same gesture double-counts (O-8); `fetch_unprocessed_observations` swallows all errors → Reflection concludes "nothing to learn" on a state.db blip (L-9).

## E — Composio (all apps, not just Gmail)

> **[STAMP 2026-07-15] MIXED.** Scoping hardened: check-readiness now filters
> `user_id` server-side AND client-side (`integrations.ts:3288–3320`, comment
> cites PR #469 defense-in-depth). STILL-OPEN: the meta-finding — execute-path
> silence (`execute_action` error envelopes, bug #15) and the absence of a
> per-toolkit last-success/last-error health surface. Remaining line items
> (orphan SKILL.md, reconnect mis-doc, retry-storm backoff) unverified.

**Corrects Part 1 Lane 3.** The connect flow: catalogue (v3 `/toolkits`, 1h cache,
~60-slug `CATEGORY_MAP`) → `POST /connect` (find/create auth_config + connected_account
scoped to `COMPOSIO_USER_ID`) → OAuth popup → `auto-config` writes the recommended
stream + generates a SKILL.md. **There is no allowlist and no gateway restart**
(confirmed bug #11) — capability = "is there an ACTIVE connection."

**Scoping** is fragile because **Composio's server-side `user_id` filter is broken**
(documented at `integrations.ts:110`) — it returns accounts across every tenant, so
ctrl-api paginates and re-filters client-side (`fetchAllOwnedConnectedAccounts`). The
**Google-family tenant-email guard is fail-open at three points** (no owner email,
identity-probe error, no email in response all `return` and allow — `operations.ts:766-794`),
and only Gmail has a live identity probe (Calendar/Drive 422 → guard skipped).

**Failure modes** (beyond confirmed bugs #10, #15):
- **⚠ [S1] `COMPOSIO_USER_ID` unset/"default"** → cross-tenant leak + 400; init only writes the fallback file when env is set (`entrypoint.sh:338`), so a tenant provisioned without it has neither source and Composio is silently dead.
- **⚠ [S1] check-readiness fetches a single un-paginated page** (`integrations.ts:2570`) — if the tenant's accounts land on page 2+ of the global pool, readiness reports a connected toolkit as `missing` (the un-fixed sibling of the execute-path pagination bug).
- **⚠ [S1] Per-app scope mismatch** — a toolkit ACTIVE under a narrow scope reports `composio_execute_enabled:true` but every write/body-fetch fails inside the swallowed envelope; nothing checks granted vs required scopes.
- **⚠ [S1] Orphan SKILL.md = phantom capability** — a skill doc surviving after disconnect makes the agent confidently invoke a toolkit with no credentials → swallowed error.
- **⚠ [S2] `reconnect_connection` is mis-documented** — the MCP tool says "in-place refresh, same id" but the route creates a brand-new connected_account with a new id (`integrations.ts:1878`); an agent trusting the description references a dead id.
- **⚠ [S2] Stream pointed at a deprecated action 404s every tick** (Notion `LIST_PAGES` removed, etc.); not-in-rewrite-map actions become `tool_not_found` silently (a stale Notion schedule once fired 1,671× against a dead action).
- **⚠ [S2] Quota/rate-limit retry-storm** has backoff only on the onboarding backfill; the recurring stream pull + agent execute path use a plain 3-attempt retry that digs the per-minute hole deeper.
- **⚠ [S1, latent] SDK/API version pin drift** — the code is full of defensive shape-walking (v3 plural-vs-singular kwargs, 5 different `auth_config.id` locations, response-wrapper nesting); any upstream change silently degrades a path that currently "works by fallback." `dangerously_skip_version_check=True` is hardcoded everywhere.

**Meta:** the defining property is **silence on the execute paths** — `execute_action`
never raises, Composio returns 200-shaped error envelopes, and capability is derived
from connection status alone. "Connected and ACTIVE" can coexist with "every call
fails" and nothing surfaces it. Same cure as the system-wide theme: a per-toolkit
health surface (last-success / last-error) + pin the resolved account on every path.

---
---

# Part 3 — Second-wave audit (the un-covered lanes)

> **[STAMP 2026-07-15]** Frozen audit wave; per-section stamps follow. Note the
> headline itself is now stale in 2 of its 3 points — see the next stamp.

Part 2 audited 5 subsystems. Part 3 covers the **8 lanes never audited**: brief,
chores, the onboarding pipeline, the Hermes runtime, ctrl-api core, the web app
(owner/ritual/other pages), the MCP connector, and first-boot. All grounded in
`file:line`; `[CONFIRMED]` = provable from code, `[SUSPECTED]` = needs runtime.

## Headline: three CLAUDE.md claims are FALSE (the architecture isn't what the docs say)

> **[STAMP 2026-07-15] 2 of 3 RESOLVED; 1 STILL TRUE. Re-verified individually:**
> 1. **Promotion contract — RESOLVED (residual side doors).** Enforcement now
>    covers the dominant write paths: POST (`vault.ts:759`), the workhorse
>    **PATCH** (`vault.ts:899`, with an explicit promotion-contract comment
>    block), and move (`vault.ts:1178`). The audit-era gap ("PATCH bypasses")
>    is closed. Residual: at least one direct `fs.writeFileSync` of a demoted
>    type survives (`packages/ctrl/src/api/routes/learning.ts:365` writes
>    `observation/<name>.md`) — a small side-door class, not the dominant path.
> 2. **Migration mechanism — RESOLVED.** `packages/ctrl/src/db/migrate.ts`
>    exists and `packages/ctrl/src/db/migrations/` holds 18 numbered migrations
>    (0001_fix_pack … 0018_channel_identity). CLAUDE.md §10.3's description is
>    now accurate. The FIX-PLAN Phase-0 warning in the body text is historical.
> 3. **ctrl-api credentials plaintext — STILL TRUE.** `credentials.ts` still
>    reads/writes secrets as plaintext `.env` (`readEnv`/`patchEnv`, no crypto
>    calls); `columnCrypto` exists only in the web package
>    (`packages/web/src/server/columnCrypto.ts`). The stale part is only the
>    framing: current CLAUDE.md no longer claims ctrl-side column encryption,
>    so it is a documented design, not a docs-vs-code falsehood.

The ctrl-api audit proved the documented foundation partly doesn't exist:

1. **The promotion contract is barely enforced.** CLAUDE.md says ctrl-api rejects
   non-canonical writes via `middleware/canonical_path.ts` with
   `CANONICAL_PATH_ENFORCEMENT=enforce`. **That middleware, env var, and dir do not
   exist** (zero grep hits). Enforcement is a function (`assertCanonicalVaultPath`,
   `db/promotionContract.ts:149`) called on **only 2 of ~38 vault-writing routes**
   (`vault.ts:740` POST, `:1065` move). The workhorse **PATCH `/vault/records/*`
   bypasses it** (`vault.ts:796-1053`), and `learning.ts:365` (`observation/`),
   `attention.ts:150` (`event/`), `chores.ts`, `stateChanges.ts`, `decisions.ts`,
   `steward.ts` all `fs.writeFileSync` demoted types straight into the vault.
   *This reconciles the wave-1 steward 422:* the contract fires on the POST path
   (which is why steward's `write_record("event",…)` 422'd) but is **absent on the
   dominant write paths** — so the vault silently accumulates exactly the demoted
   types the contract claims to exclude. **The 422 was the exception, not the rule.**
2. **There is no migration mechanism.** CLAUDE.md says "numbered SQL migrations in
   `db/migrations/`, applied transactionally on boot." **No such dir, no runner.**
   `schema.sql` is `CREATE TABLE IF NOT EXISTS`-only, `exec`'d at open (`state.ts:63`).
   **Adding/renaming a column on an existing DB is a silent no-op** (`IF NOT EXISTS`),
   and new code reading the new column breaks against the old table.
   ⚠️ **This invalidates `FIX-PLAN.md` Phase 0** — which assumed I'd "author a
   numbered migration." That fix would have silently done nothing. (Exactly the
   blind-fix regression the audit-first order was meant to catch.)
3. **`columnCrypto` does not exist in ctrl-api.** Credentials are stored/served as
   **plaintext `.env`** (`credentials.ts:117-151`). (Column encryption *does* exist
   in the **web** package for `OAuthCredential` tokens — `oauth2.ts` `encryptApiKey`
   — so the two stores differ; ctrl's API-key store is plaintext.)

## Cross-cutting confirmed bugs that appear in multiple lanes (deduped)

> **[STAMP 2026-07-15] ALL THREE RESOLVED.**
> * openclaw-alias 404s: `/api/v1/openclaw/*` is dual-registered as a thin
>   forward to the same handlers as `/api/v1/hermes/*`
>   (`packages/ctrl/src/api/routes/hermes.ts:157–168`, cites the ~7 callers).
> * Scheduled briefing crash: the schedule passes a **positional string** slot
>   with a morning/evening discriminator
>   (`packages/ctrl/src/api/routes/chores.ts:352–359`,
>   `BRIEFING_SLOT_BY_TEMPLATE`), and `BriefingWorkflow.run` normalizes it
>   (`packages/learn/src/workflows/briefing.py:76–84`).
> * `notify_principal` default channel: C8 replaced `pickPrimaryChannel` with
>   Hermes-session-index resolution that can never yield "webchat"
>   (`packages/ctrl/src/api/routes/notifications.ts:128–139`).

- **The `/api/v1/openclaw/*` alias was retired but ~7 callers still hit it → 404.**
  4 MCP `alfred` tools (`alfred.ts:306,313,320,490` incl. `list_in_flight_agents`,
  the documented anti-double-spawn guard), and the **brief composer**
  (`briefing.py:1711` → silently drops the "in-flight delegations" section). Live
  routes are `/api/v1/hermes/*` (`hermes.ts:53-61`). **[CONFIRMED, S1]**
- **The scheduled daily briefing crashes every run.** `install-standard` creates the
  schedule with `--input {chore_slug:…}` (a dict) but `BriefingWorkflow.run(self,
  slot)` does `slot.strip()` on it (`chores.ts:1585` vs `briefing.py:77`) →
  `AttributeError` → infinite Temporal retry. Both slots also lack a morning/evening
  discriminator. **The daily Morning/Evening brief never writes a record.**
  **[CONFIRMED, S1, silent]**
- **`notify_principal` default channel is hard-broken.** `channel:"auto"` (the
  default) calls `pickPrimaryChannel()` which reads
  `/mnt/encrypted/openclaw/openclaw.json` — a file the Hermes init **explicitly
  deleted** (`entrypoint.sh:11`) → falls to `"webchat"` → the route 424s
  (`notifications.ts:425,441`). **Every default-channel notify fails** — the agent's
  only path to reach Sir on autonomous completion. **[CONFIRMED, S1]**

## Brief / briefing

> **[STAMP 2026-07-15] MIXED.** The composer was rewritten
> (`write_brief_and_opportunities_opus`, PR S2-2 — `onboarding_v3.py:2312`;
> the audited vault-write `except: pass` swallow is fixed — #B2 comment at
> `onboarding_v3.py:2082` — though a handful of typed `except …: pass`
> swallows remain elsewhere in the file), and the First Brief
> has a dedicated dashboard surface
> (`packages/web/src/dashboard/components/FirstBrief.tsx`). STILL-OPEN:
> `/brief` still renders a backend failure identically to a quiet day —
> `BriefPage.tsx:273` keeps `retry: false` and the page has no error branch.
> The `(morning|evening)` slug filter persists (`briefings.ts:49`) — moot for
> the First Brief given the dedicated component, relevant if any other
> non-slot briefing is ever written. UTC/timezone and lexical-compare items
> unverified.

- **[CONFIRMED, S1]** Onboarding first-brief vault write swallows ALL errors (`except: pass`, `onboarding_v3.py:871,1175`) → brief never persists, workflow still reports `done`.
- **[CONFIRMED, S2]** First-brief email failures swallowed by both activity (`first_brief_email.py:75-141` returns `{sent:False}`) and workflow (`onboarding_pipeline.py:516`).
- **[CONFIRMED, S2]** `/brief` + Desk render a backend 502/504 identically to "quiet day" (`BriefPage.tsx:270`, `DeskPage.tsx:261`, `retry:false`, no error branch).
- **[CONFIRMED, S2]** The onboarding First Brief never appears on `/brief`: its filename `First Brief` fails the `^\d{4}-\d{2}-\d{2}-(morning|evening)$` filter (`briefings.ts:49`).
- **[CONFIRMED, S1]** Brief composes from zero signals if the pipeline is wedged → vacuous brief, no anomaly flagged (`briefing.py:687,1454`).
- **[CONFIRMED, S2]** Daily brief uses UTC for date/window with no tenant-tz → off-by-one-day filename/dateline for non-UTC tenants (`workflows/briefing.py:106`, `activities/briefing.py:2094`).
- **[CONFIRMED, S3]** `since`/`until` and state.db `ts>=` filters do lexical string compare across mixed `Z`/`+00:00` forms → boundary-second drops (`briefings.ts:274`, `state.ts:174`). Empty-brief copy hardcoded "this morning" regardless of slot (`BriefPage.tsx:154`).

## Chores

> **[STAMP 2026-07-15] RESOLVED (the S1), MIXED elsewhere.** The
> highest-blast-radius bug — workflow-name collision crash-looping the entire
> learn worker — is fixed: the loader dedups vs reserved + seen names and
> skips with a log (`packages/learn/src/workflows/chores/_dynamic_loader.py:601–706`).
> Quarantine (3 dry-runs) now exists per CLAUDE.md §6.5, but an ENFORCED
> sandbox/review gate on generated code still does not — STILL-OPEN residual.
> Schedule-vs-registration ordering, restart-readiness, timezone, and cursor
> items unverified.

- **[CONFIRMED, S1]** No cross-file workflow-name dedup in the dynamic loader (`_dynamic_loader.py:660`); one generated `@workflow.defn` name collision (with another chore or a static workflow) makes `Worker(...)` reject duplicate names → **the entire learn worker crash-loops, every chore + workflow dead.** Highest blast radius in the system.
- **[CONFIRMED, S1]** No sandbox/dry-run/review gate on what generated code DOES; `call_composio` can `GMAIL_SEND_EMAIL`/`CREATE_EVENT`/`NOTION_CREATE_PAGE` unattended; the "quarantine" is unenforced convention (`chore_generation_prompts.py:219` "validator does not yet enforce it"); smoke test only imports, never executes.
- **[CONFIRMED, S2]** Schedule created before the worker registers the workflow (`assign_chores.py:1365` then restart at `onboarding_pipeline.py:558`); if restart is skipped/fails (downgraded to a warning), every fire is a permanent `NotFoundError`.
- **[CONFIRMED, S2]** `restart_learn_worker` returns ok on ConnectError + 429 (`chore_generation.py:1887,1920`); ctrl-api restart only waits for container `running`, not worker readiness (`admin.ts:356`) → green restart, dead chores.
- **[CONFIRMED, S2]** `seed_observations_from_chore_runs` cursor drops entries on timestamp ties + validation-skip (`observe.py:248-324`).
- **[CONFIRMED, S2]** Schedules created with no `--time-zone` → UTC, while the code comment promises "5am = tenant-local" (`chores.ts:263,1605`; `workflows.ts:323`).
- **[CONFIRMED, S3]** No dedup on generated `module_name`/slug within one onboarding → silent overwrite + a `failed[]` schedule never surfaced (`assign_chores.py:1300`). Profile-key mismatch: prompt reads `detected_subscriptions`/`detected_merchants`, logic reads `detected_services` (`chore_generation.py:131` vs `assign_chores.py:294`). No chore re-registration at boot — lost Temporal schedules never recreated (`register_schedules.py` has no chore scan).

## Onboarding pipeline

> **[STAMP 2026-07-15] LARGELY RESOLVED-BY-REWRITE.** The pipeline was
> substantially rebuilt post-audit: chunked extraction (#193), rich task shape
> + 4-tier matter resolution (`dbaca816`/`935692f`), the /soul preset chooser
> relocated into the ritual between /verify and /composing (#853,
> `SoulPresetPage.tsx`), sentence-boundary truncation for personalize
> (2026-05-23 incident), day-one desk seeding (#196). Individual line items
> here (onboard.json torn read, brace-counting parser in personalize,
> re-onboard reset) were NOT each re-verified — treat as historical claims;
> re-audit before citing any of them as current.

- **[CONFIRMED, S1]** The `/soul` preset write is dead AND destructive: the brief reads `soul_md` from `onboard.json` (`onboarding_v3.py:1027`), but `/soul` writes the vault `SOUL.md` (`SoulPresetPage.tsx:99`) — so the chosen bearing never reaches the brief, and it overwrites the personalized `SOUL.md` with a canned template.
- **[CONFIRMED, S1]** `personalize_opus` hard-raises on the first of 5 vault writes failing (`onboarding_v3.py:741`) → aborts before `awaiting_verification`, leaving partial vault state and the user stuck on `/reading-the-room`.
- **[CONFIRMED, S1]** Re-onboard has no reset; pack dedup uses grep-substring `search_records` not exact-slug (`packs_opus.py:473,894,1393`; `vault_client.py:184`) → drifted-name duplicates (the 9→16 class).
- **[CONFIRMED, S2]** Brief stage is a separate `Date.now()`-id workflow with no in-flight guard on `/onboarding/corrections` (`workflows.ts:251`) → double-submit spawns parallel brief workflows. (Web client guards via `submitFactCorrections`, but the server route doesn't — a race/non-UI caller still double-spawns.)
- **[CONFIRMED, S2]** `onboard.json` is non-atomic read-modify-write with no lock (`onboarding_v3.py:107`); a concurrent `/onboarding/progress` read can hit a torn file → `JSON.parse` throws → `stage:"not_started"`.
- **[CONFIRMED, S2]** `personalize_opus` still uses the naive brace-counting JSON parser (`onboarding_v3.py:711`) the facts/patterns/packs stages were upgraded away from — the facts→0 truncation class still threatens personalize (5 markdown blobs at 16384 tokens).
- **[CONFIRMED, S2]** A pre-verify stage timeout strands the user with no resume: `already_running` blocks re-trigger (`operations.ts:958`), `/reading-the-room` has no timeout fallback.
- **[CONFIRMED, S3]** Gate maps phantom stages (`automations`, `backfill`) not in STAGE_ORDER (`DeskOnboardingGate.tsx:104`); `AwakenPage` ignores real progress (canned timer). `messages_read`/`total_days` overwritten with email count → wrong % bar (`onboarding_v3.py:418`).

## Hermes runtime

> **[STAMP 2026-07-15] MIXED.** Workers gateway :18790 IS now health-checked
> (compose `docker-compose.yaml:435–456` probes both gateways + fd-limit;
> `packages/hermes/Dockerfile:496–500`) — that entry is RESOLVED. The runtime
> has since moved on (three profiles incl. heavy :18791; session pruning; see
> Lane 7 stamp). Wrapper/clerk timeout, dispatch-lock starvation, and
> `_extract_json` items unverified — the clerk/wrapper path still exists on
> `main`, so re-audit before relying on those lines either way.

- **[CONFIRMED, S2]** `openclaw-wrapper` treats any assistant text as run-complete (`if status in terminal or text:`, line 439) → premature truncation of multi-step curator/clerk runs; file marked processed.
- **[CONFIRMED, S2]** Workers gateway `:18790` is never health-checked (compose + Dockerfile probe only `:18789`); dependents start against a dead clerk gateway.
- **[CONFIRMED, S2]** `clerk` activities get `start_to_close=60s` with a 900s HTTP budget and no heartbeat (`media_ingestion.py:110` vs `clerk.py:530`) → Temporal kills + retries while the billable run continues server-side.
- **[CONFIRMED, S2]** `_AGENT_DISPATCH_LOCK` (serial, held through the ~900s clerk call) × 1000s activity timeout × `max_concurrent_children:1` → dispatch starvation + retry storm under ≥2 concurrent agent signals (`signal_actions.py:73,1100`).
- **[CONFIRMED, S2]** `clerk` collapses 401/429/billing/transient into one generic `RuntimeError` (`clerk.py:679`) → Temporal blind-retries un-retryable failures; inconsistent with the wrapper which discriminates.
- **[CONFIRMED, S2]** `_extract_json` fabricates from truncated output (brace-padding) and can `return` a `list` from a `->dict` function (`clerk.py:744-794`) → `AttributeError` in single-object callers (`media_ingestion.py:115`).
- **[CONFIRMED/SUSPECTED, S3]** `learn-clerk` session reuses one key with idle-only reset → unbounded transcript growth, no prune job wired (the OpenClaw `.trajectory` leak re-manifested). All 4 workers + ephemeral executors pinned to `gpt-4.1-nano` (the #79 under-extraction model); `main` spends grok-4.x on a deterministic echo cron. Model PATCH restart bounces both profiles + can exceed the 30s exec timeout; init re-render clobbers a UI-set model.

## ctrl-api core (beyond the 3 headline structural findings)

> **[STAMP 2026-07-15] MIXED.** RESOLVED: the false-201 audit write — the
> primary `POST /audit` route uses strict mode and rethrows so the request
> 5xx's; only best-effort mirrors still swallow, by design
> (`packages/ctrl/src/api/routes/state.ts:411–412,808–855`). The
> `AAS_API_KEY`-unset fail-open is still mitigated the same way (hard exit,
> `standalone.ts:27–29`) and auth has since been hardened well beyond the
> audit (scoped voice-bridge allowlists in `auth.ts`; per-app MCP tokens
> PR #278). Boot-guard, per-file lock, KNOWN_TYPES divergence, CORS, and
> rowid-reuse items unverified.

- **[CONFIRMED, S2]** `authenticate()` is fail-open when `AAS_API_KEY` is unset (`auth.ts:11` "open access"); mitigated only by `standalone.ts:27` hard-exit, so the security primitive itself defaults to allow (other entrypoints unprotected).
- **[CONFIRMED, S2]** `POST /api/v1/state/audit` returns `201 {ok,id}` even when the INSERT failed (`appendAudit` swallows, `state.ts:740`) → the audit ledger silently loses entries.
- **[CONFIRMED, S2]** `schema.exec` at boot is unguarded (`standalone.ts:51`) → a corrupt `state.db` is a hard boot-loop with no degraded mode (the vault reconcile IS guarded; the 3 DB opens aren't).
- **[CONFIRMED, S2]** Single-writer lock is per-file + in-process only (`vault.ts:109`); the POST raw-`content` branch (`:750`) and the bare-`fs.writeFileSync` routes don't take it → unserialized races on the same path.
- **[CONFIRMED, S3]** `KNOWN_TYPES` (read allowlist, `vault.ts:141`) diverges from the canonical write set both ways — missing `daybook`/`place` (canonical → 400 on list), includes ~20 demoted types. `vault_index` reconciler double-reads every file at boot + misses direct-write routes. `IGNORE_DIRS` differs between `vaultIndex.ts` and `vault.ts`. CORS `*` on a bearer API. `timingSafeEqual` gated on a non-constant-time length check.
- **[SUSPECTED, S2]** Re-embed reuses freed `embedding_meta` rowids (non-AUTOINCREMENT PK) with deletes+inserts not in a transaction (`state.ts:543`) → vec0 vector / meta desync → wrong k-NN neighbors.

## Web app (owner / ritual / other pages)

> **[STAMP 2026-07-15] RESOLVED (the headline S1).** Registration lockdown
> exists: `onBeforeSignup` throws 403 once the box is claimed;
> `ALLOW_SIGNUP_AFTER_OWNER=true` reopens it deliberately
> (`packages/web/src/auth/hooks.ts`, cites "FAILURE-MODES web bug #1") — which
> also collapses the "second registrant gets everything" exposure. The Google
> refresh-token nulling is fixed (`oauth2.ts:385–390` preserves the stored
> token on re-auth). Error-swallowing list queries: at least `/brief` still
> renders failure as empty (see Brief stamp); the other ~11 unverified.

- **[CONFIRMED, S1]** **No registration lockdown + zero server-side ownership enforcement.** Signup is open (`main.wasp:35`); only the *first* user is owner, but `isOwner`/`isAdmin` are used **only cosmetically** (nav visibility) — no operation checks role (grep: no `isOwner`/`403`/`requireOwner` in any `operations.ts`). **Any second registrant gets full read/write to the owner's vault, RULES.md, decisions, and Gmail-backed data.** The headline tenant-isolation gap for an internet-exposed single-principal box.
- **[CONFIRMED, S2]** Google OAuth `handleCallback` nulls a good `refresh_token` on re-auth (`oauth2.ts:382` sets `null` when Google omits it) — and it's the exact path onboarding routes through; Gmail dies ~1h later. (`auth/hooks.ts:107` does it correctly — inconsistent.)
- **[CONFIRMED, S2]** `getOnboardingProgress` returns `stage:"not_started"` on ANY proxy error (`operations.ts:1020`) → a fully-onboarded principal is bounced to the "Start onboarding" CTA on a transient hiccup (5s poll).
- **[CONFIRMED, S2]** `getDashboardData.instance.*` reads fields off the `{}` sentinel after the fixed-target refactor (`operations.ts:168`) → ChannelsPage email card never populates.
- **[CONFIRMED, S3]** Household RULES.md editor stuck on "A moment." forever on a fetch error (`HouseholdPage.tsx:70`, `retry:false`). ~11 list queries swallow 500/502 into empty-state (`operations.ts` — incl. `getMatterDetail`→"No such matter."). Matter-detail back-link hardcoded to `/matters` (drops the onboarding seam).
- *Verified OK:* the ritual-loop fixes (ComposingPage, `ritualPathForStage`) are real; `tenantProxy` preserves status codes (the swallowing is in callers).

## MCP connector (beyond the openclaw-404 dedup)

> **[STAMP 2026-07-15] unverified line items; surface substantially evolved.**
> The MCP server gained per-app scoped bearer tokens + a management API/UI
> (PR #278 `12d02d21`) and the tool catalogue has been reworked since the
> audit. The specific type-list mismatches cited here (creatable-types vs 422,
> KNOWN_TYPES missing daybook/place, list_decisions filter) were not
> re-verified — re-check against current `packages/mcp-server/src/alfred.ts`
> before citing.

- **[CONFIRMED, S2]** `create_vault_record` advertises `observation`/`reflection`/`project` etc. as creatable, but `assertCanonicalVaultPath` 422s them (`alfred.ts:106` vs `vault.ts:740`) — the tool invites guaranteed-fail calls.
- **[CONFIRMED, S2]** `list_vault_by_type` `KNOWN_TYPES` missing `daybook`/`place` → 400 on canonical types.
- **[CONFIRMED, S3]** `list_decisions` filters `status` while the comment says filter `state` too (`decisions.ts:616,634`) → records with only `state` silently omitted. `start_workflow` advertises deleted workflow types. `notify_principal` MCP timeout (120s) races the ctrl poll (120s) with no margin; channel enum narrower than the route supports.

## Deploy / first-boot

> **[STAMP 2026-07-15] RESOLVED (top items).** `OWNER_EMAIL` is defined
> (`.env.example:95`) and compose sets both spellings from one source (C9,
> `docker-compose.yaml:730–736`) — first-brief email, cross-tenant guard, and
> sender-allowlist seeding all get the address. Memory posture fixed at the
> stack level (Plane removed, hermes 12g + swap, 48 GB min — PR #279).
> bootstrap whitespace-validation, AgentMail vars, `:latest` pinning, and
> Temporal `start-dev` items unverified (the `:latest` model is by-design per
> CLAUDE.md §12).

- **[CONFIRMED, S1]** `OWNER_EMAIL` is read by code (`first_brief_email.py:77`, `pull.py:324`, init step 9) but **never set** — compose passes the *wrong name* `ALFRED_OWNER_EMAIL` (`docker-compose.yaml:415`), bootstrap/`.env.example` never define `OWNER_EMAIL`. → first-brief email never sends, cross-tenant guard fail-open, sender-allowlist not seeded.
- **[CONFIRMED, S2]** `bootstrap.sh` treats whitespace-only required fields as present (`-z` test, no trim, `:67`) → a stray-space secret passes validation and is never regenerated.
- **[CONFIRMED, S2]** First-brief email needs AgentMail vars (`AGENTMAIL_*`) absent from `.env.example`/bootstrap/compose (`email.ts:17`) → outbound email non-functional even if `OWNER_EMAIL` were fixed.
- **[CONFIRMED, S2]** Aggregate `mem_limit` ≈ 37 GB on the default profile vs the stated 16 GB min (`docker-compose.yaml:19`) → OOM on a min-spec box during first-boot.
- **[CONFIRMED, S3]** All 12 `ssdavidai00/*` images + several bases are unpinned `:latest` (header claims otherwise) → install-to-install drift. Caddy requests 6 LE certs before DNS may resolve. Temporal runs `start-dev` (dev SQLite server) as the production engine.
- *Cleared:* `COMPOSIO_USER_ID` is actually handled correctly here (bootstrap generates it, init mirrors the file, ctrl reads env→file) — corrects an earlier worry. `VAULT_PATH` is consistent across containers. Init is fail-closed + idempotent.

## Count + the proof discipline going forward

> **[STAMP 2026-07-15]** Historical tally — do not update. The remediation
> campaigns that consumed this catalogue ran 2026-05-22 → 2026-05-24 (CLAUDE.md
> §16 incident table) and continued through #276 (2026-07-03). Residual open
> items are stamped in place; NEW bugs go to GitHub issues.

This wave adds **~45 unique confirmed bugs** (after deduping the briefing-dict and
openclaw-404 findings) to the 18 from Part 2 → **~60+ confirmed**, plus the 3
structural CLAUDE.md falsehoods. Coverage is now ~comprehensive across the planes;
the remaining un-swept tail is the sidecar mutate scripts (Sure/Plane Ruby), Vexa,
and the cold-archive compactor.

**On not hallucinating fixes:** every entry here cites the exact code path. Before
any fix lands, the discipline is **failing-test-first** — write a test that
reproduces the bug (red), then fix until green — so each fix is *proven* against the
real behavior, not against my assumption of it. The migration-mechanism finding
above is the case in point: a fix written blind would have silently no-op'd.

---
---

# Part 4 — Sidecar & edge sweep (Sure/Plane, Vexa, cold-archive)

> **[STAMP 2026-07-15]** Frozen audit wave. Two of the swept subsystems (Plane,
> Vexa) have since been REMOVED from the deployed stack — their findings are
> SUPERSEDED-STACK. Sure and cold-archive remain live; stamps follow.

Closes coverage. **4 new S1s** + a merged-compose↔code path divergence. Two whole
subsystems are dead out-of-the-box.

## New S1s

> **[STAMP 2026-07-15]**
> * Sure-dead-OOTB: **RESOLVED** — `SURE_API_KEY` is bridged end-to-end:
>   `.env.example:215–217`, `scripts/bootstrap.sh:151`, compose injects it into
>   ctrl-api (`docker-compose.yaml:646`).
> * Merged-compose path divergence: **RESOLVED** —
>   `sure.ts` writes mutate payloads to `/alfred-data` (`MUTATE_HOST_DIR`,
>   with an explicit path-note comment), and `webhooks/plane.ts` reads
>   `VAULT_PATH` defaulting `/vault` (both files carry comments describing the
>   old bug). The plane webhook is additionally moot (Plane removed).
> * Both Vexa S1s: **SUPERSEDED-STACK** — no vexa services in
>   `docker-compose.yaml` on `main`; `routes/vexa.ts` / `transcript.py` remain
>   in-tree dormant.

- **Sure is dead OOTB.** `.sure-api-key` is minted to a *file* by sure-init but
  **never injected into ctrl-api's `SURE_API_KEY` env** (`sure-bootstrap.rb:113`
  writes the file; `sure.ts:14` reads only `process.env`; bootstrap/.env.example/
  Dockerfile never bridge it). Every Sure REST proxy → `NOT_CONFIGURED`, the card
  is hidden, finance blank. [CONFIRMED, S1, silent] — Lane I/V.
- **Merged-compose ↔ code path divergence.** ctrl-api mounts `vault_data:/vault` +
  `alfred_data:/alfred-data` (no `/mnt/encrypted`), but `sure.ts:109`
  (`MUTATE_HOST_DIR="/mnt/encrypted/alfred"`) and `webhooks/plane.ts:156`
  (`/mnt/encrypted/vault/task`) hardcode the old deploy-template layout → every
  Sure mutate fails (file lands on the wrong volume) and every Plane→Steward
  webhook is silently dropped (`readdirSync` throws → `no_vault_task`). [CONFIRMED,
  S1, silent] — Lane I. (Localized to those files; the vault mount itself is
  consistent per the deploy sweep.)
- **Vexa never dispatches a bot.** `VEXA_GCAL_STREAM_ID=composio-googlecalendar`
  (compose default) short-circuits the candidate list (`transcript.py:1001`) to a
  file that never exists; the real slug is
  `composio-googlecalendar-googlecalendar-events-list` (`integrations.ts:2197`) →
  `find_upcoming_meet_events` returns `[]` forever. [CONFIRMED, S1, silent].
- **Vexa action-extraction is write-only.** `apply_transcript_action` appends
  `transcript:action_candidate` to `steward-signals.jsonl` (`transcript.py:984`)
  that **no consumer reads** — the router reads state.db signals, not the JSONL
  (`signal_gather.py:293`); grep finds zero consumers. Even with dispatch fixed,
  extracted actions vanish. [CONFIRMED, S1, silent].

## OWNER_EMAIL split — corroborated from a second angle

> **[STAMP 2026-07-15] RESOLVED.** Compose sets BOTH `OWNER_EMAIL` (canonical,
> C9) and `ALFRED_OWNER_EMAIL` from the same `.env` value
> (`docker-compose.yaml:730–736`); every reader sees the principal's address.

`transcript.py:1113` reads `ALFRED_OWNER_EMAIL` (which compose sets) while
`pull.py:324`, `first_brief_email.py:36`, `fleet_audit.py:73` read `OWNER_EMAIL`
(unset) → the cross-tenant ingest guard disables itself AND `is_sir_attendee` is
fail-open (empty owner → `True` for every meeting, `transcript.py:223`). Confirms
the deploy-lane `OWNER_EMAIL` bug is tenant-wide, not Vexa-local. [CONFIRMED, S2]

## Plane / Sure sync (Lane I ctrl `sure.ts`/`webhooks/plane.ts` · Lane II learn `plane_*.py`)

> **[STAMP 2026-07-15] SUPERSEDED-STACK (Plane rows) / unverified (Sure rows).**
> Plane was removed fleet-wide (PR #279, `4a83de87`); `plane_sync`/
> `plane_reconciliation`/`plane_alfred_triggers` code is dormant in-tree —
> deletion is an open follow-up. The Sure `_cluster/apply` envelope-shape and
> null-name items target still-live `sure.ts` code and were NOT re-verified —
> re-audit before citing as current.

- **[S2]** Reconciliation clobbers the 15s forward-sync cursor (lost-update; whole-file read-modify-write over a minutes-long scan — `plane_reconciliation.py:386` vs `plane_sync.py:91`).
- **[S2]** Staleness filter returns `{}` for the whole body when Plane is the newer author (`filtered` never repopulated, `plane_sync.py:230`) → one externally-touched field suppresses all legitimate field pushes.
- **[S2]** `plane_alfred_triggers` reads the cursor at the wrong path (missing `/state/`, `plane_alfred_triggers.py:62`) → Plane-triggered sessions never get matter context.
- **[S2-susp]** `_cluster/apply` reads `/tags`+`/merchants` as bare arrays but `/categories` as an envelope (`sure.ts:1083` vs `:1073`) → dedup maps empty → duplicate merchants/tags/rules every re-run.
- **[S3]** null-name deref 500 (`sure.ts:1078`); loop-guard description-hash oscillation; `:stable` pin drift vs hardcoded Plane-1.3.0 quirks; `set_transaction_tags` single-id-vs-array. *Cleared:* #555 migrator handling, Ruby error envelopes (don't swallow), state-group mapping.

## Cold-archive / state.db tail (Lane I — packages/ctrl)

> **[STAMP 2026-07-15] RESOLVED (the reader gap).** `coldRead.ts` now exports
> generic cross-tier readers — `queryCrossTier(table, …)` / `getCrossTier`
> (`packages/ctrl/src/db/coldRead.ts:288,405`) — not just the audit pair, so
> compacted signal/observation/routing_decision/link rows are reachable. FK
> null-ordering, transactionless re-embed, and `synchronous=NORMAL` items
> unverified.

- **[S2]** After TTL, **signal/observation/routing_decision/link are deleted from hot but only `audit` has a cross-tier reader** (`coldRead.ts` exports only `queryAuditCrossTier`) → those four tables' long tail silently unreachable from every API.
- **[S2]** FK `ON DELETE SET NULL` nulls `routing_decision.signal_id` when the signal is compacted before the (newer) decision (`schema.sql:94`, order `compactor.ts:35`) → cross-tier join broken.
- **[S2]** Embedding re-embed runs 4 statements with no transaction + non-AUTOINCREMENT rowid reuse (`state.ts:543`, `schema.sql:211`) → orphaned meta / vec mis-pair on crash.
- **[S2-susp]** `synchronous=NORMAL` on two independent DBs → power-loss can lose a compacting row to neither tier. **[S3]** cross-tier `total` double-counts straddling rows; deep-pagination per-tier cap; ingest 7d TTL deletes unprocessed (by-design). *Corrects the plan:* the compactor **is** running — the "deferred" text in `schema.sql:13` is stale doc-rot.

## Vexa runtime (Lane II learn `transcript.py` · Lane V compose)

> **[STAMP 2026-07-15] SUPERSEDED-STACK.** No Vexa services in
> `docker-compose.yaml` on `main`. Findings apply only if the dormant code
> (`packages/ctrl/src/api/routes/vexa.ts`, `packages/learn/src/activities/transcript.py`,
> `workflows/transcript_intake.py`) is ever revived.

- **[S2]** auto-join toggle controls only 1 of 2 schedules (`vexa.ts:191` vs `register_schedules.py:98,102`); **[S2]** empty-transcript-on-early-webhook marked processed → permanent loss (`transcript_intake.py:319`); **[S2]** `vexa-runtime-api` mounts docker.sock RW with no `no-new-privileges`/`cap_drop` on a 3rd-party image (`docker-compose.yaml:1117`). **[S3]** `vexa-transcripts.jsonl` never rotated; bot containers unbounded. *Cleared:* webhook HMAC is timing-safe + replay-windowed; the Omi path is independent and ingests correctly.

## Tally

> **[STAMP 2026-07-15]** Historical tally — frozen. Aggregate position as of
> this stamp pass: the structural root causes (R1 storage cutover, the
> migration runner, the promotion-contract gate, the openclaw alias, the
> registration lockdown, Sure/OWNER_EMAIL wiring) are closed; Plane + Vexa
> findings are moot (subsystems removed); the verified STILL-OPEN set is:
> `execute_action` error-envelope silence (bug #15), surveyor embedder
> liveness (bug #14, likely), `recover_stuck_dispatching` missing attempt cap
> (2026-07-15 incident), `derive_signature` `source_type="email"` gap (noise
> matching inert), ctrl plaintext credential store (by-design, headline #3),
> `/brief` error-vs-empty rendering, no backup wiring, no work-liveness
> heartbeat (R4), ctrl-api Docker-socket root-equivalence. New bugs → GitHub
> issues, not this file.

The sweep adds ~25 findings (4 new S1s) → **~85 confirmed/suspected total** across
every plane + sidecar. Coverage is now comprehensive. **The Vexa pipeline and the
Sure integration are each dead out-of-the-box** (independent S1s).
