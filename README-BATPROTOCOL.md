# README: BAT Protocol

BAT Protocol is Alfred's deterministic governance layer for agent operations.
It exists to enforce one invariant: no agent decides its own risk.

This README is the practical entry point. It summarizes why BAT exists, what is implemented now, and what is still planned.
For canonical specification and phase details, use:

- `docs/bat-protocol/CANONICAL_DESIGN.md`
- `docs/bat-protocol/PROJECT_PLAN.md`
- `SECURITY_ELEVATION.md`

## Conception

Alfred workers can mutate files, execute commands, access secrets, and trigger network activity. Without an explicit governance plane, those actions are hard to audit and easy to abuse.

BAT introduces a proposal-first execution model:

1. Agent proposes an operation.
2. BAT classifies risk deterministically.
3. BAT enforces policy.
4. BAT records the decision in an integrity-protected ledger.

## Development (Current State)

### Core governance runtime

Implemented components in `src/alfred/bat`:

- `OperationProposal` contract and deterministic risk classification (`risk.py`, `proposal.py`)
- Policy-driven enforcement decisions (`enforcement.py`)
- HMAC-signed append-only governance ledger (`ledger.py`)
- Interceptor path with fail-closed behavior (`interceptor.py`)
- Public BAT package exports at `alfred.bat` (`__init__.py`)

### Security elevation track (implemented in current branch)

Track B: Identity, Delegation, Policy Integrity

- Agent identity verification modes (`personal`, `secure`, `enterprise`)
- Delegation manager with capability intersection and chain depth controls
- Policy integrity guard with immutable root checks and startup readiness gate

Track C: Semantic state governance (ZVEC)

- Vector artifact store and artifact verification
- Drift detection signals
- Upgrade begin/commit/rollback lifecycle

Track D: Resource and deserialization safety

- Profiled resource limits (`personal`, `secure`, `enterprise`)
- Per-agent rate limiting and metadata validation
- Queue depth and ledger rotation utilities
- Safe YAML/JSON helpers and unsafe code-path checks

### Operator CLI

Implemented BAT commands:

- `bat status`
- `bat audit`
- `bat test-policy`
- `bat verify-ledger`
- `bat explain`

## Life Beyond (Roadmap)

Roadmap phases are documented and status-labeled in `docs/bat-protocol/PROJECT_PLAN.md`:

- Phase 1 Foundation: baseline governance runtime
- Phase 2 Hardening: production hardening features
- Phase 3 Universality: cross-framework and wire-format portability
- Phase 4 Enterprise: organization-grade policy and compliance controls

Treat these phase descriptions as planned work unless the code path is verified in this branch.

## Quick Start for Developers

From repo root:

```bash
pytest tests/bat -q
```

Smoke-check BAT CLI behavior via tests in `tests/bat/test_cli.py`.

Use module-level tests for security elevation coverage:

- `tests/bat/test_security_elevation.py`
- `tests/bat/test_interceptor_feedback.py`
- `tests/bat/test_path_security.py`

## Documentation Map (Recommended Next Guides)

To frame complete BAT documentation for parallel teams, create these companion docs under `docs/bat-protocol/`:

1. `OPERATOR_RUNBOOK.md`
2. `POLICY_AUTHORING_GUIDE.md`
3. `INTEGRATION_ADAPTER_GUIDE.md`
4. `THREAT_MODEL_AND_ASSUMPTIONS.md`
5. `KEY_MANAGEMENT_AND_ROTATION.md`
6. `INCIDENT_RESPONSE_AND_BREAK_GLASS.md`

## Claim Map

| Claim                                                                                          | Status      | Source                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BAT package version is `1.5.0`                                                                 | implemented | `src/alfred/bat/__init__.py:65`                                                                                                                                                                                                                            |
| Identity registry supports `personal`, `secure`, and `enterprise` modes                        | implemented | `src/alfred/bat/identity.py:26`, `src/alfred/bat/identity.py:196`                                                                                                                                                                                          |
| Delegation manager enforces bounded chain depth                                                | implemented | `src/alfred/bat/delegation.py:244`, `src/alfred/bat/delegation.py:255`                                                                                                                                                                                     |
| Policy integrity guard and startup gate exist                                                  | implemented | `src/alfred/bat/policy_integrity.py:231`, `src/alfred/bat/policy_integrity.py:471`                                                                                                                                                                         |
| Immutable governance roots include policy/rules/ledger/secrets/vectors paths                   | implemented | `src/alfred/bat/policy_integrity.py:243`, `src/alfred/bat/policy_integrity.py:245`, `src/alfred/bat/policy_integrity.py:250`, `src/alfred/bat/policy_integrity.py:255`, `src/alfred/bat/policy_integrity.py:260`, `src/alfred/bat/policy_integrity.py:265` |
| Vector governance store and factory are present                                                | implemented | `src/alfred/bat/zvec.py:310`, `src/alfred/bat/zvec.py:701`                                                                                                                                                                                                 |
| Vector store supports drift detection and upgrade lifecycle methods                            | implemented | `src/alfred/bat/zvec.py:560`, `src/alfred/bat/zvec.py:601`, `src/alfred/bat/zvec.py:633`, `src/alfred/bat/zvec.py:654`                                                                                                                                     |
| Resource governor, limits, rate limiting, and safe deserializers are implemented               | implemented | `src/alfred/bat/resource_governor.py:40`, `src/alfred/bat/resource_governor.py:102`, `src/alfred/bat/resource_governor.py:337`, `src/alfred/bat/resource_governor.py:424`                                                                                  |
| Interceptor provides opaque deny feedback and an execute scaffold with invariant check support | implemented | `src/alfred/bat/interceptor.py:46`, `src/alfred/bat/interceptor.py:197`                                                                                                                                                                                    |
| Opaque deny feedback and execute scaffold are covered by tests                                 | implemented | `tests/bat/test_interceptor_feedback.py:6`, `tests/bat/test_interceptor_feedback.py:29`, `tests/bat/test_interceptor_feedback.py:46`                                                                                                                       |
| Path hardening rejects symlink components when symlinks are disallowed                         | implemented | `src/alfred/bat/path_security.py:158`, `tests/bat/test_path_security.py:8`                                                                                                                                                                                 |
| BAT CLI exposes status/audit/test-policy/verify-ledger/explain commands                        | implemented | `src/alfred/bat/cli.py:38`, `src/alfred/bat/cli.py:126`, `src/alfred/bat/cli.py:202`, `src/alfred/bat/cli.py:279`, `src/alfred/bat/cli.py:329`                                                                                                             |
| Hardening, universality, and enterprise phases are still roadmap items                         | planned     | `docs/bat-protocol/PROJECT_PLAN.md:74`, `docs/bat-protocol/PROJECT_PLAN.md:103`, `docs/bat-protocol/PROJECT_PLAN.md:132`                                                                                                                                   |

## Scope Notes

- This README does not replace canonical architecture docs; it is an implementation-aware guide for contributors.
- When docs and code diverge, runtime tests and source code take precedence.
