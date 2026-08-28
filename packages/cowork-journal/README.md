# cowork-journal

Mirrors your local **Claude Cowork** conversations into your Alfred's journal, so
Alfred remembers what you discussed in Cowork the same way it remembers Slack
and Telegram.

## Why this exists

When you talk to Alfred through Cowork, Alfred only ever sees isolated MCP tool
calls — it has no thread, no history, no idea a conversation happened. Ask it
something in Slack afterwards and it has amnesia, which breaks the "one Alfred"
illusion (`docs/design/one-alfred.md`).

This ships each Cowork turn into `alfred_journal`. The `one-alfred` Hermes
plugin already re-injects recent journal context on every inbound message, so
the continuity works with **no plugin change** — the read path exists, it was
only ever missing the writer.

## Install

1. In your Alfred dashboard: **Connections → Custom Webhook → New**, set
   destination **journal**, and copy the URL.
2. Run:

   ```bash
   bash install.sh
   ```

It asks for the URL, verifies it can read your transcripts, offers to backfill
existing history, then schedules itself every 5 minutes via `launchd`.

```bash
bash install.sh --uninstall     # stop and remove the timer
```

## What gets sent

Only user and assistant **text** turns from local Cowork sessions:

| field | value |
|---|---|
| `chat_id` | Cowork session id — one journal thread per conversation |
| `direction` | `inbound` (you) / `outbound` (Alfred) |
| `message` | the turn's text, truncated at 4000 chars |
| `source_ref` | the turn's UUID — used for idempotency |

Skipped: `<scheduled-task>` and `<system-reminder>` injections (machinery, not
conversation), tool-call payloads, and attachments.

## Guarantees

- **Exactly once.** A per-file cursor of seen UUIDs lives in
  `~/.alfred/cowork-journal/state.json`. Re-runs never duplicate.
- **Fail-soft.** A failed POST leaves the cursor untouched, so the next run
  retries rather than dropping turns.
- **Least privilege.** The webhook token is the only credential. It can append
  journal entries and nothing else — it is not your API key. Revoke it any time
  with `DELETE /api/v1/webhooks/inbound/<token>` and this stops cleanly, with
  no other access affected.
- **Local only.** Transcripts are read from
  `~/Library/Application Support/Claude/local-agent-mode-sessions/`. Nothing
  else on your machine is read, and nothing is sent anywhere except your own
  tenant.

## Privacy

Your Cowork conversations become journal entries in **your** vault and are
embedded for semantic search there. Point this only at your own tenant. If a
conversation shouldn't reach Alfred, don't backfill — choose "no" at the prompt
and only new conversations are sent.

## Troubleshooting

```bash
tail -20 ~/.alfred/cowork-journal/push.log      # what the timer is doing
COWORK_DRY_RUN=1 python3 ~/.alfred/cowork-journal/push.py   # show, send nothing
launchctl list | grep cowork-journal            # is it scheduled
```

`pushed=0 already_seen=N` means everything is already mirrored — the normal
steady state.
