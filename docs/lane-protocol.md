# The lane protocol

> This is the CANONICAL copy. A mirror lives in the operator harness at
> `~/.claude/alfred-code/docs/lane-protocol.md` and must stay identical.
> Unified 2026-07-15: the lane IDs below ARE the enforcement lanes in
> `scripts/hooks/lanes.json`. There is no separate "harness lane scheme"
> anymore — that divergence is what let agents invent lanes ("CTRL",
> "HERMES") and commit voice-bridge work as "lane V".

Decompose a multi-PR issue into independent lanes with explicit contracts.
Each lane is one PR's worth of work; lanes don't share files; the
user-visible flow is the close gate.

## The lanes (enforcement territory — matches `scripts/hooks/lanes.json`)

| Lane | Branch prefix | Owns (allowed globs) | VERIFY |
|---|---|---|---|
| **I** — ctrl-api | `lane-1/` | `packages/ctrl/**` (routes, 4-store layer, settings, channels, templates — NOT migrations/schema/server.ts) | `cd packages/ctrl && npm run build` |
| **II** — learn | `lane-2/` | `packages/learn/**` (Temporal workflows, activities, scoring) | `cd packages/learn && python3 -m pytest -q` |
| **III** — web | `lane-3/` | `packages/web/**` (Wasp pages, ops, dashboard) | `cd packages/web && npx tsc --noEmit` |
| **IV** — alfred-vault | `lane-4/` | `packages/alfred-vault/**` (the Python vault daemon) | `cd packages/alfred-vault && python3 -m pytest -q` |
| **V** — edges/infra | `lane-5/` | `packages/{hermes,mcp-server,vault-init,setup}/**`, `scripts/**`, `caddy/**`, `docker-compose.yaml`, `.env.example`, `Makefile`, `docs/**` | `docker compose config -q` |
| **VI** — voice-bridge | `lane-6/` | `packages/voice-bridge/**` | `cd packages/voice-bridge && npm test` |
| **VII** — paperclip | `lane-7/` | `packages/paperclip/**` | `cd packages/paperclip/adapter && npm run typecheck && npm test` |
| **VIII** — alfred-mac | `lane-8/` | `packages/alfred-mac/**` | `cd packages/alfred-mac && swift build -c release` |
| phase0 — orchestrator | n/a (main checkout) | `**` (allow-all) | `true` |

Branch naming: `lane-<arabic>/<issue>-<slug>` — the arabic digit maps to
the roman lane ID (lane-1 = Lane I … lane-8 = Lane VIII). These are the
ONLY valid lane IDs. If your work doesn't fit a lane, it's orchestrator
(phase0) work — STOP and report; do not invent a lane name.

Channel-routing work inside `packages/ctrl` (channels_*.ts, alfredDeliver)
is Lane I territory — it is not a separate lane. Voice/telephony work is
Lane VI. One-shot tenant-migration scripts under `scripts/` are Lane V or
orchestrator work.

Three lanes is common. Six is rare.

## The forbidden zone (no lane may touch — orchestrator/phase0 only)

- `packages/ctrl/src/db/schema.sql`
- `packages/ctrl/src/db/migrations/**`
- `packages/ctrl/src/db/migrate.ts`
- `packages/ctrl/src/api/server.ts`
- `**/CONTRACT.md`
- `docs/FIX-CONTRACTS.md`, `docs/FIX-PLAN.md`, `docs/FAILURE-MODES.md`
- `scripts/hooks/**`
- `CLAUDE.md`

**Migrations are orchestrator-owned.** If an issue needs a state.db
migration, the orchestrator lands it (phase0, main checkout) BEFORE
dispatching the lanes that depend on it — the contracts file records the
allocated migration number and resulting `user_version` so lanes code
against it. A lane that finds itself needing a forbidden-zone edit STOPs
and reports; it never improvises across the boundary.

`.github/**` is likewise phase0-only (CI changes are orchestrator work).

## The `.lane` manifest (first action of every lane agent)

Before writing any code, drop a manifest at the worktree root:

```sh
echo '{"lane":"II"}' > .lane
# optional per-task narrowing of the VERIFY:
echo '{"lane":"II","verify":"cd packages/learn && python -m pytest tests/test_x.py -q"}' > .lane
```

The pre-commit gate (`scripts/hooks/check_lane.py`) reads it and rejects
any commit that (a) leaves the lane's allowed globs, (b) touches the
forbidden zone, (c) exceeds ~200 net LOC, or (d) fails the lane VERIFY.
The same check runs server-side in CI (the `lane-gate` workflow) against
the PR diff — removing the local hook does not bypass it. A blocked
commit means **re-scope, not override**: never set `ALFRED_SKIP_VERIFY`,
never widen `lanes.json`, never relabel yourself phase0.

## Hard rules (each has bitten us)

- **~200 net LOC per commit.** Bigger → STOP and report to the
  orchestrator; don't salami-slice.
- **Never run `npm install` / `npm ci` / `npm prune`** in a worktree — it
  corrupts the shared symlinked `node_modules`. VERIFY uses existing
  deps. Orchestrator-only: `npm ci` for a fresh worktree.
- **Stage only your own files** (`git add <paths>`, never `git add -A`).
- **One agent per lane at a time** — lanes parallel, tasks within a lane
  serial.
- **`isolation: "worktree"` does not guarantee isolation** — the
  orchestrator must `git show --stat` each agent's commit to confirm it
  touched only its own files before trusting it.

## The contracts file

For every multi-lane issue, write `/tmp/orchestrator-<issue>-contracts.md`
before dispatching:

```markdown
# Contracts for #<n>

## Migration (orchestrator-owned)
- Allocated: 0NNN (landed by orchestrator on main before lane dispatch)
- user_version after: NN → NN+1

## Env-var convention
- Per-profile writes: resolveProfileEnvPath(slug)
- Per-channel keys: <UPPERCASE_KIND>_<FIELD>

## File-ownership matrix
| Lane | Exclusive files |
|---|---|
| I   | packages/ctrl/src/api/routes/X.ts, src/db/X.ts (NOT migrations) |
| II  | packages/learn/src/workflows/Y.py, src/activities/Y.py |
| III | packages/web/src/dashboard/ZPage.tsx, operations.ts (append-only) |

## Inter-lane deps
- Lane III's UI smoke gated on Lane I's route being live (Lane I lands first)

## Cascade rules
- When Lane II archives a row, what happens to bound rows elsewhere:
  pick ONE shape, name the owning lane, document it here.
  Lanes never negotiate this at PR time.
```

Each lane reads this verbatim. If a lane needs a contract changed, it
comes back to the orchestrator — contracts don't move mid-dispatch.

Cross-lane interfaces that outlive the issue get frozen in the package
`CONTRACT.md` (orchestrator lands that edit — CONTRACT.md is forbidden
zone) or registered as a clause in `docs/FIX-CONTRACTS.md`.

## The Y/N gate (mandatory)

Before any `Agent` dispatch:

```
AskUserQuestion({
  question: "Lane decomposition for #<n>: proceed?",
  options: ["Yes — dispatch", "Wait — refine", "Skip — leave open"],
  header: "#<n> dispatch",
})
```

(In the autonomous loop, the Telegram Y/N gate plays this role.)

Each lane's bullet in the question body:

```
Lane I — agent_profile registry + CRUD routes
  Files: src/db/agentProfiles.ts, src/api/routes/profiles.ts
  Smoke: insert 1 profile + list + bind channel + archive + assert main unaffected
```

## Dispatch shape

```python
Agent({
  subagent_type: "general-purpose",
  isolation: "worktree",                # MANDATORY — hook blocks otherwise
  run_in_background: true,              # for parallel lanes
  description: "Lane <N> — <one-liner>",
  prompt: f"""
Inherit lane-worker.md. Your lane scope:
  {lane_scope}

FIRST ACTION: write the .lane manifest — echo '{{"lane":"<ID>"}}' > .lane
(valid IDs: I II III IV V VI VII VIII — see docs/lane-protocol.md).

Contracts at /tmp/orchestrator-{n}-contracts.md (read verbatim, don't drift).

Standard smoke template:
  {get_smoke_template_for(kind)}

Branch: lane-<arabic>/{n}-<slug>. Stay inside your lane's allowed globs;
~200 net LOC; never npm install; git add only your own paths.

Open PR titled `feat(...): #{n} Lane <N> — <one-liner>`. PR body:
  - References `#{n}` (not Closes — only the lane that completes the flow uses Closes)
  - Includes `## Smoke evidence` section (mandatory; the hook + CI gate block merge otherwise)
"""
})
```

## Verification per lane

After completion:

1. Read the PR diff (`git show --stat`). Did it stay in its lane's globs?
2. Read the `## Smoke evidence`. Real, not theater? (Isolation assertion present?)
3. If anything's wrong: re-dispatch with the gap named in the new prompt.
   Don't try to fix it in cargo-cult iterations.

## Closing the issue

Only when:

- ✓ All lanes' PRs are merged (providers before consumers)
- ✓ Real-tenant smoke exercises the principal-visible end-to-end flow on `home.alfred.black`
- ✓ Two-paragraph CHANGELOG.md entry under a new `[YYYY-MM-DD]` heading

Merge itself is Sir's manual gate — lanes and orchestrators only open PRs.
Until then: leave open, post a comment with the queue.

## Lineage

Descended from Sir-8 Lanes I/II/III/V (2026-05 multi-lane runs) and the
Wave A–E staged-deploy protocol (#109–#114), generalized into one shape:
decompose, contract, gate, dispatch, verify, close — and unified with the
repo enforcement gate on 2026-07-15.
