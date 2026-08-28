#!/usr/bin/env python3
"""cowork-journal-push — mirror local Claude Cowork / local-agent-mode chat turns
into Alfred's alfred_journal, so Alfred has continuity of conversations that did
not happen over a Hermes channel.

Runs on a timer (launchd). Stateful + idempotent: it records a per-file cursor,
so each turn is pushed exactly once. Fail-soft: on any network error the cursor
is NOT advanced, so the next run retries.

  channel   = "cowork"
  chat_id   = the session id (stable per conversation)
  direction = inbound  (user turns)  /  outbound (assistant turns)

Config (env, written by install.sh into ~/.alfred/cowork-journal/env):
  ALFRED_WEBHOOK_URL   full public ingest URL incl. token, e.g.
                       https://zsolt.alfred.black/api/v1/webhooks/in/<token>
  COWORK_DRY_RUN=1     print what would be sent, send nothing
  COWORK_MAX_CHARS     per-message truncation (default 4000)

The token is the only credential and it is scoped to this one webhook: it can
append journal entries and nothing else. Revoke it from the tenant at any time
(DELETE /api/v1/webhooks/inbound/<token>) and this stops, with no other access
affected.
"""
import json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT   = Path.home() / "Library/Application Support/Claude"
STATE  = Path.home() / ".alfred/cowork-journal/state.json"
URL    = os.environ.get("ALFRED_JOURNAL_URL", "").rstrip("/")

KEY    = os.environ.get("ALFRED_API_KEY", "")
DRY    = os.environ.get("COWORK_DRY_RUN") == "1"
MAXC   = int(os.environ.get("COWORK_MAX_CHARS", "4000"))

def transcripts():
    """Every local conversation transcript we know how to read."""
    yield from (ROOT / "local-agent-mode-sessions").rglob(".claude/projects/**/*.jsonl")

def load_state():
    try: return json.loads(STATE.read_text())
    except Exception: return {}

def seen_uuids(state):
    """Turn UUIDs are globally unique, and the SAME turn appears in more than
    one transcript file (Cowork copies a session's log into per-run project
    dirs). Dedupe must therefore be global — a per-file cursor re-sends every
    duplicated turn under each new file key and never converges."""
    s = set(state.get("_seen", []))
    # Migrate legacy per-file cursors written before this was fixed.
    for k, v in state.items():
        if k != "_seen" and isinstance(v, dict):
            s.update(v.get("uuids", []))
    return s

def save_state(s):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=2))
    tmp.replace(STATE)

def text_of(entry):
    m = entry.get("message") or {}
    c = m.get("content")
    if isinstance(c, str):
        return c.strip()
    if isinstance(c, list):
        return " ".join(
            b.get("text", "") for b in c
            if isinstance(b, dict) and b.get("type") == "text"
        ).strip()
    return ""

def post(entry_payload):
    req = urllib.request.Request(
        URL,
        data=json.dumps(entry_payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status

def main():
    if not DRY and not URL:
        print("ALFRED_WEBHOOK_URL unset — run install.sh", file=sys.stderr)
        return 2
    state = load_state()
    seen_all = seen_uuids(state)
    newly_seen = []
    pushed = skipped = failed = 0

    for path in sorted(transcripts()):
        key = str(path)
        seen = seen_all
        session = path.stem
        new_uuids = []
        try:
            lines = path.read_text(errors="replace").splitlines()
        except Exception:
            continue

        for line in lines:
            try: e = json.loads(line)
            except Exception: continue
            if e.get("type") not in ("user", "assistant"):
                continue
            uid = e.get("uuid")
            if not uid or uid in seen:
                skipped += 1
                continue
            body = text_of(e)
            if not body:
                continue
            # Scheduled-task and system-injected turns are not conversation.
            if body.startswith("<scheduled-task") or body.startswith("<system-reminder"):
                continue

            payload = {
                "chat_id":     e.get("sessionId") or session,
                "direction":   "inbound" if e["type"] == "user" else "outbound",
                "message":     body[:MAXC],
                "source_ref":  uid,
                "metadata": {
                    "entry_uuid": uid,
                    "timestamp":  e.get("timestamp"),
                    "cwd":        e.get("cwd"),
                    "transcript": key,
                },
            }
            if DRY:
                print(f"  [{payload['direction']:8}] {str(e.get('timestamp'))[:19]} "
                      f"{payload['chat_id'][:8]} {body[:80]!r}")
                pushed += 1
                new_uuids.append(uid)
                continue
            try:
                post(payload)
                pushed += 1
                new_uuids.append(uid)
            except Exception as ex:
                failed += 1
                print(f"  POST failed ({ex}) — cursor not advanced", file=sys.stderr)
                break   # stop this file; retry next run

        if new_uuids:
            newly_seen.extend(new_uuids)
            seen_all.update(new_uuids)

    if not DRY:
        merged = sorted(set(state.get("_seen", [])) | set(newly_seen) | seen_all)
        save_state({"_seen": merged[-50000:],
                    "last_run": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    print(f"cowork-journal: pushed={pushed} already_seen={skipped} failed={failed}"
          f"{' (DRY RUN)' if DRY else ''}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
