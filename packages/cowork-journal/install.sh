#!/usr/bin/env bash
# cowork-journal installer — mirrors local Claude Cowork conversations into
# your Alfred's journal, so Alfred remembers what you discussed in Cowork.
#
#   bash install.sh            interactive
#   bash install.sh --uninstall
set -euo pipefail

DEST="$HOME/.alfred/cowork-journal"
PLIST="$HOME/Library/LaunchAgents/com.alfred.cowork-journal.plist"
LABEL="com.alfred.cowork-journal"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Uninstalled. Your data in $DEST was left in place; delete it if you want."
  exit 0
fi

command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }

echo
echo "  Connect Claude Cowork to your Alfred"
echo "  ------------------------------------"
echo "  Alfred will remember your Cowork conversations the same way it"
echo "  remembers Slack and Telegram."
echo

# 1. the webhook URL (contains the token)
if [[ -n "${ALFRED_WEBHOOK_URL:-}" ]]; then
  URL="$ALFRED_WEBHOOK_URL"
else
  echo "  In your Alfred dashboard: Connections -> Custom Webhook -> New,"
  echo "  choose destination 'journal', and copy the URL it gives you."
  echo
  read -r -p "  Webhook URL: " URL
fi
case "$URL" in
  https://*/api/v1/webhooks/in/*) ;;
  *) echo "  That does not look like a webhook ingest URL."; exit 1 ;;
esac

mkdir -p "$DEST"
install -m 0755 "$HERE/push.py" "$DEST/push.py"
umask 077
printf 'ALFRED_WEBHOOK_URL=%s\n' "$URL" > "$DEST/env"
chmod 600 "$DEST/env"

# 2. prove it works before scheduling anything
echo
echo "  Testing..."
set -a; . "$DEST/env"; set +a
if ! COWORK_DRY_RUN=1 python3 "$DEST/push.py" >/dev/null 2>&1; then
  echo "  Could not read local Cowork transcripts. Nothing installed."; exit 1
fi
COUNT="$(COWORK_DRY_RUN=1 python3 "$DEST/push.py" 2>/dev/null | tail -1)"
echo "  $COUNT"

echo
read -r -p "  Send existing history now? [y/N] " BACKFILL
if [[ "${BACKFILL:-n}" =~ ^[Yy]$ ]]; then
  python3 "$DEST/push.py" || { echo "  Push failed — check the URL. Nothing scheduled."; exit 1; }
else
  # Mark everything seen so only NEW conversations are sent from here on.
  python3 - "$DEST" <<'PY'
import json, sys, os, pathlib
sys.path.insert(0, sys.argv[1])
os.environ["COWORK_DRY_RUN"] = "1"
import importlib.util
spec = importlib.util.spec_from_file_location("push", os.path.join(sys.argv[1], "push.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
state = {}
for path in m.transcripts():
    uuids = []
    for line in open(path, errors="replace"):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") in ("user", "assistant") and e.get("uuid"):
            uuids.append(e["uuid"])
    if uuids: state[str(path)] = {"uuids": uuids[-5000:]}
m.save_state(state)
print("  Existing history marked as seen; only new conversations will be sent.")
PY
fi

# 3. schedule it
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string><string>-lc</string>
    <string>set -a; . "$DEST/env"; set +a; exec /usr/bin/python3 "$DEST/push.py"</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DEST/push.log</string>
  <key>StandardErrorPath</key><string>$DEST/push.log</string>
</dict></plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo
echo "  Done. Runs every 5 minutes."
echo "    log:       $DEST/push.log"
echo "    uninstall: bash install.sh --uninstall"
echo
