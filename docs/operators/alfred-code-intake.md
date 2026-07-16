# Alfred Code intake

How a GitHub issue becomes controller-managed work, and where a human sits
in the loop.

## Intake

In label-gated mode, an issue enters the controller when it is labeled
`alfred-code`. When automatic intake is enabled, every open issue enters
without requiring that label. Label removal is not a cancellation mechanism
after a plan or job exists. Before approval, reject the exact current plan in
GitHub. Once a job has launched, the current controller has no cancellation
command; do not treat label removal or a late plan rejection as a stop signal.

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
full-hash command shown by the controller. Any other non-command operator
comment made while the plan awaits approval is specification feedback and
produces a new plan with a new hash. Malformed approval or rejection commands
are ignored rather than interpreted as feedback.

Truncated, paraphrased, or retyped-from-memory hashes are not accepted.
The hash binds the approval to the full plan content and the pinned base
SHA; if the plan is regenerated for any reason, it gets a new hash and any
approval of the old hash is invalid. No approval is recorded and no
build/implementation job starts until a human supplies the exact full
hash.

## Where to look: Projects vs Superset

GitHub Projects is the control center and Superset is the execution runtime.

- **GitHub Projects** is where operators act: issue status, published
  plans, approval comments, and PR linkage all live on the board and the
  issues themselves. Supported approval and rejection decisions happen here.
- **Superset** renders running lane agents, their worktrees, and live job
  output. It also exposes manual agent and workspace controls, but those are
  outside the controller protocol: they do not count as plan approval,
  rejection, or cancellation, and using them can leave the job blocked or
  out of sync with GitHub.

For normal controller-managed work, record decisions and feedback on the
GitHub issue or PR. The controller also observes Superset execution state and
can block a job when an agent fails or terminates. If manual intervention is
required after launch, first compare the GitHub state, controller state, and
Superset logs; after intervening, reconcile all three before resuming work.
