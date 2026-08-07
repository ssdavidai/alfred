# Converting evidence into hours

The method. Get this wrong and the estimate is either fiction or unusable.

## Build one timeline, then estimate from the union of intervals

The same hour of work appears in Slack, in email, in a commit, and in an Alfred
session. Four sources, one hour.

Build a single chronological activity ledger across every source, then estimate
from the **union of time intervals**. Never sum per-source estimates — that is
the single largest error available, and it inflates silently because each
source looks individually reasonable.

## Rules

1. **A verified meeting counts at its actual duration.** Add preparation or
   follow-up only when separately evidenced — normally 0.25–0.5 h. Never as an
   automatic multiplier.
2. **Cluster non-meeting events into work episodes** when the gap between
   timestamped events is at most 30 minutes. Estimate the episode from first to
   last activity, plus at most 10 minutes for setup and close-down.
3. **An isolated event is 0.25 h**, unless a linked artifact or session gives
   stronger evidence.
4. **A long artifact does not equal its apparent authoring time.** Neither does
   a commit burst, nor a transcript's length. Use surrounding activity, session
   logs and delivery timestamps.
5. **Merge overlapping intervals** across meetings, messages, commits and
   sessions before totalling.
6. **Include invisible planning or review only when evidenced** by a resulting
   artifact, an explicit session statement, or a preparation trail. Mark it
   medium or low confidence.
7. **Round each day to 0.25 h after deduplication.** Never round each event up
   — that is how twelve five-minute exchanges become three hours.
8. **Sanity-check against the day's elapsed span.** A daily estimate cannot
   exceed the evidenced work window without an explicit explanation.

## Always exclude

- Automation, notifications, inbox noise.
- Passive calendar blocks, and blocks later cancelled or contradicted.
- Waiting time and client-owned delay.
- Duplicated transcript processing.
- **The register's and this skill's own maintenance runs.** A reconciliation
  that refreshes a dashboard is not billable work, and it is the exclusion most
  easily forgotten because it looks exactly like activity.
- Agent or background execution, unless the accounting basis explicitly
  includes it or Sir actively directed and reviewed the work.

## Confidence, per day

- **High** — exact meeting or call duration, or a continuous timestamped work
  session.
- **Medium** — several corroborating events defining a bounded episode.
- **Low** — an isolated artifact or message of uncertain duration. Stay
  conservative and surface it for correction.

**A missing source lowers confidence. It is never silently compensated for.**
If a configured source is unavailable, say so and drop the affected days'
confidence; do not fill the gap with an estimate that looks like evidence.

Per-day confidence is what makes a proposal reviewable rather than a number to
rubber-stamp. Without it, Sir cannot tell which rows to check.

## False positives

Require corroboration before attributing activity to a matter. A generic
product or project name will match unrelated newsletters, vendors and threads.
A keyword alone is not attribution — require the participant, domain, or
surrounding context to agree.

## Arithmetic

Use a deterministic calculation, never mental arithmetic over a long ledger.
For each date: apply that day's credit, subtract that day's estimated work,
record the closing balance.

Then verify:

- every date in the period appears exactly once, including zero-work days;
- daily hours sum to the reported total;
- credits sum to the reported purchased amount;
- the final balance equals opening + credits − work.

**Keep zero days.** The uninterrupted daily ledger is what makes the running
balance auditable; a table with gaps cannot be checked.
