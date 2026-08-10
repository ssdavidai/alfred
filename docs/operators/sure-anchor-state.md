# Sure balance anchor state endpoint

Operator runbook for the `GET /api/v1/alfred/balance_anchor_state` endpoint
injected into `sure-web` by
`scripts/sure-patches/expose_balance_anchor_state.rb` (#318).

## What the endpoint reports

Per-account ground-truth anchor state from the vendor-internal
`lunchflow_accounts` table, which Sure's own REST API does not expose.

```
GET https://sure.<DOMAIN>/api/v1/alfred/balance_anchor_state
X-Api-Key: <SURE_API_KEY>
```

Response:

```json
{
  "accounts": [
    {
      "account_id": "550e8400-e29b-41d4-a716-446655440000",
      "has_provider_anchor": true,
      "provider_status": "active",
      "provider_observed_at": "2026-08-10T09:14:00Z"
    },
    {
      "account_id": "550e8400-e29b-41d4-a716-446655440001",
      "has_provider_anchor": false,
      "provider_status": "token_expired",
      "provider_observed_at": "2026-08-01T18:00:00Z"
    }
  ],
  "unlinked_provider_accounts": 3,
  "generated_at": "2026-08-10T10:00:00Z"
}
```

Field semantics:

| Field | Type | Meaning |
|-------|------|---------|
| `account_id` | 36-char UUID | `accounts.id` — Sure's internal account identifier, **not** the provider's external short id |
| `has_provider_anchor` | `true` | `current_balance IS NOT NULL` — provider delivered data this sync cycle |
| `has_provider_anchor` | `false` | `current_balance IS NULL` — Sure is falling back to a cached balance |
| `has_provider_anchor` | `null` | Column absent or unreadable — consumer must treat as **unknown**, never as fresh |
| `provider_status` | string | `raw_payload->>'status'` from the lunchflow_accounts row; `null` if column absent |
| `provider_observed_at` | ISO8601 | `lunchflow_accounts.updated_at` — when Sure last wrote this row |
| `unlinked_provider_accounts` | integer | Lunchflow provider rows with no linked Sure account — omitted from `accounts[]` |

## Why REST-visible timestamps were insufficient

Sure's `/api/v1/accounts` payload carries exactly two timestamps per account
(`created_at`, `updated_at`) and no balance-specific date. The two candidate
signals were measured against live fleet data:

- **`accounts.updated_at`**: advances on every sync, including failed ones.
- **`max(balances.date)`**: advances because Sure's cached-fallback path is
  itself a write that advances this date.

Measurement result:

```
provider-backed accounts (linked via account_providers):         13
of those, has_provider_anchor = false (current_balance IS NULL): 12
of those, max(balances.date) was today-or-yesterday:              9
```

Nine of twelve genuinely stale accounts would have reported as fresh.
For a feature whose purpose is trust about financial data, a confident lie is
worse than reporting nothing. The only accurate signal is
`lunchflow_accounts.current_balance IS NULL`, which lives exclusively in the
vendor-internal table this endpoint surfaces.

## Account linkage

`lunchflow_accounts.account_id` is the **provider's external id** (5 chars
on the measured tenant), not Sure's `accounts.id` UUID (36 chars). The
endpoint traverses the polymorphic `account_providers` table:

```
LunchflowAccount
  → account_providers (provider_type = 'LunchflowAccount', provider_id = lunchflow_accounts.id)
  → accounts.id  (the 36-char UUID)
```

Of 16 lunchflow rows on the measured tenant, 13 resolved to a Sure account.
The 3 unlinked rows appear in `unlinked_provider_accounts` and are omitted
from `accounts[]`. Do not attempt to match them by name — an unlinked provider
row is not an account.

## Verifying on a tenant

**Step 1 — confirm the route exists.** A missing route and "not deployed" are
indistinguishable from a 404; check the route table first:

```bash
docker exec sure-web bin/rails routes | grep anchor
# Must print one line containing balance_anchor_state
```

**Step 2 — confirm the patch loaded.** Look for the boot log line:

```bash
docker logs sure-web 2>&1 | grep "alfred #318"
# Expected: [alfred #318] balance anchor state patch loaded — GET /api/v1/alfred/balance_anchor_state
```

**Step 3 — exercise the endpoint:**

```bash
# From any host with the tenant's SURE_API_KEY:
curl -s -H "X-Api-Key: <SURE_API_KEY>" \
  https://sure.<DOMAIN>/api/v1/alfred/balance_anchor_state | jq .

# From inside the compose stack:
docker exec sure-web \
  curl -s -H "X-Api-Key: ${SURE_API_KEY}" \
  http://127.0.0.1:3000/api/v1/alfred/balance_anchor_state
```

**UUID validation check** — all returned `account_id` values must be 36-char
UUIDs. If any are shorter, the association traversal is broken:

```bash
curl -s -H "X-Api-Key: <SURE_API_KEY>" \
  https://sure.<DOMAIN>/api/v1/alfred/balance_anchor_state \
  | jq '.accounts[].account_id | length'
# Every line must print 36.
```

## The API key appears in sure-web logs

Sure's request logger writes full request headers — including `X-Api-Key` — to
stdout on every request. This means `SURE_API_KEY` will appear in
`docker logs sure-web` on every poll of this endpoint.

The initializer adds `HTTP_X_API_KEY` and `X_Api_Key` to Rails'
`filter_parameters`, which redacts the key from Rails' own controller-level
param logs. It does **not** cover Sure's middleware-level header dump
(`headers_json`), which runs before Rails' filter machinery.

A structural fix would require either configuring Sure's own request logger to
redact authentication headers, or adding a header-stripping Rack middleware
before Sure's logger — both of which are outside the scope of an initializer
patch. Anyone reading `docker logs sure-web` should know the log stream
contains a credential. Rotation of the key is Sir's call.

## Degradation modes

| Condition | Behaviour |
|-----------|-----------|
| `LunchflowAccount` model absent | `accounts: []`, `unlinked_provider_accounts: 0`, logs warning, no crash |
| `account` association absent | `has_provider_anchor` resolved, account omitted from `accounts[]`, counted in `unlinked_provider_accounts` |
| `current_balance` column absent | `has_provider_anchor: null` for affected rows |
| `raw_payload` column absent | `provider_status: null` for affected rows |
| `lunchflow_accounts` table missing | `accounts: []`, logs error, no crash |
| Wrong or missing `X-Api-Key` | HTTP 401 `{"error":"Unauthorized"}` |
| `SURE_API_KEY` env unset | HTTP 401 (empty expected key always rejects) |

## Removing this patch

Remove when Sure exposes balance anchor state through its own REST API. Signs:

- `GET /api/v1/accounts` response includes a `freshness`, `anchor`, or
  `provider_balance_at` field per account.
- Sure release notes mention "balance freshness" or "provider anchor" exposure.

Removal steps:

1. Delete `scripts/sure-patches/expose_balance_anchor_state.rb`
2. Remove the corresponding `volumes:` line from `sure-web` in `docker-compose.yaml`
3. Update `packages/ctrl/src/api/routes/sure.ts` to use the native field instead
   of calling this endpoint
4. Restart `sure-web`
