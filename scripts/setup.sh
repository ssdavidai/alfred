#!/usr/bin/env bash
#
# alfred-black — interactive setup.
#
# The documented one-command path. Shell-only on the host (no Node needed):
# pulls and runs the containerized setup wizard, which collects keys, validates
# them live, picks models, generates secrets, and writes .env.
#
#     git clone https://github.com/ssdavidai/alfred-black
#     cd alfred-black
#     ./scripts/setup.sh
#     docker compose up -d
#
# The wizard doubles as a config editor — re-run it any time to change values;
# it pre-fills each prompt with what is already in .env.
#
# Non-interactive alternative (CI / automation): cp .env.example .env, edit it,
# then ./scripts/bootstrap.sh.
#
# Exit codes: 0 success · 1 docker missing or the wizard failed.

set -euo pipefail

IMAGE="ssdavidai00/alfred-setup:latest"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n'  "$*"; }
dim()   { printf '\033[2m%s\033[0m\n'  "$*"; }

# ── locate the repo root (the dir holding .env.example + docker-compose) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ ! -f "${REPO_ROOT}/.env.example" || ! -f "${REPO_ROOT}/docker-compose.yaml" ]]; then
	red "ERROR: could not locate the alfred-black repo root."
	red "Expected .env.example and docker-compose.yaml beside ${SCRIPT_DIR}/.."
	exit 1
fi

# ── docker must be installed ──────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
	red "ERROR: docker is not installed."
	red ""
	red "Install Docker Engine + the Compose v2 plugin, then re-run this script:"
	red "  https://docs.docker.com/engine/install/"
	exit 1
fi

# ── pull the wizard image (warn-but-continue if a local copy exists) ──
bold "Pulling the setup wizard image (${IMAGE}) ..."
if ! docker pull "${IMAGE}"; then
	if docker image inspect "${IMAGE}" >/dev/null 2>&1; then
		red "WARN: pull failed — using the local copy of ${IMAGE}."
	else
		red "ERROR: could not pull ${IMAGE} and no local copy exists."
		red "Check your network, or build it with: make build-setup"
		exit 1
	fi
fi

# ── run the wizard, repo root bind-mounted at /work ───────────────────
bold ""
bold "Launching the setup wizard ..."
echo ""
docker run --rm -it -v "${REPO_ROOT}":/work "${IMAGE}"

# ── offer to bring the stack up ───────────────────────────────────────
if [[ -f "${REPO_ROOT}/.env" ]]; then
	echo ""
	green ".env is ready at ${REPO_ROOT}/.env"
	echo ""
	read -r -p "Bring the stack up now? [y/N] " REPLY
	case "${REPLY}" in
		[yY] | [yY][eE][sS])
			bold "Starting the stack ..."
			( cd "${REPO_ROOT}" && docker compose up -d )
			green "Done. Check progress with:  docker compose ps  /  docker compose logs -f"
			;;
		*)
			dim "Skipped. Bring it up later with:  docker compose up -d"
			;;
	esac
else
	red "No .env was written — the wizard was cancelled or failed."
	exit 1
fi
