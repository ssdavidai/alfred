# Codex Desktop channel contract — issue #685, revision 685-r2

**Status:** frozen phase-0 target, 2026-08-19. Migration 0021 and its static
registration are delivered by this job. The HTTP provider, local adapter,
ingest mirror repairer, continuity assembler, and erasure worker described
below do not exist at the pinned head. No consumer or operator may present
them as deployed until the owning implementation lanes land the required
source and tests.

This document freezes the wire and storage boundary. Documentation records
intent; source, migration tests, route tests, and end-to-end failure tests are
the proof of an implementation.

## 1. Product boundary and prohibited inference

The source product pinned in `packages/hermes/Dockerfile` is
`@openai/codex@0.135.0`. Revision 1 accepts only the documented external
`agent-turn-complete` notification fields: opaque thread and turn identifiers,
`cwd`, input messages, and the final assistant message. The adapter records
the installed macOS product version during provisioning and must run a real
completion callback self-test before reporting itself ready.

The adapter must not infer missing events or identity from screen scraping,
Accessibility/UI automation, transcript or log watching, process inspection,
undocumented SQLite files, app-bundle modification, or experimental app-server
interfaces. In particular, completion is not evidence of session creation,
turn start, tool activity, approval activity, cancellation, or failure.

`captured_at` is the adapter's UTC receipt time for the callback. It is not a
Codex-authored timestamp. `workspace.cwd` comes only from the callback's `cwd`;
`workspace.provenance` is therefore the literal `codex-notify.cwd`. It is a
path observation, not a workspace identity, repository root, branch, account,
or principal. The adapter and server do not resolve symlinks, inspect Git, or
derive another workspace field.

## 2. Authority, identity, and ownership

1. An installation belongs to exactly one existing `alfred_principal`. The
   binding is immutable. Replacement requires revocation and new provisioning.
2. The installation credential identifies both the installation and its bound
   principal. Request bodies cannot override either identity. Every database
   relation carries and foreign-keys that binding so a cross-principal join is
   structurally invalid.
3. ctrl-api is the only writer. `alfred-state.db` table
   `codex_desktop_source_event` owns normalized canonical event content.
   `ingest.db.stream_event` is a repairable, consume-and-expire mirror for the
   existing learning pipeline; it is not canonical.
4. A delivery acknowledgement is durable only after every canonical source row
   exists and every corresponding ingest mirror exists or is already linked.
   A crash between those steps leaves repair state, never a false success.
5. alfred-learn consumes the ordinary ingest mirror. It does not authenticate
   as an installation and does not read migration-0021 tables.
6. Continuity selects canonical active tasks, matters, and in-flight decisions
   owned by the bound principal. LCM may enrich those selected records but may
   not introduce a second canonical record or change principal scope.
7. An installation credential grants no MCP, Hermes, vault, operator, or
   cross-principal capability. MCP grants and Codex installations remain
   independent lifecycles.

## 3. Authentication and fixed bounds

### 3.1 Authentication classes

Operator calls require `Authorization: Bearer <AAS_API_KEY>`. They are:

- provisioning an installation;
- rotating or revoking an installation;
- creating or inspecting a redaction/deletion request.

Only these two calls accept a Codex-scoped credential:

- `POST /api/v1/codex-desktop/chunks`;
- `POST /api/v1/codex-desktop/continuity`.

They require `Authorization: Bearer <cdx_token>` and do not accept the operator
bearer as a substitute. Every other Codex Desktop route rejects a `cdx_`
credential before reading its body.

A credential is `cdx_` plus 43 unpadded base64url characters encoding 32 bytes
from the operating-system CSPRNG. It is returned only by provisioning or
rotation, expires exactly 90 days after minting, and is never returned again.
ctrl-api stores only lowercase SHA-256 of the complete token. Every scoped call
checks installation binding, expiry, rotation, revocation, and installation
deletion before parsing the body. Rotation and revocation invalidate the old
token immediately; no successful-auth cache may outlive that write.

Tokens, authorization headers, credential hashes, free-text operator reasons,
event content, input messages, assistant messages, raw session identifiers,
and `cwd` are forbidden from application logs and audit metadata.

### 3.2 Fixed limits and retention

| Limit | Revision 685-r2 value |
|---|---:|
| Credential lifetime | 90 days |
| Request body | 1,048,576 uncompressed UTF-8 bytes |
| Chunk | 1–256 events from one installation and one opaque session |
| Canonical event JSON | 65,536 UTF-8 bytes |
| Identifier | 1–512 UTF-8 bytes |
| `workspace.cwd` | 1–4096 UTF-8 bytes, absolute macOS path |
| Input messages | 0–64 strings, each at most 65,536 UTF-8 bytes and still subject to event/body caps |
| Delivery receipt | 30 days after acknowledgement |
| Canonical source content | 7 days after acknowledgement; longer while unacknowledged or repairable |
| Repair/quarantine provenance | 30 days |
| Continuity revision manifest | 30 days |
| Erasure tombstone | 90 days |
| Continuity response | at most 6 items and 384 `o200k_base` tokens |
| Continuity server budget | 200 ms |
| Adapter continuity budget | 250 ms total, including network |

Compressed request bodies are rejected with 415. Unknown request keys are
rejected. All strings are NFC-normalized for hashing but their stored display
form is otherwise unchanged. Timestamps are UTC RFC 3339 with millisecond
precision. Hashes are 64 lowercase hexadecimal characters without a prefix.
Alfred-generated identifiers are ULIDs; adapter idempotency and source-event
identifiers are UUIDv7 strings.

## 4. Common response and retry rules

All request and response media types are `application/json`. Every non-2xx
response has exactly:

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "idempotency key is bound to different canonical bytes",
    "retryable": false,
    "request_id": "01K2QJ7AY3R8BK4QW8Z3M6F9HE",
    "details": {}
  }
}
```

Stable codes are:

| HTTP | Code | Retryable |
|---:|---|---|
| 400 | `MALFORMED_PAYLOAD` | no |
| 401 | `AUTHENTICATION_FAILED`, `TOKEN_EXPIRED`, `INSTALLATION_REVOKED` | no |
| 403 | `FORBIDDEN`, `PRINCIPAL_MISMATCH` | no |
| 404 | `NOT_FOUND` | no |
| 409 | `IDEMPOTENCY_CONFLICT`, `PAYLOAD_HASH_CONFLICT`, `SEQUENCE_CONFLICT`, `STALE_CONTINUITY_REVISION`, `ERASURE_CONFLICT` | no |
| 413 | `PAYLOAD_TOO_LARGE` | no |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | no |
| 429 | `RATE_LIMITED` | yes |
| 503 | `SERVICE_UNAVAILABLE` | yes |
| 504 | `TIMEOUT` | yes |

A 429 includes integer `Retry-After: 1..300`. Transport failure, 429, 503, and
504 retain the durable local chunk and retry with
`min(300, 2^(attempt-1))` seconds multiplied by uniform jitter in `[0.5,1.5]`.
All other 4xx responses quarantine the chunk and require operator action.

Retries never create a new acknowledgement. Once accepted, the receipt's id,
timestamp, sequence, payload hash, accepted count, and continuity revision are
immutable. An exact replay returns HTTP 202 and the byte-for-byte equivalent
JSON object reconstructed from those persisted fields. It does not expose
whether this request was the first attempt.

## 5. Exact HTTP surface

### 5.1 Operator provisioning

`POST /api/v1/codex-desktop/installations` — operator auth.

Exact request:

```json
{
  "principal_id": "owner",
  "label": "David MacBook Pro",
  "product": "codex-macos",
  "product_version": "1.2026.224 (1427)",
  "platform": "macos",
  "adapter_version": "1"
}
```

All six strings are required. `principal_id` must resolve to an existing
principal; `product` is `codex-macos`, `platform` is `macos`, and
`adapter_version` is `1`. The other strings are trimmed, control-character
free, and 1–200 characters.

Success is HTTP 201 with exactly:

```json
{
  "installation": {
    "id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
    "principal_id": "owner",
    "label": "David MacBook Pro",
    "product": "codex-macos",
    "product_version": "1.2026.224 (1427)",
    "platform": "macos",
    "adapter_version": "1",
    "created_at": "2026-08-19T12:00:00.000Z",
    "credential_expires_at": "2026-11-17T12:00:00.000Z",
    "revoked_at": null
  },
  "credential": {
    "scheme": "Bearer",
    "token": "cdx_EfM4JnX2ZkJQxY4s6vP_8uY0Ysa1YydVtVjY8yZXQqA",
    "expires_at": "2026-11-17T12:00:00.000Z"
  }
}
```

The installation row, immutable principal binding, credential hash, and expiry
commit before response. The plaintext token is not logged or recoverable.

### 5.2 Credential rotation

`POST /api/v1/codex-desktop/installations/:installation_id/rotate` — operator
auth. Exact body: `{}`.

Success is HTTP 200 with exactly:

```json
{
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "principal_id": "owner",
  "credential": {
    "scheme": "Bearer",
    "token": "cdx_qb3eYtzD5ctB6QkMhdYvGspCkK78kQ8BxG0FVwERK1Y",
    "expires_at": "2026-11-17T13:00:00.000Z"
  },
  "rotated_at": "2026-08-19T13:00:00.000Z"
}
```

The new hash and expiry replace the old hash atomically. The old token is
invalid before the response is sent.

### 5.3 Installation revocation

`POST /api/v1/codex-desktop/installations/:installation_id/revoke` — operator
auth.

Exact request:

```json
{"reason":"device retired"}
```

`reason` is required, trimmed, control-character free, and 1–200 characters.
It is used during the operator request but omitted from logs and audit payloads.

Success is HTTP 200 with exactly:

```json
{
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "principal_id": "owner",
  "state": "revoked",
  "revoked_at": "2026-08-19T14:00:00.000Z"
}
```

Revocation is idempotent and returns the original `revoked_at`. Every later
scoped request fails `401 INSTALLATION_REVOKED`.

### 5.4 Chunk ingestion

`POST /api/v1/codex-desktop/chunks` — `cdx_` auth only.

Exact revision-1 request:

```json
{
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "opaque_session_id": "0198c5a3-3e06-72b1-9658-f15fd465c903",
  "sequence": {"first": 41, "last": 41},
  "idempotency_key": "0198c5a4-86f1-7cc1-a5ff-7563f4d7f436",
  "canonical_payload_hash": "3f70bb1417b9fc2db3a4f0b5645501607292795488bf987d279a90749ff5c76b",
  "events": [
    {
      "source_event_id": "0198c5a4-7617-77f1-85e1-3acbd77f61fc",
      "event_sequence": 41,
      "kind": "agent-turn-complete",
      "revision": 1,
      "captured_at": "2026-08-19T12:04:05.678Z",
      "opaque_turn_id": "0198c5a3-640d-7de1-8cb7-5f47d7e1cf44",
      "workspace": {
        "cwd": "/Users/david/src/alfred",
        "provenance": "codex-notify.cwd"
      },
      "content": {
        "input_messages": ["Run the migration tests."],
        "last_assistant_message": "Migration tests passed."
      }
    }
  ]
}
```

The request installation must equal the credential installation. The bound
principal is taken from the credential, not the body. Every event shares the
top-level session. Event sequences are strictly increasing and cover every
integer in the declared range; `events.length == last - first + 1`.

`canonical_payload_hash` is SHA-256 over RFC 8785 canonical JSON of exactly
`installation_id`, `opaque_session_id`, `sequence`, and `events` (excluding
the idempotency key and hash itself). Each source row's content hash is
SHA-256 over the canonical JSON of that event object.

Sequence ranges are scoped to `(installation_id, opaque_session_id)`. A new
range must begin after the highest previously accepted or tombstoned
`sequence.last`; gaps are permitted and never backfilled implicitly. Exact
replay is resolved before this monotonic check. An overlapping, regressing, or
out-of-order new range returns `409 SEQUENCE_CONFLICT` and makes no write.
Tombstoned ranges continue to reserve their sequence space for 90 days.

Success is HTTP 202 with exactly:

```json
{
  "acknowledgement": {
    "id": "01K2QJ9N8VYH4Z0S7Y6XAN1S6P",
    "state": "acknowledged",
    "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
    "principal_id": "owner",
    "opaque_session_id": "0198c5a3-3e06-72b1-9658-f15fd465c903",
    "sequence": {"first": 41, "last": 41},
    "canonical_payload_hash": "3f70bb1417b9fc2db3a4f0b5645501607292795488bf987d279a90749ff5c76b",
    "accepted_event_count": 1,
    "acknowledged_at": "2026-08-19T12:04:06.012Z",
    "continuity": {
      "workspace_key": "eb462e63f85d34c1a1dc1e6ed219a5dc6c835673319ffe1a51d96673f12d2e0c",
      "revision": 18
    }
  }
}
```

#### Collision rules

The provider checks four installation-scoped identities before insertion:

- `idempotency_key`;
- `(opaque_session_id, sequence.first, sequence.last)`;
- each `source_event_id`;
- each `(opaque_session_id, event_sequence)`.

If any identity already exists with the same canonical chunk/event hashes and
all other identities resolve to the same receipt, the provider returns that
receipt's original acknowledgement. If a reused identity has a different hash,
or the identities resolve to different receipts, it returns non-retryable 409
(`IDEMPOTENCY_CONFLICT`, `PAYLOAD_HASH_CONFLICT`, or `SEQUENCE_CONFLICT`). The
conflict never changes canonical content, mirror content, revision state, or
the original acknowledgement.

#### Canonical write and ingest mirror

Within one state-db transaction ctrl-api inserts the delivery receipt and all
canonical source rows, including `captured_at`, exact workspace provenance,
normalized content, hashes, and `mirror_state=pending`. It then upserts one
ingest mirror per event:

- `stream = "codex-desktop:<installation_id>"`;
- `channel = "codex-desktop"`;
- `kind = "agent-turn-complete"`;
- `external_id = <source_event_id>`;
- `payload_json` contains the canonical source id, principal id, opaque session
  and turn ids, sequence, captured timestamp, workspace observation, content,
  and event hash.

After every mirror is present, ctrl-api records each ingest id, marks the
receipt mirrored, advances the principal/workspace continuity revision, and
persists the acknowledgement. Only then does it send HTTP 202.

If mirroring fails, the route returns retryable 503 with no acknowledgement.
Canonical rows remain pending or `repair_required`. An exact client retry and
the background repairer both use `source_event_id` to find/create the mirror,
then complete the same receipt. They never insert another canonical row or
mint another acknowledgement. Repair applies only to unacknowledged pending
rows; it does not recreate an acknowledged ingest event removed later by the
ordinary ingest TTL.

### 5.5 Bounded continuity

`POST /api/v1/codex-desktop/continuity` — `cdx_` auth only.

Exact request:

```json
{
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "workspace": {
    "cwd": "/Users/david/src/alfred",
    "provenance": "codex-notify.cwd"
  },
  "after_revision": 17
}
```

`after_revision` is an integer >=1 or null. `workspace` follows the ingestion
rules. The server derives `workspace_key` as lowercase SHA-256 of the
NFC-normalized `cwd`; it never accepts a caller-provided workspace key.

Success is HTTP 200 with exactly:

```json
{
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "principal_id": "owner",
  "workspace_key": "eb462e63f85d34c1a1dc1e6ed219a5dc6c835673319ffe1a51d96673f12d2e0c",
  "revision": 18,
  "no_change": false,
  "delta": {
    "kind": "unseen_delta",
    "from_revision": 17,
    "removed_refs": []
  },
  "context": {
    "items": [
      {
        "kind": "task",
        "ref": "task/ship-codex-channel.md",
        "state": "active",
        "updated_at": "2026-08-19T11:58:00.000Z",
        "workspace_match": true,
        "text": "task task/ship-codex-channel.md\nShip Codex channel\nactive\nMigration and contract are in review.",
        "tokens": 25
      }
    ],
    "item_count": 1,
    "token_count": 25,
    "limits": {"items": 6, "tokens": 384},
    "tokenizer": "o200k_base",
    "selection": "active-task-matter-decision-v1"
  },
  "availability": {
    "ctrl": "available",
    "lcm": "degraded",
    "reasons": ["lcm_unavailable"],
    "non_blocking": true
  }
}
```

The exact no-change response uses the same shape with:

```json
{
  "revision": 18,
  "no_change": true,
  "delta": {"kind":"no_change","from_revision":18,"removed_refs":[]},
  "context": {
    "items": [],
    "item_count": 0,
    "token_count": 0,
    "limits": {"items": 6, "tokens": 384},
    "tokenizer": "o200k_base",
    "selection": "active-task-matter-decision-v1"
  }
}
```

Those fields replace only `revision`, `no_change`, `delta`, and `context` in
the full response; installation, principal, workspace, and availability keys
remain present.

#### Deterministic selection and token bound

Eligibility is principal-scoped and read from canonical ctrl-owned state:

- task: not under `_closed/` and neither `status` nor `state` is one of
  `done|completed|cancelled|archived|closed`;
- matter: not under `_closed/` and derived state is not one of
  `done|completed|cancelled|archived|closed`;
- decision: state is one of `open|scheduled|dispatching|executing`.

Unbound records are selectable only for the unique owner in the current
single-principal tenant model. Once more than one principal exists, an unbound
record is excluded. No fallback query may widen principal scope.

Within each kind, candidates sort by: exact workspace-prefix match first,
`updated_at` descending, then UTF-8 bytewise `ref` ascending. Workspace match
uses only an explicitly stored `workspace_root` or prior
`codex-notify.cwd` provenance and requires a path-component boundary. It never
uses Git or basename similarity.

Take at most two candidates per kind and interleave them in this order:
first task, first matter, first decision, second task, second matter, second
decision, skipping missing slots. Therefore the response can never exceed six
items and one class cannot crowd out both others.

For each item, `text` is the NFC-normalized four-line rendering
`<kind> <ref>\n<title>\n<state>\n<summary>` with internal whitespace runs in
title/state/summary collapsed to one ASCII space. Token count is the
`o200k_base` encoding of the exact `text`; the response count is the sum of
item counts. Iterate in the frozen order. If a complete item would exceed 384,
truncate only its summary at a token boundary. If the fixed first three lines
do not fit, skip that item. Continue through the remaining candidates. The
adapter injects only `text`, so structured metadata cannot evade the budget.

LCM may provide the summary for an already selected ref. It cannot change
eligibility, ordering, identity, or the two-per-kind cap. If LCM is unavailable
or misses its 100 ms sub-budget, ctrl uses canonical title/current-state text,
sets `availability.lcm="degraded"`, and returns 200.

#### Revision, no-change, and unseen delta

Revisions are monotonically increasing integers scoped to
`(principal_id, workspace_key)`, never installation-global and never shared
across principals. A revision row stores only the ordered
`{kind,ref,content_hash}` manifest and snapshot hash—not context text.

On each read, ctrl deterministically assembles the bounded current manifest:

- if its hash equals the current head, no revision is created;
- if it differs, ctrl transactionally inserts `head + 1` with
  `previous_revision = head`;
- `after_revision == head` returns `no_change` and no items;
- a retained older `after_revision` returns `unseen_delta`: only new/changed
  current items are returned, and disappeared refs are listed in
  `removed_refs`;
- `after_revision = null` returns `kind="snapshot"`, all bounded current
  items, and `from_revision=null`;
- a future, expired, unknown, wrong-workspace, or wrong-principal revision
  returns non-retryable `409 STALE_CONTINUITY_REVISION` without disclosing a
  current manifest.

A delta contains at most the six currently selected items and follows the same
384-token algorithm. Content removal can therefore produce
`no_change=false`, no items, and non-empty `removed_refs`.

#### Non-blocking degradation

Continuity is advisory and never participates in capture or ingestion
commit. LCM timeout/unavailability is the 200 degraded response above. If
ctrl itself is unreachable, returns 429/5xx, or misses the adapter's 250 ms
budget, the adapter proceeds with an empty continuity contribution, records a
local degraded reason (`ctrl_unavailable` or `ctrl_timeout`), and does not
retry or delay the Codex turn. A later turn may try again. Continuity failure
never changes an ingestion receipt or source sequence.

### 5.6 Redaction and deletion

`POST /api/v1/codex-desktop/erasures` — operator auth.

Exact session request:

```json
{
  "idempotency_key": "0198c68a-891f-7f0f-a5ea-a6277b7374fb",
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "scope": {
    "kind": "session",
    "opaque_session_id": "0198c5a3-3e06-72b1-9658-f15fd465c903"
  },
  "operation": "delete",
  "reason": "principal request"
}
```

Installation scope is the same shape with
`"scope":{"kind":"installation"}`. `operation` is `redact|delete`.
`reason` is required, trimmed, control-character free, 1–200 characters, and
never persisted verbatim. The request hash covers the whole canonical body.

After the canonical tombstone transaction commits, success is HTTP 202 with
exactly:

```json
{
  "erasure": {
    "id": "01K2QPHV3M8S6DNX02A9YX4Y3T",
    "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
    "principal_id": "owner",
    "scope": "session",
    "operation": "delete",
    "state": "accepted",
    "accepted_at": "2026-08-19T15:00:00.000Z",
    "tombstone_until": "2026-11-17T15:00:00.000Z",
    "status_url": "/api/v1/codex-desktop/erasures/01K2QPHV3M8S6DNX02A9YX4Y3T"
  }
}
```

An exact idempotency replay returns the original 202 body. Reusing the key with
a different request hash returns `409 ERASURE_CONFLICT`.

`GET /api/v1/codex-desktop/erasures/:erasure_id` — operator auth. Success is
HTTP 200 with exactly:

```json
{
  "erasure": {
    "id": "01K2QPHV3M8S6DNX02A9YX4Y3T",
    "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
    "principal_id": "owner",
    "scope": "session",
    "operation": "delete",
    "state": "complete",
    "counts": {
      "source": 4,
      "ingest": 4,
      "journal": 2,
      "derived": 1
    },
    "lcm_state": "complete",
    "last_error_code": null,
    "accepted_at": "2026-08-19T15:00:00.000Z",
    "completed_at": "2026-08-19T15:00:03.000Z",
    "tombstone_until": "2026-11-17T15:00:00.000Z"
  }
}
```

`state` is `accepted|running|complete|degraded|failed`. `last_error_code` is an
allowlisted code, never raw provider output. Completion means all reachable
server-owned canonical, ingest, journal, derived, and supported LCM effects
have committed. An unavailable supported LCM erasure API yields `degraded`,
not false completion.

The initial transaction is ordered before the 202 response:

1. Bind the request to the installation principal and create a 90-day erasure
   tombstone. Session tombstones retain a one-way session hash in the erasure
   ledger; installation tombstones also revoke the credential.
2. Mark matching receipts tombstoned and set canonical source `payload_json`
   and `workspace_cwd` to null while retaining the minimum installation,
   session, sequence, source identities, hashes, deletion id, and expiry needed
   to suppress delayed delivery.
3. Advance every affected principal/workspace continuity revision so deleted
   refs appear in unseen deltas immediately.

The worker then removes or redacts matching ingest mirrors, One Alfred journal
content, derived state, and supported LCM content. `redact` retains a visible
`[redacted]` marker where the destination requires a record; `delete` retains
no content. Neither operation creates another memory store.

Audit events contain only request id, erasure id, authenticated operator id,
installation id, bound principal id, scope kind, operation, state, integer
counts, allowlisted error code, and timestamps. They exclude credentials and
hashes, free-text reason, raw session/turn ids, workspace paths, messages,
payloads, journal text, LCM output, and stack/error strings.

## 6. Migration 0021 storage contract

Migration `0021_codex_desktop.sql` is append-only and registered as state-db
user version 21. It creates:

- `codex_desktop_installation`: immutable principal binding, product metadata,
  credential hash/expiry/rotation/revocation, and installation tombstone;
- `codex_desktop_delivery_chunk`: stable acknowledgement, installation/session
  sequence range, idempotency and chunk hash, retry/mirror state, continuity
  revision, retention, and tombstone;
- `codex_desktop_source_event`: canonical normalized content, captured time,
  exact workspace provenance, event hash/identity/sequence, ingest mirror
  repair state/reference, retention, and content tombstone;
- `codex_desktop_continuity_revision`: principal/workspace revision chain and
  content-free ordered item/hash manifests for no-change and unseen deltas;
- `codex_desktop_erasure_request`: operator idempotency, redacted scope hash,
  durable state/counts, LCM state, allowlisted error code, and tombstone expiry.

Composite foreign keys preserve event → receipt → installation → principal.
Unique indexes preserve installation-scoped idempotency, exact chunk ranges,
source identities, and session event sequences. The monotonic insert trigger
rejects overlap and sequence regression even if route validation is bypassed.
Repair indexes expose only pending/unacknowledged rows. Content columns become
null only with a deletion id and tombstone timestamp.

The migration stores no plaintext credential, authorization header, audit
reason, independent task/matter/decision copy, journal copy, or LCM database.
It does not edit `schema.sql`, `ingest-schema.sql`, or any historical migration.

## 7. Required verification ownership

- **Phase 0 (this job):** freeze this contract, register migration 0021, and
  prove its schema, foreign keys, uniqueness, range trigger, revision chain,
  mirror repair fields, credential expiry fields, and tombstone checks.
- **ctrl lane:** implement exact auth classes and shapes, canonical transaction,
  ingest mirroring/repair, retry acknowledgement, deterministic continuity,
  audit redaction, retention, and erasure worker.
- **adapter/infra lane:** implement only the supported callback, transactional
  local sequence/outbox, provisioning self-test, scoped credential handling,
  retry classifier, restart recovery, non-blocking continuity, and local
  erasure. Negative tests must prove prohibited observation methods are absent.
- **learn lane:** consume only ordinary ingest mirrors, preserve source-event
  provenance through derived state, and redact/delete only through ctrl-api.
- **Hermes/LCM lane:** expose no SQLite file. A supported bounded read/erase API
  must preserve principal scope; until it exists, ctrl returns deterministic
  degraded continuity and erasure never claims false completion.

End-to-end tests must cover principal isolation; mint/rotate/revoke/expiry;
captured/workspace provenance; exact replay after response loss; every hash and
identity conflict; overlap and regression; crash before/after mirror creation;
repair without duplicate canonical or ingest rows; six-item/384-token fixtures;
snapshot/no-change/unseen/removal/stale revision cases; ctrl/LCM degradation;
audit field allowlisting; and session/installation erasure followed by a
delayed chunk proving the tombstone prevents content recreation.
