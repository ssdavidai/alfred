# The NAR method — how Net Attention Returned is computed

Canonical. Every implementation (recap workflow, statement endpoint, MCP tool,
dashboard) computes NAR this way and no other way. Derived from two manual
recap passes over live tenant days, 2026-08-13/14. Changes to this document
are changes to the product's central claim — treat accordingly.

Epic: #563. Storage: `nar_entry` (migration 0020). Engaged-time primitive:
`packages/ctrl/src/db/engagedTime.ts`. Suppression rate: `#582`.

---

## The formula

```
NAR = displaced − engaged − interruption
```

Repair is **not** a term. There is no signal for it, a proxy would be noise,
and it does not appear on the statement in any form — not even as "not
measured". Hard failures are counted separately as a quality line, not as a
stand-in for repair.

Correction is **not** a separate term. It is already inside `engaged`.
Prompting, review and correction are one physical event — the principal at a
keyboard dealing with Alfred — and splitting them invents precision the
evidence does not support. The correction *curve* can be derived later by
labelling which bursts were corrective; it needs no new instrumentation.

---

## 1. Displaced

Three sources, never blended in the headline.

### 1a. Explicit — rate card

Countable, recurring, uniform actions with a published fixed rate.
Suppression is 0.5 min/item. An action class with no agreed rate contributes
**nothing** and is reported as "not established" — no baseline, no claim.

### 1b. Inferred — size buckets from session content

For work done in conversation. The model does **not** produce a number. It
picks a bucket:

| bucket | minutes |
|---|---|
| S | 5 |
| M | 20 |
| L | 60 |
| XL | 120 |
| — | 0 (no displacement) |

People estimate size better than minutes, and a bucket cannot drift to an
arbitrary figure — the worst case is capped by the largest bucket.

Inferred work is reported on its **own labelled line**, never folded into the
headline, until it has been calibrated against reality.

### 1c. Autonomous — by artifact, never by activity

Work Alfred did unattended. `engaged` for these is **zero** by definition.

Count what was **produced**, not what was done:

- a chore that composed a briefing → the bucket for composing that briefing
- a chore that ran, checked and found nothing → suppression rate (vigilance)
- tool calls, workflow runs, pipeline rows → **nothing at all**

On one observed day the autonomous layer made ~7,000 tool calls and produced
two artifacts. Crediting activity rather than artifacts would have inflated
the day by an order of magnitude.

**Double-counting trap.** The signal pipeline's output *is* the desk cards the
principal then decides on. Those decisions are already counted under 1a.
Crediting the pipeline as well banks the same work twice.

---

## 2. Engaged

Burst-clustered timestamps of principal-originated events: human conversation
turns plus desk decisions, merged and sorted, via `clusterBursts`.

| parameter | value |
|---|---|
| gap threshold | **10 minutes** |
| per-burst floor | **2 minutes** |

The gap is the sensitive parameter, not the floor. On one observed day 5/10/15
minutes produced 2.91/4.19/5.47 h. Ten is chosen because tool-heavy work
legitimately leaves >5 minute gaps while Alfred works, and a tighter gap
fragments one work session into many, undercounting attention.

**Human sources only, and a human source is not enough.** Two independent
filters are required, and both were learned the hard way.

1. `role='user'` does **not** mean a human typed it — on one observed month
   66% of user-role messages were machine-authored (cron, subagent,
   api_server). Filter by an **allowlist** of human session sources, never a
   denylist: a new machine source added upstream must not silently start
   counting as human attention. `cli` is suspect and should be reviewed before
   being trusted as human.

2. **`source='slack'` does not mean the principal started it.** An agent that
   spawns a task delivering into Slack produces a session carrying a human
   source. Require **`parent_session_id IS NULL`** as well: a session the
   principal opens has no parent, one an agent spawns does.

   On one observed day, 71 of 87 Slack sessions were agent-spawned — titled
   `… Transcription #27, #28 … #36`. Counting them as conversational work
   reported 38.2 h displaced against 3.0 h engaged, roughly **9x** the
   hand-computed value. Spawned sessions are **autonomous** work and belong in
   that bucket, counted by artifact.

The pattern behind both: a field named after a human describes a shape, not an
author. Check what wrote the row, not what the column is called.

---

## 3. Interruption

Unsolicited outbound only, times a published rate.

`alfred_journal.solicited` records this at write time: `1` solicited, `0`
unsolicited, `NULL` unknown. **`NULL` is never treated as `0`** — an unknown
that silently becomes unsolicited inflates a subtraction term.

Solicited replies outnumber unsolicited deliveries by roughly 100:1. Counting
them together swamps the term and flatters the number.

---

## 4. Attribution — per-session engaged, and allocation

The three terms above give a day's figure. Two further quantities exist only
to break that day down. **Neither may alter the day's NAR**; a breakdown that
changes the total it breaks down is not a breakdown.

### 4a. Per-session engaged

Each conversational entry carries `notes.engaged_minutes`: that session's own
principal turns, burst-clustered with the same gap and floor as §2.

**Only conversational entries.** Chore runs and desk decisions carry `null`,
deliberately:

- a chore consumed no principal attention at all;
- a desk decision's attention is *already* inside the day-level clustering,
  which includes decision timestamps — attributing it to the individual
  decision as well would bank it twice.

`null` means *not measured*, and must never be rendered or summed as zero. A
group whose rows are all `null` subtotals to `null`, not `0.0`. Zero is a
claim that a thing was free; the ledger may not make that claim by accident.

Per-entry NAR is `displaced − engaged`, derived at read time, `null` whenever
engaged is `null`. On a failed session — zero displaced, real engaged time —
this is correctly **negative**. That is §Judgement-rule 3 showing up as
arithmetic instead of prose.

### 4b. The sums do not reconcile, and must not be made to

Per-session engaged summed across a day **will not equal** the day's
`engaged`. Two reasons, both structural:

- day-level clustering merges bursts that span sessions; per-session
  clustering cannot;
- the 2-minute floor applies once per session rather than once per burst, so
  many short sessions inflate the attributed figure.

The difference runs in either direction. On the first live day the attributed
total *exceeded* the day total (4.75 h vs 4.19 h) — thirteen sessions each
taking a floor.

Both numbers are correct measures of different scopes. The statement prints
the difference explicitly (`allocation_reconciliation`) rather than scaling
either one to agree. **Forcing them to match would silently shrink the
per-session figures to fit a total they were never meant to sum to** — the
page would look consistent and be wrong.

The same rule governs the ledger's totals. `ENGAGED` and `NAR` cover only
measured rows, while `DISPLACED` covers all of them, so a single TOTAL row
invites a subtraction that does not come out. The statement shows a `MEASURED`
row where the arithmetic holds and a `TOTAL` row that declares how much
displacement carries no measurement.

### 4c. Allocation — work / life / unallocated

The clerk that picks a session's bucket also returns an allocation. Client and
business work is `work`; household, family, health and errands are `life`.

`unallocated` is a **first-class answer**, not a failure. Anything the clerk
cannot place stays there, and it is never defaulted to `work`. Desk decisions
and vigilance sweeps are always `unallocated` — there is nothing in them to
classify.

Interruption carries no allocation, because it is counted from
`alfred_journal` rows that have none. All of it lands in `unallocated`; `work`
and `life` show zero interruption **by construction**, not by measurement.
Splitting it would mean inventing an attribution.

---

## Judgement rules

Learned from the manual passes. Each one prevented a specific error.

1. **A quantity named in an artifact is not displacement.** A proposal
   approving N hours of billable client time displaced only the work of
   producing the proposal. Crediting the figure inside the artifact
   overstated one session by ~40×.

2. **Discussion with no artifact displaces nothing.** Thinking out loud with
   Alfred costs engaged time and produces no displacement. Without an explicit
   zero bucket a model reaches for Medium and inflates.

3. **A failed or blocked session costs full price.** Zero displacement, full
   engaged time. This asymmetry is the point.

4. **Displaced ≠ induced.** Some work only happened because Alfred made it
   cheap. That is valuable, but it is not time saved. Where the distinction is
   visible, report it; where it is not, prefer the conservative reading.

5. **Self-correction is detectable.** An assistant turn conceding an error
   correlates with heavy iteration and marks a corrective burst. Available
   today in the final assistant message; needs no new instrumentation.

---

## Integrity rules

- **A defensible small number beats an impressive one.** This is shown to
  someone deciding whether to keep paying.
- **Rates are fixed before the counting**, published wherever used, and every
  change writes an audit row. Tuning a rate after seeing a total destroys the
  entire claim.
- **Every line traceable to its evidence** — which session, which decision,
  which chore run. A number that cannot be drilled into is marketing.
- **Estimated and inferred lines are labelled as such, always.**
- **No baseline, no claim.** An unrated action class contributes nothing and
  says so.

---

## Validation

Any implementation must reproduce two manually computed reference days on the
development tenant within a stated tolerance:

| day | engaged | displaced | NAR | character |
|---|---|---|---|---|
| A (light) | 2.03 h | 2.93 h | +0.90 h | quiet, no spawned sessions |
| B (heavy) | 4.19 h | 12.03 h | +7.51 h | busy, no spawned sessions |
| C (anomalous) | 1.04 h | 4.30 h | +3.26 h | 71 of 87 Slack sessions agent-spawned |

**Day C exists because A and B were both normal days.** A method validated
only on ordinary traffic is not validated — the spawned-session defect passed
both reference days cleanly and was only caught by eye on a backfilled day
that looked absurd. Any future reference set must include a day where
something went wrong.

Both were computed by hand before any automation existed. An implementation
that cannot land near these is wrong, however plausible its output looks.

**Day A was corrected on first validation, and the correction is instructive.**
It was originally recorded as 1.85 h displaced / −0.18 h NAR. That figure was
computed with a draft bucket table (M=15, L=45) before the canonical sizes
above were settled, and it omitted the autonomous contribution entirely —
autonomous work was only added to the method while analysing day B. The first
implementation reproduced 2.933 h, which is what a corrected manual pass
gives:

```
sessions  10 + 20 + 60 + 20 + 5  = 115 min
noise     42 x 0.5               =  21 min
chores    morning M + evening M  =  40 min
                                   176 min = 2.93 h
```

The lesson worth keeping: a reference figure computed before the method was
settled is not a reference. When an implementation disagrees with a target,
re-derive the target before touching the code.

### How much the figure moves between runs

**Displaced is not reproducible to the decimal, and a validation tolerance has
to allow for that.** Re-running the recap over day B with unchanged code
produced **10.95 h** displaced against the 12.03 h recorded above — about 9%
lower.

Nothing was wrong with either run. Bucket assignment is a judgement the clerk
makes from session content, and it is not deterministic: a session read as L
one day can read as M the next. Engaged time, by contrast, is measured from
timestamps and does reproduce.

So the two halves of the formula have different characters, and the statement
should be read accordingly:

| term | character | reproducible |
|---|---|---|
| engaged | measured from timestamps | yes |
| interruption | counted rows × published rate | yes |
| displaced | estimated from judgement | **no — expect single-digit % drift** |

A re-run landing within ~10% on displaced is agreement. Chasing exact equality
would mean pinning the clerk's output, which would replace an honest estimate
with a frozen one.

This is also why §Integrity's "a defensible small number beats an impressive
one" is load-bearing rather than decorative: the largest term in the formula
is the one that cannot be checked against a clock.
