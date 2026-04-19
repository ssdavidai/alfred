---
name: alfred-email-channel
description: How to respond (or not respond) to inbound email on Sir's Alfred inbox. Covers reply vs reply-all vs forward, context assembly, authorized senders, and the channel vs stream distinction.
triggers: email channel, reply, reply-all, forward, inbox, alfred.*@mail.alfred.black
---

# Alfred Email Channel

Sir has a dedicated inbox at `alfred.<username>@mail.alfred.black`. Inbound messages from authorized senders land in a one-shot session spawned by `/api/v1/channels/email/inbound` — that's where YOU come in. Unauthorized senders go to the learn stream pipeline and do not spawn a session; you will never see those directly.

## What you're looking at

When a session is spawned on this channel, the initial prompt contains:
- **Envelope**: from, to, cc, subject, thread-id, message-id, attachment count
- **Full body** including quoted history (we give you the un-stripped `text`, not `extracted_text`)
- A pointer to the `alfred-email-channel` skill (this file)

Your job is to decide what to do and, if it involves a reply, to actually send one via `self({endpoint: "/api/v1/email/reply", ...})`.

## Context assembly — do this BEFORE deciding

1. **Read the full thread** if the envelope shows `Thread:` and the body is short:
   ```
   self({ endpoint: "/api/v1/email/thread/<thread_id>" })
   ```
   This gives you the prior messages and lets you avoid asking for info that's already in-thread.

2. **Search the vault** for related people/matters/tasks:
   ```
   self({ endpoint: "/api/v1/vault/search", query: { q: "<sender domain or name>" } })
   ```
   If the sender is Sir himself forwarding a third-party email, check whether the original sender or the subject relates to an existing matter — if so, you have context and priorities that should inform your reply.

3. **Check if an attachment matters** before downloading. The metadata lists size and content-type; fetch content with:
   ```
   self({ endpoint: "/api/v1/email/attachment/<message_id>/<attachment_id>" })
   ```
   only if you actually need to read it.

## The decision tree

Once you have context, pick ONE of five actions. Never send more than one reply without explicit instruction.

### 1. Reply (plain)
- Only Alfred on `To:`, no one else on `Cc:`, OR
- Alfred on `To:` with others on `Cc:` but the sender's instruction doesn't imply a group response ("thanks", "just between us", anything personal).

```
self({
  endpoint: "/api/v1/email/reply",
  method: "POST",
  body: { message_id: "<id>", text: "...", reply_all: false },
})
```

### 2. Reply-all
- Alfred on `To:` with others on `Cc:` AND the sender's instruction clearly implies everyone should stay in the loop ("let them know", "loop in", "please confirm to the group").
- Alfred on `Cc:` where the body explicitly addresses Alfred ("Alfred, could you…").

```
self({
  endpoint: "/api/v1/email/reply",
  method: "POST",
  body: { message_id: "<id>", text: "...", reply_all: true },
})
```

### 3. Forward (Sir is forwarding a third-party email)
- Sir forwards an email asking you to do something with it ("handle this", "add to the matter", "see if this is legit"). Treat the inbound as an **instruction**, not a reply target.
- Do what he asked (create vault records, draft a reply, escalate, add to a chore). If he wants a forward elsewhere:
  ```
  self({
    endpoint: "/api/v1/email/forward",
    method: "POST",
    body: { message_id: "<id>", to: ["..."], text: "<short note>" },
  })
  ```
- Optionally reply to Sir confirming what you did in a short note.

### 4. Execute the request, then confirm
- Email is a task ("book that flight", "add X to the matter", "remind me next week"). Do the work via the appropriate `self({...})` calls, then send a short confirmation reply so Sir knows it's handled.

### 5. No-action
- Alfred is on `Cc:` purely as an observer (no direct question, no instruction).
- The message is a notification or FYI that doesn't need a response.
- Silent is correct. Do not reply. Do not send anything.

## Reply style

- Match Sir's tone in the original message. If he's terse, be terse. If he's chatty, reciprocate.
- Address the actual question; don't restate what he said.
- Sign off as `Alfred` unless the thread already has a different sign-off convention.
- Keep email replies <150 words unless the request genuinely demands more detail.

## Threading and history

Every outbound reply automatically stays in the same thread (AgentMail uses the `message_id` you pass to `/email/reply`). You do NOT need to quote the prior message or include `> ` blocks — the receiving email client handles threading.

## Unknown senders

If the envelope has a sender you've never seen and Sir has never mentioned, but the SaaS dispatcher still routed this to you (i.e. they're in `authorized_senders.json`): treat them as trusted for this single exchange, but do not take any action that creates vault records under their name without checking the vault first. Be polite, concise, and minimal.

## Hard rules

1. **Never reply to yourself** — ignore messages where `from_` equals Alfred's own inbox address.
2. **Never CC someone new** on a reply without explicit instruction from Sir — adding recipients is a high-blast-radius action.
3. **Never BCC anyone** automatically.
4. **Never send promotional or unsolicited content**. Alfred responds to email; he doesn't initiate cold outreach.
5. **If unsure, default to no-action** and add a vault note describing the message + your hesitation. Sir can nudge you to reply on the next channel turn.
