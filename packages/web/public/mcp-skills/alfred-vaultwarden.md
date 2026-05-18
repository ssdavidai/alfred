---
name: alfred-vaultwarden
description: Drive Sir's per-tenant Vaultwarden instance from claude.ai through the MCP `vaultwarden` connector. Use whenever Sir asks to read, create, rotate, or delete a tenant secret; to generate a new password; or to surface a credential value he needs in front of him. The tools speak to a long-running `bw serve` session in the vault-cli sidecar — they're cheap and idempotent (with a few documented exceptions). Pair with the `vault_refresh` tool whenever a write needs to land in the running services' env.
license: alfred-platform internal — see the parent monorepo's LICENSE
---

# Vaultwarden MCP — operator's manual

You have **14 Vaultwarden tools** through the MCP `vaultwarden` connector. They wrap a long-running `bw serve` session that holds Sir's vault unlocked in the vault-cli sidecar; ctrl-api proxies your calls there. Every operation is single-tenant — the bearer token's audience binds you to exactly one Vaultwarden instance.

`bw serve` itself is logged-in + unlocked at boot via the BW_USER + BW_PASSWORD bootstrap entries Sir set up during the david cutover. You never see the master password. You also never need to "log in" — every tool already runs inside an authenticated session.

## The 14 tools

### Read & probe (cheap, call freely)

- `vaultwarden_status` — health probe. Returns serverUrl, lastSync, userEmail. First call when something else 502s.
- `list_vault_items` — list with optional filters. **Returns name + id + metadata, NOT password values.** Use for browsing.
- `search_vault_items` — substring search. Same shape as list but POST so quotes/specials don't need URL-encoding.
- `get_vault_item` — fetch one item by id. **This is the only tool that returns `login.password` and `login.totp`.** Chain after list/search.
- `list_vault_folders` — name → id resolution for filing items.
- `list_vault_collections` / `list_vault_organizations` — read-only, mostly empty on Sir's tenant (no Bitwarden org configured by default).

### Sync

- `vaultwarden_sync` — force `bw sync`. Sir's `vault-cli` auto-syncs every 5 minutes; call this when Sir says "I just edited the X password in the web UI" so subsequent reads see the fresh value.

### Write

- `create_vault_item` — new login. NOT idempotent — re-running creates duplicates. Search by name first if retrying.
- `update_vault_item` — partial PATCH. Pass only the fields you want changed; everything else is preserved.
- `delete_vault_item` — moves to Vaultwarden's trash (recoverable from web UI for 30 days). Confirm with Sir unless he explicitly named the item.
- `create_vault_folder` — new folder. Vaultwarden allows duplicates by name; check `list_vault_folders` first if dedup matters.

### Generate & propagate

- `generate_password` — uses bw's built-in generator. Length, charset, passphrase mode all configurable. Returns the value but doesn't save it; chain with `create_vault_item({value: <returned>})`.
- `vault_refresh` — rewrite `/opt/alfred/compose/.env` from the current Vaultwarden state and restart impacted services. Defaults to `[openclaw, alfred]`; pass `services` for narrower restarts (e.g. `["sure-web", "sure-worker"]` after rotating a Sure credential).

## The two truths every flow hinges on

1. **List/search returns metadata only. `get_vault_item` returns the password.** Sir asks "what's my OpenRouter key?" — you do `search_vault_items({search: "OPENROUTER"})`, take the id, call `get_vault_item({id})`, surface `login.password`. Don't dump the whole envelope at Sir; he wants the value.

2. **Vaultwarden writes are NOT live in the running services until `vault_refresh` runs.** Vault-init regenerates `.env` from Vaultwarden on every `docker compose up`, but a single `update_vault_item` call doesn't trigger that. After rotating a credential Sir uses in production, ALWAYS chain `vault_refresh` (with the appropriate `services` list) so the new value reaches the running container. Forgetting this means the rotation lives only in Vaultwarden until the next reboot.

## Worked flows

**1. "What's my OpenRouter key?"**

```
search_vault_items({search: "OPENROUTER"})
  → [{id: "...", name: "OPENROUTER_API_KEY", ...}]
get_vault_item({id: "..."})
  → {name: "OPENROUTER_API_KEY", login: {password: "sk-or-v1-..."}}
```

Reply with the value, not the JSON.

**2. "Rotate my OpenRouter key — here's the new one: sk-or-v1-NEW…"**

```
search_vault_items({search: "OPENROUTER"})
update_vault_item({id, value: "sk-or-v1-NEW…"})
vault_refresh({})        // defaults to openclaw + alfred
```

Confirm to Sir: "Rotated and propagated. openclaw and alfred are restarting."

**3. "Generate a 40-character password and save it as STRIPE_WEBHOOK_SECRET"**

```
generate_password({length: 40, special: true})
  → {value: "..."}
create_vault_item({name: "STRIPE_WEBHOOK_SECRET", value: "<returned>"})
vault_refresh({services: ["alfred-learn"]})  // pick the right consumer
```

**4. "I just changed the Example Bank password in the web UI"**

```
vaultwarden_sync({})
search_vault_items({search: "wise"})
get_vault_item({id})
```

The sync is essential — without it the bw serve session has the stale value cached in memory.

**5. "Delete the AGENTPHONE_PHONE_NUMBER entry — it's stale"**

Confirm with Sir first, even if he named it. Then:

```
search_vault_items({search: "AGENTPHONE_PHONE_NUMBER"})
delete_vault_item({id})
vault_refresh({})
```

The trashed item is recoverable from the Vaultwarden web UI for 30 days.

**6. "Create a folder for client credentials and move all the Acme keys into it"**

```
create_vault_folder({name: "Acme"})
  → {id: "<folder-id>", name: "Acme"}
search_vault_items({search: "ACME"})
  → [{id: "id-1"}, {id: "id-2"}, ...]
update_vault_item({id: "id-1", folder_id: "<folder-id>"})
update_vault_item({id: "id-2", folder_id: "<folder-id>"})
...
```

No `vault_refresh` needed here — folder placement doesn't change the values.

## When NOT to use this connector

- **Editing the master password.** The master password is also vault-cli's auth credential; changing it via the Vaultwarden web UI without also updating `BW_PASSWORD` in `.env` bricks vault-init. There is no MCP tool for this — and there shouldn't be.
- **Bulk export of every secret.** That's what the Vaultwarden web UI's Export feature is for. The MCP shape is point-and-shoot.
- **Anything needing attachments / sends / password history.** Not exposed in this catalogue. Use the web UI.
- **Provisioning a fresh tenant's Vaultwarden.** That's `setupVaultwarden` in the provisioner — not callable from claude.ai.

## Good behaviour

1. **Always search before create.** Vaultwarden allows duplicate names; you'll embarrass yourself adding a second `OPENROUTER_API_KEY` next to the existing one.
2. **`update_vault_item` PATCHes — pass only the fields you want changed.** The server merges with the existing record; passing `{id, value: "new"}` keeps name/username/notes intact.
3. **Chain `vault_refresh` whenever you write a value.** Without it, the rotation only exists in Vaultwarden — the container that actually consumes the secret hasn't seen it yet.
4. **Reply in prose, not envelope.** `{name, login: {password}}` is for your reasoning. The first character of any Sir-facing message is never `{`.
5. **`get_vault_item` is the only password-returning tool.** Don't try to read passwords through `list_vault_items` or `search_vault_items` — they're metadata-only by design.
6. **Confirm before delete.** Unless Sir named the item explicitly, ask. Trash is recoverable but mistakes still cost Sir time.
