#!/bin/sh
# A turn is not over until it is journaled. On Stop, look at the transcript
# since the person's last message: if alfred_continuity_note was called, allow;
# otherwise block once with the exact instruction. stop_hook_active means we
# already blocked this turn — never loop. Unreadable transcript: allow (soft).
in=$(cat 2>/dev/null)
# Only act inside a Cowork session (the sandbox VM, or Cowork's own session
# store). Claude Code sessions in the same app share the plugin list, and a
# build session is not a conversation with Alfred. ALFRED_CONTINUITY_EVERYWHERE=1
# opts every session in.
cwd=$(printf '%s' "$in" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
is_cowork=0
[ -e /run/coworkd ] && is_cowork=1
case "$cwd${CLAUDE_PROJECT_DIR:+ $CLAUDE_PROJECT_DIR}" in *"/sessions/"*|*"/mnt/"*|*"local-agent-mode-sessions"*) is_cowork=1 ;; esac
[ "${ALFRED_CONTINUITY_EVERYWHERE:-0}" = "1" ] && is_cowork=1
[ "$is_cowork" = "1" ] || exit 0
case "$in" in *'"stop_hook_active"'*'true'*) exit 0 ;; esac
sid=$(printf '%s' "$in" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
tp=$(printf '%s' "$in" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$tp" ] && [ -r "$tp" ] || exit 0
journaled=$(awk '
  /"type":[[:space:]]*"user"/ && !/tool_result/ { seen = 0; next }   # the person spoke: start counting afresh
  /alfred_continuity_note/ && /tool_use/ { seen = 1 }
  END { print seen + 0 }' "$tp")
[ "$journaled" = "1" ] && exit 0
reason="This exchange is not journaled yet. Call alfred_continuity_note twice — direction inbound with the person's last message verbatim, direction outbound with the reply you are giving — with chat_id \"${sid:-unknown}\" and channel \"cowork\". If this session has not called alfred_continuity_recent yet, call it too. Then finish."
if command -v python3 >/dev/null 2>&1; then
  printf '%s' "$reason" | python3 -c 'import json,sys; print(json.dumps({"decision":"block","reason":sys.stdin.read()}))'
else
  esc=$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"decision":"block","reason":"%s"}\n' "$esc"
fi
exit 0
