#!/usr/bin/env bash
# rollout-slim-image.sh — Deploy slimmed OpenClaw image to a tenant
#
# Updates the compose file to add qmd-cache volume mount, creates the
# cache directory, pulls the new image, and restarts the openclaw containers.
#
# Usage:
#   ./scripts/rollout-slim-image.sh <ssh_key_path> <tenant_ip>
#
# Example:
#   ./scripts/rollout-slim-image.sh ~/.ssh/alfred-tenant-77 100.82.106.30
#   ./scripts/rollout-slim-image.sh data/ssh_keys/79/id_ed25519 100.81.42.126
#
# The script is safe to run multiple times (idempotent).
set -euo pipefail

SSH_KEY="${1:?Usage: $0 <ssh_key_path> <tenant_ip>}"
TENANT_IP="${2:?Usage: $0 <ssh_key_path> <tenant_ip>}"
SSH_OPTS="-o IdentityAgent=none -o StrictHostKeyChecking=no -o ConnectTimeout=10"
COMPOSE_DIR="/opt/alfred/compose"

echo "=== Rollout slim OpenClaw image to ${TENANT_IP} ==="
echo ""

# Step 1: Check connectivity
echo "[1/6] Checking connectivity..."
ssh ${SSH_OPTS} -i "${SSH_KEY}" deploy@"${TENANT_IP}" "hostname" || {
    echo "ERROR: Cannot connect to ${TENANT_IP}"
    exit 1
}

# Step 2: Create qmd-cache directories (persist GGUF models across restarts)
echo "[2/6] Creating qmd-cache directories..."
ssh ${SSH_OPTS} -i "${SSH_KEY}" deploy@"${TENANT_IP}" "
    sudo mkdir -p /mnt/encrypted/openclaw/qmd-cache /mnt/encrypted/openclaw-workers/qmd-cache
    sudo chown -R 1000:1000 /mnt/encrypted/openclaw/qmd-cache /mnt/encrypted/openclaw-workers/qmd-cache
    echo '  Created qmd-cache dirs'
"

# Step 3: Patch compose file to add qmd-cache volume mount (idempotent)
echo "[3/6] Patching docker-compose.yaml..."
ssh ${SSH_OPTS} -i "${SSH_KEY}" deploy@"${TENANT_IP}" "
    cd ${COMPOSE_DIR}

    # Check if already patched
    if grep -q 'qmd-cache' docker-compose.yaml 2>/dev/null; then
        echo '  Already patched (qmd-cache mount exists)'
    else
        # Backup
        cp docker-compose.yaml docker-compose.yaml.pre-slim-rollout

        # Add qmd-cache volume mount after the openclaw state mount for both services
        # For openclaw: add after /mnt/encrypted/openclaw:/home/node/.openclaw
        sed -i '/\/mnt\/encrypted\/openclaw:\/home\/node\/.openclaw$/a\\      - /mnt/encrypted/openclaw/qmd-cache:/home/node/.cache/qmd' docker-compose.yaml

        # For openclaw-workers: add after /mnt/encrypted/openclaw-workers:/home/node/.openclaw
        sed -i '/\/mnt\/encrypted\/openclaw-workers:\/home\/node\/.openclaw$/a\\      - /mnt/encrypted/openclaw-workers/qmd-cache:/home/node/.cache/qmd' docker-compose.yaml

        # Verify
        PATCHES=\$(grep -c 'qmd-cache' docker-compose.yaml)
        echo \"  Patched (${PATCHES} qmd-cache mounts added)\"
    fi
"

# Step 4: Pull new image
echo "[4/6] Pulling new image (this may take a few minutes)..."
ssh ${SSH_OPTS} -i "${SSH_KEY}" deploy@"${TENANT_IP}" "
    cd ${COMPOSE_DIR}
    docker compose pull openclaw openclaw-workers 2>&1 | tail -3
"

# Step 5: Restart openclaw containers with new image
echo "[5/6] Restarting openclaw containers..."
ssh ${SSH_OPTS} -i "${SSH_KEY}" deploy@"${TENANT_IP}" "
    cd ${COMPOSE_DIR}
    # Use --no-deps to avoid restarting ctrl-api (which causes a 502 cascade)
    docker compose up -d --no-deps --force-recreate openclaw 2>&1
    echo '  openclaw restarted'

    # Wait for openclaw to be healthy before restarting workers
    echo '  Waiting for openclaw health...'
    for i in \$(seq 1 30); do
        if docker compose exec -T openclaw node -e \"fetch('http://localhost:18789/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\" 2>/dev/null; then
            echo '  openclaw healthy'
            break
        fi
        if [ \"\$i\" -eq 30 ]; then
            echo '  WARNING: openclaw not healthy after 60s (continuing anyway)'
        fi
        sleep 2
    done

    docker compose up -d --no-deps --force-recreate openclaw-workers 2>&1
    echo '  openclaw-workers restarted'
"

# Step 6: Verify
echo "[6/6] Verifying..."
ssh ${SSH_OPTS} -i "${SSH_KEY}" deploy@"${TENANT_IP}" "
    cd ${COMPOSE_DIR}
    echo '  Container status:'
    docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Image}}' 2>&1 | grep -E 'openclaw|NAME'
    echo ''
    echo '  Image size:'
    docker images ssdavidai00/alfred-openclaw --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' 2>&1
    echo ''
    echo '  qmd-cache mount:'
    ls -la /mnt/encrypted/openclaw/qmd-cache/ 2>/dev/null | head -3 || echo '  (empty — models will download on first boot)'
"

echo ""
echo "=== Rollout complete ==="
echo ""
echo "NOTE: GGUF models will download on first boot (~5 min)."
echo "During this time, qmd memory search won't work but the gateway is functional."
echo "Models are cached in /mnt/encrypted/openclaw/qmd-cache/ and persist across restarts."
