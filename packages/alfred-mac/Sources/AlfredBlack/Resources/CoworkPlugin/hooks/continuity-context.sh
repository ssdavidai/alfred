#!/bin/sh
# One Alfred, from inside a Cowork session.
#
# Cowork runs sessions in a sandbox that cannot see this Mac's files, but the
# Alfred Black app's MCP tools (alfred_continuity_recent / _note / _bind) are
# bridged into every session. So: when a rendered continuity file happens to be
# reachable (a host-mode session), inject it verbatim; otherwise tell the model
# exactly which tool to call. Fail-soft: never block the person's turn.
in=$(cat 2>/dev/null)
sid=$(printf '%s' "$in" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
ev=$(printf '%s' "$in" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$ev" ] || ev=SessionStart
f="${ALFRED_CONTINUITY_FILE:-$HOME/Alfred/continuity.md}"
[ -r "$f" ] || f="${CLAUDE_PROJECT_DIR:-.}/.alfred/continuity.md"

rules="You are one Alfred across every surface; this Cowork session is one of them (session id: ${sid:-unknown}).
Memory: if this session has not yet called alfred_continuity_recent, call it before answering — messages marked YOU -> principal there are things you said on other surfaces.
Journal: for every exchange call alfred_continuity_note twice — direction inbound with the person's message verbatim, and direction outbound with your reply — using chat_id \"${sid:-unknown}\" and channel \"cowork\". A turn is not finished until both notes are written."

if [ -r "$f" ] && [ -s "$f" ]; then
  body=$(cat "$f"; printf '\n\n%s' "$rules")
else
  body="$rules"
fi
if command -v python3 >/dev/null 2>&1; then
  printf '%s' "$body" | python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":sys.argv[1],"additionalContext":sys.stdin.read()}}))' "$ev"
else
  esc=$(printf '%s' "$body" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$ev" "$esc"
fi
exit 0
