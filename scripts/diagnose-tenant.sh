#!/bin/bash
echo "=== Docker Compose Status ==="
cd /opt/alfred/compose && docker compose ps 2>&1

echo ""
echo "=== OpenClaw Logs (last 30 lines) ==="
docker compose logs openclaw --tail 30 2>&1

echo ""
echo "=== Cloudflared Status ==="
systemctl status cloudflared 2>&1 | head -10

echo ""
echo "=== Cloudflared Logs (last 10 lines) ==="
journalctl -u cloudflared --no-pager -n 10 2>&1

echo ""
echo "=== Caddy Status ==="
systemctl status caddy 2>&1 | head -10 || echo "No caddy service"

echo ""
echo "=== Listening ports ==="
ss -tlnp | grep -E "18789|443|80|8080" 2>&1

echo ""
echo "=== OpenClaw health check (internal) ==="
curl -s -o /dev/null -w "HTTP %{http_code}" --connect-timeout 5 http://127.0.0.1:18789/api/health 2>&1
echo ""
