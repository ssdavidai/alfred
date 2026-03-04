#!/bin/bash
cd /opt/alfred/compose
echo "=== Image ==="
docker inspect compose-openclaw-1 --format '{{.Config.Image}} created={{.Created}}' 2>&1
echo ""
echo "=== qmd in container ==="
docker exec compose-openclaw-1 which qmd 2>&1
docker exec compose-openclaw-1 ls -la /usr/local/bin/qmd 2>&1
echo ""
echo "=== bun tree perms ==="
docker exec compose-openclaw-1 ls -la /root/.bun/bin/ 2>&1
docker exec compose-openclaw-1 ls -la /root/.bun/install/global/node_modules/qmd/qmd 2>&1
echo ""
echo "=== whoami ==="
docker exec compose-openclaw-1 whoami 2>&1
docker exec compose-openclaw-1 id 2>&1
echo ""
echo "=== try qmd ==="
docker exec compose-openclaw-1 qmd status 2>&1
echo ""
echo "=== try /usr/local/bin/qmd ==="
docker exec compose-openclaw-1 /usr/local/bin/qmd status 2>&1
echo ""
echo "=== PATH ==="
docker exec compose-openclaw-1 bash -c 'echo PATH=$PATH' 2>&1
echo ""
echo "=== /root readable? ==="
docker exec compose-openclaw-1 ls -la /root/ 2>&1
