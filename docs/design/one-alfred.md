# One Alfred — Architecture Design

**Author:** Claude (Opus 4.7) under Sir's direction
**Date:** 2026-05-25
**Status:** Design proposal — needs Sir's sign-off before implementation

## The principle (Sir's words, paraphrased)

> *"The user must feel, AT ALL TIMES, that they are talking to Alfred, the
> one thing. It doesn't matter that there are multiple agents or multiple
> workers or multiple sessions — that's not how the user thinks about this.
> The user treats Alfred as if it were a person. When I talk to a person I
> don't talk to a session of a person, I talk to the person."*

This is a **UX-defining constraint**, not an internal architecture preference.
Every architectural decision below is driven by it. Internal complexity —
profiles, sessions, workers, cron, webhooks — must never leak into Sir's
perception. Sir's perception is: **one continuous relationship with Alfred.**

## What Hermes actually offers (the constraint we work within)

After dredging the source on home (`gateway/platforms/webhook.py`,
`cron/scheduler.py`, `gateway/session.py`, `tools/memory_tool.py`,
`hermes_cli/`), the structural facts:

| Capability | Native in Hermes? | Notes |
|---|---|---|
| Per-(user, channel) session, deterministically keyed | ✅ | `agent:main:{platform}:dm:{chat_id}`, e.g. `agent:main:telegram:dm:432094090`. Stored in `sessions.json`. |
| Cross-channel user identity (one Sir across TG+Slack+Email) | ❌ | Each channel is an independent session. No unified principal. |
| Inject a message into an existing user-channel session from outside | ❌ | `/v1/responses`, `/v1/runs`, cron, webhook — all spawn new synthetic sessions. None lets you "POST into Sir's Telegram conversation". |
| Webhook subscription with channel delivery | ✅ | `hermes webhook subscribe --deliver=telegram --deliver-chat-id=…` runs an agent turn + delivers to channel. But the agent runs in a synthetic `webhook:{route}:{delivery_id}` session — NOT Sir's session. |
| Cron job with channel delivery | ✅ | `hermes cron create --deliver=telegram:432094090`. Same caveat: synthetic `cron_{job_id}_{ts}` session. |
| Built-in memory across sessions (per profile) | ✅ | `MEMORY.md` + `USER.md` per profile, loaded at session-start. Has `_reload_target` for mid-session reload. **Profile-scoped, NOT per-(user, channel).** |
| External memory providers | ✅ | `hermes memory setup` supports honcho, mem0, openviking, hindsight, holographic, retaindb, byterover. Same scope question. |
| `hermes hooks` subcommand | ✅ | Pre/post-turn hooks. The seam for inbound-message interception. |
| Send-message tools in channel-bound profile | ✅ | Main's toolset includes `send_message` to its bound channels — that's how it answers Sir today. |

**The structural finding that drives the design:**

> Hermes treats "the user's conversation with Alfred" and "background work
> Alfred is doing for the user" as **separate sessions by design**. There
> is no native primitive that bridges them. If we want Sir to perceive one
> Alfred, **we must build the bridge ourselves — Hermes is the per-turn
> runtime, not the continuity layer.**

## Architecture: ctrl-api as the unified-Alfred orchestrator

```
              ┌─────────────────────────────────────────────┐
              │    Sir's perception: one Alfred             │
              │    (continuous relationship, single voice,  │
              │     consistent memory)                       │
              └─────────────────────────────────────────────┘
                                  ▲
                                  │
              ┌───────────────────┴─────────────────────────┐
              │                ctrl-api                      │
              │     The unified-Alfred orchestrator          │
              │                                              │
              │  • Owns Sir's identity (one principal)       │
              │  • Stores every Alfred↔Sir exchange in       │
              │    state.db (the "Alfred journal")           │
              │  • Injects relevant journal into every       │
              │    Hermes turn (inbound + outbound)          │
              │  • Routes ALL Sir-facing messages through    │
              │    main profile                              │
              └──────┬───────────────────────┬───────────────┘
                     │                       │
              ┌──────▼──────────┐    ┌──────▼─────────────┐
              │ Hermes workers  │    │   Hermes main      │
              │  (background)   │    │   (Sir-facing)     │
              │                 │    │                    │
              │ • Does the work │    │ • Speaks to Sir    │
              │ • Returns       │    │ • Channel adapters │
              │   structured    │    │ • In Sir's session │
              │   results to    │    │ • Sees ctrl-api    │
              │   ctrl-api      │    │   journal context  │
              │ • NEVER speaks  │    │                    │
              │   to Sir        │    │                    │
              └─────────────────┘    └────────┬───────────┘
                                              │
                                              ▼
                                    ┌────────────────────┐
                                    │ Sir's Telegram     │
                                    │ / Slack / Email    │
                                    └────────────────────┘
```

**Core invariants:**
1. Sir hears Alfred's voice from **main profile only** — workers/heavy never
   send anything to Sir.
2. Every Alfred↔Sir message — outbound *and* inbound — is journalled in
   ctrl-api's state.db with structured context (channel, timestamp,
   originating delegate, etc.).
3. The journal is injected into main's context on every turn, so main's
   responses are coherent with everything Alfred has said and done.
4. Internal Hermes session boundaries become an implementation detail —
   Sir never sees them.

## Pattern A: Outbound (delegate completes → Alfred tells Sir)

```
1. Workers agent finishes the delegate, returns structured result:
   {
     decision_id: "2026-05-25T09-56-41Z-c5dc483b",
     principal_note: "send me a reminder about this on Telegram",
     summary: "Wyoming annual report due 2026-06-15. Firstbase has it
               queued behind payment. No action needed from Sir.",
     raw_outputs: { ... }
   }
   → POST /api/v1/delegate-outcomes  (NEW ctrl-api endpoint)

2. ctrl-api stores the outcome in state.db:
   alfred_journal:
     (id, principal_id, direction='outbound-pending', channel='telegram',
      delegate_id, summary, principal_note, status='pending', ts)

3. ctrl-api creates or reuses a Hermes webhook subscription on main:
   hermes -p main webhook subscribe alfred-delegate-out \
     --deliver telegram --deliver-chat-id <Sir> \
     --prompt "<butler-voice template>" \
     --secret <hmac>

   Template (the prompt main composes from):
   ```
   You are Alfred. Sir asked you on /desk earlier:
   "{{principal_note}}"
   (about: "{{source_headline}}")

   The background investigation is now complete. Findings:
   {{summary}}

   Tell Sir in your butler voice — brief, warm, no scaffolding.
   This is a single Telegram message; treat it as such.
   ```

4. ctrl-api POSTs the structured payload to /webhooks/alfred-delegate-out.
   Hermes runs an agent turn on main, composes butler-voice text, delivers
   via the Telegram adapter to Sir's chat_id.

5. ctrl-api intercepts the delivered text (Hermes calls back via a
   "delivery hook" we register) and journals it:
   alfred_journal:
     (status: 'delivered',
      composed_text: <the bytes Sir actually received>,
      hermes_session_id: webhook:alfred-delegate-out:<delivery_id>)

6. Sir sees: a butler-voice Telegram message from @alfred_black_the_butler_bot.
   He has no idea any of the above happened.
```

## Pattern B: Inbound (Sir replies → main has continuity)

```
1. Sir types "thanks, what was the deadline?" on Telegram.

2. Telegram adapter routes to main's session
   (agent:main:telegram:dm:432094090).

3. PRE-TURN HOOK (Hermes-native `hermes hooks` mechanism) fires:
   a. Hook calls ctrl-api GET /api/v1/alfred-journal/recent
      ?channel=telegram&chat_id=432094090&within=24h
   b. ctrl-api returns the last N outbound exchanges as structured context:
      [
        {ts, direction: "outbound", channel: "telegram",
         composed_text: "Sir, regarding the Wyoming annual report…",
         source_delegate: { decision_id, principal_note, summary } },
        ...
      ]
   c. Hook injects this as a system message into the session's working
      context for this turn only (not into permanent history — we don't
      lie in Sir's chat log).

4. Main now has full continuity. It loads Sir's session, sees the recent
   delegate outcome in context, sees Sir's reply, answers naturally:
   "The Wyoming filing is due 2026-06-15, Sir. Firstbase has it queued."

5. Reply delivered via the bound Telegram adapter (normal Hermes flow,
   nothing custom on the outbound side this time).

6. ctrl-api journals the inbound message + main's response.
```

## The bridge between A and B: state.db's `alfred_journal` table

This is the single source of truth for "what Alfred has said to Sir, and
what Sir has said to Alfred." Owned by ctrl-api. Append-only.

```sql
CREATE TABLE alfred_journal (
  id          TEXT PRIMARY KEY,           -- ULID
  ts          TEXT NOT NULL,              -- ISO-8601 UTC
  direction   TEXT NOT NULL,              -- 'outbound' | 'inbound'
  channel     TEXT NOT NULL,              -- 'telegram' | 'slack' | 'email' | 'web'
  chat_id     TEXT NOT NULL,              -- Hermes session key suffix
  message     TEXT NOT NULL,              -- exact bytes Sir saw / typed
  source_kind TEXT,                       -- 'delegate' | 'instinct' | 'reply' | 'init'
  source_ref  TEXT,                       -- e.g. decision_id, signal_id
  hermes_session_id TEXT,                 -- the Hermes session it landed in
  metadata    TEXT                        -- JSON: full structured context
);
CREATE INDEX alfred_journal_lookup ON alfred_journal
  (channel, chat_id, ts DESC);
```

Every Alfred↔Sir message — across channels, across time — sits here.
Cross-channel queries become trivial. The "principal" can be any concept
ctrl-api decides: today it's the owner; tomorrow we can add household
members each with their own (principal_id, channel, chat_id) tuple.

## Implementation phases

### Phase 1 — Outbound rewrite (the user-visible win)
- Add `alfred_journal` table to state.db (one new migration).
- New ctrl-api endpoints:
  - `POST /api/v1/delegate-outcomes` — workers writes structured outcomes
  - `GET /api/v1/alfred-journal/recent` — main's pre-turn hook reads context
- Replace `notify_principal`'s cron-byte-echo with a Hermes webhook
  subscription using butler-voice prompt template (the template above).
- Rip out the "ROLE: You are a deterministic message-relay job" prompt;
  replace with the warm butler-voice template.
- Journal every outbound delivery.

**Outcome:** Sir gets butler-voice reminders. Still no inbound continuity.

### Phase 2 — Inbound continuity (the main-session bridge)
- Register a Hermes pre-turn hook on main profile that calls ctrl-api for
  recent journal entries on Sir's (channel, chat_id) and injects them as
  ephemeral system context.
- Journal every inbound message too.

**Outcome:** Sir replies and main has full context. The illusion of one
Alfred is complete *within a channel*.

### Phase 3 — Cross-channel continuity (the harder version of "one Alfred")
- ctrl-api maintains a `principal_id` table mapping (chat_id × channel) →
  principal_id. Sir is one principal even if his Telegram and Slack
  chat_ids differ.
- The pre-turn hook queries the journal by `principal_id`, not just
  channel+chat_id.
- Main on Telegram now sees what Alfred said to Sir on Slack 10 minutes
  ago. One Alfred, period.

**Outcome:** True one-Alfred-across-channels.

## Verification (2026-05-25) — Hermes hook seams confirmed

Probed Hermes source on home. The hooks needed for Pattern A + B both exist
and fire on the **channel-inbound runtime path** (not just CLI):

| Hook | Source | Use |
|---|---|---|
| `pre_gateway_dispatch` | `gateway/run.py:5805` | **Pattern B inbound:** fires on every user-originated channel-inbound message (Telegram, Slack, etc.) BEFORE auth, BEFORE main processes anything. Receives the full `MessageEvent` (text, `source.platform`, `source.chat_id`). Return `{"action": "rewrite", "text": "<new>"}` to inject journal context. |
| `pre_llm_call` | `gateway/run.py:5805+` (after auth) | Alternative inbound seam — same purpose, later in the stack. Payload: `session_id`, `user_message`, `conversation_history`, `is_first_turn`, `model`, `platform`. |
| `post_llm_call` | `gateway/run.py:2953` | **Pattern A outbound:** journal what main actually composed (the bytes Sir will see). |
| `transform_tool_result` | `agent/shell_hooks.py` | Mid-turn interceptor — could capture `send_message` results if we need byte-exact outbound. |
| `on_session_start` / `on_session_finalize` / `on_session_reset` | `gateway/run.py:8308+` | Lifecycle bookkeeping. |

The hook plugin mechanism is **Python plugins registered in
`~/.hermes/config.yaml`** (`VALID_HOOKS` enum in `hermes_cli/plugins.py:128`).
Plugins can `httpx`-call ctrl-api, do anything they need. Allowlist consent
required first run (`~/.hermes/shell-hooks-allowlist.json`).

**Bottom line:** the architecture above is achievable with native primitives.
No Hermes fork. No upstream PR. The hook plugin is small, isolated, testable.

## Remaining open questions (smaller, post-hook-verification)

| # | Question | Mitigation |
|---|---|---|
| 1 | How big does the injected context get before main's context window chokes? | Windowing policy on the journal: last N exchanges within last M hours; summarise older. |
| 2 | Pre-gateway-dispatch hook timeout behaviour? | Read `_invoke_hook` defaults; if hook errors are swallowed (logged-only), Sir's reply still goes through unjournalled — graceful degradation. |
| 3 | Outbound journal accuracy when delivery fails (bot rate-limited, network blip)? | `post_llm_call` captures the *composed* text. Webhook delivery success/failure comes back to ctrl-api in the HTTP response — journal both. |
| 4 | How do existing tenants migrate? | Hard switch (per Sir's decision): `notify_principal` MCP tool name unchanged, internal implementation repointed. |

## What stays the same

- Hermes' 3-profile split (main / workers / heavy) stays. We're not
  collapsing it — we're routing AROUND it for user perception.
- `dispatch_action_to_agent` keeps dispatching delegates to workers/heavy.
- The 5-app MCP catalog stays.
- Webhook + cron + /v1/runs + /v1/responses all remain Hermes-native.

## What changes

- The `notify_principal` MCP tool — replaced with a thinner
  `deliver_to_principal` that just calls `POST /api/v1/delegate-outcomes`
  on ctrl-api. ctrl-api owns the actual delivery orchestration.
- The byte-echo cron path — retired (or kept as a fallback for non-Alfred
  message types).
- Sir's Telegram conversation gains a memory layer: ctrl-api's journal,
  injected on every turn.

## What this is NOT

- Not a fork of Hermes. Everything plugs in via Hermes-native primitives
  (webhooks, hooks, MCP tools, the deliver mechanism). Upstream-friendly.
- Not a new persistence layer. state.db already exists; we add one table.
- Not a re-route of Hermes' channel adapters. Hermes still owns
  Telegram/Slack/Email — we just guarantee everything Sir sees comes from
  main.

## Sir's decision points before I start

1. **Phase scope:** Phase 1 only, Phase 1+2, or Phases 1+2+3 in one go?
2. **Open question #1 (Hermes hooks on the inbound path):** want me to
   verify this is possible first, or accept it as a known risk?
3. **Migration:** soft cutover (new path live, old path still works) or
   hard switch?
4. **Naming:** "Alfred journal" or something else for the state.db table?
