# Spec 108: Alfred as Holding Company — Paperclip Subsidiaries Architecture

**Version:** 0.1
**Date:** 3 April 2026
**Status:** Draft — Research Complete, Ready for Design Review
**Author:** David Szabo-Stuban + Alfred

---

## Problem Statement

Alfred currently models one tenant as one Alfred instance with one OpenClaw runtime and one vault. That works for a single operator, but it does not match the shape of a person running multiple businesses.

The target model is:

- **Alfred** acts as the holding-company board
- each business runs as a **subsidiary Paperclip org**
- each subsidiary has its own **OpenClaw runtime, agents, session state, budgets, and SOUL/workspace**
- all subsidiaries write durable business memory into one **shared vault**
- Alfred watches for escalations and board approvals across all subsidiaries

---

## Research Basis

This note combines:

1. current Alfred topology and vault conventions in this repo
2. existing Alfred approval/task patterns from specs 003 and 056
3. Paperclip public source inspection, especially:
   - `paperclipai/paperclip/packages/adapters/openclaw-gateway/README.md`
   - `paperclipai/paperclip/packages/adapters/openclaw-gateway/src/index.ts`
   - `paperclipai/paperclip/docs/api/approvals.md`
   - `paperclipai/paperclip/packages/shared/src/types/approval.ts`

---

## Research Answers

| Question | Answer |
|---|---|
| Can Paperclip's OpenClaw adapter connect to a remote gateway? | **Yes.** The OpenClaw adapter is explicitly a WebSocket gateway client. It requires a `ws://` or `wss://` URL, supports auth headers/tokens/passwords, and does not assume localhost. |
| What vault namespace should each company use? | **Recommended:** `/vault/companies/{company_slug}/...` with Alfred board records outside that tree. This avoids collisions with Alfred's existing top-level type directories such as `person/`, `project/`, `observation/`, and `intuition/`. |
| How does Alfred receive approvals from Paperclip natively? | **Use Paperclip's native approvals API first.** Paperclip already exposes company-scoped approval queues (`/api/companies/{companyId}/approvals`) plus approve/reject/revision flows. I did not find a documented push-notification channel in the researched sources, so Alfred should poll the native approval queue and mirror it into the vault for memory. |
| Should subsidiaries use the same Alfred OpenClaw image? | **Yes by default.** Reuse the same base `alfred-openclaw` image and vary runtime state, skills, SOUL/workspace, budgets, and credentials per company. Company-specific images should be the exception for toolchain or compliance needs. |
| What is the board-approval handoff? | **Native Paperclip approval queue + vault mirror.** Subsidiary CEOs create Paperclip approvals; Alfred watches those approvals and writes summary/escalation records into the shared vault. Vault-only polling is a fallback, not the primary mechanism. |

---

## Why These Answers Fit Alfred

### 1. Remote OpenClaw is already supported by Paperclip

Paperclip's adapter contract says:

- transport is always WebSocket
- URL must be `ws://` or `wss://`
- auth can be provided by token, headers, or password
- the Paperclip server only needs outbound WebSocket access

That means Alfred does **not** need to force Paperclip to run on the same host as OpenClaw. Each subsidiary can keep its own OpenClaw gateway and Paperclip can connect remotely over the gateway protocol.

### 2. `/vault/{company}/` is too ambiguous for Alfred's current vault

Today Alfred already seeds and expects top-level directories like:

- `/vault/person`
- `/vault/project`
- `/vault/org`
- `/vault/observation`
- `/vault/intuition`
- `/vault/reflection`

Using raw `/vault/{company}/` at the root risks name collisions and makes it less obvious which folders are record types versus company namespaces.

**Recommended namespace:**

```text
/vault/board/
/vault/companies/{company_slug}/
/vault/escalations/{company_slug}/
```

Inside each subsidiary namespace, mirror the normal Alfred layout:

```text
/vault/companies/lumberjack/
  org/
  project/
  task/
  observation/
  intuition/
  reflection/
  workspace/
```

This keeps the current Alfred root readable while giving each company a full isolated memory tree.

### 3. Paperclip already has a first-class approval model

Paperclip's public API already models approvals as first-class records with:

- `companyId`
- `status`
- `payload`
- approve / reject / revision-request / resubmit transitions
- comments and linked issues

That is a better board-approval primitive than inventing a vault-only queue from scratch. Alfred should consume or mirror this queue rather than replacing it.

### 4. Same image, different runtime is the simpler default

This repo already deploys shared images across tenants:

- `ssdavidai00/alfred-openclaw:latest`
- `ssdavidai00/alfred-learn:latest`
- `ssdavidai00/alfred-worker:latest`

The main isolation boundaries already come from:

- separate Docker stacks
- separate OpenClaw state directories
- separate gateway auth
- separate workspace/SOUL/skills
- separate budgets and credentials

That pattern carries cleanly to subsidiaries. Build per-company images only when a company truly needs unique binaries, tools, or regulatory separation.

---

## Recommended Target Architecture

```text
ALFRED BOARD
  - shared vault owner
  - cross-company memory
  - board-level approvals watcher
  - strategic summaries and intervention

PAPERCLIP (single deployment, multi-company)
  - company: lumberjack
  - company: screenless-dad
  - company: ...

SUBSIDIARY RUNTIME (per company)
  - Paperclip company/org
  - dedicated OpenClaw gateway
  - dedicated session state + workspace + SOUL
  - dedicated budgets and credentials
  - shared vault mount, but namespaced write paths
```

### Operational Rules

1. **One Paperclip deployment can manage many companies**
   - treat companies as first-class orgs inside Paperclip
   - do not spin up one Paperclip deployment per subsidiary unless isolation requirements force it

2. **One OpenClaw runtime per subsidiary**
   - separate Docker stack or at least separate runtime state per company
   - no shared session keyspace between subsidiaries
   - no shared SOUL/workspace between subsidiaries

3. **One shared vault, namespaced by company**
   - board records stay under `/vault/board`
   - subsidiary operational memory lives under `/vault/companies/{company_slug}`
   - escalations and approval mirrors live under `/vault/escalations/{company_slug}`

4. **Approvals stay native in Paperclip**
   - CEO agent requests approval in Paperclip
   - Alfred board watcher mirrors and summarizes the approval into the vault
   - final decision is written back through Paperclip's approval endpoint

---

## Recommended Handoff Flow

### Board Approval

```text
Subsidiary CEO
  -> create native Paperclip approval
  -> approval appears in company approval queue
  -> Alfred board watcher polls that approval queue
  -> Alfred writes summary to /vault/escalations/{company}/...
  -> Alfred/board user reviews context in shared vault
  -> decision goes back to Paperclip approval endpoint
  -> subsidiary receives resolved approval state
```

### Why not vault-only polling first?

Vault-only polling loses useful Paperclip primitives that already exist:

- approval status lifecycle
- comments
- linked issues
- company-scoped queues
- explicit resubmission flow

The vault should be the **memory and observability layer**, not the authoritative approval queue if a native queue already exists.

---

## Proposed Vault Convention

### Top-Level

```text
/vault/board/
/vault/companies/{company_slug}/
/vault/escalations/{company_slug}/
```

### Company Slug Rules

- lowercase kebab-case
- stable identifier, independent of display name
- examples: `lumberjack`, `screenless-dad`

### Inside a Company Namespace

Mirror Alfred's existing per-type structure instead of inventing a new schema:

```text
/vault/companies/{company_slug}/org/
/vault/companies/{company_slug}/project/
/vault/companies/{company_slug}/task/
/vault/companies/{company_slug}/observation/
/vault/companies/{company_slug}/intuition/
/vault/companies/{company_slug}/reflection/
/vault/companies/{company_slug}/workspace/SOUL.md
```

This is the lowest-friction path because Alfred already thinks in per-type directories.

---

## Implementation Recommendation

### Phase 1 — Research Spike

- verify a Paperclip company can connect to a tenant OpenClaw gateway over `wss://`
- confirm auth mode to use (`Authorization` bearer header vs gateway token header)
- define the board watcher interface that mirrors approvals into the vault

### Phase 2 — Vault Namespace Support

- provision `/vault/board`, `/vault/companies`, and `/vault/escalations`
- teach Alfred/learn helpers to accept a company namespace prefix
- keep existing single-company tenants working unchanged

### Phase 3 — Paperclip Approval Bridge

- poll or subscribe to Paperclip approvals per company
- write normalized approval summaries into `/vault/escalations/{company_slug}/`
- write board decisions back to Paperclip approval endpoints

### Phase 4 — Subsidiary Runtime Provisioning

- provision one OpenClaw runtime per company
- mount isolated workspace/state directories per company
- keep a shared vault mount with namespaced write paths

---

## Decision Summary

1. **Paperclip multi-company:** yes, treat this as a first-class Paperclip feature
2. **Remote OpenClaw:** yes, supported through the OpenClaw gateway WebSocket adapter
3. **Vault namespace:** prefer `/vault/companies/{company_slug}` over raw `/vault/{company}`
4. **Approvals:** use Paperclip native approvals as source of truth
5. **Vault escalations:** keep as summary/memory mirror for Alfred board oversight
6. **Images:** same base image by default; isolate via runtime, not custom builds

---

## References

- `TOPOLOGY.md`
- `specs/003-task-execution-layer.md`
- `specs/056-scoped-secrets.md`
- `packages/openclaw/CONTRACT.md`
- `packages/openclaw/init/entrypoint.sh`
- `packages/ctrl/docs/concepts/vault-schema.mdx`
- `paperclipai/paperclip/packages/adapters/openclaw-gateway/README.md`
- `paperclipai/paperclip/packages/adapters/openclaw-gateway/src/index.ts`
- `paperclipai/paperclip/docs/api/approvals.md`
- `paperclipai/paperclip/packages/shared/src/types/approval.ts`
