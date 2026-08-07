# Direct delivery-evidence reconciliation

Use this when Sir asks whether active commitments have been delivered,
acknowledged, accepted, paid, or otherwise completed **in a named source** — a
channel, sent mail, an issue tracker, a Drive folder, a meeting record.

The distinction this whole document protects: *prepared*, *delivered*,
*acknowledged*, *accepted* and *fulfilled* are five different states, and
collapsing them is how a register starts lying.

## Required sequence

1. Read **every active commitment in the scope before searching the source.**
   Build a checklist: ID, obligation, expected artifact or action, current
   state, delivery evidence, acceptance criteria, known aliases and filenames.
2. Fetch the named source directly. Resolve the exact container, retrieve
   paginated raw history, include thread replies. Do not substitute session
   summaries, projection prose, a prior no-signal check, or the register
   itself.
3. Compare the complete checklist against the source. Search message text
   **and** attachment filenames, using aliases and local-language terms. Read
   surrounding messages, not isolated keyword hits.
4. Classify precisely:
   - **prepared** — the artifact exists privately;
   - **sent/delivered** — the source contains the outbound message,
     attachment, permalink or equivalent transaction;
   - **receipt acknowledged** — the recipient confirms receipt or gives
     substantive feedback;
   - **accepted** — the recipient explicitly approves the final deliverable,
     or the defined acceptance criteria are met;
   - **fulfilled** — delivery plus acceptance/outcome evidence, or an explicit
     release under policy.
5. Treat revision feedback as proof of receipt, not final acceptance. A draft
   followed by comments and a revised final file is
   `delivered_awaiting_acceptance` until the revision is accepted.
6. Capture evidence with source identity, exact timestamp, sender/recipient,
   artifact filename or action, and the acknowledgement wording. Avoid vague
   evidence such as "sent in Slack".
7. Update records immediately — frontmatter state, delivery evidence,
   acknowledgement, next action, `last_verified_at` — **and** any body text
   still saying "unsent" or "not delivered".
8. Read every changed record back. Verify frontmatter and body agree.
9. Regenerate the projection from records, read it back, and verify changed
   IDs, counts, states, timestamp and destination identity.
10. Report three groups: newly evidenced deliveries, previously known
    delivered-but-open items, and active commitments with no delivery
    evidence. State explicitly whether anything is actually fulfilled.

## Evidence cautions

- "Here is the latest version" plus an attachment proves delivery of that
  version, not acceptance.
- "Looks good" followed by requested changes proves receipt and review, not
  approval of the revised artifact.
- An invoice attachment proves sending — not acknowledgement, and not payment.
- Mentioning that a document exists somewhere else is not the same as
  attaching it.
- A client-owned prerequisite stays `waiting_on_client` unless the source
  proves it happened.
- Do not close a commitment merely because its original handoff happened, when
  revisions or acceptance remain open.

## Worked example

Records say an invoice is `ready_to_deliver` and a proposal package is
`ready_to_deliver`. Raw channel history shows the invoice PDF attached
yesterday with no reply; two proposal drafts sent Friday, recipient feedback
Saturday, a revised final offer sent Monday with no later response.

Move both to `delivered_awaiting_acceptance`. Record exact timestamps and
filenames. Preserve the proposal feedback as `client_acknowledgement` of
receipt and review — but do not mark the revised offer accepted. Replace the
stale body prose saying the invoice is unsent.

Report: two deliveries found, **zero commitments fulfilled.**
