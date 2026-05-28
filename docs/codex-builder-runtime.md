# Codex Builder Runtime — design

A sealed-compartment execution runtime for ONE Paperclip agent
(`codex-feature-builder`) that actually mutates code, while every other
Paperclip agent on the tenant (CEO `hermes`, `alfred-engineering-orchestrator`,
`alfred-code-reviewer`, the rest) goes through the existing Hermes-main
profile with NO shell, NO codex CLI, NO repo write capability.

**Read context first:** [`hermes-sole-runtime`](../packages/hermes/README.md),
[`paperclip-hermes-http-adapter`](../packages/paperclip/DESIGN.md),
[`durable-tenant-customization-pattern`](../packages/hermes/README.md#tenant-customisation),
[`joe-tenant-cratchit-stack`](../packages/hermes/README.md) (working example
of a 4th Hermes profile, port :18792).

**Status:** design only. No code, no PRs, no deploys until Sir signs off
the open questions in §11.

---

## 0. TL;DR (the one paragraph that survives skimming)

Add a fourth Hermes profile, `codex-builder`, bound to `:18793` and launched
by the existing supervisor. It loads NO MCP servers, runs as a separate
non-root uid inside its own bind-mounted scratch tree, and is the only
profile that has the Codex CLI on PATH. The `hermes_local` Paperclip adapter
gains a single name-based switch: when `agent.name === "codex-feature-builder"`
it routes to `:18793` instead of `:18789`. Every other Paperclip agent
continues to route to `:18789` (the existing main profile) where Codex is
not installed, terminal sandboxing denies network egress, and there is no
write surface to the host repo. Branches are pushed via a deploy-key
restricted to the one repo with `repo:write` only (no admin, no settings,
no merge-to-main). The end-to-end loop (orchestrator → leaf-builder issue →
codex run → branch + comment back) is unchanged from Sir's spec; only the
runtime layer changes.

---

## 1. Architecture & data flow

### Service shape on a tenant (after the change)

```
┌──────────────────────────────────────────────────────────────────────┐
│ alfred-black-hermes container                                        │
│                                                                      │
│  /usr/local/bin/hermes  (one binary, four profiles)                  │
│                                                                      │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌────────────────┐  │
│  │ hermes-main │ │hermes-      │ │ hermes-     │ │ hermes-        │  │
│  │ :18789      │ │  workers    │ │  heavy      │ │  codex-builder │  │
│  │             │ │ :18790      │ │ :18791      │ │ :18793         │  │
│  │ openrouter  │ │ openrouter  │ │ openrouter  │ │ openai-codex   │  │
│  │ all MCP     │ │ all MCP     │ │ all MCP     │ │ NO MCP         │  │
│  │ messaging   │ │ background  │ │ Opus heavy  │ │ terminal-only  │  │
│  │ uid 10000   │ │ uid 10000   │ │ uid 10000   │ │ uid 10001      │  │
│  │ HOME=…/main │ │ HOME=…/work…│ │ HOME=…/heav…│ │ HOME=…/cb      │  │
│  └─────────────┘ └─────────────┘ └─────────────┘ └────────────────┘  │
│        ▲              ▲              ▲                ▲              │
│        │              │              │                │              │
└────────┼──────────────┼──────────────┼────────────────┼──────────────┘
         │              │              │                │
         │     (compose-internal network 172.x.0.0/16)  │
         │              │              │                │
┌────────┴──────────────┴──────────────┴────────────────┴────────────┐
│ paperclip container (paperclip.alfred.black)                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ hermes_local adapter (forked, packages/paperclip/adapter)    │  │
│  │   execute(ctx):                                              │  │
│  │     if (ctx.agent.name === "codex-feature-builder")          │  │
│  │       gatewayUrl = "http://hermes:18793"                     │  │
│  │     else                                                     │  │
│  │       gatewayUrl = "http://hermes:18789"                     │  │
│  │     callHermesResponses(...)                                 │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### Data flow — one builder run, happy path

```
1. Sir → Paperclip:  files spec issue, marks ready
       │
       v
2. Paperclip heartbeats alfred-engineering-orchestrator
       │  (adapterType: hermes_local, name != codex-feature-builder)
       v
3. paperclip POST /v1/responses → http://hermes:18789  (main profile)
       │
       v
4. Hermes-main breaks the spec into a parent+children issue tree via
   mcp_paperclip_create_issue. Leaf child assigned to codex-feature-builder.
       │
       v
5. Paperclip heartbeats codex-feature-builder
       │  (adapterType: hermes_local, name == codex-feature-builder)
       v
6. paperclip POST /v1/responses → http://hermes:18793  (codex-builder profile)
       │
       v
7. Hermes-codex-builder, system-prompted to "you are a builder; given an
   issue id, run codex against a fresh worktree", invokes its sole tool —
   the terminal — to:
       a. mkdir /work/runs/<runId>
       b. git clone --depth 1 --branch main \
            git@github.com:ssdavidai/alfred /work/runs/<runId>/repo
       c. cd /work/runs/<runId>/repo
       d. git checkout -b codex/<issue-id>-<sha7>
       e. codex exec -C /work/runs/<runId>/repo \
            --sandbox workspace-write \
            --ask-for-approval never \
            --ephemeral \
            --output-last-message /work/runs/<runId>/last.txt \
            --json \
            "$(cat /work/runs/<runId>/prompt.md)"
       f. git add -A && git commit -m "<llm-authored>"
       g. (optional) npm test / pytest, capture exit code
       h. git push origin codex/<issue-id>-<sha7>
       i. Emit a single text result with branch name + diff stat + test
          outcome. Hermes returns that as the /v1/responses output.
       │
       v
8. Paperclip adapter sees the text result, writes it to the run transcript,
   and the run-completed webhook fires Paperclip's auto-comment on the
   issue with branch URL + summary.
       │
       v
9. Paperclip heartbeats alfred-code-reviewer  (back on :18789)
       v
   Reviewer fetches the diff via mcp_alfred_self HTTP-proxy → GitHub API,
   posts review comments. If approved → "merge ready" label, lands in
   Sir's queue for a manual merge click.
```

The only NEW arrows in the diagram are `paperclip → hermes:18793` and
`hermes-codex-builder → github.com (push)` + `hermes-codex-builder →
api.openai.com (codex)`.

---

## 2. The `codex-builder` Hermes profile spec

### Identity

| Field | Value |
|---|---|
| Profile name | `codex-builder` |
| API port (compose-internal) | `:18793` |
| API port (host-published) | NONE — never published, never reachable from outside the compose network |
| Default model provider | `openai-codex` (via Hermes' built-in `openai-codex` provider — uses the same ChatGPT-OAuth path joe + rj already use, but with its OWN auth.json, see §3) |
| Uid:gid the gateway process runs as | `10001:10001` (NOT `10000:10000` like main/workers/heavy) |
| HERMES_HOME view | `/hermes-state/profiles/codex-builder` (same volume, different sub-tree) |

Tenant-port-allocation rule: **`:18793` fleet-wide**. We already have a
documented port table (`18789/main`, `18790/workers`, `18791/heavy`,
`18792/cratchit` on joe). `:18793` is the next free slot, takes precedence
over per-tenant assignment because the adapter routing (§4) is name-based,
not port-discovery-based — keeping one port number simplifies both the
adapter map and the firewall rules in §6.

### `hermes-config.yaml.njk` — what gets added

A new `{% elif profile == "codex-builder" %}` branch in every block that
currently splits main / workers / heavy. The intent is:

- `model.default`: read from `${HERMES_CODEX_BUILDER_MODEL}`, default
  `"gpt-5-codex"` (the model behind `codex exec`; Hermes' own LLM calls
  in this profile use the same model so the supervising agent stays
  consistent with the tool it shells out to).
- `model.provider`: hard-pinned `"openai-codex"`. Do not let .env
  override this — codex-builder's whole point is "openai-codex only".
  Implementation: the Nunjucks block writes `provider: "openai-codex"`
  directly (no template variable).
- `agent.max_turns`: 30 (smaller than workers; one builder run shouldn't
  need 50 LLM turns to drive one codex run).
- `agent.reasoning_effort`: `"high"` (this profile thinks more than it
  acts, since the act is mostly "shell out to codex").
- `memory.memory_enabled`: `false`. Builder runs are one-shot.
- `memory.user_profile_enabled`: `false`. There is no "user" here.
- `session_reset.mode`: `idle`, `idle_minutes: 5`. Aggressive — each
  builder run should be a fresh session.
- `delegation.max_concurrent_children`: `1`. No sub-agent spawning.
- `delegation.max_spawn_depth`: `0`. Hard "this profile does not delegate".
- `approvals.mode`: `off`. There is no human in the loop here — the codex
  CLI's own sandbox is the safety net (see §6).
- `tool_loop_guardrails.hard_stop_enabled`: `true`, same exact_failure/
  same_tool_failure/idempotent_no_progress limits as workers.
- `terminal.cwd`: `${runtime_profile_dir}/workspace` (the codex-builder
  profile dir under HERMES_HOME — its `workspace/` is also where the
  per-run `/work/runs/<runId>` symlinks live, see §5).
- `terminal.timeout`: `1800` (30 min — a codex run can be long).
- `terminal.lifetime_seconds`: `3600` (1 h hard ceiling per terminal).
- `platform_toolsets`: `cli: [terminal, file]` — **only** terminal and
  file. No web, no vision, no skills, no todo, no delegation, no
  messaging. Explicitly: the builder profile cannot make outbound HTTP
  via the `web` tool, cannot delegate, cannot send messages.
- `mcp_servers`: **EMPTY**. The block is rendered as `mcp_servers: {}`.
  This is the hard fence — the profile cannot reach ctrl-api, cannot
  read vault, cannot talk to Paperclip, cannot reach plane/sure/
  vaultwarden/execute. The only thing it can do is run terminal
  commands inside its own bind-mount.
- `skills.creation_nudge_interval`: `0`, no skills directory. (The
  init container's skills-deploy step §3 skips this profile.)
- `cron`: not rendered (background profile, no cron consumers).
- `display.streaming`: `true` (so the adapter can stream codex's
  progress back to Paperclip's run transcript).

### `hermes-profile.env.njk` — what gets added

Same `{% elif profile == "codex-builder" %}` split:

```
API_SERVER_ENABLED=true
API_SERVER_PORT=18793
API_SERVER_HOST=0.0.0.0      # bind 0.0.0.0; compose-network DNS only — see §6
API_SERVER_KEY={{ api_server_key }}    # same gateway-token as the other 3
                                       # profiles. The adapter already reads
                                       # the profile-specific key, see §4.
API_SERVER_MODEL_NAME=codex-builder
# NO OPENROUTER_API_KEY — this profile uses openai-codex provider, period.
# NO ANTHROPIC_API_KEY — same reason.
# OPENAI_API_KEY: NOT rendered. Codex auth is OAuth-via-ChatGPT (see §3).
# NO COMPOSIO_API_KEY — no MCP, nothing to authenticate to.
# NO AAS_API_KEY — no ctrl-api access, nothing to authenticate to.
# NO PAPERCLIP_API_KEY — the profile MUST NOT call paperclip back.
# NO TWILIO_/SLACK_/TELEGRAM_/DISCORD_/SMS_/WHATSAPP_ keys — no channels.

CODEX_WORKSPACE_ROOT=/work
CODEX_HOME=/hermes-state/profiles/codex-builder/.codex   # see §3
GIT_SSH_COMMAND=ssh -i /hermes-state/profiles/codex-builder/.ssh/codex_id_ed25519 \
                    -o StrictHostKeyChecking=accept-new \
                    -o IdentitiesOnly=yes
GATEWAY_ALLOW_ALL_USERS=false
HERMES_HUMAN_DELAY_MODE=off
```

**Allowlist principle:** the env explicitly omits every key the other
profiles set. This is a *positive* allowlist — `render_hermes.py` will
have a per-profile branch that renders only those keys listed above,
not a "render everything and the if-block drops some" pattern. The
runtime-key preservation (§3 of `render_hermes.py`) does NOT apply to
this profile — its `_RUNTIME_KEY_PREFIXES` tuple is empty, so a
`/channels` Save Token write into another profile cannot leak in.

### `supervisor.sh` delta

Two changes only:

1. Extend `wait_for_profiles` loop from `main workers heavy` to
   `main workers heavy codex-builder`.
2. After the three existing `start_proc` lines, add a fourth, run
   under a different uid via `setpriv`:

```
start_proc "hermes-codex-builder" \
  "cd \"${PROFILES_DIR}/codex-builder\" && \
   set -a && . \"${PROFILES_DIR}/codex-builder/.env\" && set +a && \
   TERMINAL_CWD=${PROFILES_DIR}/codex-builder/workspace \
   exec setpriv --reuid=10001 --regid=10001 --clear-groups \
     hermes -p codex-builder gateway run --replace"
```

The `setpriv --reuid 10001 --regid 10001 --clear-groups` is the kernel-
level uid switch. The existing main/workers/heavy supervisors keep
running as the container's default user (uid 10000) — same as today.

The SOUL.md / auth.json mirror block in supervisor.sh is **explicitly
skipped for codex-builder** (the for-loop iterates `workers heavy`
only). The codex profile gets its own SOUL.md (§3), its own
auth.json (§3), neither inherited from main.

---

## 3. Codex CLI in the Hermes image

### Install

In `packages/hermes/Dockerfile`, after the Node.js 22 install block
(NodeSource lines 72-75), add:

```
# =============================================================================
# OpenAI Codex CLI — installed for use ONLY by the codex-builder profile.
# Available on PATH inside the container but the codex-builder profile is
# the only one with credentials (CODEX_HOME) and a workspace to act on.
# main/workers/heavy can `which codex` but a `codex exec` would 401 (no
# auth file in their CODEX_HOME) and have no workspace to mutate (their
# terminal.cwd is the profile dir, not /work).
#
# Source: npm @openai/codex. Pin a version arg so a future bump is
# explicit + reviewable.
ARG CODEX_CLI_REF=0.65.0
RUN npm install -g "@openai/codex@${CODEX_CLI_REF}" \
 && codex --version
```

**Image-size impact:** the codex CLI's npm package ships a Rust binary
per platform (linux/x64 ≈ 35 MB compressed, ≈ 90 MB unpacked). Plus
a few MB of JS wrappers. Total: ~95 MB on top of the current image.
Current `alfred-black-hermes:latest` is ~1.4 GB so this is ≈ +7%.
Acceptable.

### Auth — separate from rj/joe's existing openai-codex auth

Memory says rj's openai-codex auth.json was copied to joe to power
Hermes-main's `openai-codex` provider. **That auth.json is for the
LLM provider call** (Hermes routing chat turns through OpenAI). The
codex CLI's auth.json — the file `codex login` writes — happens to
live in the same `~/.codex/auth.json` shape, but conceptually it is a
different credential: it authorises `codex exec` to spend ChatGPT-Plus
codex-tool quota on a real engineering task that will modify code.

**Design choice: keep them strictly separate.** The codex-builder
profile gets its OWN `CODEX_HOME` (rendered in the .env as
`/hermes-state/profiles/codex-builder/.codex`). Hermes' supervisor.sh
auth-mirror block (lines 142-153) DOES NOT mirror `main/auth.json`
into the codex-builder profile — see §2 supervisor.sh delta.

**Bootstrap:** Sir runs once, post-deploy:

```
docker exec -it -u 10001:10001 -e CODEX_HOME=/hermes-state/profiles/codex-builder/.codex \
  alfred-black-hermes-1 codex login --device-auth
```

That writes `/hermes-state/profiles/codex-builder/.codex/auth.json`
into the named `hermes_data` volume. Survives every restart, every
`docker compose pull`, every image rebuild — same persistence the
existing per-profile auth.json files get. Bootstrap is a one-time per
tenant operation; the design doc REQUIRES it before any builder run.

Per memory `[[ask-before-upstream-for-tenant-work]]`: this auth bootstrap
is per-tenant runtime state, not image content. Document it as a
tenant-side ritual, not a default.

### Codex CLI in the same container, NOT a sidecar

**Decision: same container.** Reasons:

1. **Filesystem layout.** Codex needs to read `/work/runs/<runId>/repo`,
   write a git tree, and the Hermes terminal tool needs to read codex's
   stdout/stderr + exit code. A sidecar would force us to either
   network-mount a shared workspace (NFS/9p complications) or do every
   filesystem mutation over RPC. Bind-mounting `/work` once in the
   single container is cleaner.
2. **Process boundary already there.** The codex-builder profile already
   runs as uid 10001, distinct from main/workers/heavy at uid 10000.
   That IS the boundary. Splitting at the container boundary buys nothing
   extra without giving up the simpler filesystem story.
3. **Operator surface.** "Four Hermes profiles in one container" is the
   established pattern (main/workers/heavy + cratchit on joe). A fifth
   one fits. A new sidecar service is novel and would need its own
   compose entry, healthcheck, restart policy, log destination, on
   every tenant.

Tradeoff acknowledged: a kernel-level exploit inside the codex-builder
uid that escalates to uid 10000 would compromise main's MCP secrets in
the same container. Mitigation: §6 §2 — codex-builder runs as a
dedicated uid with no membership in any shared group, drops every
capability, and codex's own `--sandbox workspace-write` adds a second
layer (Linux Landlock under the hood per upstream docs).

### Codex's `--sandbox workspace-write` semantics, applied here

Per the OpenAI docs, `workspace-write` lets codex modify files under
`--cd <dir>` but blocks writes elsewhere and blocks unsolicited
network access. We pin:

- `--sandbox workspace-write`: always.
- `--ask-for-approval never`: always (the codex-builder profile is the
  approver-of-last-resort; there is no terminal-level approval surface).
- `--ephemeral`: yes — no persisted codex session files. Builder runs
  are independent; codex's own conversation state should not carry
  over between issues (this is "fresh worktree, fresh prompt, fresh
  codex run" by design).
- `--json`: yes, so the Hermes terminal can parse exit codes from the
  envelope.
- `--output-last-message <file>`: yes, so we can read codex's final
  summary text into the comment posted on the Paperclip issue.

The system prompt baked into Sir's `codex-feature-builder` Paperclip
agent constructs the codex CLI invocation; the Hermes builder profile
is just the supervisor that drives it.

---

## 4. Adapter routing change

### Choice: name-based (option B), not label-based (option A)

**Rationale:**

- We have ONE sealed agent name, fleet-wide and forever. The list is
  not going to grow weekly. A constant `CODEX_BUILDER_AGENT_NAMES`
  is sufficient and obvious in code review.
- `runtimeConfig.routing.profile` requires a schema extension on the
  Paperclip side, which Paperclip-upstream does not provide today.
  That would force us to either monkey-patch Paperclip's agent
  validator (fragile) or pretend the field lives somewhere else
  (`adapterConfig.routing.profile`, which conflates two abstractions
  — the adapter and the routing-of-the-adapter).
- Name-based routing is debuggable from a Paperclip user's terminal:
  `paperclip agents list` shows the name, and the name IS the
  routing key. No hidden config to dig out.

**Concession to flexibility:** the constant lives in
`packages/paperclip/adapter/src/shared/constants.ts` alongside
`SESSION_KEY_PREFIX`, easy to grow if a future second-sealed-agent
emerges.

### Concretely — what changes in the adapter

`packages/paperclip/adapter/src/shared/constants.ts`:

```typescript
// Compose-internal URL for the codex-builder profile. The port is fleet-
// wide so name-based routing works identically on every tenant.
export const HERMES_CODEX_BUILDER_GATEWAY_URL = "http://hermes:18793";

// Agent names that route to the sealed codex-builder profile.
// Match against agent.name (lowercased) so a UI-side capitalisation tweak
// doesn't accidentally route the agent back to the main profile.
export const CODEX_BUILDER_AGENT_NAMES = new Set<string>([
  "codex-feature-builder",
]);
```

`packages/paperclip/adapter/src/server/execute.ts` — new helper:

```typescript
function pickGatewayUrlForAgent(
  agent: AdapterAgent | null | undefined,
  config: Record<string, unknown>,
): string {
  // Explicit per-agent override always wins (operator escape hatch
  // for one-off debugging).
  const explicit = asString(config.hermesGatewayUrl);
  if (explicit) return explicit;
  const name = (agent?.name ?? "").trim().toLowerCase();
  if (CODEX_BUILDER_AGENT_NAMES.has(name)) {
    return HERMES_CODEX_BUILDER_GATEWAY_URL;
  }
  return process.env.HERMES_GATEWAY_URL ?? DEFAULT_HERMES_GATEWAY_URL;
}
```

Used at the top of `execute()` in place of the current 3-line
gatewayUrl resolution.

### Auth-key resolver delta

`readHermesMainApiKey` becomes `readHermesProfileApiKey(profile: "main" |
"codex-builder")`. The function already takes a `configDir` argument and
joins `<profile>/.env`; making `"main"` a parameter instead of a literal
is one line.

`execute()` passes `"codex-builder"` whenever it picks the
codex-builder URL, `"main"` otherwise. ctrl-api's mirror at
`packages/ctrl/src/api/routes/channels_paperclip.ts` does NOT need the
same change — that resolver is for the ctrl-api → Hermes-main bridge,
which is unaffected by codex-builder.

### Tests

Three new unit tests in `packages/paperclip/adapter/test/execute.test.ts`:

1. `agent.name === "codex-feature-builder"` → gateway URL is the codex
   builder URL.
2. `agent.name === "anything-else"` → gateway URL is the main URL
   (or `HERMES_GATEWAY_URL` env override if set).
3. `config.hermesGatewayUrl === "http://debug:18794"` for the codex
   agent → operator override wins.

The existing 38 tests stay green (none of them set `agent.name` to
`codex-feature-builder`).

### Migration of existing tenants

None required for the adapter change itself — the routing is on agent
name, and `codex-feature-builder` either exists on a tenant or doesn't.
Tenants that don't have the agent never hit `:18793`. Tenants that DO
have the agent need the codex-builder profile up before the routing
change deploys, otherwise heartbeats 502 — so the rollout order is
fixed: §10 PR 2 (profile up, no routing) precedes §10 PR 3 (routing).

---

## 5. Workspace isolation

### Layout

Inside the codex-builder profile's view:

```
/hermes-state/profiles/codex-builder/
  ├── config.yaml         (operator-owned, see §2)
  ├── .env                (rendered, see §2)
  ├── .codex/
  │   └── auth.json       (written by `codex login` once, see §3)
  ├── .ssh/
  │   ├── codex_id_ed25519        (per-tenant deploy key, see §6)
  │   └── codex_id_ed25519.pub
  ├── SOUL.md             (system prompt for the builder agent itself,
  │                        not Sir's Alfred SOUL; see below)
  ├── plugins/            (empty — no plugins for builder)
  ├── sessions/           (Hermes session store; ephemeral)
  └── workspace/          (terminal.cwd)
      └── runs/           (symlinked → /work/runs, see below)

/work/                    (separate bind mount, owned by uid 10001)
  └── runs/
      └── <runId>/
          ├── prompt.md   (the spec text, written by the builder agent's
          │                first action)
          ├── repo/       (git worktree, fresh clone)
          ├── last.txt    (codex --output-last-message destination)
          ├── codex.json  (codex --json envelope, post-run)
          └── test.log    (post-codex test runner output)
```

The `workspace/runs → /work/runs` symlink keeps the codex-builder
profile's `terminal.cwd` (per Hermes config) inside its own profile dir
(matches the established pattern) while the actual data lives on its
own mount with its own quota.

### Lifecycle

**Create (on execute() start, by the builder agent itself via the
terminal tool):**

```
runId=$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)
mkdir -p /work/runs/$runId/repo
git clone --depth 1 --branch main --no-tags \
    git@github.com:ssdavidai/alfred /work/runs/$runId/repo
git -C /work/runs/$runId/repo checkout -b codex/<issue-id>-<sha7>
```

The runId is a UUID-ish string the builder agent generates and surfaces
back in the Paperclip run transcript so an operator can `docker exec`
in and inspect.

**Teardown (on success):**

```
git -C /work/runs/$runId/repo push origin codex/<issue-id>-<sha7>
# leave the directory in place for operator forensics — see GC below.
```

**Teardown (on crash/timeout):**

The Hermes gateway's terminal tool kills the codex child process when
`terminal.timeout` fires (1800 s, see §2). The directory is left in
place — see GC.

**Garbage collection:**

A simple `tmpreaper`-style cron job inside the codex-builder profile:
`find /work/runs -maxdepth 1 -mindepth 1 -type d -mtime +7 -exec rm -rf
{} \;`. Runs daily via Hermes' own cron facility (which we DO enable
for this profile, in `cron.wrap_response: true`, single job). Seven
days is long enough for an operator to forensic a failed run, short
enough that runaway disk use is bounded — on a tenant with one builder
run per day, peak storage is ~7 × (clone + diff + test artifacts) ≈
350 MB - 2 GB depending on test output. Fits.

### Where on disk

`/work` is a **named docker volume** (`hermes_codex_work`), declared
in `docker-compose.yaml` alongside `hermes_data`. Bind-mounted into
the hermes container at `/work` with `:rw`. Owned `10001:10001`,
mode `0700` (the init container's entrypoint sets this; only uid
10001 can list it). NOT a `tmpfs` — a 2 GB diff or test artifact
must survive a single restart (e.g. supervisor reaps a stuck codex
run, the comment-back agent restarts and reads `last.txt`).

The volume is NOT mounted in the paperclip, ctrl-api, web, or any
other compose service — only `hermes`. This is a §6 fence: the run
data is not even visible to the rest of the stack.

### Concurrency

`max_concurrent_children: 1` (§2) means one builder session at a time.
The runId namespacing means even if a future config raises this, two
runs never collide on disk. For v1 we cap at 1 — see §11 open
question on parallelism.

---

## 6. The hard security boundary

### Capability table

| Capability | Can codex-builder do it? | Mechanism |
|---|---|---|
| Read/write `/work/runs/<runId>/` | YES | bind mount `/work` rw, uid 10001 owns the tree |
| Read/write `/hermes-state/profiles/codex-builder/` | YES (own state) | uid 10001 owns this sub-tree, init container chowns at boot |
| Read `/hermes-state/profiles/main/` (or workers/heavy) | NO | other profiles' dirs are `0700 10000:10000`; uid 10001 has no read bit |
| Read `/alfred-data/.gateway-token` | NO | file is `0600 10000:10000`; uid 10001 cannot read it (so the codex-builder profile boots with API_SERVER_KEY rendered explicitly from the init container's view — see §2 .env render) |
| Read `/vault` (any of it) | NO | `/vault` is NOT mounted in the codex-builder uid's namespace. The vault volume IS mounted at the container level (since the same container runs main), but uid 10001 has no read access. Init container ensures `/vault` is `0700 10000:10000`. |
| Read `/opt/alfred/.env` | NO | not mounted into the hermes container at all (already true today, kept). |
| Reach ctrl-api over the compose network | TECHNICALLY YES, but: NO useful action | TCP reachability cannot be revoked without breaking everyone else in the compose network. Mitigation: codex-builder has no AAS_API_KEY in its env, so every ctrl-api endpoint 401s. The MCP catalog is empty (§2), so the LLM has no tool to call ctrl-api with anyway. The terminal `curl` command works at the L4 level but lacks credentials. |
| Reach Paperclip API over the compose network | Same as ctrl-api: L4 yes, L7 no credentials |
| Reach Vaultwarden API | Same: L4 yes, L7 no credentials |
| Reach `github.com` (push / pull) | YES, only for `ssdavidai/alfred` | Single deploy key under `~/.ssh/codex_id_ed25519` (uid 10001), key is registered on the alfred repo with the "Allow write access" box checked. GitHub deploy keys are scoped to ONE repo — they cannot access other org repos, cannot create branches in other repos, cannot use admin scopes. `GIT_SSH_COMMAND` env pins `IdentitiesOnly=yes` so no ambient agent identity leaks in. |
| Force-push / push to `main` | NO | GitHub side: branch protection on `main` (already in place per repo settings) refuses non-PR pushes. Even with a deploy key, push to `main` returns "protected branch" 403. We also configure the local clone with `git config remote.origin.pushurl 'ssh://…'` and add a server-side commit-hook check in the post-deploy ritual that confirms branch protection is on. |
| Read `~/.codex/auth.json` of OTHER users | N/A | CODEX_HOME is per-profile (`/hermes-state/profiles/codex-builder/.codex`); no other CODEX_HOME exists in the container that this uid can read. |
| Reach `api.openai.com` (codex CLI) | YES (required) | needed for codex CLI calls. Egress allowlist (see network below) explicitly permits. |
| Reach `api.anthropic.com`, `openrouter.ai`, any other LLM provider | NO | Egress allowlist denies. The codex-builder profile uses ONE provider, openai-codex. There is no reason to reach anyone else. |
| Reach `api.composio.io`, `api.plane.so`, any other SaaS | NO | Egress allowlist denies. |
| Reach `cdn.npmjs.org` / `registry.npmjs.com` / `pypi.org` / `crates.io` | YES (required for codex's own test runs) | Egress allowlist permits. Tests may install deps; a `pip install` or `npm ci` is a normal codex workspace action. |
| Reach arbitrary internet hosts | NO | Egress allowlist is positive-only. Default deny. |
| Read `/etc/hostname`, `/etc/hosts`, `/proc/<other-pid>/environ` | YES (read-only proc/), but: limited utility | Same kernel namespace as main; `/proc/<pid>/environ` requires same uid or CAP_SYS_PTRACE. We drop CAP_SYS_PTRACE (already today on all alfred containers) so codex-builder cannot read main's `/proc/<pid>/environ`. Reading `/etc/hostname` reveals "alfred-black-hermes-1" — non-sensitive (the tenant identity is in domain, not hostname). |
| Make any Hermes-MCP tool call (`mcp_alfred__*`, `mcp_paperclip_*`, etc) | NO | profile's `mcp_servers: {}` — the gateway never instantiates an MCP client, so the tool catalogue contains zero `mcp_*` tools. Even if the LLM tries to call `mcp_paperclip_create_issue`, the gateway returns "no such tool". |
| Trigger a workflow on Temporal | NO | No MCP, no AAS_API_KEY, no client library in CODEX_HOME. Temporal is unreachable at L7. |
| Send messages on any channel (Telegram/Slack/SMS/etc) | NO | `platform_toolsets` lists only `cli: [terminal, file]`. Even if the LLM hallucinates a "telegram" tool, the gateway has no such tool registered for this profile. |
| Spawn a sub-agent / delegate | NO | `max_concurrent_children: 1, max_spawn_depth: 0`. |

### Enforcement, by layer

#### Filesystem

- **Init container, at boot:** runs an explicit `chown` and `chmod`
  pass for the codex-builder profile sub-tree, sets `/work` ownership
  to `10001:10001 mode 0700`. Idempotent; runs on every container
  recreate.
- **Bind mounts:** the existing `vault_data` and `alfred_data` volumes
  ARE mounted into the hermes container (main needs them). The uid
  10001 process has no read bit on either. We verify this in the
  post-deploy smoke test (§8).
- **Read-only paths:** `/opt/paperclip-mcp`, `/opt/mcp-stdio`,
  `/opt/hermes-lcm`, `/opt/one-alfred` are image content — already
  read-only-ish (codex-builder cannot write to them because uid 10001
  cannot write to root-owned image content). Doesn't matter — none
  of those paths are used by the codex-builder profile (no MCP).

#### Network egress

We add a single egress filter to the hermes container, applied via
an init script run by tini before the supervisor starts. It uses
`iptables` with the OUTPUT chain, scoped to uid 10001:

```
iptables -A OUTPUT -m owner --uid-owner 10001 -d <hermes-container-ip>/32 -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner 10001 -d 127.0.0.1/8        -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner 10001 -d <openai-egress>    -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner 10001 -d <github-egress>    -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner 10001 -d <pkg-mgr-egress>   -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner 10001 -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner 10001 -j REJECT --reject-with icmp-net-prohibited
```

`<openai-egress>`, `<github-egress>`, `<pkg-mgr-egress>` are resolved
at boot to the public IP ranges via:

- OpenAI: published ASN AS137967 / fetched from `https://chatgpt.com/.well-known/openai-cidr.txt` if available, else conservative hard-coded list.
- GitHub: `https://api.github.com/meta` → `git`, `web`, `api` arrays.
- npm/PyPI/crates.io: hard-coded CIDR set (Fastly, Cloudfront).

The hermes container needs `NET_ADMIN` to set iptables rules. Per
current compose `cap_drop: ALL`, we add `cap_add: NET_ADMIN` to the
hermes service. (Not the paperclip service, not ctrl-api — just hermes.)

This is the security-boundary linchpin. Without it, codex-builder
running unauthenticated curl against ctrl-api / vault / vaultwarden is
benign-but-not-zero (L7 auth blocks it). WITH it, the L4 path doesn't
even exist. We MUST land this together with the workspace work; this
is why §10 PR 4 is split 4a (filesystem) + 4b (network).

#### Env vars

The .env render is positive-allowlist (§2). The supervisor.sh `set
-a; . <profile>/.env; set +a` pattern source-and-exports ONLY what's
in the file. `setpriv --clear-groups` drops the gateway process's
supplementary groups (which would otherwise inherit from the container
default).

Crucially: env vars from the docker-compose `environment:` block
(OPENROUTER_API_KEY, ANTHROPIC_API_KEY, etc) ARE in the container's
initial environment and WOULD be inherited by the supervisor's child
processes unless explicitly unset. Two options:

- **Option A:** `setpriv --reset-env`. Clears the entire environment
  before exec. Then re-set only the things the gateway needs (PATH,
  HOME, USER, plus the .env source). This is the bigger hammer.
- **Option B:** In the start_proc command, prepend `unset
  OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY COMPOSIO_API_KEY
  COMPOSIO_USER_ID AAS_API_KEY HERMES_API_SERVER_KEY` before the .env
  source. Smaller blast radius.

**Pick option A.** The supervisor.sh codex-builder line uses
`setpriv --reuid 10001 --regid 10001 --clear-groups --reset-env`,
then re-exports the irreducible minimum (PATH, HOME, USER, TERM, plus
sources the .env file). A future env var added to the compose block
cannot accidentally leak through.

#### Process / uid

- gateway process: uid 10001:10001 (via setpriv).
- `setpriv --clear-groups` clears supplementary groups (the container
  default user gid 10000 would otherwise be inherited).
- Image-side: `/etc/passwd` gets a `codex-builder:x:10001:10001::
  /hermes-state/profiles/codex-builder:/usr/sbin/nologin` entry added
  in the Dockerfile so `id` works and codex's stat-the-user-dir code
  finds a home.
- The hermes container's `cap_drop: [ALL]` is already in place; we
  add `cap_add: [NET_ADMIN]` for the iptables setup at boot, and
  `--security-opt no-new-privileges` already prevents setuid binaries
  from escalating.

#### Hermes config

- `mcp_servers: {}` — no MCP clients instantiated for this profile.
- `platform_toolsets.cli: [terminal, file]` — only terminal + file
  builtins; no `web`, no `vision`, no `skills`, no `todo`, no
  delegation, no messaging adapters.
- `delegation.max_spawn_depth: 0` — the LLM cannot say
  "delegate to a sub-agent" and get one.
- `approvals.mode: off` — no approval surface to social-engineer.

---

## 7. The Paperclip-side `codex-feature-builder` agent reconfig

The agent already exists. The post-design change to its record:

### `adapterConfig`

```json
{
  "sessionKey": "paperclip-codex-feature-builder-<companyId>"
}
```

That's it — no `hermesGatewayUrl` (we WANT the adapter routing to win),
no model/provider (defined by the codex-builder profile's
config.yaml), no skills, no timeoutSec (let the default 300s cover
the Hermes-side wrapper; the codex CLI's own terminal.timeout is the
real ceiling).

Optionally also set `_legacy_devicePrivateKeyPem` to whatever the
migration script left there, for symmetry with the other migrated
agents — no functional difference.

### `runtimeConfig`

```json
{
  "heartbeat": { "enabled": true, "intervalMs": 60000 },
  "maxConcurrentRuns": 1,
  "runTimeoutMs": 1800000
}
```

- `heartbeat.enabled: true` — the whole point.
- `intervalMs: 60000` — 1 min; codex-builder runs are slow, no need
  for a tighter heartbeat.
- `maxConcurrentRuns: 1` — Paperclip-side enforcement that pairs
  with Hermes-side `delegation.max_concurrent_children: 1`. Belt and
  braces; either alone is sufficient.
- `runTimeoutMs: 1800000` — 30 min, matches Hermes' `terminal.timeout`.
  Paperclip kills the run if Hermes doesn't return.

### `capabilities` text

Rewrite the persona's capabilities block from the current
"isolated workspaces/branches; runs tests; does not merge or deploy"
to a tighter statement that reflects what the runtime ACTUALLY allows:

```
You are codex-feature-builder. You receive engineering issues from
alfred-engineering-orchestrator. You execute exactly one engineering
task per invocation by driving the OpenAI Codex CLI.

You have access to a single tool, `terminal`, in a sealed sandbox:
  - filesystem: writable inside /work/runs/<runId>, read-only outside
  - network: github.com, api.openai.com, npm/PyPI/crates.io only
  - no MCP, no Paperclip API, no vault, no secrets
  - no ability to merge, deploy, force-push, or modify branch protection

For each issue:
  1. Generate a fresh runId
  2. mkdir /work/runs/<runId>
  3. Write the spec to /work/runs/<runId>/prompt.md
  4. Clone ssdavidai/alfred (main, depth 1)
  5. Checkout branch codex/<issue-id>-<runId-suffix>
  6. Invoke: codex exec -C /work/runs/<runId>/repo \
       --sandbox workspace-write --ask-for-approval never --ephemeral \
       --json --output-last-message /work/runs/<runId>/last.txt \
       "$(cat /work/runs/<runId>/prompt.md)"
  7. Run repository tests if the change touches code that has tests.
  8. git commit + git push origin <branch>
  9. Return a single text response with: branch URL, diff stat,
     test outcome, and codex's final-message summary.

Never: edit /vault, edit /hermes-state, push to main, force-push,
merge a PR, install packages outside the codex sandbox, leak secrets
to logs.
```

This block lives in Paperclip's agent persona field. The narrower
language is the SECOND fence after the runtime fence — if a future
op accidentally widens the runtime sandbox, the persona still tells
the LLM "you don't do those things".

### Skills attached

None initially. The codex-builder profile renders no `skills/`
directory (§2). Even if Paperclip would attach a skill metadata-side,
the Hermes profile has nowhere to load it from.

---

## 8. End-to-end test plan

All steps are manual; no automation in this design. After PR 5 lands,
Sir or an operator runs these on `home.alfred.black`. (Sir's per-
memory rule: tenant-side validation before any fleet rollout.)

### 8.1 Profile is up

```
docker exec alfred-black-hermes-1 ls /hermes-state/profiles/codex-builder/
# expect: config.yaml .env .codex .ssh SOUL.md plugins sessions workspace
docker exec alfred-black-hermes-1 ss -tlnp | grep 18793
# expect: a hermes process listening on :18793
curl -fsS http://hermes:18793/health    # from inside another container in the compose network
# expect: 200 OK
```

### 8.2 Codex CLI is installed and authed

```
docker exec -u 10001 alfred-black-hermes-1 codex --version
# expect: codex 0.65.0 (or whatever CODEX_CLI_REF is pinned to)

docker exec -u 10001 \
  -e CODEX_HOME=/hermes-state/profiles/codex-builder/.codex \
  alfred-black-hermes-1 codex login status
# expect: exit 0, "logged in as <openai-account-email>"
```

### 8.3 Adapter routing — positive case

From Sir's laptop, hit Paperclip's HTTP test surface:

```
curl -X POST https://paperclip.<tenant>/api/v1/agents/<codex-builder-agent-id>/heartbeat \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -d '{"force":true}'
```

Inspect the Paperclip run log:
- `[hermes] Calling Hermes (gateway=http://hermes:18793, ...)`
  ← MUST be :18793, not :18789.

### 8.4 Adapter routing — negative case (regression check)

Same surface, against a non-codex agent (say
`alfred-engineering-orchestrator`):
- `[hermes] Calling Hermes (gateway=http://hermes:18789, ...)`
  ← MUST be :18789.

### 8.5 End-to-end: a stub issue

Sir files a Paperclip issue with body:

> Create a file `docs/HELLO.md` containing the text "hello from codex-
> builder" and nothing else. No code changes anywhere else.

Mark the issue ready; tag it for `codex-feature-builder`.

Within ~5 min:
- a branch `codex/<issue-id>-<hash>` appears on `github.com/ssdavidai/alfred`.
- the branch contains exactly one commit, exactly one new file
  (`docs/HELLO.md`).
- Paperclip's run transcript ends with the branch URL + diff stat +
  no test runs (the agent system prompt skips tests if no test files
  touched).
- the issue gets the auto-comment with the same.

### 8.6 Security boundary spot-checks

From inside the codex-builder runtime — Sir does this via:

```
docker exec -u 10001 -it alfred-black-hermes-1 bash
```

(this is OPERATOR access, not LLM access; the LLM never has a shell.
But the OPERATOR shell as uid 10001 IS the runtime view.)

Then:

```
# 8.6.1 vault is unreadable
ls /vault                  # expect: Permission denied
cat /vault/SOUL.md         # expect: Permission denied

# 8.6.2 alfred-data secrets unreadable
ls /alfred-data            # expect: Permission denied
cat /alfred-data/.gateway-token  # expect: Permission denied

# 8.6.3 other Hermes profiles unreadable
ls /hermes-state/profiles/main          # expect: Permission denied
ls /hermes-state/profiles/workers       # expect: Permission denied
ls /hermes-state/profiles/heavy         # expect: Permission denied

# 8.6.4 ctrl-api is L4-reachable but L7-rejected
curl -fsS http://ctrl-api:3100/api/v1/health
# L4 succeeds (200), but any AUTHENTICATED endpoint:
curl -fsS http://ctrl-api:3100/api/v1/agents
# expect: 401 (no AAS_API_KEY in env)

# 8.6.5 paperclip API L4-reachable but L7-rejected
curl -fsS http://paperclip:3100/api/v1/companies
# expect: 401 (no PAPERCLIP_API_KEY in env)

# 8.6.6 github reachable, but only for our repo
ssh -T git@github.com
# expect: "Hi ssdavidai/alfred! You've successfully authenticated, but
#          GitHub does not provide shell access."

# 8.6.7 push to main blocked
cd /tmp && git clone --depth 1 git@github.com:ssdavidai/alfred test-protect
cd test-protect && git commit --allow-empty -m "should fail" \
   && git push origin HEAD:main
# expect: remote rejected — protected branch

# 8.6.8 random egress blocked
curl -m 5 -fsS https://api.anthropic.com/v1/messages
# expect: timeout or connection refused (egress filter)

curl -m 5 -fsS https://www.google.com
# expect: timeout (egress filter)

# 8.6.9 openai + npm + pypi reachable
curl -m 10 -fsS https://api.openai.com/v1/models -o /dev/null
# expect: 401 (we have no Authorization header) — proves L4 ok
curl -m 10 -fsS https://registry.npmjs.com/-/ping -o /dev/null
# expect: 200
```

If 8.6.4 returns 200 with data, the §6 enforcement on AAS_API_KEY is
broken — STOP and fix before any real builder run.

If 8.6.7 returns success, branch protection is OFF or the deploy key
has admin scope. STOP and fix.

If 8.6.8 returns 200 (or anything non-timeout/non-refused), the egress
filter is broken or not in effect for uid 10001. STOP and fix.

### 8.7 Failure-injection drills

Beyond the happy path, run §9's six failure modes as drills:

- Pull the deploy key off the disk → next builder run fails clean on
  git push, the auto-comment surfaces "branch failed: auth".
- Kill the codex CLI mid-run → Hermes terminal timeout fires, the
  run errors with `hermes_timeout`, Paperclip retries on next
  heartbeat.
- Fill `/work` to 95% via `dd` → next builder run errors during
  git clone, the auto-comment surfaces "no space".
- Run a 2-line codex prompt that exceeds OpenAI's rate limit → codex
  exits non-zero with a clear "rate limited" message, Hermes returns
  it as the run's text, no GitHub side effect.

---

## 9. Failure modes and recovery

| # | Failure | Detection | Surfaced as | Recovery |
|---|---|---|---|---|
| 1 | Codex CLI rate-limited by OpenAI (ChatGPT daily cap exhausted) | codex exits non-zero, stderr contains "rate limit" or "quota" | builder agent posts auto-comment on issue: "codex rate-limited; retry in N hours" | manual: Sir or operator waits; or moves the codex auth to a higher-tier ChatGPT account |
| 2 | Codex produces malformed diff / fails to apply | codex's own internal `git apply` fails → codex exits with non-zero. Hermes terminal sees the exit code via the `--json` envelope. | builder agent posts auto-comment: "codex run failed: diff did not apply" + the codex stderr tail | no recovery — the spec gets re-opened and re-triaged by the orchestrator. If recurring, Sir tightens the spec wording. |
| 3 | Git push fails (network blip / auth) | git push exits non-zero, stderr captured | builder agent posts auto-comment: "build complete but push failed: <error>". Branch lives on the workspace disk for forensics. | operator: `docker exec -u 10001 hermes git -C /work/runs/<runId>/repo push`. The diff is not lost. |
| 4 | Workspace fills disk (`/work` > 95%) | `df` polled by a Hermes cron job (separate from the GC cron); when over threshold, the job posts a notify_principal-style message via ctrl-api (NOT from inside codex-builder, but from main — main's cron monitors codex-builder's disk and journals) | Sir's brief surfaces "codex workspace 95%, 7-day GC may need a manual sweep" | manual: `docker exec hermes find /work/runs -type d -mtime +1 -exec rm -rf {} \;` |
| 5 | Codex CLI hangs / no output | Hermes' `terminal.timeout` (1800 s) fires, the codex child gets SIGTERM then SIGKILL | run returns `hermes_timeout` to Paperclip; Paperclip surfaces "timed out after 30 min" on the run | next heartbeat may retry the issue; if the spec is genuinely infeasible we hit failure mode 2 instead |
| 6 | Codex auth expires (ChatGPT session revoked) | first codex call returns "not authenticated" | builder agent posts: "codex auth expired, contact operator" | manual: `docker exec -u 10001 -e CODEX_HOME=... hermes codex login --device-auth` (same as §3 bootstrap) |
| 7 | Hermes-codex-builder process crashes | supervisor.sh's restart loop catches the death, respawns | Paperclip heartbeats return `hermes_unreachable` for ~5 s | automatic (supervisor restarts) |
| 8 | Branch protection on main accidentally disabled | codex pushes to main → 8.6.7 spot-check fails | the design test catches it; no in-band detection | manual: re-enable branch protection in repo settings + run §8.6.7 quarterly |
| 9 | The egress allowlist drift (OpenAI / GitHub publish new IP ranges) | new codex run can't reach api.openai.com; iptables logs DROP | auto-comment "codex unreachable"; operator inspects iptables logs | manual: re-run the boot-time IP-range fetcher, restart the container |

---

## 10. Build plan — phased PRs

Each PR is independent and small; each is verifiable on its own before
the next begins.

### PR 1 — `codex` CLI in the hermes image

- Add `CODEX_CLI_REF=0.65.0` ARG + the `npm install -g @openai/codex`
  RUN to the Dockerfile.
- No profile changes, no compose changes, no adapter changes.
- Add `/etc/passwd` entry for `codex-builder` uid 10001 (so subsequent
  PRs can `setpriv --reuid 10001`).

**Verifies:** `docker exec hermes codex --version` returns the version.
The other 3 profiles are completely unaffected — `codex` is on PATH but
none of them have CODEX_HOME or a `codex login` token, so a stray
`codex exec` would fail at auth, never quietly succeed.

**Unblocks:** PR 2.

### PR 2 — `codex-builder` profile (idle, no traffic)

- `hermes-config.yaml.njk`: add the `{% elif profile == "codex-builder" %}`
  branches (§2).
- `hermes-profile.env.njk`: same, with positive-allowlist of env keys.
- `render_hermes.py`: extend the profile literal from `(main, workers,
  heavy)` to `(main, workers, heavy, codex-builder)` and add the
  `_API_SERVER_PORT["codex-builder"] = 18793`. Add an
  `_RUNTIME_KEY_PREFIXES` exception so codex-builder gets no runtime
  key preservation.
- `init` container's entrypoint.sh: add an init step that
  `chown 10001:10001` the codex-builder profile dir + a freshly
  created `/work` mount, sets mode `0700`.
- `docker-compose.yaml`:
  - Add the named volume `hermes_codex_work`.
  - Mount `hermes_codex_work:/work` in the hermes service.
  - Add `cap_add: [NET_ADMIN]` to the hermes service.
  - Do NOT publish `:18793` on the host (compose-internal only).
- `supervisor.sh`: extend `wait_for_profiles` and add the fourth
  `start_proc` with `setpriv --reuid 10001 --regid 10001
  --clear-groups --reset-env`. Skip the auth.json mirror for
  codex-builder.

**Verifies:** §8.1 + §8.2 (after a one-time `codex login` ritual).
No Paperclip agent is routing to :18793 yet; the profile is up and
unused.

**Unblocks:** PR 3.

### PR 3 — adapter routing

- `packages/paperclip/adapter/src/shared/constants.ts`: add
  `HERMES_CODEX_BUILDER_GATEWAY_URL` and `CODEX_BUILDER_AGENT_NAMES`.
- `packages/paperclip/adapter/src/server/execute.ts`: add
  `pickGatewayUrlForAgent()` helper; use it in `execute()`.
- `packages/paperclip/adapter/src/server/hermes-http.ts`:
  parameterize `readHermesProfileApiKey(profile)`.
- Add three new tests (§4).
- Rebuild paperclip image; CI runs the adapter test suite (38 + 3 = 41
  tests).

**Verifies:** §8.3 + §8.4. With a Sir-side Paperclip heartbeat against
the codex agent, the adapter routes to :18793. Against any other agent,
it routes to :18789. Existing 38 tests stay green.

**Unblocks:** PR 4 (which adds the actual sandbox; without 4 the
codex-builder profile runs as uid 10001 but has no egress filter — a
half-built fence).

### PR 4a — filesystem isolation

- `init` container's entrypoint.sh: stricter `chown`/`chmod` on
  vault_data + alfred_data + other-profile dirs, ensuring uid 10001
  has no read bit on any of them. Adds a startup assertion that
  fails the init container if any of the negative spot-checks (8.6.1
  through 8.6.3) would pass.
- The codex-builder profile's `.ssh/` dir gets a per-tenant
  deploy key written by the init container (the key itself is
  generated by `bootstrap.sh` and stored in Vaultwarden; init reads
  it out and writes to disk).
- bootstrap helper that registers the public key on the GitHub repo
  via the `gh` CLI / GitHub API (one-time per tenant, documented in
  `docs/codex-builder/bootstrap.md`).

**Verifies:** §8.6.1, 8.6.2, 8.6.3, 8.6.6, 8.6.7.

**Unblocks:** PR 4b.

### PR 4b — network egress allowlist

- `supervisor.sh`: before launching profiles, runs an `iptables` setup
  script that resolves the OpenAI / GitHub / package-registry CIDR sets
  at boot and installs the OUTPUT chain rules scoped to uid 10001.
- The script writes a small `/var/log/codex-builder-iptables.log`
  noting what was allowed/denied.
- A startup self-test: from a shell as uid 10001, `curl -m 5
  https://api.openai.com/v1/models` should return non-DNS-error AND
  `curl -m 5 https://api.anthropic.com/v1/messages` should fail. If
  either check is wrong, supervisor exits non-zero.

**Verifies:** §8.6.4, 8.6.5, 8.6.8, 8.6.9.

**Unblocks:** PR 5.

### PR 5 — Paperclip agent reconfig + end-to-end smoke

- A one-shot script `packages/paperclip/scripts/update-codex-builder-
  agent.sh` that PATCHes the existing `codex-feature-builder` Paperclip
  agent record with the persona text (§7), adapterConfig, runtimeConfig.
- A doc `docs/codex-builder/operator-guide.md` covering the manual
  bootstrap rituals (codex login, deploy-key registration, branch-
  protection verification, GC cron).
- Run §8.5 against home.alfred.black with a real spec issue.

**Verifies:** the full loop, end to end.

**Unblocks:** rollout to other tenants (rj, joe, zsolt, miguel — though
in practice only Sir's tenants get the builder agent).

---

## 11. Open questions for Sir

These are decisions that genuinely need Sir's input — not "consider X"
hand-waves.

### 11.1 Is the codex-builder's OpenAI auth separate from joe/rj's existing openai-codex Hermes-main auth, or shared?

**My recommendation:** SEPARATE. They're different threat models. The
joe/rj auth is "an LLM provider key powering a chat surface"; the
codex-builder auth is "the right to execute engineering changes on
ssdavidai/alfred under your name". Mixing them means a future
rotation of the chat-provider auth silently breaks builder runs, OR
worse: a compromise of one is a compromise of both.

But this means a second `codex login` ritual per tenant that has the
builder. **Sir, confirm:** OK with separate auth, or do you want them
shared for now to reduce ops surface?

### 11.2 One sealed builder runtime per tenant, or one shared one (e.g. only Sir's `home` tenant runs it)?

**My recommendation:** only Sir's tenant for v1 — `home.alfred.black`
is the only tenant with a real engineering org behind it. Other
tenants (rj, joe, zsolt, miguel) don't have a `codex-feature-builder`
agent, so they get the new profile-renderer code paths but never
actually use them (the profile is provisioned-but-idle on those
tenants, or we can short-circuit the supervisor's fourth `start_proc`
on a `${ENABLE_CODEX_BUILDER:-false}` flag).

A "shared one" (one tenant's codex-builder acting on behalf of
several tenants' issue queues) is a much bigger design — cross-tenant
auth, repo-arbitration, billing. Out of scope for v1.

**Sir, confirm:** v1 = home-only? With `ENABLE_CODEX_BUILDER=false` on
every other tenant by default?

### 11.3 Concurrency: strictly one-at-a-time, or N concurrent builder runs?

**My recommendation:** strictly one (§2 `max_concurrent_children: 1`,
§7 `runtimeConfig.maxConcurrentRuns: 1`). Reasons:

- Codex's ChatGPT-quota is per-account; two parallel runs split the
  per-minute throughput in half and one will start failing on rate
  limits.
- The workspace lifecycle (§5) tolerates parallelism (runIds are
  namespaced), but the disk-pressure math becomes much worse at N=3+.
- One builder is enough to keep up with a human PM filing issues at
  ~1-3 per day.

If Sir wants higher throughput later, raise the cap with one config
edit; the architecture supports it. **Sir, confirm:** OK with 1?

### 11.4 Codex run wall-clock budget — 30 min, or something different?

**My recommendation:** 30 min (`terminal.timeout: 1800`,
`runTimeoutMs: 1800000`). Reasons:

- Most issues codex completes successfully take < 10 min.
- A ceiling under 15 min would clip the genuinely-hard ones.
- An hour or more invites runaway spend on a single hung run.

**Sir, confirm:** OK with 30 min? Or higher (e.g. 60 min for
heavy-spec issues)?

### 11.5 Workspace persistence between runs

**My recommendation:** ephemeral (fresh clone per run, GC at 7 days
post-run, `--ephemeral` on the codex CLI). The spec implies "fresh
git worktree, fresh branch" anyway.

The alternative — keep the clone around, incremental git pull, faster
clone times — buys ~30s per run at the cost of cross-run-state
contamination risk (a previous run's stale dependency lock could
poison the next run's tests).

**Sir, confirm:** ephemeral is right?

### 11.6 Should `codex-feature-builder` be the agent name we match on, OR a more durable identifier (id / capability tag) that survives a rename in Paperclip's UI?

A user-side rename today silently breaks routing. A `codex_routing:
true` tag on the agent record, or matching on agent.id, would be more
robust.

**My recommendation:** name for v1 (it's stable enough — Sir doesn't
rename agents idly). Plan to evolve to a label in v2 if a rename
incident ever happens. **Sir, confirm:** name is acceptable for now?

---

## Appendix A. Canonical port table (post-change)

| Port | Profile | Purpose | Published to host? |
|---|---|---|---|
| 18789 | main | user-facing chat, all MCP | YES (caddy → main) |
| 18790 | workers | background, all MCP | NO (compose only) |
| 18791 | heavy | Opus reasoning, all MCP | NO (compose only) |
| 18792 | cratchit (joe only) | Craig's PA, all MCP | NO (compose only) |
| **18793** | **codex-builder** | **sealed; no MCP** | **NO (compose only)** |

## Appendix B. Files changed (for the reviewer's mental index)

| Path | PR | Type of change |
|---|---|---|
| `packages/hermes/Dockerfile` | PR 1 | +CODEX_CLI_REF arg + RUN install + /etc/passwd entry |
| `packages/hermes/hermes-config.yaml.njk` | PR 2 | +codex-builder branches |
| `packages/hermes/hermes-profile.env.njk` | PR 2 | +codex-builder branches |
| `packages/hermes/init/render_hermes.py` | PR 2 | extend profile literal + port map + runtime-key skip |
| `packages/hermes/init/entrypoint.sh` | PR 2, PR 4a | chown/chmod, dir creation, key write |
| `packages/hermes/docker/supervisor.sh` | PR 2, PR 4b | +4th start_proc + iptables boot setup |
| `docker-compose.yaml` | PR 2 | +hermes_codex_work volume + NET_ADMIN cap |
| `packages/paperclip/adapter/src/shared/constants.ts` | PR 3 | +codex builder URL + agent-name set |
| `packages/paperclip/adapter/src/server/execute.ts` | PR 3 | +pickGatewayUrlForAgent |
| `packages/paperclip/adapter/src/server/hermes-http.ts` | PR 3 | parameterize profile in API-key reader |
| `packages/paperclip/adapter/test/execute.test.ts` | PR 3 | +3 routing tests |
| `packages/paperclip/scripts/update-codex-builder-agent.sh` | PR 5 | new one-shot |
| `docs/codex-builder/bootstrap.md` | PR 4a, PR 5 | operator rituals (codex login, deploy key, branch protection) |
| `docs/codex-builder/operator-guide.md` | PR 5 | day-to-day ops |

## Appendix C. Things this design EXPLICITLY does not do

- Does not give codex-builder ANY MCP tools. No "let it call
  alfred_create_decision when it's stuck", no "let it ask the
  reviewer". If it's stuck, it errors out and the next round of the
  loop (reviewer, orchestrator) picks up.
- Does not let codex-builder merge PRs. Merge stays a Sir-side
  manual click.
- Does not let codex-builder generate its own issues. Spec → issues
  is the orchestrator's job, on the main profile.
- Does not introduce a sidecar container. Same Hermes image, fourth
  profile.
- Does not introduce cross-tenant builder routing. v1 is per-tenant.
- Does not expose :18793 to the public internet (no host publish, no
  Caddy entry, no Tailscale route).
- Does not run the codex CLI under user uid 10000 (same as main /
  workers / heavy). Uid 10001 is the boundary, and is the load-bearing
  difference between "this profile can read /vault" and "this profile
  cannot read /vault".
