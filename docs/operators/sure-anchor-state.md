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
      "account_id": "<lunchflow account identifier>",
      "has_provider_anchor": true,
      "provider_status": "active",
      "provider_observed_at": "2026-08-10T09:14:00Z"
    },
    {
      "account_id": "<another account>",
      "has_provider_anchor": false,
      "provider_status": "token_expired",
      "provider_observed_at": "2026-08-01T18:00:00Z"
    }
  ],
  "generated_at": "2026-08-10T10:00:00Z"
}
```

Field semantics:

| Field | Type | Meaning |
|-------|------|---------|
| `has_provider_anchor` | `true` | `current_balance IS NOT NULL` — provider delivered data this sync cycle |
| `has_provider_anchor` | `false` | `current_balance IS NULL` — Sure is falling back to a cached balance |
| `has_provider_anchor` | `null` | Column absent or unreadable — consumer must treat as **unknown**, never as fresh |
| `provider_status` | string | `raw_payload->>'status'` from the lunchflow_accounts row; `null` if column absent |
| `provider_observed_at` | ISO8601 | `lunchflow_accounts.updated_at` — when Sure last wrote this row |

## Why REST-visible timestamps were insufficient

Sure's `/api/v1/accounts` payload carries exactly two timestamps per account
(`created_at`, `updated_at`) and no balance-specific date. The two candidate
signals were measured against live fleet data:

- **`accounts.updated_at`**: advances on every sync, including failed ones.
- **`max(balances.date)`**: advances because Sure's cached-fallback path is
  itself a write that advances this date.

Measurement result:

```
stale accounts (lunchflow_accounts.current_balance IS NULL):   6
of those, max(balances.date) was today-or-yesterday:           4
```

Four out of six genuinely stale accounts would have reported as fresh.
For a feature whose purpose is trust about financial data, a confident lie is
worse than reporting nothing. The only accurate signal is
`lunchflow_accounts.current_balance IS NULL`, which lives exclusively in the
vendor-internal table this endpoint surfaces.

## Verifying on a tenant

```bash
# From any host with curl and the tenant's SURE_API_KEY:
curl -s -H "X-Api-Key: <SURE_API_KEY>" \
  https://sure.<DOMAIN>/api/v1/alfred/balance_anchor_state | jq .
```

From inside the compose stack (e.g. for local smoke):

```bash
docker exec sure-web \
  curl -s -H "X-Api-Key: ${SURE_API_KEY}" \
  http://127.0.0.1:3000/api/v1/alfred/balance_anchor_state
```

Expected: JSON with `accounts` array and `generated_at`. An empty `accounts`
array means no Lunchflow accounts are linked yet (not an error).

To confirm the patch loaded, check sure-web logs at startup for:

```
[alfred #318] ...
```

If `LunchflowAccount` is not defined (tenant with no Lunchflow integration),
the endpoint returns `{"accounts":[],"generated_at":"..."}` and logs a warning.

## Degradation modes

| Condition | Behaviour |
|-----------|-----------|
| `LunchflowAccount` model absent | `accounts: []`, logs warning, no crash |
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
