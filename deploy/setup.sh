#!/usr/bin/env bash
# Alfred SaaS Control Plane Setup Script
# Run this on the Hetzner VM after cloud-init completes.
#
# Prerequisites:
#   - Cloud-init has completed (Docker, Node 22, Caddy, Tailscale installed)
#   - SSH access as deploy user
#
# Usage:
#   scp -r deploy/ deploy@<ip>:/tmp/alfred-deploy/
#   ssh deploy@<ip> 'bash /tmp/alfred-deploy/setup.sh'

set -euo pipefail

INSTALL_DIR="/opt/alfred-saas"
DEPLOY_DIR="/tmp/alfred-deploy"

echo "=== Alfred SaaS Control Plane Setup ==="

# 1. Join Tailscale
echo "[1/12] Joining Tailscale..."
if ! tailscale status &>/dev/null; then
    echo "Enter Tailscale auth key:"
    read -r TS_AUTHKEY
    sudo tailscale up --authkey="$TS_AUTHKEY" --hostname=alfred-control
fi
echo "Tailscale connected: $(tailscale ip -4)"

# 2. Generate PostgreSQL password
echo "[2/12] Setting up PostgreSQL..."
PG_PASSWORD=$(openssl rand -hex 16)
export POSTGRES_PASSWORD="$PG_PASSWORD"

# Copy docker-compose, clickhouse config, and start PostgreSQL
cp "$DEPLOY_DIR/docker-compose.yaml" "$INSTALL_DIR/docker-compose.yaml"
cp -r "$DEPLOY_DIR/clickhouse" "$INSTALL_DIR/clickhouse"
cd "$INSTALL_DIR"
docker compose up -d postgres
echo "Waiting for PostgreSQL..."
sleep 5

# 3. Set up Caddy
echo "[3/12] Configuring Caddy..."
sudo cp "$DEPLOY_DIR/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl enable caddy
sudo systemctl restart caddy

# 4. Copy built Wasp app
echo "[4/12] Deploying Wasp application..."
# The built app should be at $DEPLOY_DIR/app-build/
if [ -d "$DEPLOY_DIR/app-build" ]; then
    cp -r "$DEPLOY_DIR/app-build/"* "$INSTALL_DIR/"
fi

# 5. Copy alfred-ctrl
echo "[5/12] Deploying alfred-ctrl..."
if [ -d "$DEPLOY_DIR/alfred-ctrl" ]; then
    cp -r "$DEPLOY_DIR/alfred-ctrl/"* "$INSTALL_DIR/alfred-ctrl/"
fi

# 6. Generate Plausible secrets
echo "[6/12] Generating Plausible secrets..."
PLAUSIBLE_SECRET_KEY=$(openssl rand -base64 48 | tr -d '\n')
PLAUSIBLE_TOTP_KEY=$(openssl rand -base64 32 | tr -d '\n')
export PLAUSIBLE_SECRET_KEY_BASE="$PLAUSIBLE_SECRET_KEY"
export PLAUSIBLE_TOTP_VAULT_KEY="$PLAUSIBLE_TOTP_KEY"
export PLAUSIBLE_BASE_URL="https://plausible.alfred.black"

# 7. Start Plausible
echo "[7/12] Starting Plausible Analytics..."
cd "$INSTALL_DIR"
docker compose up -d plausible_db plausible_events_db
echo "Waiting for Plausible databases..."
sleep 10
docker compose up -d plausible
sleep 5

# 8. Create .env.server
echo "[8/12] Configuring environment..."
if [ ! -f "$INSTALL_DIR/.env.server" ]; then
    cat > "$INSTALL_DIR/.env.server" << ENVEOF
DATABASE_URL=postgresql://postgres:${PG_PASSWORD}@localhost:5432/alfred_saas
PORT=3000
NODE_ENV=production

# Generate a column encryption key
COLUMN_ENCRYPTION_KEY=$(openssl rand -hex 32)

# Plausible Analytics (self-hosted)
PLAUSIBLE_SITE_ID=alfred.black
PLAUSIBLE_BASE_URL=http://localhost:8000/api
PLAUSIBLE_API_KEY=

# Fill in the rest from .env.server.example
POLAR_ORGANIZATION_ACCESS_TOKEN=
POLAR_WEBHOOK_SECRET=
POLAR_SANDBOX_MODE=false
PAYMENTS_HOBBY_SUBSCRIPTION_PLAN_ID=
PAYMENTS_PRO_SUBSCRIPTION_PLAN_ID=
HETZNER_API_TOKEN=
TAILSCALE_API_KEY=
TAILSCALE_TAILNET=
ADMIN_EMAILS=

# alfred-ctrl paths (inside Docker container)
ALFRED_CTRL_PATH=/app/alfred-ctrl/dist/index.mjs
ALFRED_CTRL_CWD=/app/alfred-ctrl
ENVEOF
    echo "Created .env.server — please fill in API keys!"
fi

# 9. Push database schema
echo "[9/12] Pushing database schema..."
cd "$INSTALL_DIR"
export DATABASE_URL="postgresql://postgres:${PG_PASSWORD}@localhost:5432/alfred_saas"
npx prisma db push --skip-generate 2>/dev/null || echo "Schema push may need manual setup"

# 10. Set up systemd service
echo "[10/12] Setting up systemd service..."
sudo cp "$DEPLOY_DIR/alfred-saas.service" /etc/systemd/system/alfred-saas.service
sudo systemctl daemon-reload
sudo systemctl enable alfred-saas

# 11. Start the app
echo "[11/12] Starting Alfred SaaS..."
sudo systemctl start alfred-saas

# 12. Verify
echo "[12/12] Verifying..."
sleep 3
if systemctl is-active --quiet alfred-saas; then
    echo "Alfred SaaS is running!"
else
    echo "WARNING: Service not running. Check: sudo journalctl -u alfred-saas -f"
fi

echo ""
echo "=== Setup Complete ==="
echo "PostgreSQL password: $PG_PASSWORD"
echo "Plausible secret key: $PLAUSIBLE_SECRET_KEY"
echo "App URL: https://alfred.black (once DNS is configured)"
echo "Plausible URL: https://plausible.alfred.black"
echo ""
echo "Next steps:"
echo "  1. Edit $INSTALL_DIR/.env.server with your API keys"
echo "  2. Configure DNS: alfred.black -> $(curl -s ifconfig.me)"
echo "  3. Configure DNS: plausible.alfred.black -> $(curl -s ifconfig.me)"
echo "  4. Caddy will auto-obtain TLS certificates"
echo "  5. Create a Plausible account at https://plausible.alfred.black"
echo "  6. Add site 'alfred.black' in Plausible"
echo "  7. Generate an API key in Plausible Settings > API Keys"
echo "  8. Add the API key to .env.server as PLAUSIBLE_API_KEY"
echo "  9. Restart: sudo systemctl restart alfred-saas"
