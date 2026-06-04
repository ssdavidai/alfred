# Paperclip secret sync

Vaultwarden is authoritative. Paperclip `local_encrypted` secrets are a read-replica written one way from Vaultwarden.

## Selection

Create a Vaultwarden folder named `paperclip` (override with `PAPERCLIP_SECRET_SYNC_FOLDER`). Put login items in that folder. The login password is the secret value.

Item names map deterministically to Paperclip keys:

- `OPENAI_API_KEY` syncs to the target company passed in the trigger.
- `<company-id>/OPENAI_API_KEY` syncs only when the route target is that company id. This is the disambiguation form for a shared Vaultwarden folder.

Secret keys must match `^[A-Za-z_][A-Za-z0-9_.-]{0,127}$`.

## Direction and deletion policy

Vaultwarden always wins. The sync never reads Paperclip as authoritative and never writes Paperclip values back to Vaultwarden.

Default behavior is additive/upsert-only:

- A selected Vaultwarden item creates or overwrites the Paperclip copy.
- A removed Vaultwarden item does not delete the Paperclip copy.
- `prune=true` is deliberately rejected by the ctrl-api route until a separate deletion gate exists.

## Safety

The route returns key names, counts, and skip reasons only. It never returns secret values. The trigger script prints the same safe response envelope.

## Manual trigger

From the ctrl package/container:

```bash
PAPERCLIP_SECRET_SYNC_COMPANY_ID=<company-id> \
AAS_API_KEY=<ctrl-api-key> \
CTRL_API_URL=http://ctrl-api:3100 \
npm run paperclip:secret-sync
```

Dry-run:

```bash
PAPERCLIP_SECRET_SYNC_COMPANY_ID=<company-id> \
AAS_API_KEY=<ctrl-api-key> \
PAPERCLIP_SECRET_SYNC_DRY_RUN=1 \
npm run paperclip:secret-sync
```

Direct API shape:

```bash
POST /api/v1/paperclip/admin/companies/:companyId/secrets/sync
Authorization: Bearer <AAS_API_KEY>
Content-Type: application/json

{"dry_run": false}
```

## Scheduled run

Default is off. To schedule it, run the same command from the tenant's preferred cron/scheduler with `PAPERCLIP_SECRET_SYNC_COMPANY_ID` set. The sync is idempotent: unchanged values upsert to the same target keys and response logs remain value-free.

Recommended cadence: every 15 minutes after Vaultwarden is configured.

## Smoke plan

1. Create a disposable login item in Vaultwarden folder `paperclip` named `PCP_SYNC_SMOKE` with a sentinel password.
2. Run the sync once and verify Paperclip can read `PCP_SYNC_SMOKE`.
3. Mutate the Paperclip copy only.
4. Run the sync again and verify Paperclip is restored to the Vaultwarden value.
5. Run with `PAPERCLIP_SECRET_SYNC_DRY_RUN=1`; confirm only key names/counts appear.
6. Remove the Vaultwarden disposable item and confirm no deletion occurs by default.
