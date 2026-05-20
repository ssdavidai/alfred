<div align="center">

# Alfred Black

### Your private chief of staff. Seen, not heard.

An agentic butler that runs your calendar, email, finances, and household
logistics in the background — so you talk to it **less** over time, not more,
and get to be present for your actual life.

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

## Presence, not productivity

Alfred Black is **not a productivity tool.** It will not gamify your to-dos or
nudge you toward inbox zero. It is built to do the opposite of most software:
to need your attention *less* the longer you use it.

Your life has outgrown your nervous system. The number of inputs — email,
messages, calendars, bills, contracts, logistics — has scaled past what a human
brain was built to hold. The usual answer is another app, another dashboard,
another screen demanding you. Alfred's answer is a butler that quietly absorbs
all of it and surfaces only what genuinely needs *you*.

The goal is to become **seen, not heard** — a system that knows your life well
enough to act on your behalf, so you spend less time looking at screens and more
time being a human. Call it *presencemaxxing*: Alfred becomes your interface to
the web, so you don't have to be.

> This is the working philosophy behind the project. The longer version:
> [**Life has outgrown your nervous system**](https://screenlessdad.com/p/life-has-outgrown-your-nervous-system).

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
— a single, isolated AI runtime. It runs in two profiles from one image: a
**main** profile for the conversations you actually have (Telegram, Slack,
email, web chat), and a concurrency-capped **workers** profile for the
background agents that never bother you (the curator, the learner, ephemeral
task runners). You choose the underlying model (any OpenRouter model, or your
own provider) — Alfred is not locked to one LLM.

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

This is **progressive autonomy**: Alfred starts by asking, learns your patterns,
begins suggesting, then — only once it has earned it — quietly automates the
things you've shown it you'd always approve. The more it learns, the less it
asks. Seen, not heard.

### Composio — 1000+ integrations, instantly

Alfred connects to your world through **[Composio](https://composio.dev)**:
**1000+ app integrations** (Gmail, Calendar, Notion, Slack, GitHub, Linear,
Stripe, and on and on) available instantly with managed OAuth — no per-app
client setup, no token plumbing on your VM. Credentials stay server-side with
Composio; Alfred just calls the tools.

### Sidecars — the back office

Three best-in-class open-source services ship in the stack so Alfred can manage
real domains of your life, not just notes:

| Sidecar | What it is | What Alfred uses it for |
|---|---|---|
| **[Sure](https://github.com/we-promise/sure)** | Personal finance | Accounts, transactions, budgets — Alfred categorises and reconciles your money |
| **[Plane](https://plane.so)** | Project management | The durable task/issue backbone behind Matters and chores |
| **[Vaultwarden](https://github.com/dani-garcia/vaultwarden)** | Secrets manager | A real vault for credentials Alfred (and you) need |

---

## What's in this repo

This repository is the canonical home of **Alfred Black**. It ships two things
that share one engine:

| | What it is | Where |
|---|---|---|
| **`alfred-vault`** | The pip-installable CLI. Turns *any* agentic runtime into an ambient butler over an Obsidian vault — the Curator / Janitor / Distiller / Surveyor workers + a Temporal workflow engine. Runs on a Mac Mini under your desk or any box with Python. | [`packages/alfred-vault/`](packages/alfred-vault/) · [`pip install alfred-vault`](https://pypi.org/project/alfred-vault/) |
| **Alfred Black** | The full self-hosted **platform**: the web dashboard, the Hermes runtime, the signal pipeline, durable workflows, multi-channel delivery, and the Sure / Plane / Vaultwarden sidecars — brought up with a single `docker compose up`, served on your own domain over HTTPS. | this repo · *the rest of `packages/`* |

> **2026-05-20 — the platform release.** The project that gave you the `alfred`
> CLI is now a complete, deployable platform. `alfred-vault` is the same
> dependable engine it always was — `pip install alfred-vault` still works
> exactly as before — and Alfred Black wraps it in everything you need to
> actually live with an agentic butler. See [`CHANGELOG.md`](CHANGELOG.md).

---

## Two ways to run Alfred

### 1 · Just the CLI (`alfred-vault`)

If you already run an agentic runtime ([Claude Code](https://docs.anthropic.com/en/docs/claude-code),
[OpenClaw](https://openclaw.com), [Zo Computer](https://zo.computer)) and want
the vault engine on a single machine:

```bash
pip install alfred-vault
alfred quickstart
alfred up
```

Three commands. Drop a file into `inbox/` and it's handled. Full docs:
[`packages/alfred-vault/README.md`](packages/alfred-vault/README.md).

### 2 · The full platform (Alfred Black)

If you want the whole product — web dashboard, Hermes runtime, the daily Brief,
multi-channel delivery, and the Sure / Plane / Vaultwarden sidecars — on a VM
you control: read on. You bring a fresh Linux VM and a domain; the stack brings
everything else and serves the web app on your domain over HTTPS. No managed
provisioning, no billing — **one repo, one VM, one `docker compose up`.**

> **Don't want to run servers?** A fully-managed cloud version is in **private
> beta at [alfred.black](https://alfred.black)** — we're working with a small
> group of design partners. Self-hosting (this repo) is, and always will be, the
> open path.

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
- **API keys**: `OPENROUTER_API_KEY` and `COMPOSIO_API_KEY` are required.
  `ANTHROPIC_API_KEY` is **optional** — Hermes routes LLM traffic through
  OpenRouter by default.
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
daemon, Plane (~13 containers), Sure (~5 containers), and Vaultwarden — is
memory-hungry. Enabling the optional Vexa profile adds roughly **3 GB** of RAM
and disk on top.

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
| `plane` | `plane.example.com` | Plane (project management)        |
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
- **validates your API keys live** — it actually calls OpenRouter, Anthropic,
  and Composio and tells you immediately if a key is wrong;
- lets you **pick the Hermes models** from OpenRouter's live model catalogue;
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
# OPENROUTER_API_KEY, COMPOSIO_API_KEY (+ optional ANTHROPIC_API_KEY, Mailgun,
# GOOGLE_CLIENT_*, HERMES_MAIN_MODEL / HERMES_WORKERS_MODEL, VEXA_*)
nano .env
./scripts/bootstrap.sh    # generate every auto-secret into .env (run once)
docker compose up -d
```

`scripts/bootstrap.sh` validates the required fields and appends every
auto-generated secret (`AAS_API_KEY`, `COLUMN_ENCRYPTION_KEY`, `JWT_SECRET`, the
Hermes gateway token, Plane/Sure/Vexa datastore credentials, the Vaultwarden
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

`HERMES_MAIN_MODEL` (user-facing chat) and `HERMES_WORKERS_MODEL` (background
agents) take **bare OpenRouter model IDs**. Defaults: `x-ai/grok-4.3` and
`openai/gpt-4.1-nano`. To change one, edit `.env` and run
`docker compose up -d --force-recreate init hermes`. Hermes also supports
switching provider entirely (`docker compose exec hermes hermes model`).

### Optional: the Vexa meeting-transcription stack

Vexa (meeting-bot transcription) ships behind a Compose profile, off by default:

```sh
docker compose --profile vexa up -d
```

Without `--profile vexa`, its nine containers are simply not created.

### Restarting

`docker compose down && docker compose up -d` is safe: all data lives in named
Docker volumes and TLS certificates persist in `caddy_data`, so no re-bootstrap
is needed and Let's Encrypt is not re-hit.

---

## The cloud version

Prefer not to run a VM? **[alfred.black](https://alfred.black)** is the
fully-managed, hosted Alfred Black — currently in **private beta with design
partners**. This repository is the open, self-hosted path and remains the source
of truth for the platform.

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
  pipeline + the learner), the MCP server, plus the Sure / Plane / Vaultwarden
  sidecars.

Four-store memory model: **vault** (markdown — the principal's surface),
**`state.db`** (SQLite + vector search — working memory), **`cold.db`** (forensic
long tail >90 days), **`ingest.db`** (raw inbound stream, 7-day TTL).

---

## License

[MIT](LICENSE) · Built by [David Szabo-Stuban](https://screenlessdad.com).
</content>
