# alfred-platform

Monorepo for Alfred Black's private infrastructure. Four packages, independent build systems, path-filtered CI.

## Packages

| Package | Stack | Purpose |
|---------|-------|---------|
| [packages/saas](packages/saas) | TypeScript/Wasp | SaaS app, billing, dashboard, tenant proxy |
| [packages/ctrl](packages/ctrl) | Node.js (zero deps) | Tenant API + Hetzner provisioning TUI/CLI |
| [packages/learn](packages/learn) | Python/Temporal | Intelligence layer, 7 workflows |
| [packages/openclaw](packages/openclaw) | Docker Compose | Tenant stack deploy, Docker image builds |

## Other directories

- `deploy/` — SaaS host infrastructure (Caddyfile, docker-compose, cloud-init, systemd)

## Related repos

- [`alfred`](https://github.com/ssdavidai/alfred) (public) — Core Python vault workers, PyPI `alfred-vault`

## Build

```bash
make build-ctrl       # Build ctrl package
make build-saas       # Build SaaS Wasp app
make test-learn       # Run learn tests
make build-learn      # Build learn Docker image
make build-openclaw   # Build openclaw Docker image
```
