#!/bin/bash
# Pull latest openclaw image and restart the container
set -e
cd /opt/alfred/compose
echo "Pulling latest openclaw image (--pull always)..."
docker compose pull --no-parallel openclaw 2>&1
echo ""
echo "Recreating openclaw container..."
docker compose up -d --no-deps --pull always openclaw 2>&1
sleep 15
echo ""
echo "Status:"
docker compose ps 2>&1
echo ""
echo "OpenClaw logs (last 10 lines):"
docker compose logs openclaw --tail 10 2>&1
