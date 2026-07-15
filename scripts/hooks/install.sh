#!/usr/bin/env bash
# Install the Alfred lane-enforcement gate. Run once from the repo root
# (idempotent — safe to re-run any time):
#     bash scripts/hooks/install.sh
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
GIT_COMMON="$(git -C "${ROOT}" rev-parse --git-common-dir)"
case "${GIT_COMMON}" in /*) : ;; *) GIT_COMMON="${ROOT}/${GIT_COMMON}" ;; esac

# 1. The intended wiring.
git -C "${ROOT}" config core.hooksPath scripts/hooks
chmod +x "${ROOT}/scripts/hooks/pre-commit" "${ROOT}/scripts/hooks/check_lane.py"

# 2. Harness-proofing: the Claude Code worktree harness rewrites
#    core.hooksPath to the default .git/hooks (shared AND per-worktree
#    config.worktree) at every worktree creation — this silently disarmed the
#    gate for ~6 weeks (2026-06 → 2026-07 audit). Symlink the hook INTO
#    .git/hooks so the gate fires whichever value core.hooksPath holds.
#    pre-commit resolves check_lane.py via `git rev-parse --show-toplevel`,
#    so running via this symlink is safe in the main checkout and in every
#    linked worktree.
mkdir -p "${GIT_COMMON}/hooks"
ln -sf "${ROOT}/scripts/hooks/pre-commit" "${GIT_COMMON}/hooks/pre-commit"

# 3. Strip any stale per-worktree hooksPath overrides the harness left behind
#    (worktree config takes precedence over shared config).
if [ -d "${GIT_COMMON}/worktrees" ]; then
  for wt_cfg in "${GIT_COMMON}"/worktrees/*/config.worktree; do
    [ -f "${wt_cfg}" ] || continue
    if grep -q 'hooksPath' "${wt_cfg}" 2>/dev/null; then
      # keep the file, drop only the hooksPath line (portable sed -i)
      sed -i.bak '/hooksPath/d' "${wt_cfg}" && rm -f "${wt_cfg}.bak"
      echo "  · stripped stale hooksPath override: ${wt_cfg}"
    fi
  done
fi

# `.lane` is per-worktree metadata — never commit it.
if ! grep -qxF '.lane' "${ROOT}/.gitignore" 2>/dev/null; then
  echo '.lane' >> "${ROOT}/.gitignore"
fi

cat <<'EOF'
✓ lane gate installed:
    core.hooksPath = scripts/hooks
    .git/hooks/pre-commit → scripts/hooks/pre-commit   (harness-proof fallback)

NOTE: local hooks are best-effort — the Claude Code worktree harness may
re-point core.hooksPath at .git/hooks (the symlink covers that case) and new
worktrees may carry a config.worktree override (re-run this script to strip
them). The AUTHORITATIVE gate is server-side: .github/workflows/lane-gate.yml
replays check_lane.py on every PR from a lane-N/* branch.

Per-lane worktree setup — drop a `.lane` manifest at the worktree root:
    echo '{"lane":"II"}' > .lane                                  # whole-lane VERIFY default
    echo '{"lane":"II","verify":"cd packages/learn && python -m pytest tests/test_signals.py -q"}' > .lane

Valid lanes: I (ctrl) · II (learn) · III (web) · IV (alfred-vault)
             V (edges/infra+setup) · VI (voice-bridge) · VII (paperclip)

The main checkout (no `.lane`) is the phase0 orchestrator lane (allow-all), so
this never blocks normal work on main. A *linked worktree* with no `.lane` is
rejected on purpose — a lane agent must declare its lane (and may NOT declare
phase0; orchestrator work happens in the main checkout only).

Self-test:  ALFRED_LANE=II python3 scripts/hooks/check_lane.py   (with files staged)
            python3 scripts/hooks/test_check_lane.py             (unit tests)
EOF
