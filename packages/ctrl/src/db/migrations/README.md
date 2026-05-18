# state.db migrations

SQL files applied in order to `/var/lib/alfred/state.db` (the per-tenant
working-memory database, separate from `data/alfred-ctrl.db`).

## Conventions

- Filename format: `NNN_short_name.sql` (e.g. `002_vault_index.sql`). `NNN` is a
  zero-padded integer; the leading digits are parsed as the version number.
- Plain SQL only. No JS, no parameter binding, no templating.
- Each file is applied inside a single transaction. On error the runner rolls
  back and crashes the boot.
- **Never edit a migration after it has been merged to `main`.** Add a new
  migration that alters the prior one if you need to fix a mistake.
- Migrations are bundled into the ctrl binaries at build time via esbuild's
  `.sql` text loader, so the on-disk path is irrelevant at runtime.
- Re-running with no new migrations is a no-op; idempotency is the runner's job,
  not the SQL's.
