# Bat Protocol: Project Plan

> **Document Status:** CANONICAL  
> **Version:** 1.0.0  
> **Created:** 2026-02-24  
> **Edit Policy:** APPEND ONLY — Do not modify existing content. Add new sections via amendments.

---

## Document Relationships

```
CANONICAL_DESIGN.md (Authoritative Specification)
        │
        ▼
PROJECT_PLAN.md (This Document — Implementation Roadmap)
        │
        ├──▶ phases/PHASE_1_FOUNDATION.md
        ├──▶ phases/PHASE_2_HARDENING.md
        ├──▶ phases/PHASE_3_UNIVERSALITY.md
        └──▶ phases/PHASE_4_ENTERPRISE.md
```

---

## Executive Summary

Bat Protocol will be implemented in four phases over approximately 12+ weeks. Each phase builds on the previous, with clear deliverables and test gates. The architecture is designed for incremental adoption—the system is useful after Phase 1 and becomes progressively more robust.

---

## Phase Overview

| Phase | Name         | Duration   | Primary Goal                                               |
| ----- | ------------ | ---------- | ---------------------------------------------------------- |
| 1     | Foundation   | Weeks 1-4  | Core governance layer with deterministic classification    |
| 2     | Hardening    | Weeks 5-8  | Production-ready security and failure handling             |
| 3     | Universality | Weeks 9-12 | Cross-framework and cross-language support                 |
| 4     | Enterprise   | Weeks 13+  | Advanced governance features for organizational deployment |

---

## Phase 1: Foundation (Weeks 1-4)

**Goal:** Implement the core governance layer with deterministic risk classification.

### Deliverables

| Deliverable                 | Description                             | Test Gate                   |
| --------------------------- | --------------------------------------- | --------------------------- |
| `OperationProposal` schema  | Python dataclass + JSON Schema          | Unit tests pass             |
| Risk engine                 | Composable predicate rules              | 100% coverage               |
| Default-deny classification | No matching rule → L3                   | Unit tests pass             |
| Enforcement engine          | Passive/enforce modes                   | Integration tests pass      |
| HMAC-signed ledger          | Append-only with integrity              | Tamper detection tests pass |
| `exec_command` wrapping     | L3 classification for shell commands    | Integration tests pass      |
| Secret backend interface    | Protocol + keyring implementation       | Unit tests pass             |
| Fail-closed error handling  | All failure modes documented and tested | Failure mode tests pass     |
| Policy testing framework    | Test harness for policy validation      | Self-testing                |
| Test coverage               | 100% on risk and enforcement engines    | Coverage report             |

### Success Criteria

- [ ] All operations flow through proposal abstraction
- [ ] Risk classification is deterministic and testable
- [ ] Ledger entries are cryptographically linked
- [ ] All failure modes result in L3 classification or blocked execution
- [ ] Policy can be tested independently of runtime

**Detailed Specification:** [`phases/PHASE_1_FOUNDATION.md`](phases/PHASE_1_FOUNDATION.md)

---

## Phase 2: Hardening (Weeks 5-8)

**Goal:** Production-ready security with comprehensive failure handling and operational tooling.

### Deliverables

| Deliverable               | Description                                  | Test Gate                     |
| ------------------------- | -------------------------------------------- | ----------------------------- |
| Risk rule DSL             | YAML-based declarative rules                 | Parser tests pass             |
| Path hardening            | Normalization, UNC/ADS blocking              | Security tests pass           |
| Temporal risk accumulator | Sliding window analysis                      | Sequence detection tests pass |
| Break-glass mechanism     | Emergency override with audit                | Authorization tests pass      |
| CLI introspection         | `bat status`, `bat audit`, `bat test-policy` | CLI tests pass                |
| Configurable profiles     | personal/secure/enterprise                   | Profile tests pass            |
| Agent manifest validation | Startup-time capability verification         | Validation tests pass         |
| Policy hot-reload         | Runtime policy updates with validation       | Hot-reload tests pass         |

### Success Criteria

- [ ] Policies are declarative and version-controllable
- [ ] Path traversal attacks are blocked on all platforms
- [ ] Compound attacks (safe operations in sequence) are detected
- [ ] Administrators can bypass governance in emergencies with full audit
- [ ] Operators can inspect and test governance without runtime

**Detailed Specification:** [`phases/PHASE_2_HARDENING.md`](phases/PHASE_2_HARDENING.md)

---

## Phase 3: Universality (Weeks 9-12)

**Goal:** Cross-framework and cross-language support for "any agent environment" claim.

### Deliverables

| Deliverable                 | Description                       | Test Gate                |
| --------------------------- | --------------------------------- | ------------------------ |
| Protocol buffer schema      | Language-agnostic wire format     | Schema validation passes |
| JSON Schema export          | Alternative wire format           | Validation passes        |
| Framework adapter interface | Protocol for wrapping frameworks  | Interface tests pass     |
| Reference adapter           | At least one external framework   | Integration tests pass   |
| Standalone package          | `bat-protocol` pip-installable    | Package tests pass       |
| Cross-language spec         | Language-agnostic documentation   | Review complete          |
| Ledger verification tool    | `bat verify-ledger`               | Verification tests pass  |
| Observability metrics       | OpenTelemetry/Prometheus emission | Metrics tests pass       |
| Policy composition docs     | Precedence and composition rules  | Documentation complete   |

### Success Criteria

- [ ] Non-Python systems can implement Bat Protocol
- [ ] At least one external framework is wrapped with governance
- [ ] Ledger integrity can be verified independently
- [ ] Governance is observable in production metrics

**Detailed Specification:** [`phases/PHASE_3_UNIVERSALITY.md`](phases/PHASE_3_UNIVERSALITY.md)

---

## Phase 4: Enterprise (Weeks 13+)

**Goal:** Advanced governance features for organizational deployment.

### Deliverables

| Deliverable                | Description                    | Test Gate                    |
| -------------------------- | ------------------------------ | ---------------------------- |
| Quorum approval workflow   | Multi-party authorization      | Workflow tests pass          |
| Policy signing             | Cryptographic policy integrity | Signature tests pass         |
| Policy immutability        | Tamper-evident policy storage  | Immutability tests pass      |
| Remote policy distribution | Central policy server          | Distribution tests pass      |
| Multi-node ledger sync     | Distributed audit trail        | Sync tests pass              |
| Compliance reports         | SOC 2 / ISO 27001 mapping      | Report generation tests pass |
| Compliance documentation   | Control mapping docs           | Review complete              |

### Success Criteria

- [ ] Organizations can require multiple approvers for high-risk operations
- [ ] Policies cannot be modified without detection
- [ ] Governance scales to multi-node deployments
- [ ] Compliance requirements are documented and reportable

**Detailed Specification:** [`phases/PHASE_4_ENTERPRISE.md`](phases/PHASE_4_ENTERPRISE.md)

---

## Risk Register

| Risk                      | Probability | Impact | Mitigation                                   |
| ------------------------- | ----------- | ------ | -------------------------------------------- |
| Performance overhead      | Medium      | Medium | Benchmark early; optimize hot paths          |
| Framework incompatibility | Medium      | High   | Adapter interface designed for extensibility |
| Policy complexity         | Low         | High   | DSL with validation; testing framework       |
| Adoption friction         | Medium      | Medium | Interceptor pattern; zero-cost opt-out       |
| Ledger storage growth     | Low         | Low    | Rotation policy; compression                 |

---

## Dependencies

### Phase 1 Dependencies

- Python 3.11+
- `cryptography` library for HMAC
- `keyring` library for secret storage
- Existing Alfred codebase

### Phase 2 Dependencies

- Phase 1 complete
- YAML parser (`pyyaml`)
- CLI framework (existing `argparse`)

### Phase 3 Dependencies

- Phase 2 complete
- `protobuf` for wire format
- Target framework for reference adapter

### Phase 4 Dependencies

- Phase 3 complete
- Distributed systems infrastructure (optional)

---

## Milestone Timeline

```
Week 1-2:   Phase 1 Core (Proposal, Risk Engine)
Week 3-4:   Phase 1 Complete (Ledger, Enforcement, Secrets)
Week 5-6:   Phase 2 Core (DSL, Path Hardening)
Week 7-8:   Phase 2 Complete (Break-glass, CLI, Profiles)
Week 9-10:  Phase 3 Core (Wire Format, Adapter Interface)
Week 11-12: Phase 3 Complete (Reference Adapter, Observability)
Week 13+:   Phase 4 (Enterprise Features)
```

---

## Testing Strategy

### Unit Tests

- Risk engine classification (all rules)
- Enforcement engine decision logic
- Ledger integrity (hash chains, signatures)
- Secret backend operations
- Failure mode handling

### Integration Tests

- End-to-end proposal → classification → enforcement flow
- Ledger persistence and verification
- CLI commands
- Policy hot-reload

### Security Tests

- Path traversal attempts
- Prompt injection (should have no effect on classification)
- Ledger tampering detection
- Break-glass authorization bypass attempts

### Performance Tests

- Classification latency (< 1ms p99)
- Ledger write latency (< 5ms p99)
- Memory usage under load

---

## Documentation Plan

| Document               | Phase   | Audience             |
| ---------------------- | ------- | -------------------- |
| API reference          | Phase 1 | Developers           |
| Policy authoring guide | Phase 2 | Operators            |
| Integration guide      | Phase 3 | Framework developers |
| Compliance mapping     | Phase 4 | Security teams       |

---

## Amendment History

| Date       | Version | Amendment            | Author          |
| ---------- | ------- | -------------------- | --------------- |
| 2026-02-24 | 1.0.0   | Initial project plan | Security Review |

---

## Next Steps

1. Review and approve [`CANONICAL_DESIGN.md`](CANONICAL_DESIGN.md)
2. Begin Phase 1 implementation
3. Establish testing infrastructure
4. Create development branch for Bat Protocol integration
