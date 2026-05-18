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
- **A domain name** you control the DNS for. You will point five A-records at
  the VM (see below).
- **`git`** and **`openssl`** on the VM (`openssl` is used by the bootstrap
  script to generate secrets).
- **API keys** for Anthropic, OpenRouter, and Composio. Optionally Google
  OAuth credentials and a SendGrid key (for transactional email).

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
| `@`     | `example.com`       | the Alfred Black web app          |
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
git clone https://github.com/ssdavidai/alfred-black
cd alfred-black

# 2. Create your .env from the template
cp .env.example .env

# 3. Edit .env — fill every value in the "USER MUST FILL" block:
#      DOMAIN, ACME_EMAIL, OWNER_NAME,
#      ANTHROPIC_API_KEY, OPENROUTER_API_KEY, COMPOSIO_API_KEY
#    (GOOGLE_CLIENT_*, SENDGRID_API_KEY, VEXA_* are optional)
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

## Building the `alfred-web` image (maintainers only)

A fresh VM never builds the web app — `docker compose` pulls the pre-built
`ssdavidai00/alfred-web` image. The image is built in CI from `packages/web`:

```sh
cd packages/web
wasp build                              # → packages/web/.wasp/build/
docker build -t ssdavidai00/alfred-web .wasp/build/
docker push ssdavidai00/alfred-web
```

Notes:

- **`wasp build` needs no database.** It only compiles the Wasp app into a
  plain Node + React project under `.wasp/build/`. Schema migrations
  (`prisma migrate deploy`) run automatically inside the `web` **container**
  at startup, against the `web-db` Postgres service — not at build time.
- Build the image **multi-arch** (`linux/amd64,linux/arm64`) via `docker
  buildx` so a fresh VM works on both Intel/AMD and ARM hosts.

The same applies to the other custom images (`alfred-ctrl-api`,
`alfred-black-hermes`, `alfred-learn`, `alfred-mcp-server`, `alfred-init`,
`alfred-vault-init`); see [`docs/PLAN.md`](docs/PLAN.md) Part G.

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
- **Cold archive** (DuckDB/Parquet) — forensic long tail.
- **`ingest.db`** (SQLite) — raw inbound stream, 7-day TTL.

See [`docs/PLAN.md`](docs/PLAN.md) for the complete plan (Parts A–I).
