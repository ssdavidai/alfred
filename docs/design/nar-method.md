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

**Human sources only.** `role='user'` does **not** mean a human typed it — on
one observed month 66% of user-role messages were machine-authored (cron,
subagent, api_server). Filter by an **allowlist** of human session sources,
never a denylist: a new machine source added upstream must not silently start
counting as human attention. `cli` is suspect and should be reviewed before
being trusted as human.

---

## 3. Interruption

Unsolicited outbound only, times a published rate.

`alfred_journal.solicited` records this at write time: `1` solicited, `0`
unsolicited, `NULL` unknown. **`NULL` is never treated as `0`** — an unknown
that silently becomes unsolicited inflates a subtraction term.

Solicited replies outnumber unsolicited deliveries by roughly 100:1. Counting
them together swamps the term and flatters the number.

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

| day | engaged | displaced | NAR |
|---|---|---|---|
| A (light) | 2.03 h | 1.85 h | −0.18 h |
| B (heavy) | 4.19 h | 12.03 h | +7.51 h |

Day B includes the autonomous contribution; both were computed by hand before
any automation existed. An implementation that cannot land near these is
wrong, however plausible its output looks.
