# Onboarding Vault-Write Generator Inventory

> Read-only audit, Phase 0 / Lane II. Maps every vault-write path reachable
> from `workflows/onboarding_pipeline.py` and labels each as KEEP, GATE,
> KILL, or LOG against the promotion contract in the top-level `CLAUDE.md`
> ("vault is the principal's surface — bookkeeping lives in SQLite").
>
> Fixture this is grounded against:
> `packages/learn/tests/fixtures/onboarding_golden/` — the full
> `2026-05-23` fresh-onboarding run on test.alfred.black (5000 emails,
> 206 facts, 22 patterns).

## Pipeline Stages → Activities

`workflows/onboarding_pipeline.py:STAGE_ORDER`:

```
metadata → profiler → facts → patterns → personalize → awaiting_verification →
brief → packs → chores → done
```

Each stage runs one or more activities. Below is every activity that
writes to the vault during onboarding, traced from the workflow.

---

## 1 · `extract_facts_opus` (stage `facts`)

- **Source:** `src/activities/onboarding_v3.py:501`
- **Consumes:** Opus prompt over the 5000-email metadata.
- **Writes:** *No vault writes.* Persists `onboard["facts"]` only.
- **Verdict:** **KEEP.** Pure observation — the input every downstream
  generator needs.
- **Evidence:** `onboard/onboard.json:facts` has 206 entries — the
  Kondorosi purchase, NeoTerra engagement, Eszter, debts, etc.

## 2 · `discover_patterns_opus` (stage `patterns`)

- **Source:** `src/activities/onboarding_v3.py:615`
- **Consumes:** Opus over `facts` + profiler stats.
- **Writes:** *No vault writes.* Persists `onboard["patterns"]`.
- **Verdict:** **KEEP.** Same shape as facts.
- **Evidence:** `onboard/onboard.json:patterns` has 22 patterns — "Real
  Estate Over SaaS", "Debt Triage Under Stress", etc.

## 3 · `personalize_opus` (stage `personalize`)

- **Source:** `src/activities/onboarding_v3.py:721`
- **Consumes:** facts + patterns.
- **Writes:** `vault/USER.md` (and `SOUL.md`, `MEMORY.md`, `TOOLS.md` per
  the docstring contract — but in this fixture only `USER.md` exists).
- **Verdict:** **GATE.** The contract promises four files, the fixture
  has one. **Gap to close in Phase 2:** verify `SOUL.md` and `RULES.md`
  are written; the golden test
  `test_principal_rules_md_exists` /
  `test_principal_soul_md_exists` fails for exactly this reason.
- **Promotion-contract status:** OK — these are the singletons explicitly
  named in `CLAUDE.md` ("plus the `SOUL.md` / `RULES.md` singletons").

## 4 · `write_brief_and_opportunities_opus` (stage `brief`)

- **Source:** `src/activities/onboarding_v3.py:1113`
  (fallback: `write_brief_opus` at `:852`)
- **Consumes:** facts + patterns + key_identity_facts + corrections.
- **Writes:** `vault/briefing/First Brief.md` (canonical type — write
  goes through ctrl-api `POST /api/v1/vault/records`, line ~1290).
- **Verdict:** **KEEP.** Briefing is one of the 12 canonical types and
  this is the marquee onboarding output.
- **Evidence:** `vault/briefing/First Brief.md` exists in the fixture.

## 5 · `generate_matter_pack_opus` (stage `packs`)

- **Source:** `src/activities/packs_opus.py:439` (writes at `:541`)
- **Consumes:** facts + patterns + profile.
- **Writes:** rich `matter/<slug>.md` with `## Context`, `key_people`,
  `related_patterns`, `## Open questions`.
- **Verdict:** **KEEP — GOLD.** This is the real Kondorosi-class matter
  generator. ~4 KB per record, principal-readable.
- **Evidence:** 9 matters in the fixture — kondorosi-t-property-purchase,
  neoterra-consulting-engagement, founder-transition-kft-setup-and-compliance,
  legacy-debts-uk-and-hungarian, childcare-and-nanny-search,
  trkblint-home-projects, alfred-black-platform, subscription-and-billing-recovery,
  lumberjack-and-screenless-dad-content.
- **Promotion-contract status:** OK.

## 6 · `generate_matter_pack` — *fallback* (stage `packs`)

- **Source:** `src/activities/packs.py:338` (writes at `:459`)
- **Consumes:** profile `sender_tiers` only.
- **Writes:** stub `matter/<domain>-project.md` named "Github Project",
  "Stripe Project", "Zoom Project", … — body is
  `Auto-generated from onboarding email analysis.` (~250 bytes).
- **Verdict:** **KILL.** This is the source of all 8 junk matters in the
  fixture. It runs whenever the Opus path 402s or fails — and #B7 / B9
  audit shows it has been firing on most runs. The fallback writes
  domain stubs that violate the promotion contract ("the principal
  reads this") and pollutes the matter namespace.
- **Evidence (8 junk records):** `matter/444-project.md`,
  `matter/digitalocean-project.md`, `matter/github-project.md`,
  `matter/google-project.md`, `matter/stripe-project.md`,
  `matter/substack-project.md`, `matter/szabostuban-project.md`,
  `matter/zoom-project.md`.
- **Promotion-contract status:** VIOLATES. A domain stub is machine
  bookkeeping (top sender), not principal-readable knowledge — belongs
  in `alfred-state.db.observation` or similar.
- **Phase recommendation:** delete the fallback **OR** gate it behind a
  schema check (≥ 400 chars of body, no autogenerated `<domain> Project`
  name, ≥ 1 related person).

## 7 · `generate_instinct_pack_opus` (stage `packs`)

- **Source:** `src/activities/packs_opus.py:1976` (writes at `:2071`)
- **Consumes:** facts + patterns + profile + matters.
- **Writes:** rich `instinct/<slug>.md` with `confidence_score`,
  `input_patterns`, `routing_rule`, `execution`.
- **Verdict:** **GATE.** Records look good (real domain extraction, named
  rules) — but every instinct comes out with
  `confidence_score ∈ [0.86, 0.94]` and `observation_count = 0`. The
  discretion gate in `src/matching/discretion.py` treats 0 observations
  as "Asking" tier, but the LLM-stamped confidence isn't grounded in
  observed decisions. **Phase 3 needs:** either drop `confidence_score`
  from the LLM output (start at 0 and earn it) or rename it
  `prior_confidence` so the discretion gate ignores it.
- **Evidence (8 of 13 instincts at confidence ≥ 0.86, obs=0):**
  `escalate-payment-failures` (0.94), `route-newsletters-to-digest`
  (0.92), `compress-github-ci-noise` (0.91),
  `surface-debt-settlement-offers` (0.9), `escalate-government-legal`
  (0.89), `guard-family-health-signals` (0.89),
  `flag-infrastructure-alerts` (0.88), `elevate-neoterra-client` (0.87).
- **Promotion-contract status:** OK (instinct is canonical).
  Risk is that the *value* of `confidence_score` is unearned, which lets
  an instinct skip the Asking tier on day one.

## 8 · `generate_instinct_pack` — *fallback* (stage `packs`)

- **Source:** `src/activities/packs.py:472` (writes at `:529, 566, 603,
  641, 693`)
- **Consumes:** sender_tiers + payment_issues.
- **Writes:** 4 canned instincts (`route-noise-to-log`,
  `route-newsletters-to-log`, `route-inner-circle-priority`,
  `route-payment-failures-urgent`) plus per-domain `route-<tier>-<domain>`
  stubs up to a cap of 10.
- **Verdict:** **KEEP.** The 4 canned instincts ARE legitimate routing
  rules and the docstring explicitly notes they no longer seed a fake
  discretion_threshold — they start at Asking with `observation_count=0`.
  The per-domain stubs (`route-<tier>-<domain>`) are weaker — only
  trigger when there are ≥ 3 senders/domain in non-covered tiers, but
  could still emit thin records. **GATE** the per-domain branch.
- **Evidence:** 4 of 13 instincts in the fixture come from this generator
  — `route-noise-to-log`, `route-newsletters-to-log`,
  `route-inner-circle-priority`, `route-payment-failures-urgent`.
  No per-domain stubs fired in this run (good).

## 9 · `generate_errand_pack_opus` (stage `packs`)

- **Source:** `src/activities/packs_opus.py:1478` (writes at `:1573`,
  type=`task`)
- **Consumes:** facts + patterns + profile.
- **Writes:** rich `task/<slug>.md`.
- **Verdict:** **KEEP.** Errand records are canonical tasks.
- **Evidence:** Not in the fixture's `vault/` subset (orchestrator didn't
  copy `task/`). Not verifiable here — confirm in a later phase.

## 10 · `generate_errand_pack` — *fallback*

- **Source:** `src/activities/packs.py:706` (writes at `:766`)
- **Consumes:** `profile.rhythm.detected_routines`.
- **Writes:** ≤ 5 `task/<routine>.md` records.
- **Verdict:** **GATE.** Routines from a profiler heuristic can produce
  generic tasks ("Check email Monday morning"). Same gate as matter
  fallback: require ≥ 1 fact citation or kill.
- **Evidence:** N/A (no `task/` in fixture).

## 11 · `generate_stream_pack` (stage `packs`)

- **Source:** `src/activities/packs.py:281`
- **Writes:** *No vault writes.* Persists onboard-side stream config
  proposals only.
- **Verdict:** **KEEP.**

## 12 · `materialize_matter_entities` (stage `packs`, post-pack)

- **Source:** `src/activities/packs_opus.py:961` (writes at `:843` via
  `_create_or_merge_entity`)
- **Consumes:** the just-written matter records' `related_persons` /
  `related_orgs` (Pass A) plus a one-shot Opus over `facts` for
  corpus-wide entity seeding (Pass B, behind `ONBOARDING_KG_SEED`).
- **Writes:** `person/<Name>.md` and `org/<Name>.md`.
- **Verdict:** **GATE — multiple failure modes:**
  1. **Pass A** copies the matter's `key_people` strings verbatim — when
     a matter wrote `key_people: [David Szabo-St]` (the comma in
     "Szabó-Stubán, Eszter" tripped a tokenizer upstream and yielded
     a truncated name), Pass A faithfully writes
     `person/David Szabo-St.md`. The fix is upstream (cleaner key_people
     tokenization in `_build_rich_matter_content`) plus a downstream
     defensive check (skip a person whose name is a prefix of another).
  2. **Pass B's LLM** produced `person/Github Notifications.md` —
     non-human, system-generated. The Pass B prompt
     (`_build_corpus_entity_prompt`, packs_opus.py:918) explicitly tells
     the LLM to skip non-human entities, but it slipped through. Needs a
     deterministic post-filter: reject any person name containing
     `Notifications?$`, `@`, or a domain substring.
  3. **org/github.com** — Pass B also wrote `org/github.com.md`, a
     domain-named org (not a real company). The prompt asks for proper
     names. Needs a regex filter against domain-like names.
- **Evidence:** all 23 persons + the 1 org came from this activity.
  Specifically the junk: `person/David Szabo-St.md` (Pass A,
  truncation), `person/Github Notifications.md` (Pass B,
  non-human), `org/github.com.md` (Pass B, domain).
- **Promotion-contract status:** OK on the canonical types; the *quality*
  of the entities is the violation.

## 13 · `assign_initial_chores` (stage `chores`)

- **Source:** `src/activities/assign_chores.py:1353`
- **Consumes:** profile + opportunities from `write_brief_and_opportunities_opus`.
- **Writes:** `chore/<slug>.md` (one per matched/generated template).
- **Verdict:** **KEEP.** Chores are canonical and the records in the
  fixture (`money-day`, `subscription-watchdog`) look correct —
  template + schedule + tags.
- **Evidence:** 2 chores, both well-formed with cron + template + tags.

## 14 · `chore_generation.generate_chore_template_code` *(side-channel)*

- **Source:** `src/activities/chore_generation.py:1051`
- **Writes:** Python *template* files to disk under
  `packages/learn/templates/` (not a vault write).
- **Verdict:** **KEEP** (out of vault scope).

## 15 · `send_first_brief_email` (stage `chores` epilogue)

- **Source:** `src/activities/first_brief_email.py`
- **Writes:** *No vault writes.* Sends transactional email.
- **Verdict:** **KEEP.**

## 16 · Notes — `note/*.md` *(external generator)*

- **Source:** *Not learn-side.* No `write_record("note", ...)` call is
  reachable from `onboarding_pipeline`. The 13 notes in the fixture come
  from the **alfred-vault curator daemon** processing
  `packages/learn/src/activities/batch_processor.py:process_stream_batch`'s
  inbox drops (`drop_to_inbox` at `:301`/`:309`). The curator wraps each
  inbox-batched email-cluster into a `note` record.
- **Verdict:** **KILL or ROUTE-TO-LOG (cross-lane / external).**
  These notes are pure machine bookkeeping ("GitHub Activity Summary",
  "GitHub Notification Summary", "GitHub Notifications and Service
  Emails Summary", "GitHub Service & Notification Summary" — 4 near
  duplicates) — they violate the promotion contract twice over:
  (a) the principal has no reason to read "Mailgun Service Emails
  Summary"; (b) they near-duplicate each other.
  **Phase recommendation:** these belong as observation rows in
  `alfred-state.db.observation` (per `CLAUDE.md` §promotion contract).
  Fixing this lives in Lane IV (alfred-vault) or in a Lane V curator
  patch — Lane II tests still assert the absence.
- **Evidence:** 13 notes, all matching `^[A-Za-z0-9.]+ (Service Emails|
  Email Digest|Activity|Notification(s)? Summary|Service & Notification
  Summary)`. 4 GitHub near-duplicates.

## 17 · Desk seeds *(missing)*

- **Source:** *Nothing.* The onboarding pipeline does **not** seed any
  Desk decision cards.
- **Verdict:** **GAP — must add (later phase).** The Desk lands empty on
  day one — there's no "verify your address", "confirm Eszter is your
  spouse", "approve the inner-circle list" card. The principal sees a
  brief and an empty Desk.
- **Evidence:** no `needs_attention/*.md` records in the fixture.
- **Phase recommendation:** add a Phase-4 activity that seeds 2-3
  identity-verification + sample-instinct-confirmation cards as part of
  the `done` stage — gives the principal an immediate action surface on
  the redesigned Desk.

---

## Direct-OpenRouter callers (Hermes bypass check)

`grep -rn 'openrouter\\|OPENROUTER\\|api\\.openai\\|api\\.anthropic\\.com'
src/`:

| File:Line | What | Status |
|-----------|------|--------|
| `src/activities/onboarding_v3.py:48` | Comment explaining the #118 migration off OpenRouter onto Hermes | **NOT a bypass** — historical doc only |
| `src/profiler/transaction_clustering.py:139` | Regex `\\bopenrouter\\b` to classify a "OpenRouter, Inc" receipt as a Subscription | **NOT a bypass** — text-matching a merchant |

**Conclusion:** zero direct-OpenRouter (or direct-Anthropic / direct-OpenAI)
callers remain in `packages/learn/src/`. Every LLM call routes through
`_call_clerk` (`src/activities/clerk.py`, main/workers Hermes profiles)
or `_call_llm` (`src/activities/onboarding_v3.py:39`, heavy Hermes
profile :18791). Lane-II is Hermes-clean.

---

## Summary table

| # | Generator | File | Writes | Verdict | Next-phase action |
|---|-----------|------|--------|---------|------------------|
| 1 | `extract_facts_opus` | `onboarding_v3.py:501` | `onboard.facts` | KEEP | none |
| 2 | `discover_patterns_opus` | `onboarding_v3.py:615` | `onboard.patterns` | KEEP | none |
| 3 | `personalize_opus` | `onboarding_v3.py:721` | `USER.md` (+ SOUL/RULES?) | **GATE** | Phase 2: verify SOUL.md & RULES.md are persisted |
| 4 | `write_brief_and_opportunities_opus` | `onboarding_v3.py:1113` | `briefing/First Brief.md` | KEEP | none |
| 5 | `generate_matter_pack_opus` | `packs_opus.py:439` | rich `matter/*.md` | **KEEP — GOLD** | none — protect this path |
| 6 | `generate_matter_pack` (fallback) | `packs.py:338` | stub `matter/<domain>-project.md` | **KILL** | Phase 1: delete fallback OR gate with quality check |
| 7 | `generate_instinct_pack_opus` | `packs_opus.py:1976` | rich `instinct/*.md` | **GATE** | Phase 3: drop or rename `confidence_score` so day-zero instincts start at Asking |
| 8 | `generate_instinct_pack` (fallback) | `packs.py:472` | 4 canned + per-domain `instinct/*.md` | KEEP (canned), GATE (per-domain) | Phase 3: skip per-domain branch unless ≥ N obs |
| 9 | `generate_errand_pack_opus` | `packs_opus.py:1478` | rich `task/*.md` | KEEP | Phase 5: verify (not in fixture) |
| 10 | `generate_errand_pack` (fallback) | `packs.py:706` | thin `task/*.md` | **GATE** | Phase 5: require fact-grounded body |
| 11 | `generate_stream_pack` | `packs.py:281` | (none) | KEEP | none |
| 12 | `materialize_matter_entities` | `packs_opus.py:961` | `person/*.md`, `org/*.md` | **GATE** | Phase 2: post-filter persons (no `@`, no domain, no `Notifications` suffix, ≥ 2 capitalized tokens); orgs (no domain-only names); dedup truncated-prefix persons |
| 13 | `assign_initial_chores` | `assign_chores.py:1353` | `chore/*.md` | KEEP | none |
| 14 | `generate_chore_template_code` | `chore_generation.py:1051` | template `.py` (not vault) | KEEP | none |
| 15 | `send_first_brief_email` | `first_brief_email.py` | (email, not vault) | KEEP | none |
| 16 | *external* note curator | `batch_processor.py:301` → alfred-vault | `note/*.md` | **KILL / LOG** (cross-lane) | Phase 6 (Lane IV/V): route these inbox-cluster summaries to `alfred-state.db.observation` instead of vault notes |
| 17 | *missing* Desk seeder | n/a | nothing | **GAP — ADD** | Phase 4: seed 2-3 onboarding-verification Desk cards in the `done` stage |

Every "GATE", "KILL", and "GAP" row above has a corresponding strict
assertion in `tests/test_onboarding_quality_golden.py`.

