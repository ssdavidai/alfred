#!/bin/sh
# A turn is not over until it is journaled. On Stop, look at the transcript
# since the person's last message: if alfred_continuity_note was called, allow;
# otherwise block once with the exact instruction. stop_hook_active means we
# already blocked this turn — never loop. Unreadable transcript: allow (soft).
in=$(cat 2>/dev/null)
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
