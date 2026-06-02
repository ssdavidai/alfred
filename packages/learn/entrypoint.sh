#!/bin/bash
set -e

# Wait for Temporal to be healthy
echo "Waiting for Temporal server..."
for i in {1..60}; do
    if timeout 2 python3 -c "import socket; socket.create_connection(('temporal', 7233), timeout=1)" 2>/dev/null; then
        echo "✓ Temporal is reachable"
        break
    fi
    if [ $i -eq 1 ] || [ $((i % 10)) -eq 0 ]; then
        echo "  Temporal not ready, waiting... ($i/60)"
    fi
    sleep 1
done

echo "[alfred-learn] Initializing vault directories..."
python -m scripts.init_vault || echo "[alfred-learn] Warning: init_vault failed, directories may already exist"

echo "Registering Temporal schedules..."
if python -m scripts.register_schedules 2>&1; then
    echo "✓ Schedules registered successfully"
else
    CODE=$?
    echo "⚠ Schedule registration returned exit code $CODE (may already exist or need retry)"
fi

# Composio HTTP sidecar — eliminates ~4s docker-exec cold-start per call.
# Runs as a background subprocess so the Temporal worker remains PID 1's
# foreground child (Docker stops on the worker, not the sidecar). The
# sidecar exits when the container does; if it crashes mid-run, ctrl-api
# will surface a 502 and Sir/Alfred can fall back via COMPOSIO_EXECUTOR=docker.
echo "Starting Composio HTTP sidecar on :8788..."
uvicorn src.composio_server:app --host 0.0.0.0 --port 8788 \
    --log-level info --no-access-log &
SIDECAR_PID=$!
echo "  composio sidecar pid=$SIDECAR_PID"

echo "Starting worker..."
exec python -m src.worker
