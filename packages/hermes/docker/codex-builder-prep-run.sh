#!/usr/bin/env bash
# =============================================================================
# codex-builder-prep-run.sh — create a fresh per-run workspace for the
# codex-builder Hermes profile.
#
# Run BY the codex-builder agent (via its terminal tool) at the start of a
# Paperclip run. Sets up:
#
#   /work/runs/<runId>/
#     prompt.md   ← spec text (written separately by the agent)
#     repo/       ← fresh `git clone --depth 1` of ssdavidai/alfred
#     audit.json  ← run audit log (written by the wrapper at the end)
#
# The agent then `cd /work/runs/<runId>/repo`, checks out a feature branch
# `codex/<issue-id>-<sha7>`, and shells out to `codex exec` (PR 5's
# wrapper).
#
# Usage:
#   codex-builder-prep-run.sh <runId> <issueIdentifier>
#
# Exits 0 on success with the workspace path on stdout.
# Exits non-zero on any failure with a clear stderr message; nothing is
# written to disk (the caller's branch checkout never happens).
#
# Idempotent guard: if /work/runs/<runId>/repo already exists, refuses to
# overwrite (runIds are timestamp+random, collisions = bug). The caller
# generates a unique runId; mid-run retries reuse the same runId so the
# workspace is preserved.
#
# Sir 2026-05-28 — PR 4 of docs/codex-builder-runtime.md §5.
# =============================================================================
set -euo pipefail

usage() {
    cat >&2 <<'EOF'
usage: codex-builder-prep-run.sh <runId> <issueIdentifier>

Creates /work/runs/<runId>/repo as a fresh git clone of
ssdavidai/alfred on the `main` branch, depth 1. Returns the absolute
path on stdout.
EOF
    exit 2
}

if [[ $# -ne 2 ]]; then
    usage
fi

RUN_ID="$1"
ISSUE_ID="$2"

# Defensive: runId must be alphanumeric + dashes + underscores only. No path
# traversal, no shell-meta. issueId is a Paperclip task identifier, same.
if ! [[ "$RUN_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    echo "error: runId must match [A-Za-z0-9_-]{1,64}; got: '$RUN_ID'" >&2
    exit 2
fi
if ! [[ "$ISSUE_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    echo "error: issueId must match [A-Za-z0-9_-]{1,64}; got: '$ISSUE_ID'" >&2
    exit 2
fi

WORK_ROOT="${CODEX_WORKSPACE_ROOT:-/work}"
RUN_DIR="${WORK_ROOT}/runs/${RUN_ID}"
REPO_DIR="${RUN_DIR}/repo"

if [[ -e "$RUN_DIR" ]]; then
    echo "error: ${RUN_DIR} already exists — refusing to overwrite (runId collision?)" >&2
    exit 3
fi

mkdir -p "$RUN_DIR"
cd "$RUN_DIR"

# Clone the alfred repo. SSH is the canonical protocol — the deploy key
# (PR 4's init step) registers as a write-capable key on this repo only.
# GIT_SSH_COMMAND in the codex-builder .env pins -i + StrictHostKeyChecking
# so no ambient agent identity sneaks in.
REPO_URL="${ALFRED_REPO_URL:-git@github.com:ssdavidai/alfred.git}"
if ! git clone --depth 1 --branch main --no-tags --quiet "$REPO_URL" "$REPO_DIR" 2>&1; then
    echo "error: git clone failed against ${REPO_URL}" >&2
    rm -rf "$RUN_DIR"
    exit 4
fi

# Create the feature branch — runId-derived suffix so two branches from the
# same issue can't collide.
SHA7="${RUN_ID: -7}"
BRANCH_NAME="codex/${ISSUE_ID}-${SHA7}"
if ! git -C "$REPO_DIR" checkout -b "$BRANCH_NAME" >/dev/null 2>&1; then
    echo "error: failed to create branch ${BRANCH_NAME}" >&2
    rm -rf "$RUN_DIR"
    exit 5
fi

# Write a minimal run-manifest so audit + GC have something to read even
# if the agent crashes before the wrapper finishes.
cat > "${RUN_DIR}/manifest.json" <<EOF
{
  "runId": "${RUN_ID}",
  "issueId": "${ISSUE_ID}",
  "branch": "${BRANCH_NAME}",
  "repoUrl": "${REPO_URL}",
  "preppedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# Return the workspace path on stdout for the caller.
echo "$REPO_DIR"
