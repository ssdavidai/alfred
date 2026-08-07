# Bounded message and calendar evidence sweeps

Use this when a reconciliation depends on recent messages/threads, or on proof
that a calendar event exists. The recurring failure in both is the same:
treating an empty first query as a complete answer.

## Messages: include replies to older parents

A bounded channel-history call returns only parent messages whose own
timestamps fall inside the window. It therefore misses a new reply posted
during the window to a thread whose parent predates the cutoff.

For a complete bounded sweep:

1. Fetch parent history far enough back to enumerate existing thread parents.
   Paginate; do not trust one page.
2. Select both parents whose `ts` falls in the window **and** parents whose
   `latest_reply` falls in the window, even when the parent is older.
3. Fetch every selected thread, paginate it, and retain only replies whose own
   timestamps are inside the window.
4. Inspect attachments, links and explicit delivery/acceptance wording on both
   parents and replies.
5. Record the parent and reply counts checked. **An empty parent-message window
   is not proof of no evidence** until the older-parent reply check also
   returns nothing.
6. Never print or persist secret values encountered during a read-only sweep.

### Slack specifics

For `SLACKBOT_FETCH_CONVERSATION_HISTORY`, pass the conversation as `channel`
(not `channel_id`), and a bounded cutoff as an epoch-seconds string in
`oldest`. The action returns parent timeline messages only — its own success
message says so. When `has_more` is true, continue with
`response_metadata.next_cursor` as `cursor` until the parent range needed to
test `latest_reply` is complete, then call
`SLACKBOT_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION` for each parent whose
`latest_reply` is at or after the cutoff.

Treat `messages: []` for an `oldest` query as "no new parents" — never as a
complete no-signal result until the older-parent test is done.

## Calendar: search every relevant owned calendar

Do not equate "not on the primary calendar" with "the event does not exist".

1. List calendars first.
2. Search every relevant owned calendar over the exact event window using
   participant and title aliases. Include work and personal calendars where the
   event could plausibly live; exclude unrelated read-only or shared calendars
   unless scope context points at them.
3. Verify title, exact local start/end, attendees, attendee status, event
   ID/link and update timestamp where present.
4. Classify an invitation as absent only after the whole owned-calendar set
   returns no match.

### Google Calendar specifics

A proven bounded lookup uses `GOOGLECALENDAR_FIND_EVENT` with snake-case
arguments `calendar_id`, `query`, `time_min`, `time_max`, run once per owned
calendar after `GOOGLECALENDAR_LIST_CALENDARS`. A successful no-match result is
nested at `data.event_data.event_data: []` — inspect that array rather than the
outer success flag or `display_url`. Preserve the exact RFC3339 bounds and
local offset in the audit so an absence claim is reproducible.

## Fallback is not degradation

A focused or delegated agent is an optimisation, not the authority. If it times
out or is unavailable, continue through a direct integration, action, or
authenticated read-only provider API where one is available and permitted.

**If the fallback completes the same bounded evidence contract, the source is
not degraded.** Label `Source refresh degraded: <source>` only when no fallback
can complete the required read, or when the fallback is partial.

When a wrapper paginates in unexpectedly small pages, or produces more payload
than the older-parent check can safely finish, go to the provider's
authenticated read-only API directly:

1. Load credentials through the profile's normal environment and `.env`
   fallback order — reuse an existing helper's token loader where one exists.
   Never print the token.
2. Paginate history at the largest permitted page size until the cursor is
   empty.
3. Count in-window parents, and separately select every parent whose
   `latest_reply` is at or after the cutoff.
4. Fetch replies only for those parents, paginate each thread, and retain
   replies by their own timestamps.
5. Emit a token-free audit summary: pages, parents scanned, in-window parents,
   candidate older threads, replies checked, relevant hits. Do not emit
   unrelated message bodies.
6. Keep it strictly read-only — no posts, reactions, edits or shares.

Completeness is determined by exhausting the provider's cursor, not by a
wrapper's apparent page size.

## Intentional non-queries stay distinct

If a conditional source had no trigger and policy says not to query it, record
the exclusion. That is not degradation, and conflating the two makes a clean
run look broken and a broken run look clean.
