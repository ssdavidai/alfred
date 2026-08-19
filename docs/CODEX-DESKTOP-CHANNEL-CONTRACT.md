# Codex Desktop channel contract — issue #684, revision 684-r2

**Status:** frozen phase-0 target, verified 2026-08-19. Migration 0021 and
its registration are delivered with this revision. The HTTP provider, local
adapter, projection, health, continuity, and deletion workers described below
do not exist at the pinned head and must not be presented as deployed until
their owning lanes implement and test them.

This contract is the only permitted basis for a production Codex Desktop
channel. Documentation is evidence of an interface, not evidence that a build
implements it. Each implementation lane must test the exact source product and
version below and fail closed when its enrollment self-test does not receive
the documented callback.

## 1. Official evidence and compatibility boundary

The server contract version is `684-r2`; the adapter protocol version is `1`;
the only accepted source-event revision is `1`. The event transport target is
`@openai/codex` **0.135.0**, the version pinned by
`packages/hermes/Dockerfile`. Codex for macOS is a rolling product whose public
app documentation does not publish a stable event-protocol or semantic app
version. Enrollment therefore records the installed bundle short version and
build as `product_version`, and an actual `agent-turn-complete` self-test is
mandatory.

Official sources reviewed on 2026-08-19:

- **O1 — external notification contract:** OpenAI's
  [Codex advanced configuration — notify](https://developers.openai.com/codex/config-advanced/#notify)
  defines the external program callback, the single supported
  `agent-turn-complete` notification, and its JSON fields.
- **O2 — configuration key:** OpenAI's
  [Codex configuration reference](https://developers.openai.com/codex/config-reference/#notify)
  defines `notify` as an external program argv and does not define a private
  pre-turn injection callback.
- **O3 — pinned source product:** OpenAI's
  [Codex 0.135.0 release](https://github.com/openai/codex/releases/tag/rust-v0.135.0)
  identifies the exact CLI source version this contract targets.
- **O4 — macOS product:** OpenAI's
  [Codex app documentation](https://developers.openai.com/codex/app/)
  is the official installation and product surface for Codex on macOS. It
  does not freeze an adapter API, updater callback, signing Team ID, or
  designated requirement.

### 1.1 Lifecycle events

Every status in this table applies to Codex CLI 0.135.0 and the rolling Codex
macOS app distribution as checked on 2026-08-19. “Unavailable” means the
adapter must not infer it from a window, transcript, log, SQLite file, process,
or experimental protocol.

| Lifecycle fact | Status | Official evidence | Contract result |
|---|---|---|---|
| Agent turn completed | **Supported** | O1, O2, O3 | Accept only `type="agent-turn-complete"`, normalized as event revision 1. |
| Session created, opened, resumed, reset, or ended | **Unavailable** | O1 exposes no such notification; O2 has no callback | No synthesized lifecycle event. First/last observed completion is not session start/end. |
| Turn started, failed, cancelled, or interrupted | **Unavailable** | O1 exposes completion only | No event and no timeout-based inference. |
| Approval requested or resolved | **Unavailable to external `notify`** | O1, O2 | TUI notifications are not an adapter transport. |
| Tool call started/completed | **Unavailable** | O1, O2 | Never watch the transcript or UI to reconstruct tool activity. |
| Assistant streaming delta | **Unavailable** | O1, O2 | Only the final assistant message supplied at completion is accepted. |
| Background task/automation lifecycle | **Unavailable** | O1, O4 | No app UI or task-database observation. |

### 1.2 Identifiers, workspace, content, and pre-turn context

| Field/capability | Status | Official evidence | Revision-1 mapping |
|---|---|---|---|
| Opaque session identifier | **Supported at completion** | O1 (`thread-id`), O3 | `thread-id` is copied byte-for-byte to `opaque_session_id`; never parsed or treated as an account/user id. |
| Opaque turn identifier | **Supported at completion** | O1 (`turn-id`), O3 | `turn-id` is copied byte-for-byte to `opaque_turn_id`; never parsed. |
| Current workspace directory | **Supported at completion** | O1 (`cwd`), O3 | Normalized to `payload.cwd`; it is a path string, not a stable workspace identity. |
| Workspace id/name/root list | **Unavailable** | O1 supplies only `cwd` | Do not derive from recent-project UI, git remotes, or app state. |
| Turn input messages | **Supported retrospectively** | O1 (`input-messages`) | `payload.input_messages`; completion payload only, not a user-message event. |
| Final assistant message | **Supported** | O1 (`last-assistant-message`) | `payload.last_assistant_message`. |
| Source timestamp, model, account, user, git branch | **Unavailable** | O1 omits them | `observed_at` is adapter receipt time and must not be labelled source time. |
| Monotonic sequence/source-event id | **Unavailable from Codex** | O1 omits them | Generated and durably advanced by the adapter. |
| Private per-turn pre-context injection | **Unavailable** | O1 and O2 define no pre-turn callback | Continuity may not block or secretly mutate a Codex turn. `journal_only` reads remain ready for a future officially evidenced surface. |

The only accepted raw notification keys are exactly `type`, `thread-id`,
`turn-id`, `cwd`, `input-messages`, and `last-assistant-message`. Unknown keys
may be ignored for forward compatibility but are never stored or projected
until a later contract revision cites official evidence and defines them.

### 1.3 macOS installation, update, and signing

| Claim | Product/version and verification | Official evidence | Frozen rule |
|---|---|---|---|
| Codex has an official macOS app/install surface | Codex for macOS rolling distribution, verified 2026-08-19; public docs expose no semantic protocol version | O4 | The operator installs Codex only from the official OpenAI surface. The Alfred adapter never installs Codex. |
| App update lifecycle/API | **Unavailable**, same product/date | O4 defines no adapter-facing updater event | The adapter never checks for, downloads, applies, blocks, or automates an app update. Re-run enrollment self-test after any observed version change. |
| Stable signing identity/Team ID/designated requirement | **Unavailable as an official Codex contract**, same product/date | O4 publishes none | Rely on normal macOS trust/notarization UI for the official app; do not hard-code or claim an OpenAI Team ID. Record the bundle version/build only after the operator launches the trusted app. |
| App bundle modification or injection | **Unsupported**, same product/date | O1/O2 already provide the permitted external callback | Never patch, inject into, re-sign, replace, or alter the Codex application bundle. |

Production implementations **MUST NOT** use screen scraping, Accessibility/UI
automation, transcript watching, filesystem/process-log tailing, app bundle
modification, undocumented SQLite access, or experimental `app-server`
interfaces. These methods are prohibited even as fallbacks. A future official
surface requires a new phase-0 contract revision before use.

## 2. Authority and data-flow invariants

1. The local adapter receives only O1 callbacks and writes a durable local
   outbox. It is not an MCP client and receives no MCP token or tool grant.
2. ctrl-api is the sole canonical server writer. It validates a chunk, writes
   migration-0021 receipt/provenance rows, projects the payload into the
   existing `ingest.db` path and One Alfred journal with stable provenance,
   and only then acknowledges it.
3. `codex_desktop_source_event` is bounded transport provenance. It contains
   identifiers, hashes, projection references, states, and retention times —
   never a payload, transcript, summary, user memory, or LCM copy.
4. The One Alfred journal and the main-profile VPS LCM remain the only
   continuity authorities. Migration 0021 creates no memory/LCM table.
5. alfred-learn consumes the ordinary projected ingest event. It never reads
   migration-0021 tables or the local outbox and persists only through
   ctrl-api.
6. MCP grants and Codex installation credentials are independent. Enrollment,
   rotation, revocation, redaction, and deletion cannot add an MCP capability.

## 3. Authentication and fixed limits

### 3.1 Two authentication classes

**Operator-authenticated** calls use `Authorization: Bearer <AAS_API_KEY>`:
enrollment, credential rotation, revocation, deletion/redaction creation, and
deletion inspection. **Installation-authenticated** calls use
`Authorization: Bearer <installation_token>`: chunk ingestion, continuity
read, and adapter health.

An installation token is `cdi_` followed by 43 unpadded base64url characters
encoding 32 random bytes from the operating-system CSPRNG. It is scoped to one
installation, expires exactly 90 days after mint/rotation, and is returned
only by enrollment or rotation. ctrl-api stores only lowercase SHA-256 of the
complete token, expiry-checks every request, and rejects an expired, rotated,
explicitly revoked, or fully redacted/deleted credential before reading a body.
Rotation and explicit revocation invalidate the prior token immediately.

An accepted installation-scope redaction/deletion is not fully
redacted/deleted or revoked until its local cleanup is acknowledged. While its
`codex_desktop_deletion.client_cleanup_pending` row is true, the existing token
is restricted to `POST /api/v1/codex-desktop/health`: chunk ingestion and
continuity fail `403 FORBIDDEN` before their bodies are read. This health-only
cleanup state is derived from the deletion row, grants no ingestion,
continuity, MCP, or content-read capability, and cannot be rotated or explicitly
revoked before the §5.6 terminal acknowledgement. The request carrying that
acknowledgement remains authorized through its response; the same transaction
then revokes the token, and every later request is rejected before body parsing.
Tokens, authorization headers, and token hashes are excluded from application
logs, error details, analytics, ingest payloads, journal metadata, and
request-body storage.

### 3.2 Concrete limits

| Limit | Frozen value/behavior |
|---|---|
| Credential lifetime | 90 days; health becomes `degraded` at 7 days remaining; expiry is a non-retryable 401. |
| JSON request body | 1,048,576 bytes, UTF-8, uncompressed; compressed transfer encoding is rejected with 415. |
| Chunk | 1–256 ordered events; contiguous sequence span of 1–256; one installation and one opaque session. |
| Normalized event payload | 65,536 UTF-8 bytes after RFC 8785 canonicalization. |
| String/array bounds | ids 1–512 bytes; `cwd` 1–4096; each message 0–65,536; `input_messages` 0–64 members, also bounded by event/body caps. |
| Continuity request | at most 64 entries, 65,536 response bytes, last 86,400 seconds; server budget 200 ms, adapter budget 250 ms. |
| Local outbox | at most 10,000 chunks and 67,108,864 payload bytes; unacknowledged payload retention 7 days. |
| Acknowledged local chunk | retained for 24 hours after the acknowledgement marker is fsynced, then removed. |
| Server delivery receipt | 30 days after acknowledgement. |
| Server source-event provenance | 7 days after successful projection; quarantined provenance 30 days. |
| Redaction/deletion tombstone | 90 days, longer than every permitted local retry window. |
| Health deletion exchange | At most 100 applied deletion ids in a request and 100 directives in a response. |
| Retry delay | `min(300, 2^(attempt-1))` seconds multiplied by uniform jitter in `[0.5,1.5]`; attempt starts at 1. |
| Deletion server completion | within 24 hours of acceptance; client-local cleanup is mandatory before any operation on its next start/health. |

When adding a chunk would exceed the outbox count or byte cap, the adapter
does not evict an older unacknowledged chunk. It stops capture, reports
`blocked/outbox_full`, and requires operator recovery. At seven days an
unacknowledged payload is irreversibly reduced to a local tombstone and is no
longer retried; health remains `blocked/outbox_age_exceeded`. This is the only
age-based removal of an unacknowledged payload. All local outbox writes,
sequence advances, acknowledgement markers, quarantine moves, and tombstones
are transactionally durable and survive adapter or application restart.

## 4. Common JSON and error rules

All media types are `application/json`. Timestamps are UTC RFC 3339 with
millisecond precision. Hashes are 64 lowercase hexadecimal characters,
without a `sha256:` prefix. IDs generated by Alfred are ULIDs; adapter
`source_event_id` and `idempotency_key` values are UUIDv7 strings. Unknown
request keys are rejected with `400 MALFORMED_PAYLOAD` except for unknown raw
O1 notification keys as described in §1.2.

Every non-2xx response has exactly this envelope:

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "idempotency key is already bound to a different payload hash",
    "retryable": false,
    "request_id": "01K2QJ7AY3R8BK4QW8Z3M6F9HE",
    "details": {}
  }
}
```

The stable codes are `MALFORMED_PAYLOAD` (400), `AUTHENTICATION_FAILED`
(401), `INSTALLATION_REVOKED` (401), `TOKEN_EXPIRED` (401), `FORBIDDEN`
(403), `NOT_FOUND` (404), `IDEMPOTENCY_CONFLICT` (409),
`SEQUENCE_CONFLICT` (409), `STALE_CONTINUITY_REVISION` (409),
`REDACTION_RACE` (409), `PAYLOAD_TOO_LARGE` (413),
`UNSUPPORTED_MEDIA_TYPE` (415), `RATE_LIMITED` (429),
`CONTINUITY_UNAVAILABLE` (503), `SERVICE_UNAVAILABLE` (503), and
`CONTINUITY_TIMEOUT` (504). Only 429, 503, and 504 carry
`retryable:true`. A 429 also carries an integer `Retry-After` header from 1 to
300 seconds.

## 5. Frozen HTTP surface

### 5.1 Installation enrollment

`POST /api/v1/codex-desktop/installations` — operator auth.

Exact request body:

```json
{
  "label": "David MacBook Pro",
  "product": "codex-macos",
  "product_version": "1.2026.224 (1427)",
  "platform": "macos",
  "adapter_version": "1"
}
```

All five strings are required. `product` must be `codex-macos`, `platform`
must be `macos`, `adapter_version` must be `1`, and other strings are trimmed
1–200 characters without control characters.

Success is HTTP 201 with exactly:

```json
{
  "installation": {
    "id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
    "label": "David MacBook Pro",
    "product": "codex-macos",
    "product_version": "1.2026.224 (1427)",
    "platform": "macos",
    "adapter_version": "1",
    "created_at": "2026-08-19T12:00:00.000Z",
    "token_expires_at": "2026-11-17T12:00:00.000Z",
    "revoked_at": null
  },
  "credential": {
    "token": "REDACTED"
  }
}
```

`REDACTED` represents the freshly generated token whose exact format is frozen
in §3.1; the provider returns the actual token in this field only once.

The provider must not commit enrollment until the token hash, expiry, and
installation row are durable. The adapter then runs an actual completion
self-test; absence or shape mismatch sets visible health
`blocked/source_contract_mismatch` and sends no inferred events.

### 5.2 Credential rotation

`POST /api/v1/codex-desktop/installations/:installation_id/rotate` — operator
auth. Exact body: `{}`. Success is HTTP 200 with exactly:

```json
{
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "credential": {
    "token": "REDACTED",
    "token_expires_at": "2026-11-17T13:00:00.000Z"
  },
  "rotated_at": "2026-08-19T13:00:00.000Z"
}
```

As in enrollment, `REDACTED` represents the actual freshly generated token,
which is returned only in this response. If an installation-scope
redaction/deletion has `client_cleanup_pending=true`, rotation instead returns
non-retryable `409 REDACTION_RACE` and changes nothing.

### 5.3 Installation revocation

`POST /api/v1/codex-desktop/installations/:installation_id/revoke` — operator
auth. Exact body:

```json
{"reason":"device retired"}
```

`reason` is required, trimmed, control-character-free, and 1–200 characters.
Success is HTTP 200 with exactly:

```json
{
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "revoked_at": "2026-08-19T14:00:00.000Z",
  "reason": "device retired"
}
```

The revocation write commits before the response. Every later installation
request fails `401 INSTALLATION_REVOKED`; cached successful auth may not be
used. If an installation-scope redaction/deletion has
`client_cleanup_pending=true`, this endpoint instead returns non-retryable
`409 REDACTION_RACE` and changes nothing; explicit revocation cannot strand the
only channel that can deliver and acknowledge the local cleanup directive.

### 5.4 Chunk ingestion

`POST /api/v1/codex-desktop/chunks` — installation auth.

Exact revision-1 request shape:

```json
{
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "opaque_session_id": "0198c5a3-3e06-72b1-9658-f15fd465c903",
  "sequence": {"first": 41, "last": 41},
  "idempotency_key": "01980000-0000-7000-8000-000000000041",
  "canonical_payload_hash": "3f70bb1417b9fc2db3a4f0b5645501607292795488bf987d279a90749ff5c76b",
  "events": [
    {
      "source_event_id": "0198c5a4-7617-77f1-85e1-3acbd77f61fc",
      "event_sequence": 41,
      "kind": "agent-turn-complete",
      "revision": 1,
      "observed_at": "2026-08-19T12:04:05.678Z",
      "opaque_turn_id": "0198c5a3-640d-7de1-8cb7-5f47d7e1cf44",
      "payload": {
        "cwd": "/Users/david/src/alfred",
        "input_messages": ["Run the migration tests."],
        "last_assistant_message": "Migration tests passed."
      }
    }
  ]
}
```

`installation_id` must equal the authenticated installation. All events must
share the top-level session, be ordered by strictly increasing
`event_sequence`, cover every integer from `sequence.first` through
`sequence.last`, and have `kind="agent-turn-complete"`, `revision=1`.
`canonical_payload_hash` is SHA-256 over the RFC 8785 canonical JSON bytes of
the object containing exactly `installation_id`, `opaque_session_id`,
`sequence`, and `events` in that order-independent canonical form.

The adapter maps O1 as follows: `thread-id` → top-level session, `turn-id` →
turn id, `cwd`/`input-messages`/`last-assistant-message` → the three payload
keys. It allocates the next session sequence and source-event UUIDv7 in the
same local transaction that stores the outbox chunk.

Success is HTTP 202. The initial delivery and every exact replay return the
same persisted status and exact body:

```json
{
  "acknowledgement_id": "01K2QJ9N8VYH4Z0S7Y6XAN1S6P",
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "opaque_session_id": "0198c5a3-3e06-72b1-9658-f15fd465c903",
  "sequence": {"first": 41, "last": 41},
  "canonical_payload_hash": "3f70bb1417b9fc2db3a4f0b5645501607292795488bf987d279a90749ff5c76b",
  "accepted_event_count": 1,
  "acknowledged_at": "2026-08-19T12:04:06.012Z",
  "continuity_revision": "01K2QJ9N9A6H3B4EVS3Y0WGS1D"
}
```

The acknowledgement is written only after every event is projected or linked
to an existing projection, except for the content-free tombstone suppression
case frozen below. Projection is stable:

- `stream="codex-desktop:<installation_id>"`,
  `channel="codex-desktop"`, `kind="agent-turn-complete"`, and
  `external_id=<source_event_id>` in the existing ingest path;
- the ingest payload contains the normalized revision-1 payload plus opaque
  session/turn ids and event hash; `existing_ingest_ref` stores its canonical
  `stream_event.id`;
- one One Alfred outbound journal entry stores the final assistant message,
  with `source_kind="codex-desktop"`, `source_ref=<source_event_id>`,
  `channel="codex-desktop"`, `chat_id=<opaque_session_id>`, and metadata
  containing the bounded input messages, cwd, opaque turn id, and event hash;
- replay links to those existing rows and never creates a second projection.

The provider resolves all uniqueness races inside one transaction. Reusing
the same `(installation, session, sequence range)`, installation-scoped
`idempotency_key`, or installation-scoped `source_event_id` with the same
canonical hash returns the original acknowledgement. Any different hash
returns non-retryable HTTP 409 (`IDEMPOTENCY_CONFLICT` or
`SEQUENCE_CONFLICT`) and changes no receipt, projection, or acknowledgement.

Before projecting a valid chunk, ingestion checks the unexpired
`codex_desktop_deletion` selectors in the same transaction. A match creates
only payload-free chunk/source receipts marked `redacted` or `deleted`, creates
no ingest or journal content, and returns the same exact HTTP 202 body shown
above; `accepted_event_count` remains the validated request event count and
`continuity_revision` is the revision advanced by the deletion. Replays return
that original acknowledgement under the same hash/conflict rules. This is the
only content-free acknowledgement/suppression shape; no additional response
field or status is permitted.

Network failures, 429, and 5xx keep the durable chunk and retry with the §3.2
backoff. `Retry-After` replaces the exponential base after clamping to 1–300,
then receives the same jitter. Authentication failures stop all delivery and
set `blocked/authentication`; 409 quarantines the chunk and sets
`blocked/conflict`; 400/413/415 quarantine it and set
`blocked/malformed_payload`. None of these terminal classes advances or
deletes the outbox sequence. Health exposes the exact reason and quarantined
count.

### 5.5 Bounded continuity read

`POST /api/v1/codex-desktop/continuity/read` — installation auth. Exact body:

```json
{
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "opaque_session_id": "0198c5a3-3e06-72b1-9658-f15fd465c903",
  "after_revision": null,
  "limit": 64,
  "max_bytes": 65536,
  "within_seconds": 86400
}
```

The three numeric values may be smaller positive integers but never larger.
Success is HTTP 200 with exactly:

```json
{
  "mode": "journal_only",
  "revision": "01K2QJ9N9A6H3B4EVS3Y0WGS1D",
  "opaque_session_id": "0198c5a3-3e06-72b1-9658-f15fd465c903",
  "window": {
    "limit": 64,
    "max_bytes": 65536,
    "within_seconds": 86400,
    "truncated": false
  },
  "entries": [
    {
      "journal_id": "01K2QJ9N91D7KPW6W95KYB3Y5M",
      "revision": "01K2QJ9N9A6H3B4EVS3Y0WGS1D",
      "ts": "2026-08-19T12:04:06.000Z",
      "direction": "outbound",
      "message": "Migration tests passed.",
      "source_kind": "codex-desktop",
      "source_ref": "0198c5a4-7617-77f1-85e1-3acbd77f61fc"
    }
  ]
}
```

Until a supported, version-pinned LCM read API is evidenced in this contract,
the provider reads only ctrl-owned journal/state data and always returns
`mode="journal_only"`. It never opens a Hermes or LCM SQLite file, even
read-only. A mismatched non-null `after_revision` returns
`409 STALE_CONTINUITY_REVISION`; a redaction observed during assembly returns
`409 REDACTION_RACE`; unavailable journal state returns 503; the 200 ms budget
returns 504. The adapter records health degradation and proceeds with the
Codex turn. Because O1/O2 expose no private pre-turn hook, revision 684-r2 does
not inject this response into Codex.

### 5.6 Adapter health

`POST /api/v1/codex-desktop/health` — installation auth. Exact body:

```json
{
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "adapter_version": "1",
  "adapter_time": "2026-08-19T12:11:00.000Z",
  "state": "healthy",
  "reason_codes": [],
  "outbox": {
    "unacknowledged_chunks": 0,
    "bytes": 0,
    "oldest_observed_at": null,
    "quarantined_chunks": 0
  },
  "last_acknowledgement_id": "01K2QJ9N8VYH4Z0S7Y6XAN1S6P",
  "applied_deletion_ids": []
}
```

`state` is `healthy|degraded|blocked`; reason codes are sorted unique values
from `source_contract_mismatch`, `network`, `rate_limited`, `server`,
`authentication`, `conflict`, `malformed_payload`, `outbox_full`,
`outbox_age_exceeded`, `continuity_timeout`, `continuity_unavailable`,
`stale_revision`, `redaction_race`, and `cleanup_pending`.

`applied_deletion_ids` contains 0–100 unique deletion ULIDs, sorted
lexicographically. Before including an id, the adapter must have
transactionally applied the complete directive as specified in §5.7. Repeated
reports for a directive previously issued to this installation are
idempotently accepted. An id that was not issued to this installation makes
the whole request fail with `400 MALFORMED_PAYLOAD`; no partial report is
committed.

Success is HTTP 200 with exactly:

```json
{
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "status": "healthy",
  "reason_codes": [],
  "server_time": "2026-08-19T12:11:00.050Z",
  "token_expires_at": "2026-11-17T12:00:00.000Z",
  "continuity": {
    "mode": "journal_only",
    "status": "available",
    "revision": "01K2QJ9N9A6H3B4EVS3Y0WGS1D",
    "last_error_code": null
  },
  "limits": {
    "outbox_max_chunks": 10000,
    "outbox_max_bytes": 67108864,
    "unacknowledged_max_age_seconds": 604800
  },
  "deletion_directives": [
    {
      "deletion_id": "01K2QK1BZCA4WX4G2S38YWMY7M",
      "selector": {
        "scope": "session",
        "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
        "opaque_session_id": "0198c5a3-3e06-72b1-9658-f15fd465c903"
      },
      "operation": "delete",
      "accepted_at": "2026-08-19T12:10:00.000Z",
      "tombstone_expires_at": "2026-11-17T12:10:00.000Z"
    }
  ]
}
```

`continuity.status` is
`available|timeout|unavailable|stale_revision|redaction_race`. Server status is
the worse of server and adapter state. Health never includes payload content,
tokens, hashes, or journal messages.

`deletion_directives` contains 0–100 objects of exactly the shape shown; no
additional item keys are permitted, and no pending directive is represented
by an empty or partial object. `selector.scope` is `session|installation` and
`operation` is `redact|delete`, with the same meanings as §5.7. For
installation scope,
`selector.opaque_session_id` is exactly `null`; for session scope it is the
exact opaque session id from the operator request. The server returns the
oldest unreported directives for the authenticated installation, ordered by
`(accepted_at, deletion_id)` ascending, and repeats each directive on every
health response until a later health request reports its id in
`applied_deletion_ids`. If more than 100 are pending, later pages become
eligible only after earlier ids are reported. Processing reports and selecting
the next response page occur in one server transaction. Each valid report sets
`client_cleanup_pending=false` and `client_applied_at` to server receipt time;
re-reporting it leaves those values unchanged. A response with no eligible
directive uses `"deletion_directives":[]`.

The health route remains available in the §3.1 health-only cleanup state. Its
HTTP 200 response uses exactly the success shape above with
`status="blocked"`, `reason_codes=["cleanup_pending"]`, and continuity
`status="unavailable"` / `last_error_code="FORBIDDEN"`; it returns no journal
entry or other content. It repeats the pending installation-scope directive
until a request reports that deletion id. On that request, ctrl-api
transactionally records the report, sets `client_cleanup_pending=false` and
`client_applied_at` on every still-pending directive for the installation (the
installation-wide local wipe subsumes every session selector), marks the
installation redacted/deleted as requested, and sets `revoked_at`. That already
authorized request returns the same exact HTTP 200 shape with
`deletion_directives=[]`; every later request returns
`401 INSTALLATION_REVOKED`. The adapter retains the token only for this final
report, erases it after the 200, and treats a subsequent
`INSTALLATION_REVOKED` after a lost response as confirmation; a network, 429,
or 5xx failure retains the payload-free local tombstone and retries health.

### 5.7 Session/installation redaction or deletion

`POST /api/v1/codex-desktop/deletions` — operator auth. Exact body:

```json
{
  "request_id": "0198c5b1-77e3-7dc0-ad9c-e713736678d9",
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "scope": "session",
  "opaque_session_id": "0198c5a3-3e06-72b1-9658-f15fd465c903",
  "operation": "delete"
}
```

`scope` is `session|installation`; `operation` is `redact|delete`. Session
scope requires a non-null session id. Installation scope requires
`opaque_session_id:null`. `request_id` makes creation idempotent; replay returns
the original response, while different selectors/operation return 409.

Success is HTTP 202 with exactly:

```json
{
  "deletion_id": "01K2QK1BZCA4WX4G2S38YWMY7M",
  "status": "pending",
  "scope": "session",
  "operation": "delete",
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "opaque_session_id": "0198c5a3-3e06-72b1-9658-f15fd465c903",
  "accepted_at": "2026-08-19T12:10:00.000Z",
  "completion_deadline": "2026-08-20T12:10:00.000Z"
}
```

`GET /api/v1/codex-desktop/deletions/:deletion_id` — operator auth, no body.
Success is HTTP 200 with exactly:

```json
{
  "deletion_id": "01K2QK1BZCA4WX4G2S38YWMY7M",
  "status": "complete",
  "scope": "session",
  "operation": "delete",
  "installation_id": "cdi_01K2QHZA7G9E2N3E9QQ7AK8F5M",
  "opaque_session_id": "0198c5a3-3e06-72b1-9658-f15fd465c903",
  "accepted_at": "2026-08-19T12:10:00.000Z",
  "completion_deadline": "2026-08-20T12:10:00.000Z",
  "completed_at": "2026-08-19T12:10:03.000Z",
  "server_complete": true,
  "client_cleanup_pending": false,
  "last_error": null
}
```

For this GET, `status` is `pending|complete|failed`; `completed_at` is null
until server completion. A failure still retains the deadline and uses the
common error envelope in `last_error` instead of content. The provider must
complete or durably mark failed within 24 hours; it never reports complete
before all server effects below commit.

Effects are ordered and idempotent:

1. Insert a `codex_desktop_deletion` control receipt keyed by `deletion_id` and
   globally unique `request_id`. `request_payload_hash` is SHA-256 over the
   RFC 8785 canonical JSON object containing exactly `request_id`,
   `installation_id`, `scope`, `opaque_session_id`, and `operation`; same-hash
   replay returns the original response and a different hash returns
   `409 IDEMPOTENCY_CONFLICT`. The row carries the exact installation/session
   selector and a 90-day
   `tombstone_expires_at`, and can exist before any matching chunk or source
   event. It is committed first. Ingestion checks every unexpired matching
   selector before creating receipt/projection rows, then returns a
   content-free acknowledgement/suppression, so a delayed first delivery or
   retry can never recreate deleted content. The deletion receipt remains the
   stable deletion-id link while matching existing chunk/event redaction states
   are updated in the same transaction.
2. For installation scope, immediately restrict the credential to the
   health-only cleanup state in §3.1; do not set `revoked_at` until the adapter
   reports the installation-wide directive. Chunk ingestion and continuity are
   unavailable during this state. For session scope, keep the credential but
   reject/suppress matching chunks.
3. Redact or delete matching existing ingest payloads and every derived row
   reachable by the stable ingest/source provenance. Redaction retains only a
   `redacted` marker and deletion id; deletion removes content. Neither creates
   a new store.
4. Redact matching One Alfred journal messages/metadata or delete their
   content, advance the continuity revision, and exclude them from every
   continuity response. LCM remains authoritative but no implementation may
   edit its SQLite directly; LCM erasure waits for an evidenced supported API
   and is surfaced as health degradation rather than guessed.
5. Return the exact §5.6 deletion directive on health. The selector matches
   every local row for its installation when scope is `installation`, or only
   rows with the byte-identical opaque session id when scope is `session`.
   Before any retry or capture after its next start/health, the adapter applies
   directives in response order and transactionally erases matching
   unacknowledged local payloads, acknowledged-retention payloads, and
   quarantined payloads. It retains only the deletion id, selector, operation,
   and `tombstone_expires_at` in the 90-day local tombstone, then reports the
   deletion id in the next health request's `applied_deletion_ids`.
6. `client_cleanup_pending` remains true until that report. For installation
   scope, the report and terminal credential revocation follow the single
   transaction and final-response rule in §5.6. An offline client can therefore
   receive and acknowledge its mandatory local wipe at its next health, and
   cannot recreate data because the server tombstone predates content removal.

Acknowledged local chunks are never removed early merely because a server
receipt exists: the fixed 24-hour local retention applies unless a redaction or
deletion directive explicitly removes them. Unacknowledged chunks otherwise
survive adapter and Codex restarts and follow the seven-day rule in §3.2.

## 6. Migration 0021 storage contract

Migration `0021_codex_desktop.sql` creates three transport
receipt/provenance tables and one bounded deletion control/tombstone table in
ctrl-owned `alfred-state.db`:

- `codex_desktop_installation`: product/version, adapter version, SHA-256 token
  hash, token expiry/rotation/revocation, bounded health, redaction/deletion,
  and retention timestamps;
- `codex_desktop_delivery_chunk`: installation/session sequence range,
  installation-scoped idempotency key, canonical payload hash, stable
  acknowledgement, projection state/reference, redaction state, and retention;
- `codex_desktop_source_event`: installation/chunk, opaque session and turn,
  source identity, session event sequence, kind/revision, canonical hash,
  ingest/journal projection references, redaction state, and retention.
- `codex_desktop_deletion`: deletion/request identity and canonical request
  hash, exact installation/session selector, operation and completion state,
  ordered client-cleanup state, tombstone expiry, and retention. It contains no
  deleted payload and may be inserted before any delivery row for its session.

Foreign keys bind event → chunk → installation and deletion → installation.
Unique indexes enforce installation-scoped idempotency,
installation/session/chunk range, installation/source-event identity,
installation/session/event sequence, and global deletion `request_id`.
Selector and directive indexes support
pre-ingest suppression and `(accepted_at,deletion_id)` health ordering. No
plaintext token, event payload, deleted content, transcript, independent user
memory, or LCM table is permitted. Physical retention sweep implementations
must preserve active deletion tombstones and honor the 30/7/30/90-day limits
in §3.2.

## 7. Required implementation and verification ownership

- **Phase 0 (this job):** contract freeze, migration 0021, static registration,
  schema/constraint/idempotency/tombstone tests.
- **ctrl lane:** auth classes, exact routes/shapes, transactional projection,
  receipt retention, journal-only continuity, health, tombstones, redaction and
  deletion. ctrl-api remains the only canonical writer.
- **adapter/infra lane:** O1 callback command, transactional local outbox,
  enrollment self-test, retry classifier, restart recovery, local deletion,
  and visible health. It must include negative tests proving prohibited
  observation methods are absent.
- **learn lane:** consume only ordinary projected ingest events, preserve
  source-event provenance through curation, and implement deterministic
  redaction of derived state through ctrl-api. No direct migration-table read.
- **Hermes lane:** preserve One Alfred/LCM authority and add no direct LCM DB
  access. A supported LCM read or erase API can be adopted only after a new
  evidence-backed phase-0 revision.

End-to-end verification must cover enrollment/rotation/revocation; expiry;
request and outbox bounds; restart persistence; same-hash replay and all four
collision identities; different-hash 409; retry/backoff classes; projection
dedupe; journal-only timeout/unavailable/stale/redaction-race degradation; and
session/installation redact/delete with a delayed retry proving the tombstone
prevents recreation.
