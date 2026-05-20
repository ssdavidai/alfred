# Fix Fan-Out Plan v2 — against the real architecture

v1 planned against the *docs*. The audit proved the docs wrong, so v1's Phase 0
(which assumed a migration runner) would have silently no-op'd. v2 is planned
against what the code actually is: **no migration runner, a patchily-enforced
promotion contract, plaintext ctrl credentials, and ~60+ confirmed bugs** across
all five planes (see `FAILURE-MODES.md` Parts 2–3).

Three mechanisms keep ~5 agents fixing in parallel without stepping on each other
or shipping regressions:

1. **A commit-time gate that auto-rejects bad work** (built + proven — below).
2. **Package-scoped lanes** with non-overlapping glob territories.
3. **Frozen contracts** (`FIX-CONTRACTS.md`) at every lane boundary.

---

## 1 · The enforcement gate (built + proven)

`scripts/hooks/` — installed via `bash scripts/hooks/install.sh` (sets
`core.hooksPath`; every linked worktree inherits it). On `git commit`,
`check_lane.py` rejects the commit **before the diff reaches the orchestrator** if
it:

| Gate | Rejects | How |
|---|---|---|
| **Lane boundary** | a staged file outside the lane's `ALLOWED` globs | per-worktree `.lane` manifest → glob check |
| **Forbidden zone** | any edit to Phase-0-owned shared surface | global `forbidden_zone` in `lanes.json` |
| **Scope** | net staged diff > ~200 LOC | `git diff --cached --numstat` |
| **Regression** | the lane's `VERIFY` (tests/typecheck/`compose config`) fails | `subprocess` run, blocks on non-zero |

Proven end-to-end in a throwaway repo — **6/6**: lane-jump blocked, forbidden-zone
blocked, in-lane allowed, >200 LOC blocked, failing VERIFY blocked, phase0
orchestrator allowed into the forbidden zone. The main checkout (no `.lane`) is
the allow-all `phase0` lane; a linked worktree with no `.lane` is rejected
(fail-safe). Files: `lanes.json`, `check_lane.py`, `pre-commit`, `install.sh`.

---

## 2 · Phase 0 — Foundations (orchestrator only, sequential, all in the forbidden zone)

Nothing parallel starts until these land. All edit forbidden-zone files, so only
the orchestrator (phase0) can do them.

- **0.1 — Build the migration runner.** `packages/ctrl/src/db/migrate.ts`:
  `user_version`-gated numbered-SQL applier, transactional, at boot. Author
  `0001_fix_pack.sql` (adds `observation.processed_at`, normalizes signal status
  default per **C2/C5**). *This is the thing v1 wrongly assumed existed.*
- **0.2 — Promotion-contract stance: RULED Fork A (enforce everywhere).** This
  becomes the foundational **PR-1**: ctrl enforces `assertCanonicalVaultPath` on
  ALL write routes + reconciles `KNOWN_TYPES`; learn reroutes every demoted-type
  write to `state.db`/audit. It sits on the migration runner (0.1) and the C1/C2/C6
  contracts. Each individual reroute is still a ≤200-LOC, failing-test-first task.
- **0.3 — Freeze contracts** (`FIX-CONTRACTS.md`, C1–C11). Done (revise on 0.2).
- **0.4 — The gate** (`scripts/hooks/*`). Done + proven.
- **0.5 — Write the lane briefs** from the cards below + the template.

---

## 3 · The five lanes

Package-scoped so glob territories never overlap → merges are conflict-free by
construction. **At most one agent per lane at a time** (lanes parallel; tasks
within a lane serial) so there's no intra-package collision either. Cross-package
bugs split into per-lane tasks against the frozen contracts. Each task ≤ ~200 LOC.

### Lane card — I · ctrl-api
- **Territory / ALLOWED:** `packages/ctrl/**`
- **FORBIDDEN:** `packages/ctrl/src/db/schema.sql`, `…/db/migrations/**`, `…/db/migrate.ts`, `…/api/server.ts`, `**/CONTRACT.md`, the FIX-*/FAILURE docs, `scripts/hooks/**` (+ all other packages)
- **VERIFY:** `cd packages/ctrl && npm run build`
- **CONTRACT:** `packages/ctrl/CONTRACT.md` + `FIX-CONTRACTS.md` C1,C2,C3,C4,C7,C8,C10
- **Bugs:** observation-count endpoint (C1) · mark-processed endpoint (C1) · signal status default (C2) · `/openclaw/*` alias restore (C7) · `notify_principal` channel resolve (C8) · briefing schedule input dict→slot (C10) · audit-201-on-failure · auth fail-open · unguarded boot · single-writer lock on POST raw-content · ingest-mirror swallow · ingest TTL · Desk endpoints no-dual-write (C4) · decisions reverse endpoint (C4) · restart-waits-for-running · `KNOWN_TYPES` sync *(HELD on 0.2)* · briefings filename regex · timestamp string-compare filters · embedding rowid reuse · cold-tier `total` double-count + FK-SET-NULL · CORS/timing

### Lane card — II · learn
- **ALLOWED:** `packages/learn/**`
- **VERIFY:** `cd packages/learn && python -m pytest -q` *(task briefs scope to the relevant test file for speed; full suite at PR gate)*
- **CONTRACT:** `packages/learn/CONTRACT.md` + `FIX-CONTRACTS.md` C1,C2,C3,C6,C9,C10
- **Bugs:** mark-processed client + instinct_ref verify (C1) · pass status=unrouted (C2) · source_type drop + don't-mark-processed (C6) · gmail account pin (C3) · composio_execute raise · flags default-on · defer resurface-parse · BriefingWorkflow slot signature (C10) · brief write swallow · first-brief email surfacing · brief zero-signal vacuity · brief UTC→tenant-tz · chore name-collision dedup *(highest blast radius)* · chore generated-code gate/quarantine · chore schedule-before-register · restart_learn_worker false-ok · seed cursor ties · chore module dedup · profile-key mismatch · personalize hard-raise · re-onboard grep-dedup · onboard.json atomic write · personalize JSON parser · clerk 60s-vs-900s heartbeat · clerk retry-class · dispatch-lock storm · `_extract_json` salvage

### Lane card — III · web
- **ALLOWED:** `packages/web/**`
- **VERIFY:** `cd packages/web && npx tsc --noEmit` *(or `wasp build` at PR gate)*
- **CONTRACT:** `FIX-CONTRACTS.md` C4
- **Bugs:** **server-side ownership enforcement** *(security headline)* · OAuth refresh-token drop · `getOnboardingProgress` not_started-on-error · dead `instance.*` · ~11 error-swallowing list queries · Household RULES "A moment." stuck · matter back-link · Desk optimistic-UI reconcile (C4) · Done/approval client (C4) · Undo wiring (C4) · `/soul` write (don't clobber personalized SOUL.md) · BriefPage/DeskPage error branch · composio enable-tool UI copy

### Lane card — IV · alfred-vault (workers)
- **ALLOWED:** `packages/alfred-vault/**`
- **VERIFY:** `cd packages/alfred-vault && python -m pytest -q`
- **CONTRACT:** `packages/alfred-vault/CONTRACT.md`
- **Bugs:** distiller can't write principal `decision/` *(namespacing)* · surveyor `matter` type reconcile · surveyor Ollama-down health-gate · worker 5-restart-drop surface · in-process scope enforcement *(R2; partial)*

### Lane card — V · edges & infra (hermes / mcp / deploy)
- **ALLOWED:** `packages/hermes/**`, `packages/mcp-server/**`, `packages/vault-init/**`, `scripts/**`, `caddy/**`, `docker-compose.yaml`, `.env.example`, `Makefile`, `docs/**`
- **FORBIDDEN (within ALLOWED):** `scripts/hooks/**`, the FIX-*/FAILURE docs, `**/CONTRACT.md`
- **VERIFY:** `docker compose config -q` *(task briefs override: `shellcheck scripts/bootstrap.sh`, `cd packages/mcp-server && npx tsc --noEmit`)*
- **CONTRACT:** `FIX-CONTRACTS.md` C7,C8,C9
- **Bugs:** `OWNER_EMAIL` env name (C9) · bootstrap whitespace-not-caught · AgentMail vars · mem_limit vs min-spec · `:latest` pinning · Caddy ACME / temporal start-dev · MCP `/openclaw/*` paths *(or rely on C7 alias)* · MCP `create_vault_record`/`list_vault_by_type` advertised-vs-real types · openclaw-wrapper premature-truncation · workers-gateway healthcheck · learn-clerk session reset + model pinning · model-PATCH restart bounces both / init re-render clobber

---

## 4 · The agent brief template

Every lane task is dispatched with exactly this brief:

```
LANE:        <I · II · III · IV · V>
GOAL:        <one sentence — what gets shipped>
ALLOWED:     <glob list — paste from the Lane card>
FORBIDDEN:   <glob list — paste from the Lane card + the Forbidden Zone>
VERIFY:      <test command that must pass before you commit>
CONTRACT:    <link to the package CONTRACT.md + the relevant FIX-CONTRACTS.md clause if API surface is affected>
SCOPE LIMIT: ~200 LOC. If the goal needs more, STOP and report.
WHEN DONE:   Write a 3-line PR description. Do not start another task.
```

Plus the standing preamble injected into every lane agent:
> First action: write `.lane` = `{"lane":"<LANE>","verify":"<VERIFY>"}` at the
> worktree root. Read `FIX-CONTRACTS.md` and your package `CONTRACT.md`. Touch
> ONLY your ALLOWED globs. Code against the frozen contracts — if one is wrong,
> STOP and report; do not edit across the boundary. The commit gate enforces all
> of this; a blocked commit means re-scope, not override.

**Filled example (Lane II, the autonomy root-cause):**
```
LANE:        II
GOAL:        Mark observations processed in state.db (not the vault) so Reflection stops re-feeding the same set nightly.
ALLOWED:     packages/learn/**
FORBIDDEN:   packages/{ctrl,web,alfred-vault,hermes,mcp-server}/**, scripts/hooks/**, **/CONTRACT.md, docs/FIX-*.md
VERIFY:      cd packages/learn && python -m pytest tests/test_reflection.py tests/test_observations.py -q
CONTRACT:    packages/learn/CONTRACT.md + FIX-CONTRACTS.md C1
SCOPE LIMIT: ~200 LOC. If the goal needs more, STOP and report.
WHEN DONE:   Write a 3-line PR description. Do not start another task.
```

---

## 5 · Parallelism & PR sequencing

5 lanes run concurrently; within each lane, tasks are serial (one worktree per
lane). Tasks group into logical PRs that respect the CLAUDE.md one-change-per-PR /
build-then-smoke rule. Merge order = providers before consumers:

| PR | Lanes (tasks) | Logical change | Acceptance smoke |
|---|---|---|---|
| **PR-0** | phase0 | migration runner + `0001` | ctrl-api boots, `user_version=1`, `processed_at` exists |
| **PR-1** | I + II | observation cutover → autonomy unfreezes | a decision increments `/instinct-counts`; an instinct leaves "Asking"; Reflection marks processed |
| **PR-2** | I + II + V | brief + chores actually run | daily brief writes a record (slot fix); a generated chore can't crash-loop the worker; chore can't send mail unattended |
| **PR-3** | I + III | Desk + auth honest | one server call per action; failed action returns the card; **2nd registrant is forbidden** |
| **PR-4** | I + II | signal pipeline can't silently zero | flags on; real email → signal `unrouted` → routed → card; gmail pull pinned |
| **PR-5** | IV | workers safe + observable | distiller can't write `decision/`; surveyor degrades loudly when Ollama down |
| **PR-6** | V | first-boot correct | `OWNER_EMAIL` set; bootstrap rejects blank secrets; mem fits min-spec |

Each PR: full cross-package build → deploy to the verify VM → run the smoke →
*then* the next PR.

---

## 6 · Risks & open items

- **C11 RULED Fork A** (enforce everywhere) → PR-1 is the foundational storage
  cutover; the largest single ripple. De-risked by failing-test-first per reroute.
- **Repo target RULED: `alfred-merged` working clone** → all lane worktrees branch
  from `/Users/ssd/dev/alfred-merged`; merge to `ssdavidai/alfred` via PRs once a
  PR's smoke passes. Install the gate there (`bash scripts/hooks/install.sh`).
- **Sidecar/Vexa sweep folded in** (FAILURE-MODES Part 4): the new bugs slot into
  existing lanes — Sure/Plane ctrl glue + cold-archive → Lane I; `plane_*.py`/
  `transcript.py` → Lane II; `OWNER_EMAIL`/compose/Vexa-hardening → Lane V. No new
  lane needed. Vexa + Sure are each dead OOTB (independent S1s) — candidates for
  their own PRs after the core planes are sound.
- **VERIFY cost.** Full `pytest` per commit is slow; briefs scope it to the
  task's tests, with the full suite at the PR gate (and optionally a `pre-push`
  full run). Lane III `tsc`/`wasp build` paths need finalizing against the tree in
  0.5.
- **Temporal replay safety** (PR-1/2/4 touch workflow-adjacent code): use
  `workflow.patched()`; never remove a registered activity in the deploy that
  stops scheduling it.
- **A "disjoint" file turns out shared** → it moves to the forbidden zone (Phase-0
  owned) and the lanes consume it. The gate makes a violation impossible to commit
  silently, so this surfaces immediately rather than as a tangled merge.
