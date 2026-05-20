# CI secrets & publishing setup

What a maintainer must configure in **Settings → Secrets and variables →
Actions** (and **Settings → Environments**) for the GitHub Actions workflows in
this repo to work. Nothing here is required just to *use* Alfred — only to
build/publish from CI.

## Repository Actions secrets

| Secret | Used by | Purpose |
|--------|---------|---------|
| `DOCKERHUB_USERNAME` | every `build-*.yml` | Docker Hub login to push the `ssdavidai00/*` images. |
| `DOCKERHUB_TOKEN` | every `build-*.yml` | Docker Hub access token (not the password) paired with the username. |

`GITHUB_TOKEN` is provided automatically by Actions — no setup needed.

## PyPI publishing — no secret (Trusted Publishing / OIDC)

`release-alfred-vault.yml` publishes the `alfred-vault` package with PyPI
**Trusted Publishing**, so there is **no API token to store**. One-time setup:

1. Create two GitHub **Environments** (Settings → Environments): `pypi` and
   `testpypi`. (Optionally add required reviewers to `pypi` for a manual
   release gate.)
2. On **PyPI** (pypi.org) → project `alfred-vault` → *Publishing* → add a
   trusted publisher:
   - Owner: `ssdavidai` · Repository: `alfred`
   - Workflow: `release-alfred-vault.yml` · Environment: `pypi`
3. Repeat on **TestPyPI** (test.pypi.org) with Environment: `testpypi` (used by
   the manual `workflow_dispatch` → `testpypi` dry-run path).

The package version in `packages/alfred-vault/pyproject.toml` must match the
release tag `alfred-vault-vX.Y.Z`.

## Secret scanning — no secret

`gitleaks.yml` needs no secret for this personal public repo. A free
`GITLEAKS_LICENSE` is only required if the repo is moved under a GitHub
Organization.
