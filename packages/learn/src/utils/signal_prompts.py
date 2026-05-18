"""Prompt templates for signal extraction (T6.0.2).

Pairs with ``packages/learn/src/activities/signals.py:extract_signal_from_event``.
The prompt encodes the 8-mutation-class + 3-effect-class taxonomy from
RFC #842 §6 and produces strict-JSON output that ``signals.py`` parses.

Why this module is its own file
-------------------------------
The activity in ``signals.py`` has zero room to drift on prompt content
without breaking JSON parsing in ``_validate_llm_classification``. By
isolating the prompt builder here we can iterate on classification
quality (adding examples, sharpening rules, tuning source-type framing)
without touching the activity, the worker registration, or the workflow
caller.

Design decisions encoded in the prompt
--------------------------------------
1. **Assertion-vs-question filter.** Stream events are NOT all signals.
   Sir reading something out loud, asking a question, speculating, or
   ambient OMI noise must NOT produce mutation/action signals — they
   would flood the router with phantom work. The prompt teaches an
   explicit gate: "would a human assistant reading this expect to take
   action / mutate state because of it?"
2. **Two confidences.** ``target_confidence`` (how sure are we WHICH
   task/matter is meant) and ``effect_confidence`` (how sure are we
   it's a mutation vs action vs noise) decouple cleanly. The router
   uses each on a separate threshold.
3. **Strict JSON wire format.** ``signals.py``'s validator accepts
   ``effect`` ∈ ``{"mutation", "action", "none"}``. Conceptually the
   taxonomy in this module distinguishes 4 effect classes
   ("mutation" / "action" / "informational" / "noise") because giving
   the LLM the 4-way mental model improves classification accuracy on
   the action-vs-noise boundary — but BOTH "informational" and "noise"
   serialize to the wire value ``"none"``. The prompt instructs the
   LLM to emit the wire value ``"none"`` for either category and
   record the conceptual distinction in the ``reasoning`` field. This
   gives us downstream optionality (T6.7 calibration can re-classify
   ``"none"`` outputs by parsing reasoning) without churning the
   already-shipped validator.
4. **Source-type framing at the top of the prompt.** Gmail is not
   Slack is not OMI. The interpretation rules differ enough that a
   single generic prompt produced too many false positives on OMI
   ambient transcripts in the v0 prototype. The prompt now branches
   on ``source_type`` to give the LLM the right interpretive frame
   before it sees the body.
5. **Few-shot examples are real.** Sampled from
   ``/mnt/encrypted/vault/event/`` and
   ``/mnt/encrypted/vault/conversation/`` on david. Synthetic examples
   are flagged explicitly so a future calibration pass can replace
   them with real ones once david has produced matching events.

What ``raw_quote`` is (and isn't)
---------------------------------
``raw_quote`` is the ≤200-char excerpt that survives stream-event
purge (T6.6). It is NOT the prompt's primary input — the prompt sees
the full body — but it IS displayed in the prompt so the LLM can mark
which slice of the body was the "load-bearing" assertion. The
downstream router and any future re-evaluation only see the quote, so
the LLM should reason about the body but its confidence should be
calibrated to "how clear is the signal in JUST the quote?".
"""
from __future__ import annotations

import json
from typing import Any


# ---------------------------------------------------------------------------
# Taxonomies (the load-bearing constants signals.py + tests both consume)
# ---------------------------------------------------------------------------

# 8 mutation classes from RFC #842 §6. The router (T6.3.x) dispatches
# on these — the LLM picks one when ``effect == "mutation"``. When
# ``effect`` is anything else the classification is null.
CORRECTION_TAXONOMY: list[str] = [
    "task_resolution",        # "we already handled X" / "X is done"
    "task_dismissal",         # "drop X, not pursuing it"
    "task_reframing",         # "X isn't really about Y, it's about Z"
    "task_blocked_on",        # "X is waiting on Y"
    "matter_context_edit",    # "the M thing isn't about A, it's about B"
    "matter_state_change",    # "park M for now" / "M is done"
    "matter_creation",        # "the Berlin thing should be its own matter"
    "matter_membership",      # "X belongs under M, not where it is"
]

# Conceptual 4-class effect taxonomy. The wire JSON only emits 3
# values (``"mutation"``, ``"action"``, ``"none"``) because that's
# what ``signals.py:_validate_llm_classification`` accepts —
# "informational" and "noise" both serialize as ``"none"``. The 4-way
# split is taught to the LLM in the prompt body for sharper
# action-vs-not classification.
EFFECT_CLASSES: list[str] = [
    "mutation",        # implies a state change to an existing record
    "action",          # implies work needs to happen (reply, send, schedule)
    "informational",   # context worth knowing, no mutation/action — wire="none"
    "noise",           # event shouldn't drive anything — wire="none"
]


# ---------------------------------------------------------------------------
# Few-shot examples — REAL events from david's vault unless flagged synthetic.
# ---------------------------------------------------------------------------

# Each tuple is (input_dict, expected_output_dict). ``input_dict``
# mirrors what ``build_signal_extraction_prompt`` receives:
# source_type, frontmatter, body (truncated for prompt budget), and
# raw_quote. ``expected_output_dict`` is the JSON we want the LLM to
# emit — used for prompt few-shot rendering AND as the ground truth
# fixture the eval suite (T6.7.2) replays.
FEW_SHOT_EXAMPLES: list[tuple[dict[str, Any], dict[str, Any]]] = [
    # 1. Real — gmail receipt for a Google Play subscription auto-charge.
    #    Source: /mnt/encrypted/vault/event/Sat, 11 Ap-3974ae66e724.md
    #    Reasoning: receipts are informational (no action expected of
    #    Sir, no state change to any task/matter). Wire emits "none".
    (
        {
            "source_type": "gmail",
            "frontmatter": {
                "from": "Google Play <googleplay-noreply@google.com>",
                "subject": "Your Google Play Order Receipt from Apr 11, 2026",
            },
            "body": (
                "Google Play Thank you Your subscription from Google "
                "Commerce Limited on Google Play continues and you've "
                "been charged. Manage your subscriptions To help keep "
                "your subscription active, add a backup"
            ),
            "raw_quote": (
                "Your Google Play Order Receipt from Apr 11, 2026 — "
                "Google Play Thank you Your subscription from Google "
                "Commerce Limited on Google Play continues"
            ),
        },
        {
            "classification": None,
            "effect": "none",
            "target_kind": None,
            "target_hint": None,
            "mutation_proposal": None,
            "action_proposal": None,
            "target_confidence": 0.0,
            "effect_confidence": 0.95,
            "reasoning": (
                "Informational receipt — no action required of Sir, no "
                "state change to any task or matter. Subscription is "
                "active and auto-charged."
            ),
        },
    ),

    # 2. Real — gmail repeated payment failure from Acme Video.
    #    Source: /mnt/encrypted/vault/event/Mon, 26 Ja-76372e059335.md
    #    Reasoning: a failed payment requires Sir to either update the
    #    card or cancel — that's an action. No existing task is
    #    obviously about Acme Video billing, so target_hint is descriptive
    #    and target_confidence stays modest.
    (
        {
            "source_type": "gmail",
            "frontmatter": {
                "from": '"Acme Video HQ Inc." <failed-payments@acme-video.tv>',
                "subject": "$26.00 payment to Acme Video HQ Inc. was unsuccessful again",
            },
            "body": (
                "We weren't able to charge the credit card you provided. "
                "Please update your payment method to keep your "
                "subscription active."
            ),
            "raw_quote": (
                "$26.00 payment to Acme Video HQ Inc. was unsuccessful again — "
                "We weren't able to charge the credit card you provided."
            ),
        },
        {
            "classification": None,
            "effect": "action",
            "target_kind": "matter",
            "target_hint": "household cash flow subscription billing",
            "mutation_proposal": None,
            "action_proposal": {
                "what": "Update Acme Video payment method or cancel the subscription",
                "suggested_actor": "human",
                "due_at": None,
            },
            "target_confidence": 0.5,
            "effect_confidence": 0.85,
            "reasoning": (
                "Repeat-failure billing email — Sir has to either fix "
                "the card or cancel; agent can't decide which. Belongs "
                "under household cash-flow matter if one exists."
            ),
            "display_headline": "Acme Video's card charge failed again.",
            "display_body": (
                "Second strike on the $26 subscription — they'll "
                "lock the account soon. I'd update the card if "
                "you're still using Acme Video, otherwise cancel and be "
                "done with it."
            ),
        },
    ),

    # 3. Real — gmail Hungarian medical invoice (számla).
    #    Source: /mnt/encrypted/vault/event/2026-05-05-fa59359d3bcd.md
    #    Reasoning: an invoice arriving is an action — Sir/agent has
    #    to record + pay it. The matter "household cash flow" or a
    #    healthcare matter is the natural target.
    (
        {
            "source_type": "gmail",
            "frontmatter": {
                "from": '"Acme Clinic Kft." <villanyi.medical@invoicing.example.com>',
                "subject": "A rendelőnk most az Ön segítségét kéri! Számla és köszönetnyilvánítás",
            },
            "body": (
                "Tisztelt Páciensünk! Mellékelten küldjük a kórházi "
                "vizsgálathoz tartozó számlát. Kérjük, hogy a "
                "fizetést a megadott határidőig teljesítse."
            ),
            "raw_quote": (
                "Acme Clinic Kft. — A rendelőnk most az Ön "
                "segítségét kéri — kórházi vizsgálat számla, fizetési "
                "határidő"
            ),
        },
        {
            "classification": None,
            "effect": "action",
            "target_kind": "matter",
            "target_hint": "health fitness restart medical invoice",
            "mutation_proposal": None,
            "action_proposal": {
                "what": "Pay the Acme Clinic invoice by the stated deadline",
                "suggested_actor": "either",
                "due_at": None,
            },
            "target_confidence": 0.6,
            "effect_confidence": 0.9,
            "reasoning": (
                "Real invoice with a payment deadline — clear action. "
                "Maps to the health/fitness matter where the visit "
                "originated."
            ),
            "display_headline": "Acme Clinic sent the hospital bill.",
            "display_body": (
                "There's a payment deadline attached. I'd file it "
                "under household cash flow and pay it now while "
                "it's in hand."
            ),
        },
    ),

    # 4. Real — OMI ambient transcript (Sir narrating about onboarding tax).
    #    Source: /mnt/encrypted/vault/conversation/2026-04-02-1676adbd5443.md
    #    Reasoning: Sir is *narrating an essay*, not asserting a
    #    decision. Long internal monologue about the onboarding tax,
    #    Oliver Bruce, AI butler thinking. No mutation, no action.
    #    Classic OMI narration → noise.
    (
        {
            "source_type": "omi",
            "frontmatter": {
                "name": "Omi conversation — 2026-04-02 — 11:48-11:53 — (en) pt 3/6",
                "speaker_attribution": "ambient",
            },
            "body": (
                "The recording goes somewhere he doesn't have to think "
                "about. His AI butler receives it, processes it, and "
                "acts on it if needed. He didn't configure this. He "
                "didn't read documentation. The onboarding tax is "
                "something I've felt for years without having a name "
                "for it."
            ),
            "raw_quote": (
                "The recording goes somewhere he doesn't have to think "
                "about. His AI butler receives it, processes it... "
                "The onboarding tax is something I've felt for years"
            ),
        },
        {
            "classification": None,
            "effect": "none",
            "target_kind": None,
            "target_hint": None,
            "mutation_proposal": None,
            "action_proposal": None,
            "target_confidence": 0.0,
            "effect_confidence": 0.85,
            "reasoning": (
                "Ambient OMI narration — Sir is thinking out loud / "
                "essay-drafting about a concept. No assertion that "
                "anything specific should change or be done."
            ),
        },
    ),

    # 5. Real — OMI Hungarian short utterance about groceries/baking.
    #    Source: /mnt/encrypted/vault/conversation/2026-04-02-1c8a4d005d51.md
    #    Reasoning: domestic chatter ("vigyünk szőlőt, baguettet") —
    #    not addressed to an agent, not a decision Sir wants tracked.
    #    Ambient noise → noise.
    (
        {
            "source_type": "omi",
            "frontmatter": {
                "name": "Omi conversation — 2026-04-02 — 13:06-13:08 — (hu) pt 3/3",
                "speaker_attribution": "ambient",
            },
            "body": (
                "Mondta, hogy vigyünk szőlőt, meg áfonyát, de hogy "
                "amúgy nagyon sok minden más lesz, úgyhogy nagyon más "
                "ne vegyünk, de hogy vigyünk még baguettet, és akkor "
                "úgy voltam vele, hogy ha már úgyis sütök kalácsot, "
                "akkor sütök baguettet is."
            ),
            "raw_quote": (
                "vigyünk szőlőt, meg áfonyát... vigyünk még baguettet, "
                "és akkor úgy voltam vele, hogy ha már úgyis sütök "
                "kalácsot, akkor sütök baguettet is"
            ),
        },
        {
            "classification": None,
            "effect": "none",
            "target_kind": None,
            "target_hint": None,
            "mutation_proposal": None,
            "action_proposal": None,
            "target_confidence": 0.0,
            "effect_confidence": 0.9,
            "reasoning": (
                "Domestic chatter about weekend groceries / baking — "
                "not an instruction to the agent, not a tracked "
                "decision. Pure ambient noise."
            ),
        },
    ),

    # 6. Synthetic — openclaw-chat: Sir explicitly tells Alfred a
    #    project should be its own matter. No real openclaw-chat events
    #    exist in david's vault yet (T6.1 ships the emitter), so this
    #    is hand-crafted from the v0 spec example. Replace with real
    #    once Phase 6.1 produces them.
    #    Reasoning: openclaw-chat assertions to Alfred are almost
    #    always signals — Sir is explicitly addressing the agent.
    (
        {
            "source_type": "openclaw-chat",
            "frontmatter": {
                "session_id": "synthetic-example",
            },
            "body": (
                "Hey Alfred — the Berlin trip planning conversations "
                "should be their own matter, not buried under "
                "household-life. Spin one up."
            ),
            "raw_quote": (
                "the Berlin trip planning conversations should be their "
                "own matter, not buried under household-life. Spin one up"
            ),
        },
        {
            "classification": "matter_creation",
            "effect": "mutation",
            "target_kind": "matter",
            "target_hint": "Berlin trip planning",
            "mutation_proposal": {
                "decision": "create_matter:matter/berlin-trip-planning",
                "details": (
                    "Sir asked to spin up a dedicated matter for "
                    "Berlin trip planning, currently lumped under "
                    "household-life."
                ),
            },
            "action_proposal": None,
            "target_confidence": 0.9,
            "effect_confidence": 0.95,
            "reasoning": (
                "Direct assertion via openclaw-chat naming a new "
                "matter to create and the existing scope it should "
                "split off from."
            ),
        },
    ),

    # 7. Synthetic — openclaw-chat: Sir asks a *question* (not a
    #    command). Critical negative example so the LLM doesn't
    #    over-trigger on chat sessions.
    (
        {
            "source_type": "openclaw-chat",
            "frontmatter": {
                "session_id": "synthetic-example-question",
            },
            "body": "What's on my plate today? Anything urgent for the Acme Clinic invoice?",
            "raw_quote": "What's on my plate today? Anything urgent for the Acme Clinic invoice?",
        },
        {
            "classification": None,
            "effect": "none",
            "target_kind": None,
            "target_hint": None,
            "mutation_proposal": None,
            "action_proposal": None,
            "target_confidence": 0.0,
            "effect_confidence": 0.95,
            "reasoning": (
                "Sir is asking a question, not making an assertion. "
                "Questions never produce signals — answer in-session, "
                "do not mutate vault state."
            ),
        },
    ),

    # 8. Synthetic — OMI Sir hypothesizing aloud. Negative example
    #    for hypotheticals. Replace with a real example if a clean
    #    one shows up in conversation/.
    (
        {
            "source_type": "omi",
            "frontmatter": {
                "name": "Omi conversation — synthetic hypothetical",
                "speaker_attribution": "ambient",
            },
            "body": (
                "I keep thinking — what if we just dropped the whole "
                "billing automation track and outsourced it. In theory "
                "it would free up a quarter of a head."
            ),
            "raw_quote": (
                "what if we just dropped the whole billing automation "
                "track and outsourced it. In theory it would free up a "
                "quarter of a head"
            ),
        },
        {
            "classification": None,
            "effect": "none",
            "target_kind": None,
            "target_hint": None,
            "mutation_proposal": None,
            "action_proposal": None,
            "target_confidence": 0.0,
            "effect_confidence": 0.85,
            "reasoning": (
                "Hypothetical — 'what if' / 'in theory' framing with "
                "no decision made. Do NOT treat as a task_dismissal "
                "signal; Sir is exploring, not deciding."
            ),
        },
    ),

    # 9. Synthetic — plane assignee change to Sir. Phase 6.7 added
    #    after T6.7.3 found the LLM was treating plane "Please
    #    update" boilerplate as automation noise. The point: Plane
    #    events surface real obligations; the body describing an
    #    upstream change IS the signal regardless of phrasing.
    (
        {
            "source_type": "plane",
            "frontmatter": {
                "name": "Plane: ALFRED-200 reassigned to Sir",
            },
            "body": (
                "Plane issue ALFRED-200: 'Configure CloudFront for "
                "assets' reassigned from Jane Smith to Sir "
                "Szabo-Stuban. Priority: high. Due: Friday May 9, 2026."
            ),
            "raw_quote": (
                "Plane issue ALFRED-200 reassigned from Jane Smith to "
                "Jane Doe — priority high, due Friday May 9"
            ),
        },
        {
            "classification": None,
            "effect": "action",
            "target_kind": "task",
            "target_hint": "configure cloudfront assets",
            "mutation_proposal": None,
            "action_proposal": {
                "what": (
                    "Pick up or delegate the reassigned ALFRED-200 task "
                    "(configure CloudFront) — due Friday."
                ),
                "suggested_actor": "either",
                "due_at": None,
            },
            "target_confidence": 0.7,
            "effect_confidence": 0.85,
            "reasoning": (
                "Plane reassign-to-Sir with explicit due date — "
                "concrete obligation regardless of automation framing. "
                "Action."
            ),
        },
    ),

    # 10. Synthetic — gcal invite needing RSVP. Phase 6.7 added
    #     because the LLM was dropping invites with 'Please respond'
    #     as informational. They aren't.
    (
        {
            "source_type": "gcal",
            "frontmatter": {
                "name": "Strategy review w/ Alex Kim",
            },
            "body": (
                "Event: Strategy review w/ Alex Kim. Time: Mon May 12, "
                "2026, 4:00pm-5:00pm CEST. Attendees: "
                "owner@example.com, user@example.com, "
                "user@example.com. Status: not yet responded. "
                "Description: Quarterly strategy alignment."
            ),
            "raw_quote": (
                "Strategy review w/ Alex Kim — Mon May 12 4-5pm CEST, "
                "attendees include Sir, Alex Kim, Anna; Sir has not yet "
                "responded"
            ),
        },
        {
            "classification": None,
            "effect": "action",
            "target_kind": None,
            "target_hint": "RSVP to strategy review with Alex Kim May 12",
            "mutation_proposal": None,
            "action_proposal": {
                "what": (
                    "RSVP to the May 12 strategy review (yes/no/maybe)."
                ),
                "suggested_actor": "human",
                "due_at": None,
            },
            "target_confidence": 0.3,
            "effect_confidence": 0.85,
            "reasoning": (
                "New invite Sir has not responded to and where he is "
                "an explicit attendee. Needs RSVP — action."
            ),
        },
    ),

    # 11. Synthetic — vault_edit creating a matter. Phase 6.7 added
    #     because the LLM was dropping vault_edit bodies that read
    #     'Sir created matter/X.md' as 'narration about an automation'.
    #     The vault_edit source type's whole purpose is to surface
    #     these as signals.
    (
        {
            "source_type": "vault_edit",
            "frontmatter": {
                "name": "Vault edit: matter/berlin-relocation.md (new)",
            },
            "body": (
                "Sir created matter/berlin-relocation.md: status: "
                "active, created_by: human, summary: 'Relocation of "
                "household + workshop from Budapest to Berlin over Q3 "
                "2026; covers logistics, paperwork, schools.'"
            ),
            "raw_quote": (
                "Sir created matter/berlin-relocation.md — active, "
                "created_by human, summary covers Budapest→Berlin "
                "relocation Q3 2026"
            ),
        },
        {
            "classification": "matter_creation",
            "effect": "mutation",
            "target_kind": "matter",
            "target_hint": "berlin relocation",
            "mutation_proposal": {
                "decision": "create_matter:matter/berlin-relocation",
                "details": (
                    "Sir's hand-edit creates a new matter for the "
                    "Berlin relocation; matter_creation."
                ),
            },
            "action_proposal": None,
            "target_confidence": 0.95,
            "effect_confidence": 0.95,
            "reasoning": (
                "Vault edit describing matter creation — the edit "
                "itself is the mutation signal. matter_creation."
            ),
        },
    ),

    # 12. Synthetic — openclaw-chat with structured `### Sir` heading.
    #     Phase 6.7 added because real openclaw-chat events ship with
    #     a Channel/Session/Turns frontmatter prefix and `### Sir`
    #     heading per turn; v1 prompt assumed plain bodies and
    #     occasionally treated the structured form as 'narration about
    #     a chat session' rather than the chat itself.
    (
        {
            "source_type": "openclaw-chat",
            "frontmatter": {
                "session_id": "phase6-7-shotsample",
            },
            "body": (
                "**Channel**: dashboard\n\n"
                "### Sir\n"
                "Alfred — the Acme Cloud billing dispute is resolved, "
                "they credited the account. Close that task."
            ),
            "raw_quote": (
                "Alfred — the Acme Cloud billing dispute is resolved, "
                "they credited the account. Close that task"
            ),
        },
        {
            "classification": "task_resolution",
            "effect": "mutation",
            "target_kind": "task",
            "target_hint": "Acme Cloud billing dispute",
            "mutation_proposal": {
                "decision": "likely_done",
                "details": (
                    "Sir says the Acme Cloud billing dispute is resolved "
                    "and explicitly asks to close the task."
                ),
            },
            "action_proposal": None,
            "target_confidence": 0.85,
            "effect_confidence": 0.95,
            "reasoning": (
                "Direct chat command — task_resolution. The `### Sir` "
                "header marks Sir's turn; the imperative 'Close that "
                "task' is the mutation."
            ),
        },
    ),
]


# ---------------------------------------------------------------------------
# Source-type framing — short interpretive primer per stream source.
# ---------------------------------------------------------------------------

# Keep these one-paragraph each. They sit at the top of the prompt
# right after the role description so the LLM has the right frame
# before it sees the event body. Unknown source types fall through to
# a generic frame.
_SOURCE_FRAMES: dict[str, str] = {
    "gmail": (
        "This is a Gmail message Sir received or sent. Sir is the "
        "user (owner@example.com, owner@example.com, alfred@example.com); "
        "the sender is the counterparty unless 'from' matches Sir. "
        "Receipts, marketing, and newsletters are noise. Invoices, "
        "account warnings, failed-payment notices, security alerts, "
        "direct human asks, and meeting requests ARE actions — even "
        "when the sender is automated, if the BODY describes a "
        "concrete obligation on Sir (pay, update, confirm, decide). "
        "Sir's own outbound mail confirming work done is a mutation."
    ),
    "slack": (
        "This is a Slack message. Watch for thread context — "
        "multi-message conversations may be split across stream "
        "events. Direct asks to Sir are actions; Sir's own messages "
        "saying a task is done / dropped / blocked / reframed / "
        "reparented ARE mutations on the named target. App-bot "
        "billing-state messages are usually informational."
    ),
    "omi": (
        "This is an ambient audio transcript Sir captured via his "
        "Omi wearable. Speakers are blended (speaker_attribution often "
        "= 'ambient'). Treat ONLY clear assertions in Sir's voice as "
        "signal candidates. Most Omi transcripts are ambient narration, "
        "domestic chatter, or essay-drafting and should be classified "
        "as noise. BUT: when Sir uses imperative/decisive language "
        "('I've decided…', 'we're not pursuing…', 'park X', 'spin one "
        "up', 'mark it as waiting', '… is resolved, close it') THAT "
        "is a real signal — emit mutation/action even though the "
        "channel is ambient. The bar for mutation/action is high here, "
        "but explicit decisions clear it."
    ),
    "openclaw-chat": (
        "This is Sir talking directly to you (Alfred) via the "
        "openclaw dashboard chat. The body may include a "
        "`### Sir`/`### Alfred` heading-per-turn structure or a "
        "plain message; in either case, Sir's turns are the signal "
        "source. Most direct assertions here ARE signals — Sir is "
        "explicitly engaging the agent and almost every imperative "
        "(create, drop, close, park, rename, reparent, send, schedule) "
        "is a real mutation or action. ONLY questions ('what's on my "
        "plate?'), recall ('show me X'), and explicit hypotheticals "
        "('what if…') are noise. When in doubt with openclaw-chat, "
        "lean toward producing a signal — the channel is too "
        "high-trust to drop on uncertainty."
    ),
    "vexa": (
        "This is a Google Meet / Vexa transcript with multiple "
        "speakers (each line typically prefixed `[<speaker>]:`). "
        "ONLY Sir's own assertions count as mutation/action sources. "
        "Counterparties' asks become signals ONLY when Sir agrees / "
        "commits (e.g. counterparty asks 'can you send X?', Sir "
        "replies 'yeah, I'll send it Friday' → action). Sir's own "
        "in-meeting decisions ('let's drop Acme Notes', 'that task is "
        "closed', 'spin up a matter for Berlin') ARE mutations."
    ),
    "sure": (
        "This is a Sure (finance app) event — usually a categorized "
        "transaction, recurring-charge match, or balance/dispute "
        "alert. Most routine matches are informational. Failed "
        "payments, duplicate charges, overdraft warnings, "
        "category-disagreement events, and large-unusual-charge "
        "events ARE actions (Sir or agent has to review/categorize/"
        "resolve). A confirmed-cancelled recurring charge that closes "
        "a Sir-driven subscription-decision task is a mutation."
    ),
    "gcal": (
        "This is a Google Calendar event change. New invites Sir "
        "hasn't responded to ARE actions (need RSVP). Conflicts and "
        "cancellations needing rescheduling ARE actions. Counterparty-"
        "accepted invites that close a Sir-owned 'schedule-it' task "
        "ARE mutations. Routine reminders for already-accepted "
        "meetings are informational. A solo time-block with no "
        "agenda and no other attendees is usually noise."
    ),
    "plane": (
        "This is a Plane (project tracker) issue, comment, or "
        "status-change event. The body describes an upstream change "
        "that Sir needs to react to or that mirrors something on his "
        "vault tasks. Counterparty comments asking Sir for input ARE "
        "actions. Reassign-to-Sir, priority bump, due-date alarm, "
        "and overdue alerts ARE actions even when phrased as "
        "automation ('Please update' boilerplate is still surfacing "
        "real obligations). Status changes by counterparty (closed, "
        "blocked) ARE mutations on Sir's mirrored task. State "
        "transitions Sir HIMSELF triggered upstream are "
        "informational — don't echo them back as signals."
    ),
    "vault_edit": (
        "This is a hand-edit Sir made (or just made) to a vault "
        "record. The body describes what changed (e.g. 'status: "
        "active → done', 'created matter/X.md'). Sir's vault edits "
        "are themselves the signal — the described change IS a "
        "mutation on the named target (target_hint should match the "
        "edited record's slug). status→done is task_resolution; "
        "creating a matter/X.md is matter_creation; reparenting a "
        "task is matter_membership; archiving a matter is "
        "matter_state_change. Edits to minor frontmatter fields "
        "(tags, priority) are noise."
    ),
}

_SOURCE_FRAME_GENERIC: str = (
    "This is a stream event of an unspecified source type. Apply the "
    "general assertion-vs-question filter and lean toward 'none' when "
    "in doubt."
)


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------

def _frontmatter_excerpt(frontmatter: dict[str, Any]) -> str:
    """Render a small, prompt-safe excerpt of the event frontmatter.

    The full frontmatter on a david vault event can run 30+ lines.
    We cherry-pick the fields that meaningfully change classification.
    Notably we INCLUDE ``action_items``, ``topic_tags``, ``alfred_tags``,
    ``related_persons``, ``related_orgs``, ``related_projects``: the
    upstream curator/distiller has often pre-extracted these — when the
    LLM doesn't see them, signals get classified as noise even though
    the system already knows the right answer. The cost in tokens is
    small; the classification recovery is large.
    """
    if not isinstance(frontmatter, dict):
        return "{}"
    keep_keys = (
        "from",
        "to",
        "subject",
        "name",
        "stream_type",
        "source",
        "priority",
        "speaker_attribution",
        "related_matters",
        "related_persons",
        "related_orgs",
        "related_projects",
        "entities",
        "channel",
        "session_id",
        "action_items",
        "topic_tags",
        "alfred_tags",
    )
    excerpt: dict[str, Any] = {}
    for key in keep_keys:
        if key in frontmatter and frontmatter[key] not in (None, "", [], {}):
            value = frontmatter[key]
            # Truncate large lists so a 50-relationship blob can't
            # dominate the prompt.
            if isinstance(value, list) and len(value) > 5:
                value = value[:5] + ["... (truncated)"]
            excerpt[key] = value
    try:
        return json.dumps(excerpt, indent=2, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(excerpt)


def _truncate_body(body: str, limit: int = 2000) -> str:
    """Cap the event body so the prompt stays under context budget.

    OMI part-N transcripts can be 4-6k chars each. We keep the head
    (where Sir's assertions usually land — 'I've decided…' / 'we
    should…' tend to start sentences) plus a tail marker.
    """
    if not isinstance(body, str):
        return ""
    body = body.strip()
    if len(body) <= limit:
        return body
    return body[:limit].rstrip() + "\n... (body truncated for prompt budget)"


def _render_few_shot(
    inp: dict[str, Any], out: dict[str, Any], idx: int
) -> str:
    """Render one few-shot pair as a markdown block."""
    inp_block = json.dumps(inp, indent=2, ensure_ascii=False, default=str)
    out_block = json.dumps(out, indent=2, ensure_ascii=False, default=str)
    return (
        f"### Example {idx}\n"
        f"**Input event:**\n```json\n{inp_block}\n```\n"
        f"**Expected output:**\n```json\n{out_block}\n```"
    )


def build_signal_extraction_prompt(
    source_type: str,
    event_frontmatter: dict,
    event_body: str,
    raw_quote: str,
) -> str:
    """Construct the LLM prompt for one stream event.

    Contract: this function's signature is imported by
    ``src.activities.signals.extract_signal_from_event``. Don't
    rename or reorder positional parameters without coordinating
    with that activity's caller site.

    The returned string is one self-contained prompt (no separate
    system/user split) because ``clerk._call_clerk`` takes a single
    prompt argument. Structure of the returned prompt:

      1. Role + task description.
      2. Source-type-specific interpretive frame.
      3. The 8-class mutation taxonomy with definitions.
      4. The 4-class effect taxonomy + the 3-value wire mapping.
      5. The strict JSON output schema.
      6. Assertion-vs-question filter rules.
      7. 8 few-shot examples covering breadth + negatives.
      8. The actual event to classify.
      9. The "Output ONLY the JSON object" closer.

    The whole thing aims for clarity and load-bearing detail over
    brevity. Trimming this prompt is a T6.7 calibration job, not a
    cost-cutting reflex.
    """
    source_type = (source_type or "").strip().lower()
    frame = _SOURCE_FRAMES.get(source_type, _SOURCE_FRAME_GENERIC)

    # ---- Section 3 — mutation taxonomy with one-line definitions.
    mutation_defs = "\n".join(
        f"- `{cls}` — {desc}"
        for cls, desc in (
            ("task_resolution",
             "Sir says a task is already done / handled / resolved."),
            ("task_dismissal",
             "Sir says to drop the task entirely (not pursuing it)."),
            ("task_reframing",
             "Sir says the task is really about something different from "
             "what it currently says."),
            ("task_blocked_on",
             "Sir says the task is waiting on something / someone before "
             "it can move."),
            ("matter_context_edit",
             "Sir says the matter's framing is wrong — the situation is "
             "actually about a different topic / person / scope."),
            ("matter_state_change",
             "Sir says to park, archive, reactivate, or close a matter."),
            ("matter_creation",
             "Sir says a topic should become its own matter (split-off, "
             "spin-up, promote-to-matter)."),
            ("matter_membership",
             "Sir says a task / sub-thing belongs under a different "
             "matter than where it currently lives."),
        )
    )

    # ---- Section 4 — effect taxonomy + wire mapping.
    effect_defs = (
        "- `mutation` — the event implies a state change to an existing "
        "task or matter record. Pick this when one of the 8 mutation "
        "classes above clearly fires.\n"
        "- `action` — the event implies work needs to happen (reply, "
        "send, schedule, pay, decide). No existing record state changes "
        "yet — but Sir or an agent has to do something.\n"
        "- `informational` — real content worth knowing (a receipt, an "
        "FYI, a status update Sir didn't request) but no mutation and "
        "no action. **Wire format: emit `\"effect\": \"none\"` and "
        "explain in `reasoning` that it's informational.**\n"
        "- `noise` — the event shouldn't even drive a glance: "
        "newsletter spam, system notifications, ambient OMI silence, "
        "Sir reading something out loud, hypotheticals, questions. "
        "**Wire format: emit `\"effect\": \"none\"` and explain in "
        "`reasoning` that it's noise.**\n"
    )

    # ---- Section 5 — JSON output schema (exact shape the LLM must produce).
    schema_block = """{
  "classification": "<one of the 8 mutation taxonomy classes; null when effect != mutation>",
  "effect": "<mutation | action | none>",
  "target_kind": "<task | matter | null>",
  "target_hint": "<short text describing what task or matter Sir is referring to, OR null>",
  "mutation_proposal": {
    "decision": "<for effect=mutation only: e.g. 'likely_done', 'archive', 'reparent_to:matter/<slug>', 'create_matter:matter/<slug>'>",
    "details": "<free-form description of the proposed change>"
  },
  "action_proposal": {
    "what": "<short action description>",
    "suggested_actor": "<human | agent | either>",
    "due_at": "<ISO8601 datetime string or null>"
  },
  "target_confidence": 0.0,
  "effect_confidence": 0.0,
  "reasoning": "<1-3 sentences explaining your call>",
  "display_headline": "<Alfred's one-line headline for Sir's desk, in Alfred's voice; null when effect=none>",
  "display_body": "<Alfred's 1-2 sentence framing: what happened, what he'd suggest. In Alfred's voice. null when effect=none>"
}"""

    schema_rules = (
        "Schema rules:\n"
        "- `effect` MUST be exactly one of `mutation`, `action`, "
        "`none` (the wire enum). Map informational and noise both to "
        "`none` and disambiguate in `reasoning`.\n"
        "- When `effect` is `mutation`, `classification` MUST be one "
        "of the 8 taxonomy classes and `mutation_proposal` MUST be "
        "an object (not null). `action_proposal` MUST be null.\n"
        "- When `effect` is `action`, `classification` MUST be null "
        "and `action_proposal` MUST be an object (not null). "
        "`mutation_proposal` MUST be null.\n"
        "- When `effect` is `none`, set `classification`, "
        "`target_kind`, `target_hint`, `mutation_proposal`, and "
        "`action_proposal` all to null. Set `target_confidence` to "
        "0. `effect_confidence` reflects how sure you are it's "
        "informational/noise (high = clearly nothing).\n"
        "- `target_confidence` and `effect_confidence` are floats in "
        "[0.0, 1.0]. Do not emit percentages, do not emit strings, "
        "do not emit nulls.\n"
        "- `target_kind` MUST be `task` or `matter` (or null). Never "
        "invent a third kind.\n"
        "- `reasoning` MUST be 1-3 sentences. Never emit empty "
        "string.\n"
        "- `display_headline` and `display_body` are the human-facing "
        "surface fields. When `effect` is `action` or `mutation`, both "
        "MUST be non-empty strings written in Alfred's voice "
        "(see Section 4.5). When `effect` is `none`, both MUST be "
        "null. Some of the few-shot examples below predate these "
        "fields — emit them anyway following Section 4.5."
    )

    # ---- Section 4.5 — Alfred's voice for the surface fields.
    # The schema-anchored prose (`reasoning`) stays a calibration-loop
    # field and reads like research notes. `display_headline` and
    # `display_body` are what Sir actually reads on /desk — they need
    # to sound like the assistant from SOUL.md, not like a router.
    voice_block = (
        "## 4.5 Alfred's voice for `display_headline` and `display_body`\n\n"
        "These two fields are the only thing Sir sees on his Today "
        "screen. Everything else in this JSON is plumbing. Write them "
        "as Alfred would — grounded in SOUL.md:\n\n"
        "- **Genuinely helpful, not performatively helpful.** No "
        '"Great question!", no "Here\'s what I found:", no apologies '
        "for the obvious. Skip filler. Go straight to the point.\n"
        "- **Have an opinion.** Don't list options when one is "
        "clearly better. Suggest the thing. If there's a real "
        "tradeoff, say so in one phrase, then recommend.\n"
        "- **Proactive, not reactive.** Frame what happened as "
        "Alfred noticing on Sir's behalf, and what he'd suggest "
        "doing. Use first person sparingly (\"I'd update the card\", "
        '"I\'d skip this one") but never sycophantic ("I\'d be '
        'happy to…").\n'
        "- **Concise.** Headline: ≤ 9 words, ideally a sentence "
        "fragment with a verb. Body: 1-2 sentences, ≤ 240 chars "
        "total. Use the em dash freely when it tightens the line.\n"
        "- **Refer to Sir in second person (\"you\") in the body**, "
        "not third person. The headline can be subjectless.\n"
        "- **No jargon, no decision codes**, no confidence numbers, "
        "no record IDs. Those live elsewhere in the JSON.\n\n"
        "Voice examples — same input scenario, three registers, "
        "Alfred is the last one:\n\n"
        '- Router (wrong): "Slack subscription renewal payment '
        'failed; suggest updating payment method or cancelling."\n'
        '- Sycophant (wrong): "I noticed Slack had trouble with '
        'your payment! Would you like me to help you sort it out?"\n'
        '- Alfred (right): headline `"Slack wants their money — '
        'or they\'ll close the workspace."` body `"Their renewal '
        "charge didn't go through on Friday. I'd update the card "
        'in Slack billing — unless Lumberjack is wrapping up, in '
        'which case this is a clean moment to cancel."`\n\n'
        "Two more shapes:\n\n"
        '- Calendar invite needing RSVP: headline `"Acme Consulting '
        'check-in wants an RSVP by Friday."` body `"Andrew '
        "Newton put a 30-min hold on Friday 3pm — I'd accept "
        "unless you want me to push it; you've got the kids "
        'pickup at 4."`\n'
        '- Medical invoice: headline `"Acme Clinic sent the '
        'hospital bill."` body `"It\'s due by the end of the '
        "month. I'd file it under household cash flow and pay "
        'now while it\'s in hand."`\n'
    )

    # ---- Section 6 — assertion-vs-question filter rules.
    assertion_filter = (
        "Assertion-vs-question filter (apply BEFORE classifying):\n"
        "- An *assertion* is 'I've decided X' / 'X is done' / 'stop "
        "doing Y' / 'this is wrong, it's actually Z' / 'spin up a "
        "matter for X'. Assertions can produce signals.\n"
        "- A *question* is 'should I do X?' / 'what's on my list?' / "
        "'tell me about Y' / 'is X done yet?'. Questions NEVER "
        "produce mutation/action signals — they are answered in-"
        "session, not via vault mutations. Classify as effect=none, "
        "reasoning=question.\n"
        "- A *hypothetical* is 'what if I…' / 'imagine…' / 'in "
        "theory…' / 'we could maybe…' / 'I'm thinking … maybe'. "
        "Hypotheticals NEVER produce signals. Classify as effect=none, "
        "reasoning=hypothetical.\n"
        "- A *narration* is Sir reading something out loud, ambient "
        "OMI silence, third-party speech in background, essay-"
        "drafting, domestic chatter (e.g. about groceries / the kids). "
        "Narration NEVER produces signals. Classify as effect=none, "
        "reasoning=narration.\n"
        "- A *system/automation echo* is when an upstream system "
        "describes a state in third-person (e.g. 'Plane issue X "
        "status changed', 'Sir hand-edited frontmatter on Y', "
        "'Recurring charge ended', 'Calendar event status: needs "
        "response'). These are NOT noise just because the phrasing "
        "is automated — they DO produce signals when the described "
        "state is something Sir or his agent must react to (RSVP, "
        "pay, review, mirror a closed task). Treat the body as "
        "ground truth about what happened and classify accordingly. "
        "Only echoes of Sir's OWN upstream actions (e.g. 'Sir "
        "himself moved ALFRED-180 to in_progress') are pure "
        "informational noise — those are reflections of work he "
        "already did.\n"
        "The bar: would a human assistant reading this expect to "
        "TAKE ACTION or CHANGE A RECORD because of it? If not → "
        "effect=none. If yes (even when phrased as automation) → "
        "effect=action or effect=mutation.\n\n"
        "Upstream-hints rule (load-bearing):\n"
        "- If `frontmatter.action_items` is a non-empty list, this "
        "is the upstream curator/distiller telling you the answer. "
        "DEFAULT to `effect=action` with `action_proposal.what` set "
        "to the first action item. Only override to `effect=none` "
        "if the body explicitly contradicts (e.g. 'never mind, "
        "we're not doing this'). If `frontmatter.related_matters` "
        "has at least one entry, set `target_kind=matter` and "
        "`target_hint` from that entry.\n"
        "- If `frontmatter.priority` is `high` AND `action_items` "
        "is non-empty, treat `effect_confidence` as ≥ 0.85.\n"
        "- `frontmatter.topic_tags` like `failed-payment`, "
        "`card-declined`, `mailroom-renewal`, `subscription-"
        "cancellation`, `invoice`, `due-date` are strong action "
        "indicators — these alone (with empty body) are enough to "
        "produce an action signal grounded in the subject.\n\n"
        "Empty-body rule:\n"
        "- Compute the body's actionable length: strip leading "
        "lines that are just `**From**:`, `**To**:`, `## Entities`, "
        "and `# <subject repeated>`. If what remains is ≤300 chars, "
        "treat the body as effectively empty and ground your "
        "decision in `subject` + `frontmatter.action_items` + "
        "`frontmatter.topic_tags`. Don't default to noise just "
        "because the body looks short — many gmail events on this "
        "tenant lost their bodies during a Composio fetch bug, but "
        "their subjects (e.g. 'DigitalOcean - Failed to process "
        "card payment') are still unambiguous action signals."
    )

    # ---- Section 7 — few-shot examples.
    few_shot_block = "\n\n".join(
        _render_few_shot(inp, out, i + 1)
        for i, (inp, out) in enumerate(FEW_SHOT_EXAMPLES)
    )

    # ---- Section 8 — the actual event under classification.
    fm_excerpt = _frontmatter_excerpt(event_frontmatter or {})
    body_excerpt = _truncate_body(event_body or "")
    raw_quote_clean = (raw_quote or "").strip()

    event_block = (
        f"source_type: `{source_type or 'unknown'}`\n\n"
        f"frontmatter (excerpt):\n```json\n{fm_excerpt}\n```\n\n"
        f"body:\n```\n{body_excerpt}\n```\n\n"
        f"raw_quote (≤200 chars, this is what survives stream-event "
        f"purge):\n```\n{raw_quote_clean}\n```"
    )

    # ---- Final assembly.
    return f"""You are Alfred's signal extractor. Your job: read ONE stream event and decide whether it should produce a `signal` record (which downstream routers will use to mutate vault state, dispatch agent work, or surface a needs-attention card to Sir) — and if so, what kind.

You produce STRICT JSON output that another Python module parses. Malformed JSON, missing fields, or values outside the declared enums break the downstream pipeline silently and lose Sir's signal. Be precise.

## 1. Source-type frame

{frame}

## 2. The 8 mutation classes (RFC #842 §6)

Pick exactly one when `effect` is `mutation`:

{mutation_defs}

## 3. The effect taxonomy (4-way conceptually, 3-way on the wire)

{effect_defs}

## 4. The output JSON schema

You MUST emit exactly this shape (with the field types shown):

```json
{schema_block}
```

{schema_rules}

{voice_block}

## 5. Assertion-vs-question filter (the critical gate)

{assertion_filter}

## 6. Few-shot examples (real events from Sir's vault unless flagged synthetic)

{few_shot_block}

## 7. The event you must classify now

{event_block}

## 8. Output

Output ONLY the JSON object, no other text. No markdown code fences. No commentary before or after. The first character of your response must be `{{` and the last must be `}}`.
"""


# ---------------------------------------------------------------------------
# Multi-signal prompt builder — Phase 1 of the n-signals refactor.
# ---------------------------------------------------------------------------
#
# Why a second builder rather than evolving the existing one in place:
# in-flight workflows replaying old history must keep returning the same
# single-signal shape. The new `extract_signals_from_event` activity is
# wired through `workflow.patched("signal_extract_multi_signal_v1")`; it
# calls this builder, parses a `{"signals": [...]}` envelope, and emits
# 0..N signal dicts (each in the same per-signal shape the legacy
# validator already accepts). The pre-patched branch keeps calling the
# legacy single-signal builder above.


def build_signal_extraction_prompt_multi(
    source_type: str,
    event_frontmatter: dict,
    event_body: str,
    raw_quote: str,
    soul_md: str | None = None,
) -> str:
    """Multi-signal variant of ``build_signal_extraction_prompt``.

    One stream event may contain multiple, conceptually independent
    signals — e.g. a single openclaw-chat session in which Sir closes
    one task AND spins up a new matter; an Omi recording in which he
    makes two separate decisions; a long email thread that triggers
    both an RSVP and a payment. The legacy prompt forced the LLM into
    a single-signal frame, which lost the second signal silently. This
    builder asks the LLM for a *list* — and accepts 0 (noise) as a
    first-class output.

    The per-signal output shape is identical to the legacy
    single-signal output (so the validator + downstream consumers
    stay unchanged), PLUS one new per-signal field:

      - ``raw_quote`` — the LLM's own evidence excerpt for THIS
        signal (≤200 chars). The activity will fall back to the
        stream-event-level raw_quote (T6.6 purge-survival quote) when
        the LLM omits it, but per-signal quotes are the goal — they
        let Sir's reader and the audit ledger anchor each signal to
        the exact span that triggered it.

    The wire envelope:

      {
        "signals": [
          { ...per-signal shape, with raw_quote... },
          ...
        ]
      }

    An empty list means "this event produced no signals" (the
    multi-signal analogue of the legacy ``effect=none`` shortcut).
    """
    source_type = (source_type or "").strip().lower()
    frame = _SOURCE_FRAMES.get(source_type, _SOURCE_FRAME_GENERIC)

    mutation_defs = "\n".join(
        f"- `{cls}` — {desc}"
        for cls, desc in (
            ("task_resolution",
             "Sir says a task is already done / handled / resolved."),
            ("task_dismissal",
             "Sir says to drop the task entirely (not pursuing it)."),
            ("task_reframing",
             "Sir says the task is really about something different from "
             "what it currently says."),
            ("task_blocked_on",
             "Sir says the task is waiting on something / someone before "
             "it can move."),
            ("matter_context_edit",
             "Sir says the matter's framing is wrong — the situation is "
             "actually about a different topic / person / scope."),
            ("matter_state_change",
             "Sir says to park, archive, reactivate, or close a matter."),
            ("matter_creation",
             "Sir says a topic should become its own matter (split-off, "
             "spin-up, promote-to-matter)."),
            ("matter_membership",
             "Sir says a task / sub-thing belongs under a different "
             "matter than where it currently lives."),
        )
    )

    effect_defs = (
        "- `mutation` — the event implies a state change to an existing "
        "task or matter record. Pick this when one of the 8 mutation "
        "classes above clearly fires.\n"
        "- `action` — the event implies work needs to happen (reply, "
        "send, schedule, pay, decide). No existing record state changes "
        "yet — but Sir or an agent has to do something.\n"
        "- `informational` and `noise` — these never appear as items in "
        "the `signals` list. When an event is purely informational OR "
        "purely noise, return an EMPTY list `\"signals\": []`. Do not "
        "emit a signal entry just to mark something as noise.\n"
    )

    per_signal_schema = """{
  "raw_quote": "<≤200 chars: the exact span of the body that triggered THIS signal — evidence>",
  "classification": "<one of the 8 mutation taxonomy classes; null when effect != mutation>",
  "effect": "<mutation | action>",
  "actor": "<principal | counterparty | system | alfred — who acted to produce this signal>",
  "decision_required": true | false,
  "target_kind": "<task | matter | null>",
  "target_hint": "<short text describing what task or matter Sir is referring to, OR null>",
  "mutation_proposal": {
    "decision": "<for effect=mutation only: e.g. 'likely_done', 'archive', 'reparent_to:matter/<slug>', 'create_matter:matter/<slug>'>",
    "details": "<free-form description of the proposed change>"
  },
  "action_proposal": {
    "what": "<short action description>",
    "suggested_actor": "<human | agent | either>",
    "due_at": "<ISO8601 datetime string or null>"
  },
  "target_confidence": 0.0,
  "effect_confidence": 0.0,
  "reasoning": "<1-3 sentences explaining your call>",
  "display_headline": "<for decision_required=true: Alfred's forward-looking headline for Sir's desk. For decision_required=false: brief past-tense bookkeeping line for the matter timeline.>",
  "display_body": "<for decision_required=true: 1-2 sentences in Alfred's voice, second-person, what he'd suggest. For decision_required=false: one terse bookkeeping line, first person fine.>"
}"""

    schema_block = (
        "{\n"
        '  "signals": [\n'
        f"    {per_signal_schema},\n"
        "    ... (zero or more signal entries)\n"
        "  ]\n"
        "}"
    )

    schema_rules = (
        "Schema rules:\n"
        "- Top-level shape is ALWAYS `{\"signals\": [...]}`. The list "
        "MAY be empty (noise / informational / question / "
        "hypothetical) — that is the valid encoding for \"no "
        "signals fire on this event.\"\n"
        "- Each entry in the list represents ONE independent signal: "
        "one decision Sir made, one action that needs taking, one "
        "mutation to a single record. If Sir closed two unrelated "
        "tasks in the same Omi clip, emit TWO entries. If a long "
        "email thread triggers both an RSVP and a payment, emit TWO "
        "entries.\n"
        "- `effect` per entry MUST be exactly one of `mutation` or "
        "`action`. Noise/informational events emit no entry; do not "
        "emit `effect=none` items.\n"
        "- `actor` per entry MUST be one of "
        "`principal | counterparty | system | alfred` — see Section "
        "3.5.\n"
        "- `decision_required` per entry MUST be a strict boolean "
        "(`true` or `false`, not strings) — see Section 3.5. This is "
        "the single most load-bearing field after `effect`: it gates "
        "whether the signal becomes a /desk card asking Sir to act "
        "or whether it lands silently on the matter timeline as "
        "bookkeeping.\n"
        "- When `effect` is `mutation`, `classification` MUST be one "
        "of the 8 taxonomy classes and `mutation_proposal` MUST be "
        "an object (not null). `action_proposal` MUST be null.\n"
        "- When `effect` is `action`, `classification` MUST be null "
        "and `action_proposal` MUST be an object (not null). "
        "`mutation_proposal` MUST be null.\n"
        "- `raw_quote` per entry is mandatory and ≤200 chars. Pick the "
        "smallest excerpt from the event body that is sufficient on "
        "its own evidence for THIS signal. Don't share quotes across "
        "entries — each signal stands alone.\n"
        "- `target_confidence` and `effect_confidence` are floats in "
        "[0.0, 1.0]. Do not emit percentages, do not emit strings, "
        "do not emit nulls.\n"
        "- `target_kind` MUST be `task` or `matter` (or null). Never "
        "invent a third kind.\n"
        "- `reasoning` MUST be 1-3 sentences. Never emit empty "
        "string.\n"
        "- `display_headline` and `display_body` MUST be non-empty. "
        "The voice depends on `decision_required` — see Section 4.5. "
        "Cards face forward (decision_required=true). Bookkeeping "
        "entries face backward, terse, descriptive "
        "(decision_required=false).\n"
        "- Order of entries doesn't matter; the downstream pipeline "
        "treats them as a set. If two entries would collapse to the "
        "same target with the same effect, emit ONE entry with the "
        "stronger reasoning rather than duplicating."
    )

    # Section 3.5 — actor + decision_required classification.
    # This is the load-bearing addition for Phase 3: a signal is
    # always recorded against a matter+task (bookkeeping), but it
    # ONLY surfaces as a /desk card when decision_required=true.
    # Sir's own outbound actions (e.g. an email he sent asking
    # someone something) ARE signals — they update the matter
    # timeline — but they do NOT need a Sir-side decision because he
    # already acted by sending. He shouldn't open /desk to be told
    # what he did yesterday.
    actor_decision_block = (
        "## 3.5 Actor + decision_required (the new load-bearing fields)\n\n"
        "**Why these exist:** every signal flows to its matter + task "
        "timeline as bookkeeping. But only a SUBSET need Sir's eyes "
        "right now. `actor` records who acted; `decision_required` "
        "says whether Sir needs to look at this card on /desk.\n\n"
        "### actor — who acted in the underlying event\n"
        "- `principal` — Sir is the actor. The event is an outbound "
        "thing Sir sent / a decision Sir already made / Sir's own "
        "vault edit / Sir's own upstream status change (e.g. he "
        "moved a Plane issue himself).\n"
        "  - gmail: `frontmatter.from` matches a Sir-owned address "
        "(`owner@example.com`, `owner@example.com`, "
        "`alfred@example.com`).\n"
        "  - openclaw-chat: anything inside a `### Sir` heading or "
        "an unstructured chat body Sir authored.\n"
        "  - omi: Sir is the speaker.\n"
        "  - vault_edit: any record Sir hand-edited.\n"
        "  - plane: Sir is named as the actor on the status change.\n"
        "- `counterparty` — an external human acted: counterparty "
        "emailed Sir, counterparty commented on a Plane ticket Sir "
        "watches, counterparty spoke on a Vexa transcript.\n"
        "- `system` — automated upstream: failed-payment notices, "
        "Plane state reassignments by a bot, Sure transaction "
        "categorizations, calendar invites generated by another "
        "person's calendar app, etc.\n"
        "- `alfred` — Alfred himself acted autonomously (rare on the "
        "extractor; this branch is mostly emitted by signal_router "
        "for OBS-6 companion decisions). When you see no human "
        "actor and the source is Alfred's own background workflow, "
        "use this.\n\n"
        "### decision_required — does Sir need to look at this?\n"
        "Default rules by actor:\n"
        "- `actor=principal` → `decision_required=false`. Sir already "
        "acted. The signal is bookkeeping — it updates the matter "
        "timeline (e.g. 'Sir contacted Acme re EIN on May 14') "
        "but doesn't put a card on /desk asking him to decide what "
        "he already decided. Override to `true` ONLY if Sir's "
        "outbound action explicitly creates a future Sir-side "
        "follow-up he needs to schedule (rare — usually it just "
        "means waiting for the counterparty).\n"
        "- `actor=counterparty` and Sir is the recipient / target of "
        "an ask → `decision_required=true`. Counterparty needs a "
        "reply, a payment, a confirmation, a scheduling response. "
        "This is the canonical /desk card.\n"
        "- `actor=counterparty` but Sir is NOT being asked for "
        "anything (FYI cc, broadcast, third-party-to-third-party "
        "thread Sir is just on) → `decision_required=false` if "
        "still a signal worth recording, else emit nothing.\n"
        "- `actor=system` echoing Sir's OWN upstream action → "
        "`decision_required=false`. (Sir himself moved an issue in "
        "Plane; the webhook echo doesn't need a card.)\n"
        "- `actor=system` describing a state Sir must react to "
        "(failed payment, RSVP-needed invite, due-date overdue) → "
        "`decision_required=true`.\n"
        "- `actor=alfred` → `decision_required=false`. The OBS-1 "
        "decision→observation loop handles training; no card.\n\n"
        "### Cardinal test\n"
        "If Sir reads this card, will he say *\"I know, I did that\"* "
        "or *\"why are you telling me what I already did\"*? If yes "
        "→ `decision_required=false`. The card shouldn't exist. The "
        "signal still gets recorded for matter-timeline bookkeeping, "
        "but it lands silently.\n\n"
        "### Worked examples\n"
        "- Sir emails `tax@example.com` asking about the EIN. "
        "→ `actor=principal`, `decision_required=false`. Bookkeeping "
        "entry on the tax matter timeline: \"Sent Acme the "
        "EIN question.\" No card.\n"
        "- Acme replies to Sir with the EIN answer. "
        "→ `actor=counterparty`, `decision_required=true`. /desk "
        "card: \"Acme answered on the EIN — you can finish "
        "the form.\"\n"
        "- Stripe webhook: payment Sir initiated yesterday "
        "settled. → `actor=system` echoing Sir's own action, "
        "`decision_required=false`. Bookkeeping only.\n"
        "- Stripe webhook: a customer's card declined. "
        "→ `actor=system` describing a state Sir must react to, "
        "`decision_required=true`. Card: \"Acme Consulting customer's "
        "card declined — I'd retry in 24h or email them.\"\n"
        "- Sir says \"close the Acme Cloud billing task\" in "
        "openclaw-chat. → `actor=principal`, "
        "`decision_required=false`. Bookkeeping: Sir's "
        "task-resolution decision is already made; the signal "
        "drives the mutation on the task. No /desk card.\n"
    )

    # Inline SOUL.md (the principal's voice anchor) when the caller
    # passed it in. SOUL.md is read once per signal-extract tick from
    # the tenant workspace and threaded through. The phrase "grounded
    # in SOUL.md" in the bullet rules below WAS aspirational before
    # — the model never saw SOUL.md. Now the LLM gets the actual
    # voice anchor as load-bearing context, not a reference.
    soul_inline = ""
    if isinstance(soul_md, str) and soul_md.strip():
        soul_inline = (
            "### SOUL.md — Alfred's voice (Sir's living voice guide; "
            "treat this as the canonical source for HOW to speak)\n\n"
            "```\n"
            f"{soul_md.strip()}\n"
            "```\n\n"
        )

    voice_block = (
        "## 4.5 Alfred's voice for `display_headline` and `display_body`\n\n"
        + soul_inline
        + "These two fields appear in TWO different surfaces, and the "
        "register depends entirely on `decision_required`:\n\n"
        "### When `decision_required` is `true` (a /desk card)\n"
        "Sir is reading this on his Today screen because Alfred is "
        "asking him to look. The card faces FORWARD — what Alfred "
        "noticed, what he'd suggest, what Sir might want to decide. "
        "Apply SOUL.md voice rigorously:\n"
        "- **Genuinely helpful, not performatively helpful.** No "
        '"Great question!", no "Here\'s what I found:", no apologies '
        "for the obvious. Skip filler. Go straight to the point.\n"
        "- **Have an opinion.** Don't list options when one is "
        "clearly better. Suggest the thing. If there's a real "
        "tradeoff, say so in one phrase, then recommend.\n"
        "- **Proactive, not reactive.** Frame what happened as "
        "Alfred noticing on Sir's behalf, and what he'd suggest "
        "doing. Use first person sparingly (\"I'd update the card\", "
        '"I\'d skip this one") but never sycophantic ("I\'d be '
        'happy to…").\n'
        "- **Concise.** Headline: ≤ 9 words, ideally a sentence "
        "fragment with a verb. Body: 1-2 sentences, ≤ 240 chars "
        "total. Use the em dash freely when it tightens the line.\n"
        "- **Refer to Sir in second person (\"you\")**, never third. "
        '"You\'ve got an unresponded invite" — never "He has an '
        'unresponded invite". The headline can be subjectless.\n'
        "- **Never narrate Sir's past actions back to him.** If the "
        "card opens with \"He hit a wall on the Acme form\" or "
        '"Sir sent an email about X", you got it wrong — that signal '
        "should have been `decision_required=false`. Cards face "
        "forward; bookkeeping lines face backward. See Section 3.5.\n"
        "- **No jargon, no decision codes**, no confidence numbers, "
        "no record IDs. Those live elsewhere in the JSON.\n\n"
        "### When `decision_required` is `false` (matter-timeline "
        "bookkeeping)\n"
        "These never surface on /desk. They land on the matter or "
        "task timeline as silent state-updates. Sir reads them only "
        "if he opens the matter detail page. The register is "
        "different:\n"
        "- **Brief past-tense descriptive.** *\"Sent Acme the "
        "EIN question.\"* / *\"Stripe payment for $400 settled.\"* / "
        "*\"Closed the Acme Cloud billing task.\"*\n"
        "- **First person fine** when Alfred is summarising "
        "(*\"I'll watch for Acme's reply.\"*) but third person "
        "in past tense is OK too here — the timeline is a record, "
        "not a conversation.\n"
        "- **Even shorter.** Headline: ≤ 9 words. Body: ONE sentence, "
        "≤ 140 chars. These are log entries, not prose.\n"
        "- **No suggestion, no recommendation.** Don't ask Sir to do "
        "anything. He already acted (or the actor wasn't him); the "
        "entry is just what was logged.\n"
    )

    multi_signal_rules = (
        "## 0. Multi-signal framing (read first)\n\n"
        "One stream event may carry zero, one, or many signals. Your "
        "job is to enumerate ALL of them — not collapse them into one. "
        "Each signal corresponds to a single decision/action/mutation "
        "on a single target.\n\n"
        "Examples of multi-signal events:\n"
        "- An openclaw-chat turn where Sir says \"close the Acme Cloud "
        "billing task, and also spin up a matter for the Berlin "
        "trip\" → 2 signals: 1 mutation (task_resolution) + 1 "
        "mutation (matter_creation).\n"
        "- A long email thread where the counterparty asks Sir to "
        "RSVP for a meeting AND to confirm a payment plan → 2 "
        "action signals.\n"
        "- An Omi clip where Sir says \"the Acme Notes thing is dead, "
        "drop it\" AND \"actually the Anna onboarding belongs under "
        "Berlin not under household\" → 2 mutations "
        "(task_dismissal + matter_membership).\n\n"
        "Examples of zero-signal events (emit `\"signals\": []`):\n"
        "- Receipts, newsletters, marketing.\n"
        "- Sir asking a question, recalling, hypothesising.\n"
        "- Ambient Omi narration / domestic chatter.\n"
        "- System echoes of Sir's own upstream actions.\n\n"
        "Examples of single-signal events:\n"
        "- A simple invoice email → 1 action signal.\n"
        "- A calendar invite needing RSVP → 1 action signal.\n"
        "- Sir tells Alfred via openclaw-chat to close one task → "
        "1 mutation signal.\n\n"
        "Independence rule: if two candidate signals share the same "
        "target AND the same effect AND are saying essentially the "
        "same thing, MERGE them into one entry with the stronger "
        "reasoning. The list is a SET of distinct signals, not a "
        "transcript of every sentence."
    )

    assertion_filter = (
        "Assertion-vs-question filter (apply BEFORE classifying):\n"
        "- An *assertion* is 'I've decided X' / 'X is done' / 'stop "
        "doing Y' / 'this is wrong, it's actually Z' / 'spin up a "
        "matter for X'. Assertions can produce signals.\n"
        "- A *question* is 'should I do X?' / 'what's on my list?' / "
        "'tell me about Y' / 'is X done yet?'. Questions NEVER "
        "produce mutation/action signals — drop them.\n"
        "- A *hypothetical* is 'what if I…' / 'imagine…' / 'in "
        "theory…' / 'we could maybe…' / 'I'm thinking … maybe'. "
        "Hypotheticals NEVER produce signals.\n"
        "- A *narration* is Sir reading something out loud, ambient "
        "OMI silence, third-party speech in background, essay-"
        "drafting, domestic chatter. Narration NEVER produces "
        "signals.\n"
        "- A *system/automation echo* is when an upstream system "
        "describes a state in third-person (e.g. 'Plane issue X "
        "status changed', 'Sir hand-edited frontmatter on Y', "
        "'Recurring charge ended'). These DO produce signals when "
        "the described state is something Sir or his agent must "
        "react to (RSVP, pay, review, mirror a closed task). Only "
        "echoes of Sir's OWN upstream actions are pure "
        "informational noise.\n"
        "The bar: would a human assistant reading this expect to "
        "TAKE ACTION or CHANGE A RECORD because of it? If not → "
        "drop the signal (or emit empty list). If yes → emit one "
        "signal entry per distinct action/mutation.\n\n"
        "Upstream-hints rule (load-bearing):\n"
        "- If `frontmatter.action_items` is a non-empty list, each "
        "item is typically a separate action signal. Emit one entry "
        "per action item unless two items collapse to the same "
        "target. Set `target_kind=matter` and `target_hint` from "
        "`frontmatter.related_matters[0]` if present.\n"
        "- `frontmatter.topic_tags` like `failed-payment`, "
        "`invoice`, `due-date` are strong action indicators — these "
        "alone (with empty body) are enough to produce an action "
        "signal grounded in the subject.\n\n"
        "Empty-body rule:\n"
        "- Compute the body's actionable length: strip leading lines "
        "that are just `**From**:`, `**To**:`, `## Entities`. If "
        "what remains is ≤300 chars, ground decisions in `subject` + "
        "`frontmatter.action_items` + `frontmatter.topic_tags`. "
        "Don't default to empty list just because the body looks "
        "short — many gmail events have lost bodies but their "
        "subjects (e.g. 'DigitalOcean - Failed to process card "
        "payment') are still unambiguous action signals."
    )

    # Few-shot examples for multi-signal. We reuse the existing
    # FEW_SHOT_EXAMPLES dataset (each is a single-signal scenario) and
    # render it as the equivalent multi-signal output: signals=[entry]
    # for action/mutation, signals=[] for noise. Then we add a handful
    # of multi-signal scenarios for the truly multi-signal cases.
    def _legacy_to_multi(out: dict[str, Any]) -> dict[str, Any]:
        if out.get("effect") == "none":
            return {"signals": []}
        # Phase 3 — legacy few-shots predate actor + decision_required.
        # All legacy examples are counterparty-driven action/mutation
        # events Sir must react to → inject the canonical defaults so
        # the rendered example still teaches the new schema.
        entry: dict[str, Any] = {
            "raw_quote": out.get("raw_quote") or "",
            "classification": out.get("classification"),
            "effect": out.get("effect"),
            "actor": out.get("actor") or "counterparty",
            "decision_required": (
                out["decision_required"]
                if "decision_required" in out
                else True
            ),
            "target_kind": out.get("target_kind"),
            "target_hint": out.get("target_hint"),
            "mutation_proposal": out.get("mutation_proposal"),
            "action_proposal": out.get("action_proposal"),
            "target_confidence": out.get("target_confidence", 0.0),
            "effect_confidence": out.get("effect_confidence", 0.0),
            "reasoning": out.get("reasoning") or "",
            "display_headline": out.get(
                "display_headline"
            ) or "(placeholder — set this in your output)",
            "display_body": out.get(
                "display_body"
            ) or "(placeholder — set this in your output)",
        }
        return {"signals": [entry]}

    legacy_examples_rendered: list[str] = []
    for i, (inp, out) in enumerate(FEW_SHOT_EXAMPLES):
        # Lift the input's raw_quote into the per-signal raw_quote so
        # the example output models how the field flows.
        out_with_quote = dict(out)
        if out.get("effect") not in (None, "none"):
            out_with_quote["raw_quote"] = inp.get("raw_quote") or ""
        multi_out = _legacy_to_multi(out_with_quote)
        inp_block = json.dumps(inp, indent=2, ensure_ascii=False, default=str)
        out_block = json.dumps(multi_out, indent=2, ensure_ascii=False, default=str)
        legacy_examples_rendered.append(
            f"### Example {i + 1}\n"
            f"**Input event:**\n```json\n{inp_block}\n```\n"
            f"**Expected output:**\n```json\n{out_block}\n```"
        )

    # ---- Two-signal worked examples (these are the load-bearing
    # additions; the legacy examples cover the 0/1 cases).
    multi_examples: list[tuple[dict[str, Any], dict[str, Any]]] = [
        (
            {
                "source_type": "openclaw-chat",
                "frontmatter": {
                    "session_id": "synthetic-two-signal-chat",
                },
                "body": (
                    "Alfred — the Acme Cloud billing dispute is resolved, "
                    "they credited the account, close that task. Also "
                    "the Berlin trip planning conversations should be "
                    "their own matter, not buried under household-life. "
                    "Spin one up."
                ),
                "raw_quote": (
                    "Acme Cloud billing dispute is resolved... close that "
                    "task ... Berlin trip planning should be its own "
                    "matter ... Spin one up"
                ),
            },
            {
                "signals": [
                    {
                        "raw_quote": (
                            "the Acme Cloud billing dispute is resolved, "
                            "they credited the account, close that task"
                        ),
                        "classification": "task_resolution",
                        "effect": "mutation",
                        "target_kind": "task",
                        "target_hint": "Acme Cloud billing dispute",
                        "mutation_proposal": {
                            "decision": "likely_done",
                            "details": (
                                "Sir says the Acme Cloud billing dispute "
                                "is resolved and explicitly asks to "
                                "close the task."
                            ),
                        },
                        "action_proposal": None,
                        "target_confidence": 0.85,
                        "effect_confidence": 0.95,
                        "reasoning": (
                            "Direct chat command — task_resolution on "
                            "the Acme Cloud billing task."
                        ),
                        "display_headline": (
                            "Acme Cloud credited the account — closing "
                            "the dispute."
                        ),
                        "display_body": (
                            "You confirmed they refunded. I'll mark "
                            "the billing task done."
                        ),
                    },
                    {
                        "raw_quote": (
                            "Berlin trip planning conversations should "
                            "be their own matter, not buried under "
                            "household-life. Spin one up"
                        ),
                        "classification": "matter_creation",
                        "effect": "mutation",
                        "target_kind": "matter",
                        "target_hint": "Berlin trip planning",
                        "mutation_proposal": {
                            "decision": (
                                "create_matter:matter/berlin-trip-planning"
                            ),
                            "details": (
                                "Sir asked to split Berlin trip "
                                "planning out of household-life into "
                                "its own matter."
                            ),
                        },
                        "action_proposal": None,
                        "target_confidence": 0.9,
                        "effect_confidence": 0.95,
                        "reasoning": (
                            "Same chat turn but a second, independent "
                            "mutation — matter_creation."
                        ),
                        "display_headline": (
                            "Berlin trip deserves its own matter."
                        ),
                        "display_body": (
                            "You asked to split it out of household-"
                            "life. I'll spin up matter/berlin-trip-"
                            "planning and move the thread there."
                        ),
                    },
                ]
            },
        ),
        (
            {
                "source_type": "gcal",
                "frontmatter": {
                    "name": (
                        "Two-event day — Strategy review + Dentist "
                        "appointment"
                    ),
                },
                "body": (
                    "1) Event: Strategy review w/ Alex Kim. Mon May 12, "
                    "2026 4:00pm-5:00pm CEST. Status: not yet "
                    "responded.\n"
                    "2) Event: Dentist — Dr. Nagy. Tue May 13, 2026 "
                    "9:00am-9:30am CEST. Status: not yet responded."
                ),
                "raw_quote": (
                    "Strategy review Mon May 12 — not yet responded; "
                    "Dentist Tue May 13 — not yet responded"
                ),
            },
            {
                "signals": [
                    {
                        "raw_quote": (
                            "Strategy review w/ Alex Kim. Mon May 12, "
                            "2026 4:00pm-5:00pm CEST. Status: not yet "
                            "responded"
                        ),
                        "classification": None,
                        "effect": "action",
                        "target_kind": None,
                        "target_hint": (
                            "RSVP to strategy review with Alex Kim May 12"
                        ),
                        "mutation_proposal": None,
                        "action_proposal": {
                            "what": (
                                "RSVP to the May 12 strategy review "
                                "with Alex Kim."
                            ),
                            "suggested_actor": "human",
                            "due_at": None,
                        },
                        "target_confidence": 0.3,
                        "effect_confidence": 0.85,
                        "reasoning": (
                            "Unresponded invite where Sir is an "
                            "attendee — needs RSVP."
                        ),
                        "display_headline": (
                            "Alex Kim wants an RSVP for Monday's review."
                        ),
                        "display_body": (
                            "Mon 4-5pm CEST. I'd accept unless you "
                            "want to push it; nothing else is on the "
                            "calendar."
                        ),
                    },
                    {
                        "raw_quote": (
                            "Dentist — Dr. Nagy. Tue May 13, 2026 "
                            "9:00am-9:30am CEST. Status: not yet "
                            "responded"
                        ),
                        "classification": None,
                        "effect": "action",
                        "target_kind": None,
                        "target_hint": (
                            "RSVP to dentist appointment May 13"
                        ),
                        "mutation_proposal": None,
                        "action_proposal": {
                            "what": (
                                "Confirm the May 13 dentist "
                                "appointment with Dr. Nagy."
                            ),
                            "suggested_actor": "human",
                            "due_at": None,
                        },
                        "target_confidence": 0.4,
                        "effect_confidence": 0.85,
                        "reasoning": (
                            "Separate invite, separate target — "
                            "second action signal."
                        ),
                        "display_headline": (
                            "Dr. Nagy is holding a 9am slot Tuesday."
                        ),
                        "display_body": (
                            "Half-hour dental check. I'd confirm "
                            "now if you're keeping it; otherwise tell "
                            "me to push it."
                        ),
                    },
                ]
            },
        ),
    ]

    # Phase 3 — append the canonical Sir-as-sender example.
    # This is the load-bearing example for the new actor +
    # decision_required schema. Without it the model has no
    # calibration anchor for "outbound from Sir → bookkeeping, no
    # card". The Acme EIN scenario is taken from the real
    # signal that triggered this whole refactor.
    multi_examples.append(
        (
            {
                "source_type": "gmail",
                "frontmatter": {
                    "from": "Admin Szabo-Stuban <admin@example.com>",
                    "to": "tax@example.com",
                    "subject": "EIN question for the tax filing",
                },
                "body": (
                    "Hi — we have a question about the tax filing. "
                    "I wanted to start the form but hit a wall on "
                    "the EIN field — wasn't sure of the address on "
                    "file. Could you confirm? Thanks, Sir."
                ),
                "raw_quote": (
                    "Sir → Acme: EIN question, address-on-file "
                    "confirmation requested before continuing the "
                    "tax filing form"
                ),
            },
            {
                "signals": [
                    {
                        "raw_quote": (
                            "Hi — we have a question about the tax "
                            "filing. I wanted to start the form but "
                            "hit a wall on the EIN field"
                        ),
                        "classification": None,
                        "effect": "action",
                        "actor": "principal",
                        "decision_required": False,
                        "target_kind": "matter",
                        "target_hint": (
                            "Example Kft. tax filing"
                        ),
                        "mutation_proposal": None,
                        "action_proposal": {
                            "what": (
                                "Wait for Acme to confirm the "
                                "EIN address on file; resume the "
                                "tax form once they reply."
                            ),
                            "suggested_actor": "agent",
                            "due_at": None,
                        },
                        "target_confidence": 0.7,
                        "effect_confidence": 0.85,
                        "reasoning": (
                            "Outbound email from Sir (sender is a "
                            "Sir-owned address) asking Acme a "
                            "question. Sir has already acted by "
                            "sending. Bookkeeping for the tax "
                            "matter timeline; no /desk card because "
                            "the next move is on Acme, not Sir."
                        ),
                        "display_headline": (
                            "Asked Acme about the EIN."
                        ),
                        "display_body": (
                            "I'll watch for their reply and surface "
                            "it when it lands."
                        ),
                    }
                ]
            },
        ),
    )

    # Phase 3 — inject actor + decision_required defaults into any
    # legacy multi_examples entry that predates the new schema, so
    # all rendered examples teach the same shape. The first two
    # multi-signal examples (Acme Cloud+Berlin, Strategy+Dentist) were
    # written before Phase 3 and don't carry the new fields.
    def _ensure_actor_fields(example_out: dict[str, Any]) -> dict[str, Any]:
        signals = example_out.get("signals")
        if not isinstance(signals, list):
            return example_out
        patched_signals: list[dict[str, Any]] = []
        for s in signals:
            if not isinstance(s, dict):
                patched_signals.append(s)
                continue
            s_out = dict(s)
            if "actor" not in s_out:
                # Heuristic for legacy examples: openclaw-chat
                # entries where the example body is Sir's direct
                # imperatives are `principal` with
                # decision_required=False (they drive a mutation;
                # they're not asking Sir to decide what he just
                # told Alfred). Everything else defaults to
                # counterparty/system + decision_required=True.
                # Note: this is a render-time default for examples;
                # the LIVE classifier still uses Section 3.5.
                if s.get("classification") in (
                    "task_resolution",
                    "task_dismissal",
                    "matter_creation",
                    "matter_state_change",
                ):
                    s_out.setdefault("actor", "principal")
                    s_out.setdefault("decision_required", False)
                else:
                    s_out.setdefault("actor", "counterparty")
                    s_out.setdefault("decision_required", True)
            patched_signals.append(s_out)
        return {**example_out, "signals": patched_signals}

    multi_examples_rendered: list[str] = []
    base_idx = len(legacy_examples_rendered)
    for i, (inp, out) in enumerate(multi_examples):
        out_patched = _ensure_actor_fields(out)
        inp_block = json.dumps(inp, indent=2, ensure_ascii=False, default=str)
        out_block = json.dumps(out_patched, indent=2, ensure_ascii=False, default=str)
        multi_examples_rendered.append(
            f"### Example {base_idx + i + 1} (multi-signal)\n"
            f"**Input event:**\n```json\n{inp_block}\n```\n"
            f"**Expected output:**\n```json\n{out_block}\n```"
        )

    few_shot_block = "\n\n".join(
        legacy_examples_rendered + multi_examples_rendered
    )

    fm_excerpt = _frontmatter_excerpt(event_frontmatter or {})
    body_excerpt = _truncate_body(event_body or "")
    raw_quote_clean = (raw_quote or "").strip()

    event_block = (
        f"source_type: `{source_type or 'unknown'}`\n\n"
        f"frontmatter (excerpt):\n```json\n{fm_excerpt}\n```\n\n"
        f"body:\n```\n{body_excerpt}\n```\n\n"
        f"event-level raw_quote (≤200 chars; survives stream-event "
        f"purge — use this as a fallback if you can't isolate a "
        f"per-signal quote):\n```\n{raw_quote_clean}\n```"
    )

    return f"""You are Alfred's signal extractor. Your job: read ONE stream event and decide which `signal` records it should produce — ZERO, ONE, or MANY — and emit them as a JSON list. Each signal will downstream become its own decision card, its own task (creating one if no match), and its own audit trail entry.

You produce STRICT JSON output that another Python module parses. Malformed JSON, missing fields, values outside the declared enums, or a missing top-level `signals` key all break the downstream pipeline silently and lose Sir's signal. Be precise.

{multi_signal_rules}

## 1. Source-type frame

{frame}

## 2. The 8 mutation classes (RFC #842 §6)

Pick exactly one per entry when `effect` is `mutation`:

{mutation_defs}

## 3. The effect taxonomy

{effect_defs}

{actor_decision_block}

## 4. The output JSON envelope

You MUST emit exactly this top-level shape:

```json
{schema_block}
```

{schema_rules}

{voice_block}

## 5. Assertion-vs-question filter (the critical gate)

{assertion_filter}

## 6. Few-shot examples (real events from Sir's vault unless flagged synthetic)

{few_shot_block}

## 7. The event you must classify now

{event_block}

## 8. Output

Output ONLY the JSON object, no other text. No markdown code fences. No commentary before or after. The first character of your response must be `{{` and the last must be `}}`.
"""
