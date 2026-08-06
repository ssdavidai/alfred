<div align="center">

# Alfred Black

### Your attention is the business. Alfred gives it back.

A self-hosted operator that carries the coordination layer of a one-person
company — the inbox triage, the follow-ups, the context reconstruction — so you
talk to it **less** over time, not more.

**This repository is the system itself.** Every gate, every audit row, every
line of the machine that decides what Alfred may do without asking you.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-green.svg)](https://python.org)
[![PyPI: alfred-vault](https://img.shields.io/pypi/v/alfred-vault.svg)](https://pypi.org/project/alfred-vault/)
[![Cloud: alfred.black](https://img.shields.io/badge/cloud-alfred.black-black.svg)](https://alfred.black)

**[Website](https://alfred.black)** · **[Demo](https://www.youtube.com/watch?v=_Y2K5-zQKhk)** · **[Manifesto](https://screenlessdad.com/p/life-has-outgrown-your-nervous-system)** · **[Changelog](CHANGELOG.md)**

</div>

---

<div align="center">

[![Watch the Alfred Black demo walkthrough](https://img.youtube.com/vi/_Y2K5-zQKhk/maxresdefault.jpg)](https://www.youtube.com/watch?v=_Y2K5-zQKhk)

*▶ Demo walkthrough (5 min)*

</div>

---

## Attentionmaxxing

Alfred Black is **not a productivity tool.** It will not gamify your to-dos or
nudge you toward inbox zero. It is built to do the opposite of most software:
to need your attention *less* the longer you use it.

In a one-person company, every line of the P&L is downstream of one asset — the
owner's attention. Revenue is attention converted at your hourly judgment rate.
Costs are attention leaks with logos on them. Underneath the billable work sits
a second, unbilled job: inbox triage, meeting prep, chasing, and re-reading
three threads to remember what was agreed. Call it forty-something hours a
month. It isn't billable, and it isn't life.

Most AI hasn't fixed this, because every AI subscription shows you one number —
the price — and never the other one. **The token bill is visible. The mess bill
is hidden:** the prompting, reviewing, correcting, re-doing, and the ambient
cost of being quality control for a fast, confident intern. For high-stakes
work the mess bill is routinely the larger of the two.

So the number worth maximising isn't output. It's **Net Attention Returned** —
accepted work lifted off you, *minus every minute you spent making it happen*.
Only accepted work counts. Every supervision minute subtracts.

That metric is why this system is shaped the way it is. You cannot produce an
honest attention ledger from a chat window; it needs a substrate where every
decision is a record, every state change writes an audit row, and every
suppression is logged. That substrate is what this repository is.

> The long version: [**Attentionmaxxing — the thesis**](https://alfred.black).

---

## What this repo is, and what it isn't

**This is the machine.** MIT-licensed, self-hosted, yours. One repo, one VM,
one `docker compose up`. Nothing phones home; your data never leaves your box.

**It is not the service.** [alfred.black](https://alfred.black) is *managed AI
employment* — a Client Operator placed inside your company, where the
supervising, quality control and repair are somebody else's job and you receive
a monthly statement of hours returned. The management is the product there.

If you run this yourself, **you are the manager.** That is a real job, and the
honest note further down says what it costs.

---

200 emails on Tuesday. Alfred surfaced the 1 that actually required attention.

A meeting transcript drops into the inbox at 3pm. By 3:02, Alfred has created
the conversation record, updated three people, filed two tasks under the right
matter, and linked everything together. Nobody asked. It just happened.

That night, Alfred notices two records in the vault contradict each other and
flags it. Fixes broken links. Finds a cluster of notes about the same theme that
were never connected, and writes the relationships. By morning the knowledge
graph is richer than when everyone went home.

**This is what a chief of staff does.** Not tasks-on-demand — anticipatory
attention, owning things so you don't have to hold them in your head.

---

## How it works

Alfred Black is a private, self-hosted system. Everything below runs on **one
VM you control** — your data never leaves it.

### The Hermes runtime

The reasoning core is **[Hermes Agent](https://github.com/NousResearch/hermes-agent)**
— a single, isolated AI runtime. It runs in three profiles from one image: a
**main** profile for the conversations you actually have (Telegram, Slack,
email, web chat), and a concurrency-capped **workers** profile for the
background agents that never bother you (the curator, the learner, ephemeral
task runners), and a **heavy** profile for the reasoning-bound work
(onboarding and the nightly Reflection). Each profile runs its own OpenAI
Codex model tier, so you can spend reasoning where it matters and stay cheap
everywhere else.

### Memory — a vault you can read, and databases you don't have to

Alfred's memory is split by *who reads it*:

- **The vault** is an **Obsidian-compatible markdown directory** — the
  principal's surface. ~12 record types (`matter`, `task`, `note`, `person`,
  `org`, `place`, `asset`, `chore`, `instinct`, `decision`, `briefing`,
  `daybook`), wikilinked together. You can open it in Obsidian, grep it, edit it
  by hand, back it up with git. It is your second brain *and* the agent's
  operational memory — the same artifact.
- **`state.db`** (SQLite + vector search) is the **machine's working memory** —
  signals, observations, the link graph, embeddings. The UI reads from here; you
  never touch it.
- **`cold.db`** is the forensic long tail — anything older than 90 days is rolled
  out of working memory so context stays lean.
- **`ingest.db`** is the raw inbound firehose, with a hard 7-day TTL.

The rule is simple: *the vault holds what a human has a reason to read; everything
else is a database.* That separation is what keeps Alfred's context small,
fast, and grounded.

### Signals — turning noise into attention

This is the pipeline that makes 200 emails become 1:

```
Streams  →  stream events  →  signals  →  matched to Matters & Tasks  →  rolling state
(raw pull)   (ingest.db)      (scored)     (your real concerns)          (lean context)
```

1. **Streams** pull raw data — Gmail, calendar, transcripts, messages.
2. Each item becomes a **stream event** in `ingest.db`.
3. An extractor turns events into **signals** — the decision-grade "something
   here might matter" units, scored and deduped.
4. Signals are **matched against your Matters and Tasks** — so a new email about
   a contract attaches to the *matter* it belongs to, not a flat pile.
5. Matters and Tasks carry **rolling state**: a compact, continuously-updated
   summary instead of the full history. This is what keeps the agent's context
   small and **prevents hallucination** — it reasons over curated state, not raw
   noise.

### Matters — your ongoing concerns

A **Matter** is an ongoing concern that spans time and people — a deal, a move, a
legal thing, a health thing, a relationship with a vendor. Matters are how Alfred
aggregates everything related to one thread of your life in one place: the
emails, the tasks, the people, the decisions, the documents. When something new
arrives, Alfred files it under the right Matter and updates that Matter's rolling
state — so you always have one current, coherent view instead of fragments.

### Decisions and progressive autonomy

Every time Alfred acts — or asks you to — it records a **Decision** (HANDLED /
HELD / ASKED). Decisions are the audit trail of your life's judgment calls, and
they are also how Alfred *learns*.

By observing the decisions you make and how you make them, Alfred surfaces
**patterns of behaviour** — your *instincts*. It then moves through tiers of
trust:

```
Asking        →   Confirming        →   Acting
"what should      "I'm about to do      "handled it; here's
 I do here?"       X — ok?"               what I did"
```

This is **progressive autonomy** — and in this system it is a mechanism, not a
promise. The tier is a **ceiling, enforced in code**, checked *before*
confidence, at two independent points:

- the **signal router**, which decides whether Alfred acts alone or brings you
  a card; and
- the **pre-extraction noise gate**, which decides whether something reaches
  you at all — the most consequential thing an instinct can do.

Both read the same tier. Both **fail closed**: a missing, malformed or unknown
tier degrades to `Asking`, as does an unmatched signal. No amount of confidence
promotes an `Asking` instinct into autonomy.

**Alfred cannot promote himself.** Reflection may *propose* that an instinct
has earned `Acting`; applying it requires your explicit approval. Demotion is
never gated — dropping *out* of autonomy is always immediate.

Every routing decision is auditable after the fact, including the ones where
nothing happened:

```
signal-action: human (tier_gate_asking) — conf=0.94 bar=0.85 tier=Asking mode=live
```

That line says: it matched, it was confident enough, and it still didn't act —
because it hadn't been authorised to. The suppression path is audited the same
way, so "what did Alfred keep from me last week?" is a query, not a guess.

Three tiers, one rule: **only `Acting` acts unattended, and only you grant it.**

### Bring your own model

The runtime is provider-agnostic. Hermes ships support for **Anthropic,
OpenAI, OpenRouter, Google, Groq, Together, Mistral, DeepSeek, xAI** and
OpenAI Codex, and `hermes model` is an interactive provider + model picker.

Each of the three profiles takes its own model, so you can put reasoning where
it earns its keep and stay cheap everywhere else. This repo ships **Codex
tiers as the default** — that is a choice about defaults, not a limitation —
and a profile's `config.yaml` is operator-owned, so a provider you set stays
set across upgrades and reseeds.

Nothing downstream cares: the intelligence layer only ever speaks
`POST /v1/responses` to a local gateway. Swapping providers changes one block
of one file.

### Composio — 1000+ integrations, instantly

Alfred connects to your world through **[Composio](https://composio.dev)**:
**1000+ app integrations** (Gmail, Calendar, Notion, Slack, GitHub, Linear,
Stripe, and on and on) available instantly with managed OAuth — no per-app
client setup, no token plumbing on your VM. Credentials stay server-side with
Composio; Alfred just calls the tools.

### One VM, several principals

Alfred runs as **profiles** — isolated operators on the same box. Each gets its
own Hermes gateway, its own channels (Slack, Telegram, email, a phone number),
its own MCP catalogue and skills, and its own identity on the wire. Adding one
is a form, not a deployment.

That is what makes placing an operator inside a company a routine act rather
than a project.

### Built for the mess, not the demo

The interesting failures in agent systems are never the model. They are the
disk that fills, the provider that rate-limits you at 3am, the poison record
that jams a queue forever, the job that fails while reporting healthy. This
stack has met all four and carries the scar tissue:

- a **durable run ledger** with atomic I/O, idempotent enqueueing, stall
  detection and terminal-state derivation — because maintenance workers used
  to fail silently while the status said fine;
- **dead-lettering** for poison ingest events, and classification of permanent
  vs. transient failures so activities stop retrying forever;
- **provider-cap-aware backoff**, request pacing and quarantine, so a rate
  limit degrades throughput instead of correctness;
- **retention everywhere** — session pruning, audit sweeps, log caps, a cold
  archive for anything older than 90 days.

None of it is exciting. All of it is the difference between a demo and
something you'd let near a client.

### Your data never leaves your VM

There is no vendor cloud in this architecture. The vault is markdown on your
disk; the databases are SQLite files next to it; secrets live in your own
Vaultwarden. Model calls go to whichever provider you chose, from your box,
under your account.

For anyone under a confidentiality obligation — most consultants, most
fractional executives — this is not a preference. It is the difference between
being able to use a system like this and not.

### Sidecars — the back office

Two best-in-class open-source services ship in the stack so Alfred can manage
real domains of your life, not just notes:

| Sidecar | What it is | What Alfred uses it for |
|---|---|---|
| **[Sure](https://github.com/we-promise/sure)** | Personal finance | Accounts, transactions, budgets — Alfred categorises and reconciles your money |
| **[Vaultwarden](https://github.com/dani-garcia/vaultwarden)** | Secrets manager | A real vault for credentials Alfred (and you) need |

---

## What's in this repo

This repository is the canonical home of **Alfred Black**. It ships two things
that share one engine:

| | What it is | Where |
|---|---|---|
| **`alfred-vault`** | The pip-installable CLI. Turns *any* agentic runtime into an ambient butler over an Obsidian vault — the Curator / Janitor / Distiller / Surveyor workers + a Temporal workflow engine. Runs on a Mac Mini under your desk or any box with Python. | [`packages/alfred-vault/`](packages/alfred-vault/) · [`pip install alfred-vault`](https://pypi.org/project/alfred-vault/) |
| **Alfred Black** | The full self-hosted **platform**: the web dashboard, the Hermes runtime, the signal pipeline, durable workflows, multi-channel delivery, and the Sure / Vaultwarden sidecars — brought up with a single `docker compose up`, served on your own domain over HTTPS. | this repo · *the rest of `packages/`* |

---

## Two ways to run Alfred

### 1 · Just the CLI (`alfred-vault`)

If you already run an agentic runtime ([Claude Code](https://docs.anthropic.com/en/docs/claude-code),
[Zo Computer](https://zo.computer), or Hermes itself) and want the vault engine
on a single machine:

```bash
pip install alfred-vault
alfred quickstart
alfred up
```

Three commands. Drop a file into `inbox/` and it's handled. Full docs:
[`packages/alfred-vault/README.md`](packages/alfred-vault/README.md).

### 2 · The full platform (Alfred Black)

If you want the whole product — web dashboard, Hermes runtime, the daily Brief,
multi-channel delivery, and the Sure / Vaultwarden sidecars — on a VM
you control: read on. You bring a fresh Linux VM and a domain; the stack brings
everything else and serves the web app on your domain over HTTPS. No managed
provisioning, no billing — **one repo, one VM, one `docker compose up`.**

> **Don't want to be the manager?** [alfred.black](https://alfred.black) places
> and manages an operator for you — see [the honest note](#running-this-yourself-means-you-are-the-manager)
> near the end. Self-hosting (this repo) is, and always will be, the open path.

---

## Prerequisites

- **A Linux VM** you can SSH into with `sudo`/root. Any cloud (Hetzner, AWS,
  GCP, DigitalOcean, …) or bare metal works — `amd64` or `arm64`.
- **Docker Engine 24+** and the **Docker Compose v2** plugin (`docker compose`,
  not the legacy `docker-compose`).
- **A domain name** you control the DNS for. You will point **six** A-records
  at the VM (see below).
- **`git`** and **`openssl`** on the VM (`openssl` is used by the bootstrap
  script to generate secrets).
- **API keys**: `COMPOSIO_API_KEY` is required (it connects Gmail, Calendar and
  the rest of the third-party surface). Hermes itself does **not** use an LLM
  API key — it authenticates to OpenAI Codex over OAuth, which the first-run
  setup walks you through.
- **Google OAuth credentials** (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) —
  **optional**. Onboarding does *not* need them: with `COMPOSIO_API_KEY` set,
  "Start onboarding" connects Gmail through Composio's managed Google OAuth,
  so you create no Google Cloud client. Set these two only for the cosmetic
  "Sign in with Google" login button, or to run onboarding's Gmail connect
  through your own Google client instead of Composio's managed flow.
- Optionally: a **Mailgun** API key + domain for transactional email (signup
  verification / password reset — see the note under *Install*).

### Minimum VM spec

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| RAM      | 16 GB   | 32 GB       |
| vCPU     | 4       | 4+          |
| Disk     | 80 GB   | 80 GB+      |

The full stack — web app, ctrl-api, Temporal, Ollama, Hermes, the vault
daemon, Sure (~5 containers), and Vaultwarden — is
memory-hungry.

> At-rest disk encryption is **not** applied by the stack (no LUKS). The
> security-conscious should provision an encrypted Docker data-root or an
> encrypted volume for `/var/lib/docker`. AES-256-GCM column encryption of
> OAuth tokens and Vaultwarden's own vault encryption still apply regardless.

---

## DNS — do this first

Before you run `docker compose up`, create these **A-records**, all pointing at
your VM's public IP, where `example.com` is your domain:

| Record  | Host                | Serves                            |
|---------|---------------------|-----------------------------------|
| `@`     | `example.com`       | the Alfred Black dashboard (SPA)  |
| `api`   | `api.example.com`   | the Alfred Black API server       |
| `sure`  | `sure.example.com`  | Sure (personal finance)           |
| `vault` | `vault.example.com` | Vaultwarden (secrets manager)     |
| `mcp`   | `mcp.example.com`   | MCP server (Claude connector)     |

Caddy obtains a Let's Encrypt certificate per host using the HTTP-01
challenge — **no DNS API token is needed**. If DNS hasn't propagated when the
stack first starts, Caddy keeps retrying and self-heals once the records
resolve; a stale record only delays the first certificate.

---

## Install

```sh
# 1. Clone onto the VM
git clone https://github.com/ssdavidai/alfred
cd alfred

# 2. Run the interactive setup wizard
./scripts/setup.sh

# 3. Bring the whole stack up
docker compose up -d
```

`./scripts/setup.sh` is the recommended path. It is shell-only on the host —
no Node needed — and runs a containerized wizard that:

- prompts every required and optional value, with inline help;
- **validates your API keys live** — it actually calls the providers you have
  configured (Composio and friends) and tells you immediately if a key is wrong;
- lets you set the three Hermes Codex model tiers (main / workers / heavy);
- if you opt into your own Google OAuth client, prints the exact **redirect
  URI** to register for your domain (skip it to use Composio-managed Gmail);
- generates every auto-secret with a cryptographically-secure
  `randomBytes(32)`;
- writes a complete `.env`.

The wizard **doubles as a config editor** — re-run `./scripts/setup.sh` any
time to change a value; it detects the existing `.env`, offers "edit existing
values" vs "start fresh", and keeps secrets you already have. At the end it
offers to run `docker compose up -d` for you.

### Non-interactive install (CI / automation)

```sh
cp .env.example .env
# Edit .env — fill the "USER MUST FILL" block: DOMAIN, ACME_EMAIL, OWNER_NAME,
# OWNER_EMAIL, COMPOSIO_API_KEY (+ optional Mailgun, GOOGLE_CLIENT_*, and the
# HERMES_{MAIN,WORKERS,HEAVY}_MODEL Codex tiers)
nano .env
./scripts/bootstrap.sh    # generate every auto-secret into .env (run once)
docker compose up -d
```

`scripts/bootstrap.sh` validates the required fields and appends every
auto-generated secret (`AAS_API_KEY`, `COLUMN_ENCRYPTION_KEY`, `JWT_SECRET`, the
Hermes gateway token, the Sure datastore credentials, the Vaultwarden
admin token, …) with `openssl rand -hex 32`. It is idempotent — re-running never
overwrites an existing value.

`docker compose up` only **pulls** images — it never builds. First boot runs
migrations, scaffolds the vault, and requests TLS certificates; give it a few
minutes. Check progress with `docker compose ps` and `docker compose logs -f`.

When the stack is healthy, open `https://<your-domain>` and **sign up**. The
**first account created becomes the owner**; later signups are plain members.

> **Email:** the owner's account is auto-verified on signup, so you can log in
> immediately with no mail provider configured. Later members need a real
> `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` (or switch the provider in
> `packages/web/main.wasp`) to receive verification email.

### Onboarding

Onboarding is automatic and runs once, for the owner:

1. Sign up and log in — you land on `/desk`.
2. The desk shows a **"Start onboarding"** card. Click it.
3. You're sent to Google to **connect Gmail** — by default through Composio's
   managed Google OAuth (no Google Cloud client of your own).
4. On return, Alfred backfills ~100 days of email, builds a behavioural profile,
   extracts facts, and composes your **first Brief** — you watch the progress
   through the onboarding ritual, pausing once to confirm the inferred facts.
5. When the first Brief lands you're dropped back on `/desk`, now live.

### Choosing the LLM models

Hermes is **Codex-only**. `HERMES_MAIN_MODEL` (Sir's chat),
`HERMES_WORKERS_MODEL` (background agents) and `HERMES_HEAVY_MODEL`
(onboarding + the nightly Reflection) take OpenAI Codex model tiers.
Defaults: `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol`.

To change one, edit `.env` and run
`docker compose up -d --force-recreate init hermes`.

Two gotchas worth knowing:

- `config.yaml` is **seed-once and operator-owned** — init writes it if
  absent and never overwrites it. On an existing tenant, editing `.env` alone
  does nothing until the profile is re-rendered; edit the profile's
  `config.yaml` (`model.default`) for an immediate change.
- The `.env` values **override** the code defaults, so a stale entry there
  silently wins on a reseed. Keep the two in step.

### Meeting-bot transcription

The earlier Vexa profile was retired in issue
[#113](https://github.com/ssdavidai/alfred/issues/113). A Recall.ai
replacement is in flight; until it lands, no meeting-bot capture
surface is bundled.

### Restarting

`docker compose down && docker compose up -d` is safe: all data lives in named
Docker volumes and TLS certificates persist in `caddy_data`, so no re-bootstrap
is needed and Let's Encrypt is not re-hit.

---

## Running this yourself means you are the manager

Worth being straight about, because it is the part no README usually prints.

Self-hosting gives you the whole capability and none of the management. Alfred
still has to be supervised, and that supervision is a job:

- **Instincts need reviewing.** Alfred proposes what he thinks he's learned.
  Something has to decide whether a pattern is real, and approve any promotion
  to `Acting`. The gates make that safe; they don't make it automatic.
- **Decisions need checking.** The audit trail is only worth having if somebody
  reads it.
- **Failures need catching.** Dead-letters, stalled runs, a provider changing
  its limits, a token that quietly expires.
- **A VM needs keeping alive.** Disk, memory, upgrades, backups of the vault
  and the certs.

Budget a few hours a month once it's settled, and meaningfully more while it's
learning your work. That's not a warning — plenty of people will happily pay
that in exchange for owning the whole thing, and the fact that you *can* is the
point of the licence.

But notice what it is: the coordination tax, converted into a management tax.
If your reason for wanting Alfred was to stop being the person who supervises
the work, self-hosting hands that job straight back to you.

## If you'd rather not hold that job

**[alfred.black](https://alfred.black)** is the other answer: *managed AI
employment*. One Client Operator, placed inside your one-person company,
accountable for a defined job — with the supervision, quality control and
repair as **our** job, not yours.

The difference isn't hosting. It's who is accountable when the work is wrong.
You review a monthly statement of hours actually returned — accepted work,
minus every minute you spent on prompting, review, correction and repair — not
the work itself.

Keep your Claude. Keep your ChatGPT. Alfred works through them.

**[Apply to hire Alfred →](https://alfred.black)**

---

## Building the images (maintainers only)

A fresh VM never builds anything — `docker compose` only **pulls**. The custom
`ssdavidai00/*` images are built and pushed by CI on every push to the default
branch (`.github/workflows/build-*.yml`, multi-arch `linux/amd64,linux/arm64`):

| Image | Built from |
|-------|-----------|
| `alfred-web` / `alfred-web-client` | `wasp build` → server + SPA halves |
| `alfred-ctrl-api` | `packages/ctrl` (esbuild bundle + sqlite-vec) |
| `alfred-black-hermes` | `packages/hermes` (Hermes runtime + shim) |
| `alfred-worker` | `packages/hermes/dockerfiles/alfred.Dockerfile` (the vault daemon — bundles `packages/alfred-vault`) |
| `alfred-learn` | `packages/learn` (Temporal worker) |
| `alfred-mcp-server` | `packages/mcp-server` |
| `alfred-init` | `packages/hermes/init` (one-shot bootstrap — bundles `packages/alfred-vault`) |
| `alfred-setup` | `packages/setup` (the interactive wizard — run via `./scripts/setup.sh`) |

The **`alfred-vault`** Python package has its own independent release train —
it publishes to PyPI on an `alfred-vault-vX.Y.Z` tag via
`.github/workflows/release-alfred-vault.yml`. The platform uses date-based
releases; the package uses semver.

---

## Architecture

Three planes on one VM, behind a bundled Caddy reverse proxy with automatic TLS.
Every service talks over the Compose network by service DNS; only Caddy binds
host ports (`:80`/`:443`).

- **Web** (`packages/web`) — the Wasp dashboard. Auth + UI; proxies all data
  calls to the local `ctrl-api`.
- **Control** (`packages/ctrl`) — the `ctrl-api` service on `:3100`; owns the
  vault and the operational SQLite stores, and enforces the read/write contract.
- **Data** — Hermes (AI runtime), Temporal, Ollama, the vault daemon
  (`packages/alfred-vault`, run as `alfred-worker`), `alfred-learn` (the signal
  pipeline + the learner), the MCP server, plus the Sure / Vaultwarden
  sidecars.

Four-store memory model: **vault** (markdown — the principal's surface),
**`state.db`** (SQLite + vector search — working memory), **`cold.db`** (forensic
long tail >90 days), **`ingest.db`** (raw inbound stream, 7-day TTL).

---

## License

[MIT](LICENSE) · Built by [David Szabo-Stuban](https://screenlessdad.com).
</content>
