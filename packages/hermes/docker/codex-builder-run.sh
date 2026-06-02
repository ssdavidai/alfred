#!/usr/bin/env bash
# =============================================================================
# codex-builder-run.sh — drive `codex exec` against a prepped workspace.
#
# Run BY the codex-builder Hermes agent (via its `terminal` tool) at the
# heart of a Paperclip build run. Expects the workspace to already be
# prepped via codex-builder-prep-run.sh (PR 4). Wraps:
#
#   codex exec -C <repo> \
#     --sandbox workspace-write \
#     --ask-for-approval never \
#     --ephemeral \
#     --json \
#     --output-last-message <run>/last.txt \
#     "$PROMPT"
#
# Then attempts to:
#   * git add -A && git commit -m "codex: <issueId>"
#   * git push origin <branch>
#   * write /work/runs/<runId>/audit.json with timestamps, branch, push
#     outcome, codex exit code, diff stats.
#
# Stdout is JSON the agent returns directly to Paperclip's run transcript:
#
#   { "ok": true|false,
#     "runId":       "<runId>",
#     "branch":      "<branch>",
#     "branchUrl":   "https://github.com/ssdavidai/alfred/tree/<branch>",
#     "lastMessage": "<codex's final summary>",
#     "diffStat":    "<files-changed insertions deletions>",
#     "pushed":      true|false,
#     "error":       null | "<short reason>",
#     "auditPath":   "/work/runs/<runId>/audit.json" }
#
# Exit codes:
#   0  success (commit + push landed; ok=true)
#   1  codex non-zero (the LLM gave up, ok=false but JSON returned)
#   2  bad args / workspace not found (bug)
#   3  git commit failed (e.g. no changes — codex made no edits)
#   4  git push failed (network blip, auth expired, branch protection)
#   5  codex auth failed at the SDK layer (401 on the OAuth refresh)
#
# Usage:
#   codex-builder-run.sh <runId> <issueId> <promptFile>
#
# Sir 2026-05-28 — PR 5 of docs/codex-builder-runtime.md.
# =============================================================================
set -uo pipefail

usage() {
    cat >&2 <<'EOF'
usage: codex-builder-run.sh <runId> <issueId> <promptFile>

  runId       must match [A-Za-z0-9_-]{1,64} — created by
              codex-builder-prep-run.sh as the workspace key.
  issueId     same constraint — the Paperclip issue identifier.
  promptFile  absolute path to a file holding the natural-language
              spec to pass codex (typically /work/runs/<runId>/prompt.md).
EOF
    exit 2
}

if [[ $# -ne 3 ]]; then
    usage
fi

RUN_ID="$1"
ISSUE_ID="$2"
PROMPT_FILE="$3"

# Defensive input scrubbing — see prep-run.sh.
if ! [[ "$RUN_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    echo "error: runId must match [A-Za-z0-9_-]{1,64}; got: '$RUN_ID'" >&2
    exit 2
fi
if ! [[ "$ISSUE_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    echo "error: issueId must match [A-Za-z0-9_-]{1,64}; got: '$ISSUE_ID'" >&2
    exit 2
fi
if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "error: prompt file not found: '$PROMPT_FILE'" >&2
    exit 2
fi

WORK_ROOT="${CODEX_WORKSPACE_ROOT:-/work}"
RUN_DIR="${WORK_ROOT}/runs/${RUN_ID}"
REPO_DIR="${RUN_DIR}/repo"
LAST_TXT="${RUN_DIR}/last.txt"
CODEX_JSON="${RUN_DIR}/codex.json"
AUDIT_JSON="${RUN_DIR}/audit.json"

if [[ ! -d "$REPO_DIR" ]]; then
    echo "error: repo dir not found at '$REPO_DIR' — was prep-run.sh called for runId=${RUN_ID}?" >&2
    exit 2
fi

# Read the branch the prep-run created.
BRANCH=$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
    echo "error: repo at $REPO_DIR has no checked-out branch" >&2
    exit 2
fi
BRANCH_URL="https://github.com/ssdavidai/alfred/tree/${BRANCH}"

# Helper — emit JSON-safe string (just escape the chars JSON disallows).
json_escape() {
    python3 -c '
import json, sys
print(json.dumps(sys.stdin.read()), end="")
'
}

# Audit timestamps.
T_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EPOCH_START="$(date +%s)"

# --- 1. codex exec -----------------------------------------------------------
# `codex exec` is the non-interactive runner. The flag set:
#   --sandbox workspace-write    — only mutate files under --cd (codex's
#                                  own internal sandbox; belt-and-braces
#                                  against our outer FS + iptables fences).
#   --dangerously-bypass-approvals-and-sandbox  — skip approval prompts.
#                                  codex 0.135.0 retired --ask-for-approval
#                                  (the old "never" mode); the supported
#                                  non-interactive path is this flag. Per
#                                  the CLI's --help: "Intended solely for
#                                  running in environments that are
#                                  externally sandboxed." That description
#                                  matches us exactly:
#                                    * uid 10001 with FS isolation
#                                    * iptables egress allowlist (uid 10001)
#                                    * Hermes profile mcp_servers: {} +
#                                      platform_toolsets.cli: [terminal, file]
#                                  The bypass is at the APPROVAL layer, not
#                                  the sandbox itself (per the CLI docs).
#   --ephemeral                  — no persisted codex session across runs.
#   --json                       — machine-parsable envelope on stdout.
#   --output-last-message FILE   — final message goes here, easy to read.
#
# We capture stdout to CODEX_JSON for forensics. Stderr is folded into the
# audit log if codex bails.
T_CODEX_START="$(date +%s)"
PROMPT_CONTENT="$(cat "$PROMPT_FILE")"
CODEX_STDERR_FILE="${RUN_DIR}/codex.stderr"
if codex exec \
       -C "$REPO_DIR" \
       --sandbox workspace-write \
       --dangerously-bypass-approvals-and-sandbox \
       --ephemeral \
       --json \
       --output-last-message "$LAST_TXT" \
       "$PROMPT_CONTENT" \
       > "$CODEX_JSON" 2> "$CODEX_STDERR_FILE"; then
    CODEX_EXIT=0
else
    CODEX_EXIT=$?
fi
T_CODEX_END="$(date +%s)"
CODEX_DURATION=$((T_CODEX_END - T_CODEX_START))

LAST_MESSAGE=""
if [[ -f "$LAST_TXT" ]]; then
    LAST_MESSAGE="$(cat "$LAST_TXT")"
fi

# Auth failure detection — codex returns 1 in many failure modes; we look
# at stderr for "401" / "not authenticated" / "unauthorized" markers.
if (( CODEX_EXIT != 0 )) \
   && grep -qiE '(401|unauthor|not authenticated|expired|please log ?in)' "$CODEX_STDERR_FILE" 2>/dev/null; then
    AUTH_FAILED=1
else
    AUTH_FAILED=0
fi

# --- 2. git status / diffstat -----------------------------------------------
# Did codex actually write anything?
cd "$REPO_DIR" || { echo "error: cd into $REPO_DIR failed mid-run" >&2; exit 2; }
DIRTY="$(git status --porcelain | head -100)"
if [[ -z "$DIRTY" ]]; then
    # Codex's exit code matters here: 0 + no changes = "codex thinks it's
    # done but didn't edit", probably "I cannot implement this in this
    # repo"; non-zero = codex bailed before reaching its tool calls.
    DIFFSTAT="0 files changed"
else
    git add -A >/dev/null 2>&1 || true
    DIFFSTAT="$(git diff --cached --shortstat 2>/dev/null | head -1 | tr -d '\n')"
    [[ -z "$DIFFSTAT" ]] && DIFFSTAT="<unparsed>"
fi

# --- 3. git commit -----------------------------------------------------------
COMMIT_OK=0
COMMIT_SHA=""
if [[ -n "$DIRTY" ]]; then
    COMMIT_MSG="codex: ${ISSUE_ID}"
    if [[ -n "$LAST_MESSAGE" ]]; then
        # First line of last.txt becomes the commit summary suffix; cap at
        # 60 chars to keep the subject under git's 72-col convention.
        FIRST_LINE="$(echo "$LAST_MESSAGE" | head -1 | cut -c1-60)"
        COMMIT_MSG="codex: ${ISSUE_ID} — ${FIRST_LINE}"
    fi
    # Author identity for the commit. The deploy key isn't an OAuth-linked
    # identity, so we set author/committer explicitly here so the commit
    # doesn't fall through git's user.name/user.email lookup chain.
    if git -c user.name="codex-feature-builder" \
           -c user.email="codex-feature-builder@alfred.black" \
           commit -m "$COMMIT_MSG" >/dev/null 2>&1; then
        COMMIT_OK=1
        COMMIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "")"
    fi
fi

# --- 4. git push -------------------------------------------------------------
PUSH_OK=0
PUSH_ERROR=""
if (( COMMIT_OK == 1 )); then
    # GIT_SSH_COMMAND is set from the profile's .env (PR 2 quoting hotfix).
    if PUSH_OUTPUT="$(git push origin "$BRANCH" 2>&1)"; then
        PUSH_OK=1
    else
        PUSH_ERROR="$(echo "$PUSH_OUTPUT" | tail -3 | tr '\n' ' ' | cut -c1-300)"
    fi
fi

# --- 5. Decide overall status ------------------------------------------------
T_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EPOCH_END="$(date +%s)"
TOTAL_DURATION=$((EPOCH_END - EPOCH_START))

if (( AUTH_FAILED == 1 )); then
    OK="false"
    ERROR="codex auth expired — run \`codex login\` against the codex-builder profile's CODEX_HOME (see operator-guide)"
    EXIT_CODE=5
elif (( CODEX_EXIT != 0 )); then
    OK="false"
    ERROR="codex exec exited ${CODEX_EXIT}"
    EXIT_CODE=1
elif [[ -z "$DIRTY" ]]; then
    OK="false"
    ERROR="codex ran but made no changes (no diff to commit)"
    EXIT_CODE=3
elif (( COMMIT_OK == 0 )); then
    OK="false"
    ERROR="git commit failed"
    EXIT_CODE=3
elif (( PUSH_OK == 0 )); then
    OK="false"
    ERROR="git push failed: ${PUSH_ERROR}"
    EXIT_CODE=4
else
    OK="true"
    ERROR="null"
    EXIT_CODE=0
fi

# --- 6. Write audit log ------------------------------------------------------
# Audit JSON is independent of the agent's return value — if the agent
# crashes / the gateway is restarted, the audit on disk still shows what
# happened.
LAST_MESSAGE_JSON="$(printf '%s' "$LAST_MESSAGE" | json_escape)"
DIFFSTAT_JSON="$(printf '%s' "$DIFFSTAT" | json_escape)"
PUSH_ERROR_JSON="$(printf '%s' "$PUSH_ERROR" | json_escape)"
CODEX_STDERR_TAIL="$(tail -20 "$CODEX_STDERR_FILE" 2>/dev/null | json_escape)"
ERROR_FIELD="null"
if [[ "$ERROR" != "null" ]]; then
    ERROR_FIELD="$(printf '%s' "$ERROR" | json_escape)"
fi
cat > "$AUDIT_JSON" <<EOF
{
  "schema": "codex-builder/audit/v1",
  "runId": "${RUN_ID}",
  "issueId": "${ISSUE_ID}",
  "branch": "${BRANCH}",
  "branchUrl": "${BRANCH_URL}",
  "startedAt": "${T_START}",
  "endedAt": "${T_END}",
  "totalSeconds": ${TOTAL_DURATION},
  "codex": {
    "exitCode": ${CODEX_EXIT},
    "durationSeconds": ${CODEX_DURATION},
    "authFailed": $([ "$AUTH_FAILED" == "1" ] && echo true || echo false),
    "stderrTail": ${CODEX_STDERR_TAIL}
  },
  "git": {
    "diffStat": ${DIFFSTAT_JSON},
    "committed": $([ "$COMMIT_OK" == "1" ] && echo true || echo false),
    "commitSha": "${COMMIT_SHA}",
    "pushed": $([ "$PUSH_OK" == "1" ] && echo true || echo false),
    "pushError": ${PUSH_ERROR_JSON}
  },
  "lastMessage": ${LAST_MESSAGE_JSON},
  "ok": ${OK},
  "error": ${ERROR_FIELD}
}
EOF

# --- 7. Emit caller-facing JSON ---------------------------------------------
cat <<EOF
{
  "ok": ${OK},
  "runId": "${RUN_ID}",
  "branch": "${BRANCH}",
  "branchUrl": "${BRANCH_URL}",
  "lastMessage": ${LAST_MESSAGE_JSON},
  "diffStat": ${DIFFSTAT_JSON},
  "pushed": $([ "$PUSH_OK" == "1" ] && echo true || echo false),
  "error": ${ERROR_FIELD},
  "auditPath": "${AUDIT_JSON}"
}
EOF

exit "$EXIT_CODE"
