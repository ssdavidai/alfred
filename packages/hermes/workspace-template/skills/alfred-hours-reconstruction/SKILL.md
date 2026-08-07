---
name: alfred-hours-reconstruction
description: Reconstruct Sir's work on a matter from bounded cross-source evidence — calendar, messages, mail, commits, transcripts, sessions, artifacts — and produce an auditable per-period proposal for his approval. Never accepts hours automatically. Use when a tracked period closes, when Sir asks "how much did I work on X?", or for a one-off retrospective backfill. Activates for matters carrying `hours_tracking` in their frontmatter.
version: "1.0"
metadata:
  openclaw:
    emoji: "⏱️"
---

# Alfred — Hours reconstruction

Reconstruct what Sir actually worked on, from evidence, and propose it.

Two rules sit above everything else here:

> **Nothing enters the ledger without Sir's explicit approval.**
> **The accepted ledger is the cursor — not the calendar, not the schedule.**

This is an evidence-based estimate. It is not a timer export, not an invoice,
and not automatically accepted time.

## Switching it on

```yaml
hours_tracking: true
```

Off by default. Everything is derived: the period is weekly, closing at the end
of Sir's Friday in his timezone; the approval request goes wherever Alfred
normally reaches him; the ledger is `note/<matter-slug>-timesheet.md` and the
proposals are `note/<matter-slug>-timesheet-proposal-<period-end>.md`.

Object form only to override:

```yaml
hours_tracking:
  enabled: true
  period: weekly
  approval_channel: <channel>
  rate: 125            # optional, for later invoicing; not needed to track
```

Same boolean-or-object shape as `commitment_register`. **A capability is a
shipped skill, switched on by a boolean on the matter, with an object form as
the escape hatch.**

## The window comes from the ledger

The window runs from the **last date covered by the accepted ledger**
(exclusive) to this period's cutoff (inclusive).

Not from the calendar, and not from the last time the schedule fired. That
distinction is the whole point: if a run is missed, the next window widens to
cover the gap. Keyed to the schedule instead, a missed Friday silently loses a
week of Sir's work, and nothing ever reports it.

Before reconstructing anything, read the existing ledger and record its latest
covered date, closing balance, credits and rate. Reconstruct **only the
uncovered period** — never lay a partial reconstruction over a period a fuller
ledger already represents.

Weekend work therefore carries into the following period rather than vanishing.

## Gather bounded evidence

Read only the window. Keep a source handle for everything.

1. **Calendar** — every owned calendar, not just the primary. Count meetings at
   actual start/end. Corroborate with transcripts or meeting notes where
   available.
2. **Messages** — Sir-authored messages, threads, attachments and file
   deliveries in matter-related channels and DMs. Include replies whose own
   timestamps are in-window even when the thread parent is older.
3. **Mail** — sent and received threads in the window. Metadata first, then
   fetch only relevant threads. Reading an email is not automatically work.
4. **Transcripts and meeting notes** — to classify discussion, preparation,
   follow-up and deliverables. Transcript length is not duration.
5. **Repositories** — commits, PRs, reviews, issues, releases attributable to
   the matter. Commits prove activity and output, not duration.
6. **Sessions** — Sir's own conversations with Alfred about this work.
   Exclude register refreshes, cron maintenance and repeated summaries unless
   he was actively directing substantive work.
7. **Vault and artifacts** — record transitions, generated files, delivery
   evidence. Timestamps anchor work; they do not determine hours.

If a configured source is unavailable, **say so and lower confidence.** Never
compensate by inventing time.

Then convert evidence to hours by the method in
`references/evidence-to-hours.md`. The union-of-intervals rule is not optional:
the same hour seen in four sources is one hour.

## Write the proposal — never the ledger

Search first, so one period has exactly one proposal. Write
`note/<matter-slug>-timesheet-proposal-<period-end>.md` with:

```yaml
status: proposed
accepted: false
period_start: <date>
period_end: <date>
generated_at: <ISO timestamp>
total_hours: <number>
scope: <matter-slug>
source_coverage: <which sources were read, which were unavailable>
confidence: <overall>
```

Body:

1. **Daily table** — date, proposed hours, short work summary, linked
   commitment IDs where a register exists, per-day confidence.
2. **Evidence table** — time, source, exact handle, activity, interval used.
3. **Exclusions and uncertainties.**
4. **Total and its effect on capacity, clearly labelled provisional.** Never
   present unapproved excess as billable — see
   `../alfred-commitment-register/references/contract-authority.md`.

Read the note back before delivering anything.

**The ledger is not touched.** Not on generation, not on a test run, not
because the reconstruction was thorough.

## Ask for approval — on the Desk

A proposal delivered only as a message is a message: easy to miss, easy to
defer, invisible once scrolled past. Write a Desk card, so the decision sits
where Sir's other decisions sit.

Create a `needs_attention` record carrying:

```yaml
approval_kind: hours_proposal
proposal_ref: note/<matter-slug>-timesheet-proposal-<period-end>.md
ledger_ref:   note/<matter-slug>-timesheet.md
action_what:  "Approve <n.nn> h for <matter name> — <period-start> to <period-end>"
suggested_actor: human
```

Those three fields are a contract, not decoration. `route_decision` reads
`approval_kind` to recognise the card, and `proposal_ref` / `ledger_ref` to
know what to book. **A card missing any of them books nothing** — the click
will close the card and silently do nothing else.

Then deliver the itemised request as well: the period and total; one line per
non-zero day; the confidence and coverage caveat; the proposal note's path; and
an explicit prompt to approve or supply a corrected figure.

Tell Sir he can correct the number **in the note when approving** — typing
`6`, or `6.5 — Tuesday ran short`, books that figure instead of the estimate.
A note that is only prose (`looks fine`) approves the estimate unchanged; the
number is never guessed from wording.

Only Sir's explicit approval of the identified period is acceptance. **A
generated proposal is not approval. Silence is not approval. A successful
scheduled run is not approval. A reaction or a "thanks" is not approval.**

## On approval

Approving the Desk card does the booking automatically — `route_decision`
appends the period to the ledger, then marks the proposal accepted, then reads
both back. Do **not** perform these writes yourself when the card path was
used; you would double-append, and the ledger is the cursor for the next
window, so a duplicate corrupts the following period too.

When approval arrives some other way — Sir replies in chat, or no card was
written — do it by hand, in this order:

1. Read the exact proposal note. Confirm its period overlaps no other accepted
   or proposed record.
2. Patch it to `status: accepted`, `accepted: true`, `accepted_at`,
   `accepted_by`. Preserve the original evidence.
3. Append the accepted period to the ledger — which advances the cursor for the
   next window.
4. Read both back and verify the period appears exactly once and the totals
   agree.

## On correction

When Sir supplies different hours instead of approving, **record both his
figure and the original estimate, with the delta.**

That delta is the only feedback signal in this whole feature. Without it the
estimator is permanently as good as it was on day one — and it is the thing
most easily dropped as a nicety, because storing only the correct number
obviously "works".

Then patch the proposal, recompute totals, read it back, and repost the
corrected proposal. Do not silently accept a corrected figure.

## Retrospective backfill

Reconstructing history is a different job from closing a period: a broad sweep
rather than a bounded one, and it should stay manual and on demand. It is not
part of the scheduled run.

When Sir asks for one, establish the contract first — inclusive dates, timezone,
opening balance, credits and their effective dates, whether the estimate should
be conservative, central or generous, and the matter's aliases. Preserve his
exact ordering when he gives a rule such as "start at zero on the 18th, then
add 40 hours on the 19th":

    closing = opening + credits effective that day − estimated work that day

For long ranges, produce a Markdown or CSV artifact with date, estimated hours,
concise work, credit and closing balance, plus a methodology section. Read it
back and verify the totals, end date and final balance.

If Sir first asks for a generous estimate and then a conservative commercial
presentation, **re-estimate the daily rows** — do not scale the headline.
Reduce uncertain prep, editorial and follow-up time before touching exact
meetings or directly evidenced work. A requested ceiling is a scenario
constraint, not permission to fabricate contemporaneous time; if it cannot be
met without contradicting exact evidence, surface the conflict rather than
forcing the ledger.

## Failure behaviour

- One optional source fails → continue, and label source coverage degraded.
- Delivery fails after the proposal is saved → **do not create a duplicate
  note.** Retry delivery only.
- Vault access fails → do not post a proposal as though it were durable.
- Never send client-facing messages, invoices or timesheets from this workflow.

## Pitfalls

- Do not sweep unbounded history when the period is known.
- Do not trust one keyword; a generic product name matches unrelated threads.
- Do not count automated jobs, digests or dashboard refreshes as Sir's labour.
- Do not silently convert an estimate into an authoritative timesheet.
- Do not infer billability or client debt from a negative balance — resolve
  commercial treatment from the executed agreement first.
- Do not hide uncertainty. Label the method and the confidence.
- Do not omit zero days.
- **Do not accept hours at any confidence level, ever.**
