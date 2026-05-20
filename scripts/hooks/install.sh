#!/usr/bin/env bash
# Install the Alfred lane-enforcement gate. Run once from the repo root:
#     bash scripts/hooks/install.sh
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"

git -C "${ROOT}" config core.hooksPath scripts/hooks
chmod +x "${ROOT}/scripts/hooks/pre-commit" "${ROOT}/scripts/hooks/check_lane.py"

# `.lane` is per-worktree metadata — never commit it.
if ! grep -qxF '.lane' "${ROOT}/.gitignore" 2>/dev/null; then
  echo '.lane' >> "${ROOT}/.gitignore"
fi

cat <<'EOF'
✓ lane gate installed (core.hooksPath=scripts/hooks). All worktrees inherit it.

Per-lane worktree setup — drop a `.lane` manifest at the worktree root:
    echo '{"lane":"II"}' > .lane                                  # whole-lane VERIFY default
    echo '{"lane":"II","verify":"cd packages/learn && python -m pytest tests/test_signals.py -q"}' > .lane

The main checkout (no `.lane`) is the phase0 orchestrator lane (allow-all), so
this never blocks normal work on main. A *linked worktree* with no `.lane` is
rejected on purpose — a lane agent must declare its lane.

Self-test:  ALFRED_LANE=II python3 scripts/hooks/check_lane.py   (with files staged)
EOF
