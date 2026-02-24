# Bat Protocol Documentation

## Overview

Bat Protocol is a deterministic governance layer for autonomous agent systems. It provides risk classification, enforcement, and audit capabilities that agents cannot subvert.

## Core Principle

**No agent decides its own risk.**

Governance is structurally separated from agency. Agents propose; a distinct engine classifies; a distinct engine enforces.

## Documentation

| Document                                                | Description                               |
| ------------------------------------------------------- | ----------------------------------------- |
| [Canonical Design](CANONICAL_DESIGN.md)                 | Authoritative architectural specification |
| [Project Plan](PROJECT_PLAN.md)                         | Implementation roadmap and milestones     |
| [Phase 1: Foundation](phases/PHASE_1_FOUNDATION.md)     | Core governance layer implementation      |
| [Phase 2: Hardening](phases/PHASE_2_HARDENING.md)       | Production-ready security features        |
| [Phase 3: Universality](phases/PHASE_3_UNIVERSALITY.md) | Cross-framework support                   |
| [Phase 4: Enterprise](phases/PHASE_4_ENTERPRISE.md)     | Enterprise governance features            |

## Quick Start

```bash
# Check Bat Protocol status
alfred bat status

# Audit governance decisions
alfred bat audit --level L3

# Test policy rules
alfred bat test-policy rules.yaml

# Verify ledger integrity
alfred bat verify-ledger
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    BAT PROTOCOL CORE                     │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Operation   │  │    Risk      │  │  Enforcement   │  │
│  │  Contract    │──│    Engine    │──│    Engine       │  │
│  │  Schema      │  │  (Rules)     │  │  (Policy)      │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
│         │                │                   │           │
│  ┌──────┴────────────────┴───────────────────┴────────┐  │
│  │              Governance Ledger                      │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Risk Levels

| Level | Description | Default Action       |
| ----- | ----------- | -------------------- | --------------------------- |
| L1    | Low         | Routine operations   | Allow + Log                 |
| L2    | Medium      | Requires awareness   | Log + Optional confirmation |
| L3    | High        | Sensitive operations | Block in enforce mode       |

## Key Features

- **Deterministic Classification** — No LLM calls in governance path
- **Proposal Abstraction** — Agents propose, they do not act unilaterally
- **HMAC-Signed Ledger** — Cryptographic audit trail
- **Scope-Based Access Control** — Per-agent capability restrictions
- **Fail-Closed** — All failures result in blocked execution
- **Break-Glass** — Emergency override with full audit

## Status

- **Version:** 1.0.0
- **Branch:** Bat-Protocol
- **Created:** 2026-02-24
