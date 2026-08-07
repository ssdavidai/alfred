// Vault record type tables — data, not route logic.
//
// Extracted from `routes/vault.ts` so the read allowlist can be imported
// without importing the route module. `routes/vault.ts` participates in an
// import cycle with `routes/admin.ts` (which evaluates `${VAULT_PATH}/chore`
// at module top level), so importing it outside the app's entry order throws
// `ReferenceError: Cannot access 'VAULT_PATH' before initialization`.
//
// That is what broke `tests/vault-known-types.test.ts` in CI: the test needs
// these tables, importing the route module to reach them was not viable, and
// the tables never belonged to the route in the first place.
//
// This module must stay import-free. Adding an import risks re-entering the
// cycle and reintroducing exactly the failure it exists to avoid.

export const KNOWN_TYPES = [
  "person", "org", "project", "task", "event", "note", "location",
  "process", "account", "asset", "conversation", "input", "run",
  "session", "decision", "triage",
  "assumption", "constraint", "contradiction", "synthesis",
  "observation", "instinct", "reflection",
  "matter", "ledger_entry",
  "chore",
  // Phase 6 signal-layer record types (RFC #842):
  //  - signal           : extracted from stream events; carries target +
  //                       effect + mutation/action proposal.
  //  - needs_attention  : Phase 6.4 — actions routed to Sir (low confidence
  //                       OR no matching instinct).
  //  - stream_event     : Phase 6.6 — unified replacement for event/ +
  //                       conversation/ once the migration script runs.
  //  - signal_noise_pattern : ARCH-12 — materialised when the principal
  //                       clicks Noise on /desk. signal_extract consults
  //                       these before the LLM call to filter
  //                       known-noise events at source. Missing this
  //                       allowlist entry meant both the writer and the
  //                       loader got 400 from /vault/list and /vault/records.
  //  - pattern_proposal  : OBS-3 — clustered proposals from the unified
  //                       observation pool (decisions + signals).
  //                       PatternDetectionWorkflow (OBS-4) writes
  //                       status=proposed; the principal accepts on /desk
  //                       and OBS-5's acceptor materialises an instinct.
  //                       Distinct from legacy decision_pattern/ which
  //                       extracts only from decisions.
  "signal", "needs_attention", "stream_event", "signal_noise_pattern",
  "pattern_proposal",
  // State-mutation contract (#889 spec §8.2):
  //  - briefing : morning + evening composer output. Frontmatter shape
  //               validated by alfred-learn (validators/briefing.py).
  //               ctrl-api just allowlists the type; the BriefingWorkflow
  //               writes through POST /api/v1/vault/records with the
  //               structured `content` body.
  "briefing",
  // Canonical types (db/promotionContract.ts CANONICAL_RECORD_TYPES) that were
  // missing from this read allowlist, so GET /vault/list/daybook and /place
  // 400'd valid records:
  //  - daybook : the principal's day-by-day journal entries.
  //  - place   : a location/venue record.
  // (Demoted legacy types above stay until the C11 contract-enforcement pass.)
  "daybook", "place",
  //  - commitment : a promise with an accountable party and an evidence
  //                 handle (#469/#470). Added to CANONICAL_RECORD_TYPES so
  //                 the WRITE path accepts commitment/, but missing here —
  //                 so GET /vault/list/commitment 400'd and every register
  //                 bootstrap failed. Third instance of this exact split;
  //                 the test in tests/vault-known-types.test.ts now makes a
  //                 fourth impossible.
  "commitment",
];

export const STATUS_BY_TYPE: Record<string, string[]> = {
  project: ["active", "paused", "completed", "abandoned", "proposed"],
  task: ["todo", "active", "blocked", "done", "cancelled"],
  session: ["active", "paused", "finished"],
  input: ["unprocessed", "processed", "deferred"],
  person: ["active", "inactive"],
  org: ["active", "inactive"],
  location: ["active", "inactive"],
  note: ["draft", "active", "review", "final"],
  decision: ["draft", "final", "superseded", "reversed"],
  process: ["active", "proposed", "design", "deprecated"],
  run: ["active", "completed", "blocked", "cancelled"],
  account: ["active", "suspended", "closed", "pending"],
  asset: ["active", "retired", "maintenance", "disposed"],
  conversation: ["active", "waiting", "resolved", "closed", "archived"],
  assumption: ["active", "challenged", "invalidated", "confirmed"],
  constraint: ["active", "expired", "waived", "superseded"],
  contradiction: ["unresolved", "resolved", "accepted"],
  synthesis: ["draft", "active", "superseded"],
  observation: ["unprocessed", "processed", "invalid"],
  instinct: ["active", "proposed", "deprecated", "merged"],
  matter: ["active", "resolved", "abandoned"],
  ledger_entry: ["active"],
  chore: ["active", "paused", "completed"],
  // commitment carries only the coarse four-value vocabulary here. The real
  // 11-state lifecycle lives in `commitment_state`, because `status` cannot
  // express `delivered_awaiting_acceptance` and forcing it would assert a
  // closure that has not happened. Mirrors alfred-vault's STATUS_BY_TYPE.
  commitment: ["todo", "active", "blocked", "done"],
  // pattern_proposal lifecycle (OBS-3..OBS-5):
  //  - proposed  : freshly written by PatternDetectionWorkflow,
  //                awaiting principal review on /desk
  //  - adopted   : principal clicked delegate; OBS-5 acceptor wrote
  //                the instinct (the loop closure step)
  //  - rejected  : principal clicked delete; the next detection run
  //                avoids re-proposing this rule
  //  - deferred  : principal clicked defer; will resurface later
  //  - superseded: replaced by a refined cluster in a later run
  // Status verbs match the existing decision_pattern flow so the
  // DecisionRouterWorkflow's pattern handler can stay uniform across
  // both legacy and OBS-era proposals.
  pattern_proposal: ["proposed", "adopted", "rejected", "deferred", "superseded"],
};
