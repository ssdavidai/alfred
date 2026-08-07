---
type: note
name: "<Matter name> commitment management"
created: "<ISO timestamp>"
status: active
matter: "[[matter/<matter-slug>]]"
tags:
  - "<matter-slug>"
  - commitment-management
---

# <Matter name> commitment management

Operating policy for promises and requests within `<matter-slug>`. Individual
commitments are `commitment/` vault records with IDs `<PREFIX>-COM-YYYY-NNN`.
Any note, Canvas, dashboard or briefing is a generated projection and never the
source of truth.

## Resolved configuration

Recorded here so a later run — or a different agent — can reproduce what this
register was set up to do. Derived values are marked as such; overrides come
from the matter's `commitment_register` block.

- Matter: `matter/<matter-slug>.md`
- Prefix: `<PREFIX>` (derived from the matter slug unless overridden)
- Participants and aliases: `<list>` (derived from the matter's related
  persons/orgs unless overridden)
- Evidence surfaces: `<bounded list of what is actually connected>`
- Projection: `<note path, or the opted-in external destination>`
- Forbidden destinations: `<list>` — every client-facing or shared surface
- External action policy: no sends and no client-facing mutations during
  reconciliation, ever.

## Required fields

`commitment_id`, `commitment_scope`, `commitment_kind`, `commitment_state`,
`requested_by`, `accountable_party`, `next_action`, `source_type`,
`source_ref`, `source_quote`, `last_verified_at`, `matter_ref` — plus
dependency and delivery/acceptance evidence where relevant.

## Lifecycle

`captured` → `accepted` → `in_progress` → `ready_to_deliver` →
`delivered_awaiting_acceptance` → `fulfilled`

Holding: `waiting_on_principal`, `waiting_on_alfred`, `waiting_on_client`,
`blocked`.

Terminal exceptions: `released`, `superseded`.

## Rules

1. Preserve source wording and evidence handles.
2. Do not infer acceptance from brainstorming.
3. Deduplicate before creating.
4. Represent dependency chains explicitly.
5. Preparation is not delivery; delivery is not acceptance.
6. Close only with evidence or an explicit release.
7. Preserve history when scope changes; link both directions.
8. Client-owned prerequisites remain blockers, not phantom owned records.
9. Generate projections only from canonical records, and verify every write by
   reading it back.
