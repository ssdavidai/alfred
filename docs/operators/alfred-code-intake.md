# Alfred Code intake

How a GitHub issue becomes controller-managed work, and where a human sits
in the loop.

## Intake

In label-gated mode, an issue enters the controller when it is labeled
`alfred-code`. When automatic intake is enabled, every open issue enters
without requiring that label. Label removal is not a cancellation mechanism
after a plan or job exists; reject the current plan in GitHub or use the
documented incident procedure instead.

## Planning before building

Planning discovers lanes and contracts before any build begins. On intake
the controller reads the live lane policy (`scripts/hooks/lanes.json`),
maps every path the change touches to its owning lane, and lists the
contracts each lane job must read (and any a phase0 job would change).
The result is an execution plan published as an issue comment: pinned base
SHA, ordered lane jobs with paths and per-job verification commands, and
the contract set. No branch is cut and no implementation job starts during
planning.

## Approval: the exact full plan hash

The controller halts after publishing the plan and waits for a human.
Approval must use the exact full plan hash displayed by the controller —
the complete hex string, copied verbatim:

```
/approve-plan <full-plan-hash>
```

To reject the plan without starting a build, use the corresponding exact
full-hash command shown by the controller. Any other operator comment made
while the plan awaits approval is specification feedback and produces a new
plan with a new hash.

Truncated, paraphrased, or retyped-from-memory hashes are not accepted.
The hash binds the approval to the full plan content and the pinned base
SHA; if the plan is regenerated for any reason, it gets a new hash and any
approval of the old hash is invalid. No approval is recorded and no
build/implementation job starts until a human supplies the exact full
hash.

## Where to look: Projects vs Superset

GitHub Projects is the control center and Superset is the execution
viewer.

- **GitHub Projects** is where operators act: issue status, published
  plans, approval comments, and PR linkage all live on the board and the
  issues themselves. Decisions happen here.
- **Superset** is where operators watch: it renders the running lane
  agents, their worktrees, and live job output. It is read-only from a
  control standpoint — nothing you do in Superset approves, dispatches,
  or halts work.

If a run looks wrong in Superset, act on it from GitHub (comment on the
issue or PR); the controller only responds to signals in the control
center.
