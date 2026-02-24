# Bat Protocol Security Elevation Plan

**Date:** 2026-02-24  
**Audience:** Core governance, platform, agent-runtime, and semantic-layer maintainers  
**Purpose:** Security elevation blueprint for parallel execution across remaining development phases

## 1. Executive Intent

Bat Protocol is already strong on deterministic risk classification and auditability. The remaining security risk is architectural: ungoverned semantic state, execution-path bypasses, identity spoofing, policy tampering, TOCTOU, and multi-process blind spots.  

This document defines the required controls, implementation sequencing, and acceptance gates to close those gaps without introducing non-deterministic behavior.

## 2. Security Elevation Objectives

1. Make semantic artifacts (embeddings/indexes/drift) first-class governed state.
2. Ensure governance is not advisory: prevent check-then-bypass execution paths.
3. Authenticate agent identity and provenance for every proposal.
4. Protect governance assets (policy, ledger, secrets, vector store) from runtime mutation.
5. Bound resource use and deserialization risk to maintain fail-closed behavior under stress.
6. Preserve deterministic governance decisions; isolate probabilistic/statistical work to observability inputs.

## 3. Non-Negotiable Invariants

1. No agent decides its own risk.
2. No agent authenticates its own identity.
3. No governance decision depends on LLM output.
4. Failure defaults to deny.
5. Delegation does not elevate privilege.
6. Governance initializes before agency.
7. Policy integrity is verified before policy is used.
8. Classification feedback does not leak policy boundaries in enforce mode.
9. Ledger is governed confidential state.
10. Key material is separated by function and principal.
11. Unknown operations default to L3.
12. Deserialization is always safe.
13. Governance resource consumption is bounded.

## 4. Parallel Workstreams

### Track A: Core Governance Runtime Hardening
- Atomic execution handover (`bat.execute(proposal)`); remove check-then-act model.
- TOCTOU guard: execution-time invariant revalidation (path, symlink, command hash).
- Startup gate: agents blocked until governance readiness + policy integrity pass.
- Generic enforcement feedback to agents (`E_DENIED`), full rationale only in audit channel.
- Deterministic content sanitization for text artifacts before hashing/execution.

### Track B: Identity, Delegation, and Policy Integrity
- Authenticated proposals (Ed25519 in secure/enterprise mode; process attestation in personal mode).
- Credential lifecycle: issuance, rotation, revocation, emergency disable.
- Delegation provenance chain and “capability intersection” enforcement.
- Signed policy manifest verification at startup and every hot reload.
- Immutable root assets hard-blocked pre-classification:
  - `bat.yaml`, bat rule files, ledger path, secret store, governed vector store.

### Track C: Semantic State Governance (ZVEC)
- Vector taxonomy extension and schema-enforced `VectorArtifact` provenance envelope.
- Write-time vector hash verification mandatory.
- Read-time verification strategy configurable (`on_access`, `background_sweep`, `sampling`) with deterministic escalation on mismatch.
- Model upgrade protocol with lock/shadow recompute/approval gate/commit-or-rollback.
- Index mutation envelopes with pre/post index hash and proposal linkage.
- Drift signal split:
  - Observability: centroid/distribution/outlier metrics.
  - Governance triggers: collapse, rapid churn, dissolution.

### Track D: Platform and Operational Security
- Resource controls: rate limits, metadata size caps, queue depth caps, temporal window bounds, ledger rotation.
- Multi-instance consistency mode:
  - `in_process` (single-user)
  - `daemon` (shared governance state, single ledger writer).
- Ledger confidentiality:
  - filesystem permission enforcement (`0600` equivalent),
  - governed read/export operations,
  - optional encryption at rest.
- CI guardrails:
  - block unsafe YAML loaders,
  - block `pickle`,
  - block `eval/exec/compile` in governance-critical paths.

## 5. Phase Execution Map

## Phase 1 (Immediate Security Baseline)
- Atomic execute path + TOCTOU revalidation.
- Policy integrity guard (signed manifest) + immutable root protections.
- Startup ordering gate.
- Safe deserialization controls + CI checks.
- Resource caps/rate limits.
- Initial vector governance:
  - operation taxonomy,
  - artifact schema,
  - write-time integrity verification,
  - deterministic semantic delta classification with model-aware thresholds.
- Remediate current BAT runtime blockers:
  - broken `bat/cli.py` import paths,
  - signing-key parsing/type handling,
  - path-hardening symlink-escape behavior.

## Phase 2 (Secure Scale-Out)
- Authenticated proposal pipeline + key rotation/revocation.
- Delegation provenance and confused-deputy controls.
- Classification opacity modes (`opaque` default in enforce).
- Read-time vector verification strategies and staleness handling.
- Temporal + semantic compound rules.
- Governance daemon mode for multi-process consistency.
- Ledger access controls + rotation/encryption rollout.

## Phase 3 (Enterprise-Grade Semantic Assurance)
- Wire protocol extensions for vector governance events.
- Index rebuild governance with anomaly quarantine.
- Advanced drift governance triggers and richer anomaly analytics.
- Embedding plausibility/anomaly checks (documented limitations for covert-channel defense).
- OS-level sandbox integrations for untrusted agent execution.

## 6. Threat-to-Control Matrix (Condensed)

| Threat | Control | Phase |
|---|---|---|
| Agent identity spoofing | Signed proposals / process attestation | 2 |
| Governance bypass by direct syscalls | Atomic execute + sandbox strategy | 1/3 |
| Policy tampering | Signed policy manifest + immutable root | 1 |
| TOCTOU exploit | Execution-time invariant checks | 1 |
| Confused deputy | Delegation provenance + capability intersection | 2 |
| Initialization race | Governance readiness gate | 1 |
| Ledger intelligence leakage | Governed access + encryption/permissions | 2 |
| Semantic tampering | Vector write/read integrity checks | 1/2 |
| Silent model redefinition | Upgrade protocol + approval gate | 2 |
| Cross-process temporal blind spots | Governance daemon mode | 2 |
| Governance DoS | Rate/resource limits | 1 |
| Policy probing oracle | Opaque agent feedback in enforce mode | 2 |

## 7. Acceptance Gates (Must Pass)

### Gate G1: Determinism
- Same proposal + same config + same state always yields same decision.
- No network/LLM call in classification/enforcement path.

### Gate G2: Fail-Closed
- Ledger unavailable, policy unverifiable, or identity invalid => operation denied.
- Governance initialization failure prevents agent execution.

### Gate G3: Integrity
- Any vector hash mismatch escalates deterministically (L3/block policy path).
- Policy manifest mismatch blocks startup/reload.

### Gate G4: Confidentiality & Leakage Control
- Agent-facing denies do not include path/rule internals in enforce mode.
- Ledger read/export operations are governed and auditable.

### Gate G5: Concurrency Safety
- In daemon mode, one authoritative temporal stream and one serialized ledger writer.
- No hash-chain corruption under concurrent proposal load tests.

## 8. Test Strategy Requirements

1. Unit tests for each invariant and deny-by-default behavior.
2. Property tests for deterministic classifier outputs.
3. Adversarial tests:
   - identity forgery,
   - policy file mutation,
   - symlink TOCTOU swaps,
   - delegation privilege escalation,
   - vector tampering and stale-source scenarios.
4. Concurrency tests for daemon-mode governance and ledger append integrity.
5. Performance budget tests for governance-path p99 latency targets.

## 9. Governance of This Plan

- This plan is a living security control baseline.
- Any exception requires a documented risk acceptance entry with owner and expiry.
- Phase exit requires evidence artifacts: tests, benchmarks, and signed review notes.

## 10. Immediate Next Actions

1. Land Phase 1 guardrails before adding new capability surface.
2. Split delivery into the four tracks above and assign parallel owners.
3. Add “security elevation gate” as required check for all BAT/ZVEC PRs.

## 11. Claimed Parallel Lane (Codex)

**Owner:** Codex  
**Phase:** Phase 1 (Immediate Security Baseline)  
**Track Focus:** Track A + targeted Track D remediation

### Scope I Am Claiming

1. BAT runtime execution safety baseline
- Implement atomic governance execution handoff scaffolding (`execute` path) for file and command operations.
- Add TOCTOU revalidation hooks for path and command execution invariants.

2. BAT CLI/runtime correctness blockers (required before broader hardening)
- Fix broken module import paths in `src/alfred/bat/cli.py`.
- Fix signing-key parsing/type handling for ledger verification path.

3. Path hardening correction
- Close `allow_symlinks=False` escape gap in `src/alfred/bat/path_security.py`.
- Add regression tests for traversal/symlink edge cases.

4. Enforce-mode feedback hygiene
- Add agent-safe denial surface (opaque code/message) while keeping detailed audit rationale in ledger/log channel.

### Deliverables

1. Code changes in BAT runtime/CLI/path-security modules.
2. Tests covering:
- CLI smoke behavior for `status`/`verify-ledger`,
- signing-key parsing,
- symlink/TOCTOU edge cases.
3. Updated docs/changelog notes for new behavior and migration impacts.

### Out of Scope for This Lane

1. Full cryptographic agent identity pipeline (Phase 2).
2. Governance daemon multi-process architecture (Phase 2).
3. Full ZVEC upgrade protocol implementation (Phase 2/3).
