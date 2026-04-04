#!/usr/bin/env bash
# rollout-slim-image.sh — Deploy slimmed OpenClaw image to a tenant
#
# Updates the compose file to add qmd-cache volume mount, creates the
# cache directory, pulls the new image, and restarts the openclaw containers.
#
# Usage:
#   ./scripts/rollout-slim-image.sh <ssh_key_path> <tenant_ip>
#
# The script is safe to run multiple times (idempotent).
set -euo pipefail

SSH_KEY="${1:?Usage: $0 <ssh_key_path> <tenant_ip>}"
TENANT_IP="${2:?Usage: $0 <ssh_key_path> <tenant_ip>}"
SSH_CMD="ssh -o IdentityAgent=none -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${SSH_KEY} deploy@${TENANT_IP}"

echo "=== Rollout slim OpenClaw image to ${TENANT_IP} ==="
echo ""

# Step 1: Check connectivity
echo "[1/6] Checking connectivity..."
${SSH_CMD} "hostname" || { echo "ERROR: Cannot connect"; exit 1; }

# Step 2: Create qmd-cache directories
echo "[2/6] Creating qmd-cache directories..."
${SSH_CMD} "
mkdir -p /mnt/encrypted/openclaw/qmd-cache /mnt/encrypted/openclaw-workers/qmd-cache 2>/dev/null || \
  sudo mkdir -p /mnt/encrypted/openclaw/qmd-cache /mnt/encrypted/openclaw-workers/qmd-cache
sudo chown -R 1000:1000 /mnt/encrypted/openclaw/qmd-cache /mnt/encrypted/openclaw-workers/qmd-cache 2>/dev/null || true
echo 'done'
"

# Step 3: Patch compose file to add qmd-cache volume mount
echo "[3/6] Patching docker-compose.yaml..."
${SSH_CMD} 'cd /opt/alfred/compose
if grep -q "qmd-cache" docker-compose.yaml 2>/dev/null; then
    echo "  Already patched"
else
    cp docker-compose.yaml docker-compose.yaml.pre-slim-rollout
    # Add qmd-cache mount after openclaw state mount
    sed -i "/\/mnt\/encrypted\/openclaw:\/home\/node\/.openclaw$/a\\      - /mnt/encrypted/openclaw/qmd-cache:/home/node/.cache/qmd" docker-compose.yaml
    # Add qmd-cache mount after openclaw-workers state mount
    sed -i "/\/mnt\/encrypted\/openclaw-workers:\/home\/node\/.openclaw$/a\\      - /mnt/encrypted/openclaw-workers/qmd-cache:/home/node/.cache/qmd" docker-compose.yaml
    PATCHES=$(grep -c "qmd-cache" docker-compose.yaml)
    echo "  Patched ($PATCHES mounts added)"
fi'

# Step 4: Pull new image
echo "[4/6] Pulling new image..."
${SSH_CMD} "cd /opt/alfred/compose && docker compose pull openclaw openclaw-workers 2>&1 | tail -3"

# Step 5: Restart containers
echo "[5/6] Restarting openclaw containers..."
${SSH_CMD} 'cd /opt/alfred/compose
docker compose up -d --no-deps --force-recreate openclaw 2>&1
echo "  openclaw restarted, waiting for health..."
for i in $(seq 1 30); do
    if docker compose exec -T openclaw node -e "fetch(\"http://localhost:18789/health\").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" 2>/dev/null; then
        echo "  openclaw healthy"
        break
    fi
    [ "$i" -eq 30 ] && echo "  WARNING: not healthy after 60s"
    sleep 2
done
docker compose up -d --no-deps --force-recreate openclaw-workers 2>&1
echo "  openclaw-workers restarted"'

# Step 6: Verify
echo "[6/6] Verifying..."
${SSH_CMD} 'cd /opt/alfred/compose
echo "  Containers:"
docker compose ps --format "table {{.Name}}\t{{.Status}}" 2>&1 | grep -E "openclaw|NAME"
echo ""
echo "  Image size:"
docker images ssdavidai00/alfred-openclaw --format "{{.Repository}}:{{.Tag}}\t{{.Size}}" 2>&1
echo ""
echo "  qmd-cache:"
ls -la /mnt/encrypted/openclaw/qmd-cache/ 2>/dev/null | head -3 || echo "  (empty — downloads on first boot)"'

echo ""
echo "=== Done. GGUF models will download on first boot (~5 min). ==="
