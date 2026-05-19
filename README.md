# alfred-black

Single-VM, `docker compose up` deployment of Alfred Black — an agentic butler
for your calendar, email, finances, household logistics, and everything else
you currently keep in your head.

This is a standalone reframing of the `alfred-platform` SaaS fleet: **one repo,
one VM, one `docker compose up`** — no Acme Cloud auto-provisioning, no Tailscale,
no Cloudflare, no billing. You bring a fresh Linux VM and a domain; the stack
brings everything else and serves the web app on your domain over HTTPS.

The AI runtime is **Hermes Agent**
([`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)),
which replaces OpenClaw's two-container split with a single isolated runtime.

The full design lives in [`docs/PLAN.md`](docs/PLAN.md) (Parts A–I).

---

## Prerequisites

- **A Linux VM** you can SSH into with `sudo`/root. Any cloud (Acme Cloud, AWS,
  GCP, DigitalOcean, …) or bare metal works — `amd64` or `arm64`.
- **Docker Engine 24+** and the **Docker Compose v2** plugin (`docker compose`,
  not the legacy `docker-compose`).
- **A domain name** you control the DNS for. You will point **six** A-records
  at the VM (see below).
- **`git`** and **`openssl`** on the VM (`openssl` is used by the bootstrap
  script to generate secrets).
- **API keys**: `OPENROUTER_API_KEY` and `COMPOSIO_API_KEY` are required.
  `ANTHROPIC_API_KEY` is **optional** — Hermes routes LLM traffic through
  OpenRouter by default. Optionally: Google OAuth credentials, and a
  **Mailgun** API key + domain for transactional email (signup
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
git clone https://github.com/ssdavidai/alfred-black
cd alfred-black

# 2. Create your .env from the template
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
variable exists by the time `docker compose` parses `.env`.

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

### Choosing the LLM models

`HERMES_MAIN_MODEL` (user-facing chat) and `HERMES_WORKERS_MODEL` (background
agents) take **bare OpenRouter model IDs** (see `openrouter.ai/models`).
Defaults: `x-ai/grok-4.3` and `openai/gpt-4.1-nano`. To change one, edit
`.env` and run `docker compose up -d --force-recreate init hermes`.

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

A fresh VM never builds anything — `docker compose` only **pulls**. The eight
custom `ssdavidai00/*` images are built and pushed by CI on every push to
`main` (`.github/workflows/build-*.yml`, multi-arch `linux/amd64,linux/arm64`):

| Image | Built from |
|-------|-----------|
| `alfred-web` | `wasp build` → the server half of `.wasp/build/` |
| `alfred-web-client` | the SPA half of `.wasp/build/web-app/`, served by nginx |
| `alfred-ctrl-api` | `packages/ctrl` (esbuild bundle + sqlite-vec) |
| `alfred-black-hermes` | `packages/hermes` (Hermes runtime + shim) |
| `alfred-worker` | `packages/hermes/dockerfiles/alfred.Dockerfile` |
| `alfred-learn` | `packages/learn` (Temporal worker) |
| `alfred-mcp-server` | `packages/mcp-server` |
| `alfred-init` | `packages/hermes/init` (one-shot bootstrap) |

`wasp build` needs no database — schema migrations (`prisma migrate deploy`)
run inside the `web` container at startup against `web-db`. The `Makefile`
has `build-*` targets that mirror CI for local rebuilds. See
[`docs/PLAN.md`](docs/PLAN.md) Part G.

---

## Architecture

Three planes on one VM, behind a bundled Caddy reverse proxy with automatic
TLS. Every service talks over the Compose network by service DNS; only Caddy
binds host ports (`:80`/`:443`).

- **Web** (`packages/web`) — the Wasp dashboard. Auth + the UI; proxies all
  data calls to the local `ctrl-api`.
- **Control** (`packages/ctrl`) — the `ctrl-api` service on `:3100`; owns the
  vault and the operational SQLite store.
- **Data** — Hermes (AI runtime), Temporal, Ollama, the vault daemon,
  `alfred-learn`, the MCP server, plus the Plane / Sure / Vaultwarden sidecars.

Four-store storage model — see [`docs/PLAN.md`](docs/PLAN.md) Part I:

- **Vault** (markdown) — the principal's published knowledge surface.
- **`state.db`** (SQLite + sqlite-vec) — the machine's working memory.
- **`cold.db`** (zstd-compressed SQLite) — forensic long tail; a daily
  compactor rolls `state.db` rows older than 90 days into it.
- **`ingest.db`** (SQLite) — raw inbound stream, 7-day TTL.

See [`docs/PLAN.md`](docs/PLAN.md) for the complete plan (Parts A–I).
