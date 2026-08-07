# Register projection format

Every commitment-register projection follows this hierarchy, whatever the
destination. A vault note and a Slack Canvas render the same document; only the
write path differs.

```markdown
# <Matter name> Commitment Register

<One-sentence statement that this is a projection and the records are canonical.>

## Summary
- <Immediately actionable, principal-owned count>
- <Ready to deliver count>
- <Waiting on client / third party count>
- <Blocked-behind-another-commitment count>
- <Delivered, awaiting acceptance count>
- <Recently fulfilled count>

## Attention required
- <Only genuine decisions, due/overdue actions and material commercial watches>

## Ready to deliver
<Items or `None.`>

## Open commitments
| ID | Commitment | Owner | State | Due | Next action |
|---|---|---|---|---|---|
| ... |

## Waiting on others
- <External prerequisites, each with its commitment ID>

## Dependencies
- <Explicit A → B chain, or an unresolved blocker>

## Delivered, awaiting acceptance
- <Delivered item, evidence date, remaining acceptance boundary>

## Recently fulfilled
- <Rolling 30-day fulfilled items only>

<Optional matter-specific operational sections, such as `## Timesheet`. These
come after the lifecycle sections and before the footer.>

_Updated <local timestamp> · Canonical source: `commitment/` records for
`<matter-slug>` in the vault._
```

## Rendering rules

- Keep exactly one document H1. A destination that injects its own outer
  heading is chrome, not corruption — see `slack-projection.md`.
- Use the section order above. Do **not** add a `Changes since yesterday /
  previous reconciliation` section: the projection shows current state, and
  evidenced changes belong in the reply or scheduled digest.
- Keep Summary terse and count-based. Separate immediately actionable
  principal work from work blocked behind another commitment.
- Use one consolidated `Open commitments` table rather than a table per state.
- Preserve state labels where useful, but write owner and next action in plain
  language.
- Matter-specific sections are allowed only after `Recently fulfilled`, and
  must not disturb the lifecycle hierarchy.
- Timesheets and ledgers must separate accepted periods from proposals. Never
  merge provisional hours into an accepted total.
- The projection is a projection. `commitment/` records remain authoritative.

## Count consistency

Before writing, check every Summary count against the rendered document. Each
count must equal the distinct commitment IDs shown in its section.

`waiting on client / third party` includes commitments awaiting external
review, acknowledgement, acceptance or a prerequisite — **even when the same
commitment also appears under `Open commitments` or `Delivered, awaiting
acceptance`**. Categories may overlap; do not undercount because of the
overlap. Within a single category, count each ID once.

After read-back, verify the count-bearing phrases *and* their corresponding ID
rows together — not merely that the headings and the update marker exist.

## Auditability when the lifecycle window hides a record

If the first or highest canonical commitment ID falls outside both the open and
recently-fulfilled sections — because it was fulfilled more than 30 days ago —
include a compact archival line naming that ID and its terminal date and state.

This preserves first/highest-ID verification without falsely counting old work
as recently fulfilled.
