# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the `alfred-vault` package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2026-05-20] — the platform release

The project that gave you the `alfred` CLI is now a complete, deployable
platform. Alfred Black wraps the same dependable vault engine in everything you
need to actually live with an agentic butler — a real UI, onboarding, a daily
Brief, and a one-command self-hosted deploy.

### Added — the Alfred Black platform

The project now ships a complete self-hosted platform alongside the CLI:

- A one-VM `docker compose up` deploy — bring a fresh Linux VM and a domain;
  the stack brings everything else and serves the web app over HTTPS.
- A web dashboard for working with the vault.
- The **Hermes** AI runtime — a single isolated runtime that replaces the prior
  OpenClaw two-container split.
- A bundled **Caddy** reverse proxy with automatic per-host TLS (Let's Encrypt
  HTTP-01) — no DNS API token required.
- A four-store storage model: vault markdown (the published knowledge surface),
  `state.db` (the machine's working memory), `cold.db` (forensic long tail,
  >90 days), and `ingest.db` (raw inbound stream, 7-day TTL).
- The **Plane** (project management), **Sure** (personal finance), and
  **Vaultwarden** (secrets manager) sidecars.
- An optional **Vexa** meeting-transcription profile, off by default and started
  with `docker compose --profile vexa up -d`.

### Added — onboarding + daily Brief

- An automatic owner onboarding ritual that runs once: connect Gmail, backfill
  recent email, build a behavioural profile, and confirm the inferred facts.
- A daily **Brief** surface, composed for the owner as the final onboarding step
  and on an ongoing basis thereafter.

### Changed — `alfred-vault` 0.3.2 → 0.4.0

- The pip-installable CLI moved into this monorepo at `packages/alfred-vault/`.
- This is the engine the platform is built on — the platform's vault daemon runs
  the same `alfred-vault` package.

### Continuity — migrating from `alfred-vault`

If you only want the CLI, nothing changes. `pip install alfred-vault` and the
`alfred` console command work exactly as before — full backward compatibility.

- To get just the CLI, keep using `pip install alfred-vault`.
- The CLI now lives at `packages/alfred-vault/` in this repo for source installs.

### Versioning

The `alfred-vault` package and the platform version independently: the package
uses SemVer and publishes to PyPI on `alfred-vault-vX.Y.Z` tags, while the
platform uses date-based releases.

---

Earlier `alfred-vault` history: see the git log and PyPI release history.
