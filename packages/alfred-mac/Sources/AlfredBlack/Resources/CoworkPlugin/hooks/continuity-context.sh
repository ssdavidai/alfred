#!/bin/sh
# Inject Alfred's cross-surface memory into this turn. The file is rendered
# every 30s by Alfred Black for Mac from the tenant's journal; reading a local
# file needs no network egress from the Cowork sandbox. Fail-soft: no file,
# no context, never an error — the user's turn always goes through.
f="${ALFRED_CONTINUITY_FILE:-$HOME/Alfred/continuity.md}"
[ -r "$f" ] || exit 0
ctx=$(cat "$f")
[ -n "$ctx" ] || exit 0
# Hooks return additionalContext as JSON; escape via python if present, else a
# conservative sed fallback so the hook works on a bare sandbox too.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$f" <<'PY'
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": open(sys.argv[1]).read()}}))
PY
else
  esc=$(printf '%s' "$ctx" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$esc"
fi
exit 0
