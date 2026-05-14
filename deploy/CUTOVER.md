# Alfred Black 1.0 — M9 Cutover Runbook

This runbook covers the swap of the production SaaS app on `alfred-control`
(serving `alfred.black`) from `main` to the `feat/alfred-black-1.0` branch
build. Preview infra (`preview.alfred.black`, Hetzner VM `130279227`) has
been running the candidate build with `WASP_DISABLE_JOBS=true` and
`WRITE_BLOCK_TENANT_OPS_DENYLIST` set to the four prod tenant hostnames,
so the only meaningful change at cutover is unsetting those two env vars
on the prod control plane and pointing `alfred.black` at the new build.

---

## 1. Pre-cutover checklist

Confirm every item before scheduling the cutover window. Preview must
have been green for the agreed soak period and all blocker issues
closed: preview deployment to `preview.alfred.black` healthy for the
last 7 days (no Caddy 502s, no Wasp app crash-loops, healthMonitor
returning ok against itself); M-1 plus M0..M8 all closed in Plane;
admin sign-off recorded as a comment on issue #872; Polar webhook URL
on the Polar dashboard double-checked to still target
`https://alfred.black/payments-webhook` (no preview override left
behind); Caddy config diff (`deploy/Caddyfile`) reviewed and clean —
no stray `preview.alfred.black` block leaking onto prod; prod Postgres
backup taken within the previous hour and its restore command rehearsed
locally so we know it actually round-trips.

## 2. Maintenance announcement template

Send to active subscribers ~24h before the window, again 30 minutes
prior, and once when complete. Tenant principals (the four prod tenant
human contacts) get a direct heads-up alongside the broadcast.

```
Subject: Brief Alfred maintenance window — <DATE> <TIME UTC>

We're rolling out Alfred Black 1.0 on <DATE> between <START> and
<END> UTC. The dashboard at alfred.black will be unavailable for
roughly 5 minutes while we swap the SaaS app build. Your tenant
instance keeps running normally — only the management dashboard is
briefly offline. Email + Telegram entrypoints into your tenant are
unaffected.

If anything looks off after the window, reply to this email or ping
@alfred on Telegram.

— Alfred ops
```

Tenant principal heads-up (sent individually):

```
Hey <NAME> — quick heads-up that the alfred.black dashboard will be
offline for ~5 minutes around <TIME UTC> on <DATE> for the 1.0
rollout. Your tenant box keeps running. If you notice anything
weird in your inbox/agent during that window, screenshot and send.
```

## 3. Cutover steps

Run from a workstation with SSH access to `alfred-control`. All times
are wall-clock targets, not strict SLAs. Total budget ~10 minutes.

1. **Stop prod Wasp on alfred-control (~30s).** SSH in, then
   `cd /opt/alfred-saas && docker compose stop app && docker compose rm -f app`.
   Caddy keeps running, returns 502 until step 5 — that's the
   maintenance window the announcement promised.
2. **Run final Prisma migration if any (~1 min).** Triggered by the
   deploy workflow itself (`docker compose run --rm --no-deps --entrypoint
   "" app npx prisma db push ...`), but if you're doing the rsync by hand,
   run the same one-liner from `/opt/alfred-saas/wasp-build` after the
   build is in place. Skip on a no-schema-delta cutover.
3. **Rsync feat-branch build to alfred-control's `/opt/alfred-saas/` (~2 min).**
   Either trigger `deploy-saas.yml` against the merged commit OR rsync
   manually from a local `wasp build` of `feat/alfred-black-1.0`. The
   rsync command mirrors the deploy workflow — `wasp-build/` plus
   `client/`, `--exclude=web-app/ --exclude=node_modules/`.
4. **Unset preview safety belts on alfred-control's `.env.server` (~30s).**
   `sed -i '/^WASP_DISABLE_JOBS=/d; /^WRITE_BLOCK_TENANT_OPS_DENYLIST=/d' /opt/alfred-saas/.env.server`.
   Verify with
   `grep -E '^(WASP_DISABLE_JOBS|WRITE_BLOCK_TENANT_OPS)' /opt/alfred-saas/.env.server`
   — must return nothing. These two vars must NOT survive into prod;
   the workers are needed and proxyToTenant must accept writes again.
5. **Restart Wasp service (~30s).**
   `cd /opt/alfred-saas && docker compose up -d --force-recreate app`.
   Watch `docker compose logs -f app` until "Server listening" appears.
6. **Verify Caddy still serves; smoke `/desk` as admin (~1 min).**
   `curl -sSf https://alfred.black/auth/me` should return JSON (401 is
   fine — auth wall is up). Then sign in as the admin account in a
   browser and load `/desk`; instance list and per-tenant subdomain
   links must resolve.
7. **Run `scripts/smoke-test.sh` against `david` tenant (~2 min).**
   Validates the full stack: Tailscale Serve → ctrl-api auth → vault
   read → openclaw health → temporal scheduling. A green run here
   means proxyToTenant writes are flowing again post-step-4 and tenant
   plane is intact.
8. **Watch healthMonitor + Polar webhook errors for 30 min.** Tail
   `docker compose logs -f app | grep -E '(healthMonitor|payments-webhook|ERROR)'`.
   Polar webhook errors mean the webhook URL drifted; healthMonitor
   errors against a specific tenant mean reconcile-tunnel work needed.
   No errors = green.
9. **Lift maintenance banner, announce completion.** Send the
   "complete" variant of the maintenance email; ping tenant principals
   directly with a one-liner.
10. **Begin 7-day hold.** Sir explicitly waived the 7-day hold for this
    run — see issue #872 sign-off — so step 10 collapses into "monitor
    healthMonitor + paid-conversion funnel for 24h, then proceed
    directly to post-cutover decommission". Documenting the waiver
    here so the next rollout doesn't quietly inherit it.

## 4. Rollback procedure (≤5 min)

If steps 5–8 surface a regression we can't hot-patch, roll back the
build, not the schema (`prisma db push` is forward-compatible by
construction in this project). Procedure:

1. SSH to `alfred-control`, `cd /opt/alfred-saas`.
2. The previous prod build is preserved at `/opt/alfred-saas/wasp-build.prev`
   if the deploy script mirrored cleanly; if not, check
   out the previous commit on a workstation, `wasp build`, and rsync
   the result back to `wasp-build/`.
3. `docker compose stop app && docker compose rm -f app`.
4. `cd /opt/alfred-saas/wasp-build && docker build -t alfred-saas:latest .`.
5. `cd /opt/alfred-saas && docker compose up -d --force-recreate app`.
6. `curl -sSf https://alfred.black/auth/me` to verify; smoke `/desk`.

Total wall time ~5 minutes if `wasp-build.prev` exists, ~15 if you
have to rebuild from a previous commit. Schema does not need to be
rewound — the new schema is a strict superset. If a hot-patch beats
rollback (single bad migration, single bad activity), prefer the
hot-patch and skip the rollback.

## 5. Post-cutover

After 24h of green metrics (per the waived 7-day hold), retire the
preview lane. Close issue #872 with the cutover timestamp + any
incidents observed; flip the M9 issue to Done in Plane. Then:

- **Delete preview Hetzner VM 130279227.** Use `hcloud server delete
  130279227` from the SaaS host or run `alfred-ctrl destroy preview`
  if it was ever registered. Confirm the VM is gone in the Hetzner
  Cloud console and the firewall + volume + SSH key references are
  released.
- **Remove the `preview.alfred.black` DNS record (Cloudflare record id
  `33e11b967ed1b214b2e0be301da07643`).** `curl -X DELETE` against
  `https://api.cloudflare.com/client/v4/zones/<zone>/dns_records/33e11b967ed1b214b2e0be301da07643`
  with the CF API token from memory (cloudflare-api-token.md).
- **Retire `.github/workflows/deploy-preview.yml`** by deleting the
  file in a follow-up PR; the workflow has no further purpose now
  that preview infra is gone, and leaving it armed risks an
  accidental push triggering a deploy to a non-existent host.
- **Drop `WASP_DISABLE_JOBS` and `WRITE_BLOCK_TENANT_OPS*` from any
  preview-only documentation.** The env switches stay in the codebase
  (cheap insurance for the next preview lane), but they should not be
  referenced as live config anywhere.
