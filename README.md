<div align="center">

# Alfred Black

**The agent you can forget about.**

An ambient butler for your calendar, email, finances, household logistics, and
everything else you currently keep in your head — self-hosted, always on, on
hardware you control.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-green.svg)](https://python.org)
[![PyPI: alfred-vault](https://img.shields.io/pypi/v/alfred-vault.svg)](https://pypi.org/project/alfred-vault/)

</div>

---

200 emails on Tuesday. Alfred surfaced the 1 that actually required attention.

A meeting transcript drops into the inbox at 3pm. By 3:02, Alfred has created
the conversation record, updated three people, filed two tasks under the right
matter, and linked everything together. Nobody asked. It just happened.

That night, Alfred notices two records in the vault contradict each other and
flags it. Fixes broken links. Finds a cluster of notes about the same theme
that were never connected, and writes the relationships. By morning the
knowledge graph is richer than when everyone went home.

**This is what a butler does.** Not just tasks when asked — anticipatory
attention, owning things so you don't have to hold them in your head. The goal
isn't to talk to your AI more. It's to **prompt less and live more.**

---

## What's in this repo

This repository is the canonical home of **Alfred Black**. It ships two things
that share one engine:

| | What it is | Where |
|---|---|---|
| **`alfred-vault`** | The original pip-installable CLI. Turns *any* agentic runtime into an ambient butler over an Obsidian vault — four background workers (Curator · Janitor · Distiller · Surveyor) plus a Temporal workflow engine. Runs on a Mac Mini under your desk or any box with Python. | [`packages/alfred-vault/`](packages/alfred-vault/) · [`pip install alfred-vault`](https://pypi.org/project/alfred-vault/) |
| **Alfred Black** | The full self-hosted **platform**: a web dashboard, the Hermes AI runtime, durable workflows, multi-channel delivery, and finance / project / secrets sidecars — all brought up with a single `docker compose up` on one VM, served on your own domain over HTTPS. | this repo · *the rest of `packages/`* |

> **2026-05-20 — the big one.** The project that gave you the `alfred` CLI is
> now a complete, deployable platform. `alfred-vault` is the same dependable
> engine it always was — `pip install alfred-vault` still works exactly as
> before — and Alfred Black wraps it in everything you need to actually *live*
> with an agentic butler: a real UI, onboarding, a daily Brief, and a
> one-command self-hosted deploy. See [`CHANGELOG.md`](CHANGELOG.md).

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
multi-channel delivery, and the Plane / Sure / Vaultwarden sidecars — on a VM
you control: read on. You bring a fresh Linux VM and a domain; the stack brings
everything else and serves the web app on your domain over HTTPS. No Hetzner
auto-provisioning, no Tailscale, no Cloudflare, no billing — **one repo, one
VM, one `docker compose up`.**

The AI runtime is **Hermes Agent**
([`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)),
a single isolated runtime that replaces OpenClaw's two-container split.

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
  through your own Google client instead of Composio's managed flow. See
  *Onboarding* below.
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

`wasp build` produces the dashboard as two parts — a static React SPA and
its API server — served on `@` and `api.` respectively. Both A-records are
required; the SPA calls the API cross-subdomain.

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
- lets you **pick the Hermes models** from OpenRouter's live model catalogue
  (autocomplete search);
- if you opt into your own Google OAuth client, prints the exact **redirect
  URI** to register for your domain (skip it to use Composio-managed Gmail);
- generates every auto-secret with a cryptographically-secure
  `randomBytes(32)`;
- writes a complete `.env`.

The wizard **doubles as a config editor** — re-run `./scripts/setup.sh` any
time to change a value; it detects the existing `.env`, offers "edit existing
values" (pre-filling every prompt) vs "start fresh", and keeps secrets you
already have. At the end it offers to run `docker compose up -d` for you.

### Non-interactive install (CI / automation)

If you can't run an interactive terminal, the manual path still works:

```sh
# 1. Clone, 2. copy the template
cp .env.example .env

# 3. Edit .env — fill the required values in the "USER MUST FILL" block:
#      DOMAIN, ACME_EMAIL, OWNER_NAME, OPENROUTER_API_KEY, COMPOSIO_API_KEY
#    Optional: ANTHROPIC_API_KEY, MAILGUN_API_KEY + MAILGUN_DOMAIN (email),
#      GOOGLE_CLIENT_*, HERMES_MAIN_MODEL / HERMES_WORKERS_MODEL, VEXA_*
nano .env

# 4. Generate every auto-secret into .env (run once, before `up`)
./scripts/bootstrap.sh

# 5. Bring the whole stack up
docker compose up -d
```

`scripts/bootstrap.sh` validates that the required fields are filled and
appends every auto-generated secret (`AAS_API_KEY`, `COLUMN_ENCRYPTION_KEY`,
`JWT_SECRET`, the Hermes gateway token, Plane/Sure/Vexa datastore credentials,
the Vaultwarden admin token, …) using `openssl rand -hex 32`. It is
idempotent — re-running never overwrites an existing value — so every
variable exists by the time `docker compose` parses `.env`. Unlike the wizard
it does **not** verify keys against the provider APIs.

`docker compose up` only **pulls** images — it never builds. The first boot
runs database migrations, scaffolds the vault, and requests TLS certificates;
give it a few minutes. Check progress with `docker compose ps` and
`docker compose logs -f`.

When the stack is healthy, open `https://<your-domain>` and **sign up**. The
**first account created becomes the owner** with full administrative control;
any later signups are plain members.

> **Email:** the owner's account is auto-verified on signup, so you can log in
> immediately with no mail provider configured. Later members receive a
> verification email — that requires a real `MAILGUN_API_KEY` + `MAILGUN_DOMAIN`
> in `.env` (or switch the provider in `packages/web/main.wasp`). Without one,
> only the owner can log in.

### Onboarding

Onboarding is automatic and runs once, for the owner:

1. Sign up and log in — you land on `/desk`.
2. The desk shows a **"Start onboarding"** card. Click it.
3. You're sent to Google to **connect Gmail**. By default — whenever
   `COMPOSIO_API_KEY` is set (it is required anyway) — this goes through
   **Composio's managed Google OAuth**: no Google Cloud client of your own,
   no Google app-verification. The consent screen is **Composio-branded**
   (Composio's verified Google app) and requests **full Gmail access**
   (`https://mail.google.com/`) plus Google contacts/profile scopes.
4. On return, Alfred backfills ~100 days of email, builds a behavioural
   profile, extracts facts, and composes your first Brief — you watch the
   progress through the onboarding ritual (`/awaken → … → /first-brief`),
   pausing once to confirm the facts Alfred inferred.
5. When the first Brief lands you're dropped back on `/desk`, now live.

Later (non-owner) members skip onboarding — it is the owner's setup.

> **Using your own Google client instead.** If you set `GOOGLE_CLIENT_ID` /
> `GOOGLE_CLIENT_SECRET` in `.env`, onboarding's Gmail connect switches to a
> direct Google OAuth flow under *your* brand, requesting only the narrower
> read-only `gmail.readonly` scope. That path needs a Web-application OAuth
> client from console.cloud.google.com and Google's app-verification for the
> `gmail.readonly` scope. If `COMPOSIO_API_KEY` is set, the Composio-managed
> flow wins regardless.

### Choosing the LLM models

`HERMES_MAIN_MODEL` (user-facing chat) and `HERMES_WORKERS_MODEL` (background
agents) take **bare OpenRouter model IDs** (see `openrouter.ai/models`).
Defaults: `x-ai/grok-4.3` and `openai/gpt-4.1-nano`. To change one, edit
`.env` and run `docker compose up -d --force-recreate init hermes`.

**Switching provider.** Hermes itself supports many providers (OpenAI,
OpenAI Codex, Nous Portal, NovitaAI, NIM, a custom endpoint, …). To switch,
use Hermes' own command inside the container —
`docker compose exec hermes hermes model` (and `hermes auth add <provider>`
for OAuth providers) — then `docker compose restart hermes`. The `init`
container preserves a switched `model:` block across restarts, so the choice
persists. (Note: as of Hermes `v2026.5.16`, the `openai-codex` provider is
broken inside the agent loop — upstream issue #5736 — so a Codex
subscription does not yet work for Alfred; OpenRouter is the supported path.)

### Optional: the Vexa meeting-transcription stack

Vexa (meeting-bot transcription) ships behind a Compose profile so it is
off by default. To run it:

1. Set `VEXA_ENABLED=true` (and `ALFRED_OWNER_EMAIL`, `VEXA_TRANSCRIPTION_*`)
   in `.env`, then re-run `./scripts/bootstrap.sh`.
2. Start the stack **with the profile**:

   ```sh
   docker compose --profile vexa up -d
   ```

Without `--profile vexa`, the nine Vexa containers are simply not created.

### Restarting

`docker compose down && docker compose up -d` is safe: all data lives in
named Docker volumes and TLS certificates persist in `caddy_data`, so no
re-bootstrap is needed and Let's Encrypt is not re-hit.

---

## Building the images (maintainers only)

A fresh VM never builds anything — `docker compose` only **pulls**. The custom
`ssdavidai00/*` images are built and pushed by CI on every push to the default
branch (`.github/workflows/build-*.yml`, multi-arch `linux/amd64,linux/arm64`).
Note `alfred-setup` is the setup wizard — run by `./scripts/setup.sh`, never
started by `docker compose`:

| Image | Built from |
|-------|-----------|
| `alfred-web` | `wasp build` → the server half of `.wasp/build/` |
| `alfred-web-client` | the SPA half of `.wasp/build/web-app/`, served by nginx |
| `alfred-ctrl-api` | `packages/ctrl` (esbuild bundle + sqlite-vec) |
| `alfred-black-hermes` | `packages/hermes` (Hermes runtime + shim) |
| `alfred-worker` | `packages/hermes/dockerfiles/alfred.Dockerfile` (the vault daemon — bundles `packages/alfred-vault`) |
| `alfred-learn` | `packages/learn` (Temporal worker) |
| `alfred-mcp-server` | `packages/mcp-server` |
| `alfred-init` | `packages/hermes/init` (one-shot bootstrap — bundles `packages/alfred-vault`) |
| `alfred-setup` | `packages/setup` (the interactive setup wizard — run via `./scripts/setup.sh`, not a compose service) |

`wasp build` needs no database — schema migrations (`prisma migrate deploy`)
run inside the `web` container at startup against `web-db`. The `Makefile`
has `build-*` targets that mirror CI for local rebuilds.

The **`alfred-vault`** Python package has its own independent release train —
it publishes to PyPI on an `alfred-vault-vX.Y.Z` tag via
`.github/workflows/release-alfred-vault.yml`. Platform images and the PyPI
package are versioned separately (date-based releases for the platform, semver
for the package).

---

## Architecture

Three planes on one VM, behind a bundled Caddy reverse proxy with automatic
TLS. Every service talks over the Compose network by service DNS; only Caddy
binds host ports (`:80`/`:443`).

- **Web** (`packages/web`) — the Wasp dashboard. Auth + the UI; proxies all
  data calls to the local `ctrl-api`.
- **Control** (`packages/ctrl`) — the `ctrl-api` service on `:3100`; owns the
  vault and the operational SQLite store.
- **Data** — Hermes (AI runtime), Temporal, Ollama, the vault daemon
  (`packages/alfred-vault`, run as `alfred-worker`), `alfred-learn`, the MCP
  server, plus the Plane / Sure / Vaultwarden sidecars.

Four-store storage model:

- **Vault** (markdown) — the principal's published knowledge surface.
- **`state.db`** (SQLite + sqlite-vec) — the machine's working memory.
- **`cold.db`** (zstd-compressed SQLite) — forensic long tail; a daily
  compactor rolls `state.db` rows older than 90 days into it.
- **`ingest.db`** (SQLite) — raw inbound stream, 7-day TTL.

---

## License

[MIT](LICENSE).
</content>
