# Issue #59: Staging Tenant for Pre-Production Testing

## Problem

Today, every Docker image build (`build-learn.yml`, `build-openclaw.yml`, `build-alfred.yml`) pushes `:latest` to DockerHub immediately. The `update --all` command (or `alfred-update.timer` on tenants) then pulls `:latest` and restarts containers on production tenants. There is no gate between "image built" and "image running on customer infrastructure." A broken image goes straight to every tenant.

The deploy-saas and deploy-ctrl pipelines have a similar gap: they rsync directly to the production SaaS host and restart, with only a basic HTTP status code health check.

## Current System Summary

### Provisioning (17 steps in provisioner.ts)

1. Create DB record
2. Generate Ed25519 SSH keypair
3. Upload SSH key to Hetzner
4. Ensure firewall (SSH + ICMP only)
5. Create 20GB encrypted volume
6. Render cloud-init (user creation, packages, LUKS)
7. Create Hetzner VPS (cx53)
8. Wait for cloud-init completion (up to 5 min)
9. Upload .env secrets via SSH
10. Configure restic backups to Hetzner Object Storage
11. Upload docker-compose.yaml
12. Start containers (init + temporal, then openclaw, alfred, alfred-learn, ctrl-api)
13. Bootstrap OpenClaw + Tailscale
14. Backup LUKS keyfile locally
15. Setup Cloudflare Tunnel + DNS
16. Deploy/finalize tenant API (ctrl-api)
17. Health check

### Docker Image Pipeline

| Image | Workflow | Trigger | Rollout |
|-------|----------|---------|---------|
| `alfred-learn` | `build-learn.yml` | `packages/learn/**` | Push `:latest` + `:$sha`, then `update --all` via SSH |
| `alfred-openclaw` | `build-openclaw.yml` | `packages/openclaw/**` | Push `:latest` + `:sha-$short`, then fleet-update API |
| `alfred-init` | `build-alfred.yml` | `packages/openclaw/init/**` | Push `:latest` only |
| `alfred-worker` | `build-alfred.yml` | `packages/openclaw/dockerfiles/**` | Push `:latest` only |

### Tenant Stack (docker-compose.yaml.njk)

Six services: `init`, `temporal`, `openclaw`, `alfred`, `ctrl-api`, `alfred-learn`. All custom images use `:latest`. Tenants pull updates via `alfred-update.timer` (scheduled `docker compose pull && up -d`).

### Smoke Test (scripts/smoke-test.sh)

Checks 7 things on a tenant: 4 containers running, OpenClaw health endpoint, Temporal cluster health, ctrl-api responds, disk < 90%, memory < 95%, cloudflared active.

## Options Evaluated

### Option A: Permanent Staging VPS

A dedicated Hetzner VPS (cx53, ~$36/month) provisioned once and kept running. Every CI build deploys to staging first, runs smoke tests, then promotes images.

**Pros:** Always warm (no 5-min provision wait), mirrors production exactly, can accumulate state to catch data-migration bugs, reusable for manual QA.

**Cons:** Ongoing cost (~$36/mo), needs its own Tailscale node and Cloudflare tunnel, must be maintained (disk cleanup, cert renewal).

### Option B: Ephemeral Staging (provision + test + destroy)

Spin up a fresh tenant for each build, run smoke tests, destroy it.

**Pros:** No ongoing cost, tests full provisioning path every time, perfectly clean slate.

**Cons:** Provisioning takes 5-8 minutes (cloud-init + image pulls + bootstrap), adds significant CI time to every build, exercises the provisioner (which itself could fail and block deploys), cannot test data-migration scenarios.

### Option C: Reuse Existing Test Tenant (alfred-david-mn36flsy)

Use David's existing test tenant as the staging target.

**Pros:** Zero additional cost, already provisioned and warm, has real-ish state for testing.

**Cons:** Staging failures corrupt a tenant someone might be using, not isolated, name collision between "David's test tenant" and "CI staging," risky to automate destructive operations on it.

## Recommendation: Option A (Permanent Staging VPS)

Option A is the right choice. The $36/month cost is negligible compared to the risk of pushing broken images to every paying tenant simultaneously. Ephemeral staging (B) is too slow for the feedback loop and adds provisioner-as-dependency risk. Reusing an existing tenant (C) violates isolation.

## Design

### 1. Staging Tenant Identity

- **Name:** `staging`
- **Hetzner VPS:** `alfred-staging` (cx53, fsn1)
- **Tailscale hostname:** `alfred-staging`
- **Subdomain:** `staging.alfred.black` (Cloudflare Tunnel)
- **Provisioned once** using the standard 17-step provisioner, then kept running

The staging tenant is a normal tenant in the ctrl database with `customer_name: staging`. It is distinguished only by convention and by the CI workflows that target it.

### 2. Image Tag Strategy: Build SHA, Not Latest

The core change: CI builds push images tagged with the git SHA only (not `:latest`). Promotion to `:latest` happens only after staging passes.

**Current flow:**
```
build → push :latest → update --all (production)
```

**New flow:**
```
build → push :sha-<short> → deploy to staging → smoke test → promote :sha-<short> to :latest → update --all (production)
```

### 3. New Workflow: `staging-gate.yml`

A reusable workflow called after each image build. It is triggered by `workflow_call` from the build workflows.

```yaml
name: Staging Gate
on:
  workflow_call:
    inputs:
      image:
        description: "Full image name (e.g. ssdavidai00/alfred-learn)"
        required: true
        type: string
      tag:
        description: "SHA tag to test (e.g. sha-abc1234)"
        required: true
        type: string
      services:
        description: "Space-separated container names to restart (e.g. 'alfred-learn' or 'openclaw alfred')"
        required: true
        type: string

jobs:
  staging:
    runs-on: ubuntu-latest
    concurrency:
      group: staging-gate
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4

      - name: Setup SSH
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.DEPLOY_SSH_KEY }}" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          ssh-keyscan -H ${{ secrets.DEPLOY_HOST }} >> ~/.ssh/known_hosts

      - name: Get staging tenant IP
        id: staging
        run: |
          IP=$(ssh -i ~/.ssh/deploy_key deploy@${{ secrets.DEPLOY_HOST }} \
            'cd /opt/alfred-saas/alfred-ctrl && node --experimental-sqlite dist/index.mjs list --json --status running' \
            | python3 -c "import sys,json; tenants=json.load(sys.stdin); print(next(t['ip_address'] for t in tenants if t['customer_name']=='staging'))")
          echo "ip=$IP" >> "$GITHUB_OUTPUT"

          # Get the SSH key path and copy it to a temp location
          KEY_PATH=$(ssh -i ~/.ssh/deploy_key deploy@${{ secrets.DEPLOY_HOST }} \
            'cd /opt/alfred-saas/alfred-ctrl && node --experimental-sqlite dist/index.mjs list --json --status running' \
            | python3 -c "import sys,json; tenants=json.load(sys.stdin); print(next(t['ssh_key_path'] for t in tenants if t['customer_name']=='staging'))")
          HOST_KEY="${KEY_PATH//\/app\/alfred-ctrl/\/opt\/alfred-saas\/alfred-ctrl}"
          ssh -i ~/.ssh/deploy_key deploy@${{ secrets.DEPLOY_HOST }} "sudo cat $HOST_KEY" > ~/.ssh/staging_key
          chmod 600 ~/.ssh/staging_key

      - name: Pin image SHA on staging
        run: |
          # SSH to staging tenant and update the compose image tag
          ssh -i ~/.ssh/staging_key -o StrictHostKeyChecking=no deploy@${{ steps.staging.outputs.ip }} "
            cd /opt/alfred/compose
            for SVC in ${{ inputs.services }}; do
              # Replace image tag for matching service
              sed -i \"s|${{ inputs.image }}:.*|${{ inputs.image }}:${{ inputs.tag }}|\" docker-compose.yaml
            done
            docker compose pull ${{ inputs.services }}
            docker compose up -d --force-recreate ${{ inputs.services }}
          "

      - name: Wait for services to stabilize
        run: sleep 30

      - name: Run smoke test
        run: |
          ssh -i ~/.ssh/staging_key -o StrictHostKeyChecking=no deploy@${{ steps.staging.outputs.ip }} \
            'bash -s' < scripts/smoke-test.sh

      - name: Promote image to :latest
        if: success()
        run: |
          # Pull the SHA-tagged image locally, retag as :latest, push
          echo "${{ secrets.DOCKERHUB_TOKEN }}" | docker login -u "${{ secrets.DOCKERHUB_USERNAME }}" --password-stdin
          docker pull ${{ inputs.image }}:${{ inputs.tag }}
          docker tag ${{ inputs.image }}:${{ inputs.tag }} ${{ inputs.image }}:latest
          docker push ${{ inputs.image }}:latest

      - name: Reset staging to :latest
        if: always()
        run: |
          ssh -i ~/.ssh/staging_key -o StrictHostKeyChecking=no deploy@${{ steps.staging.outputs.ip }} "
            cd /opt/alfred/compose
            for SVC in ${{ inputs.services }}; do
              sed -i \"s|${{ inputs.image }}:${{ inputs.tag }}|${{ inputs.image }}:latest|\" docker-compose.yaml
            done
            docker compose pull ${{ inputs.services }}
            docker compose up -d --force-recreate ${{ inputs.services }}
          " || true
```

### 4. Changes to Existing Build Workflows

Each build workflow stops pushing `:latest` directly and instead calls the staging gate.

**build-learn.yml** changes:
- Build step pushes only `:sha-<short>` (drop `:latest` from tags)
- Remove the `update --all` step
- Add `staging-gate` job that calls `staging-gate.yml` with `image: ssdavidai00/alfred-learn`, `tag: sha-<short>`, `services: alfred-learn`
- Add `rollout` job (after staging-gate passes) that runs `update --all`

**build-openclaw.yml** changes:
- Build step pushes only `:sha-<short>` (drop `:latest`)
- Remove fleet-update curl
- Add staging-gate call with `services: openclaw`
- Add rollout job

**build-alfred.yml** changes:
- Both build-init and build-worker push `:sha-<short>` only
- Add staging-gate call with `services: init alfred` (init + worker)
- Add rollout job

### 5. Staging Tenant Provisioning

One-time manual provisioning via the ctrl CLI:

```bash
cd /opt/alfred-saas/alfred-ctrl
node --experimental-sqlite dist/index.mjs provision staging \
  --server-type cx53 --location fsn1
```

No special flags needed -- it goes through the standard 17-step process. After provisioning, the tenant is left running permanently.

To prevent the `alfred-update.timer` on the staging tenant from pulling `:latest` on its own schedule (which would bypass the staging gate), disable the timer:

```bash
ssh deploy@<staging-ip> 'sudo systemctl disable --now alfred-update.timer'
```

### 6. Staging Tenant Maintenance

- **No auto-update:** The `alfred-update.timer` is disabled. Only CI updates staging.
- **Disk cleanup:** A monthly cron on the staging VPS prunes old Docker images: `docker image prune -af --filter "until=168h"`
- **Monitoring:** The staging tenant is included in the normal health check sweep (`health` command). Alerts fire if it goes down, but staging-down does not block production (it blocks new deploys until fixed).
- **State reset:** If staging accumulates too much state, `destroy` + re-provision. This is rare -- the staging tenant does not receive real user traffic.

### 7. Failure Modes

| Scenario | Behavior |
|----------|----------|
| Smoke test fails | Image is NOT promoted to `:latest`. Production tenants stay on the previous version. CI job fails visibly. Staging is reset to `:latest`. |
| Staging tenant is unreachable | CI job fails. No images are promoted. Alert fires from health monitor. Manual intervention required. |
| Two builds race | `concurrency: staging-gate` serializes them. Second build queues. |
| Staging tenant destroyed accidentally | Re-provision with the same name. CI resumes automatically. |

### 8. Rollback

If a bad image somehow reaches production (e.g., staging test passes but production fails):

1. The existing `update --all` with a specific SHA can pin production tenants to the last-known-good image
2. The `last_healthy_sha` field in the instances table (already tracked by health monitoring) identifies the safe version
3. Future enhancement: automated rollback when post-rollout health checks fail

## Implementation Plan

### Phase 1: Provision staging tenant (manual, ~15 min)
- [ ] Run `provision staging` from the ctrl CLI on the SaaS host
- [ ] Disable `alfred-update.timer` on the staging VPS
- [ ] Verify smoke-test.sh passes on the staging tenant

### Phase 2: Add staging-gate workflow (~1 hour)
- [ ] Create `.github/workflows/staging-gate.yml`
- [ ] Modify `build-learn.yml`: drop `:latest` push, add staging-gate + rollout jobs
- [ ] Modify `build-openclaw.yml`: same pattern
- [ ] Modify `build-alfred.yml`: same pattern

### Phase 3: Verify end-to-end (~30 min)
- [ ] Push a trivial change to `packages/learn/` and verify the full flow: build SHA-tagged image, deploy to staging, smoke test, promote to `:latest`, rollout to production tenants
- [ ] Verify failure path: push a deliberately broken change, confirm it does NOT reach production

### Phase 4: SaaS + ctrl pipelines (future)
- [ ] Extend the staging gate to `deploy-saas.yml` and `deploy-ctrl.yml` (these deploy to the SaaS host, not tenants, so the staging gate pattern is different -- more like a canary deploy of the SaaS app itself)

## Cost

- Hetzner cx53: ~EUR 32.59/month ($36 USD)
- Hetzner volume 20GB: ~EUR 0.96/month
- Total: ~$37/month ongoing

## Open Questions

1. **Should staging run the full tenant stack including Temporal workflows?** Recommendation: yes, so that alfred-learn bugs are caught before production. The staging tenant will not have real user data, but the workflows exercise code paths.
2. **Should we add integration tests beyond smoke-test.sh?** The smoke test checks that containers are running and endpoints respond. A deeper test (e.g., send a message through OpenClaw and verify alfred processes it) would catch more bugs but requires test fixtures and API credentials. Defer to a follow-up issue.
3. **Should staging share the same Tailscale tailnet as production?** Yes -- the staging tenant needs to be reachable from the SaaS host for the ctrl API proxy to work during manual QA.
