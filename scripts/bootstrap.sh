#!/usr/bin/env bash
#
# alfred-black — bootstrap.
#
# Run ONCE, after filling the "USER MUST FILL" block in .env, and before
# `docker compose up -d`:
#
#     cp .env.example .env      # then edit .env
#     ./scripts/bootstrap.sh
#     docker compose up -d
#
# What it does:
#   1. Validates that every required field in .env is non-empty — fails loud
#      with a clear message naming each missing field.
#   2. Generates every auto-secret with `openssl rand -hex 32` and appends it
#      to .env. Idempotent: an existing non-empty value is never overwritten,
#      so re-running is safe.
#
# Exit codes: 0 success · 1 a required field is missing or .env is absent.

set -euo pipefail

# ── locate the repo root + .env ─────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n'  "$*"; }

if [[ ! -f "${ENV_FILE}" ]]; then
	red "ERROR: ${ENV_FILE} not found."
	red "Copy the template first:  cp .env.example .env"
	exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
	red "ERROR: openssl is required but not installed."
	exit 1
fi

# ── helpers ─────────────────────────────────────────────────────────

# Read a KEY=VALUE from .env. Returns the value (may be empty) on stdout.
env_get() {
	local key="$1"
	# Last assignment wins; strip the KEY= prefix; tolerate no match.
	grep -E "^${key}=" "${ENV_FILE}" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

# ── 1. validate required fields ─────────────────────────────────────
REQUIRED=(
	DOMAIN
	ACME_EMAIL
	OWNER_NAME
	OPENROUTER_API_KEY
	COMPOSIO_API_KEY
)
# ANTHROPIC_API_KEY is optional — Hermes routes LLM traffic through
# OpenRouter by default; set it only if you want a direct Anthropic route.

bold "Validating required fields in .env ..."
MISSING=()
for key in "${REQUIRED[@]}"; do
	value="$(env_get "${key}")"
	if [[ -z "${value}" ]]; then
		MISSING+=("${key}")
	fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
	red "ERROR: the following required field(s) in .env are empty:"
	for key in "${MISSING[@]}"; do
		red "  - ${key}"
	done
	red ""
	red "Fill them in ${ENV_FILE} (see the 'USER MUST FILL' block), then re-run."
	exit 1
fi
green "All required fields present."

# ── 1b. recommended fields (warn, don't fail) ───────────────────────
# OWNER_EMAIL is the canonical owner-identity var the code reads (pull.py,
# first_brief_email.py, fleet_audit.py, init step 9, sure-bootstrap.rb;
# compose also mirrors it into ALFRED_OWNER_EMAIL for transcript.py). It is
# not strictly required to boot, but leaving it blank fails the first-brief
# email open and disables the cross-tenant ingest guard — so warn loudly.
if [[ -z "$(env_get OWNER_EMAIL | tr -d '[:space:]')" ]]; then
	red "WARNING: OWNER_EMAIL is empty in ${ENV_FILE}."
	red "  The first-brief email won't send and the cross-tenant ingest guard"
	red "  fails open. Set OWNER_EMAIL to the principal's address, then re-run."
fi

# ── 2. generate auto-secrets ────────────────────────────────────────
# Each entry is generated with `openssl rand -hex 32` if absent or empty.
AUTO_SECRETS=(
	AAS_API_KEY
	COLUMN_ENCRYPTION_KEY
	JWT_SECRET
	HERMES_API_SERVER_KEY
	WEB_DATABASE_PASSWORD
	VAULTWARDEN_ADMIN_TOKEN
	VAULTWARDEN_BW_PASSWORD
	MCP_APPROVAL_SECRET
	DJANGO_SECRET_KEY
	POSTGRES_PASSWORD
	REDIS_PASSWORD
	MINIO_ROOT_PASSWORD
	LIVE_SERVER_SECRET_KEY
	SURE_SECRET_KEY_BASE
	SURE_POSTGRES_PASSWORD
	SURE_REDIS_PASSWORD
	VEXA_POSTGRES_PASSWORD
	VEXA_MINIO_PASSWORD
	VEXA_ADMIN_API_TOKEN
	VEXA_INTERNAL_API_SECRET
)

# Ensure the file ends with a newline before we append.
if [[ -n "$(tail -c1 "${ENV_FILE}" 2>/dev/null)" ]]; then
	printf '\n' >> "${ENV_FILE}"
fi

bold "Generating auto-secrets ..."
GENERATED=0
KEPT=0
for key in "${AUTO_SECRETS[@]}"; do
	# An existing non-empty `KEY=value` line means "already set" — skip.
	existing="$(env_get "${key}")"
	if [[ -n "${existing}" ]]; then
		KEPT=$((KEPT + 1))
		continue
	fi

	secret="$(openssl rand -hex 32)"

	# If a commented or empty placeholder line exists, replace it in place;
	# otherwise append a fresh line. Keeps .env tidy and re-run-stable.
	if grep -qE "^#?${key}=" "${ENV_FILE}" 2>/dev/null; then
		tmp="$(mktemp)"
		# Use a sentinel so sed never trips on / or & inside the secret.
		awk -v k="${key}" -v v="${secret}" '
			$0 ~ "^#?" k "=" && !done { print k "=" v; done=1; next }
			{ print }
		' "${ENV_FILE}" > "${tmp}"
		mv "${tmp}" "${ENV_FILE}"
	else
		printf '%s=%s\n' "${key}" "${secret}" >> "${ENV_FILE}"
	fi
	GENERATED=$((GENERATED + 1))
done

# ── 3. COMPOSIO_USER_ID ─────────────────────────────────────────────
# A stable per-deploy identifier that scopes THIS install's Composio
# connected accounts (managed OAuth). Not a random secret — it takes a
# readable `alfred-owner-<rand>` form. It must never be empty or "default":
# ctrl-api rejects the onboarding "connect Gmail" flow without it, and a
# shared "default" would let separate installs collide on one Composio
# account. init mirrors it to /alfred-data/.composio-user-id for the worker.
existing_uid="$(env_get COMPOSIO_USER_ID)"
if [[ -z "${existing_uid}" || "${existing_uid}" == "default" ]]; then
	uid="alfred-owner-$(openssl rand -hex 4)"
	if grep -qE "^#?COMPOSIO_USER_ID=" "${ENV_FILE}" 2>/dev/null; then
		tmp="$(mktemp)"
		awk -v v="${uid}" '$0 ~ "^#?COMPOSIO_USER_ID=" && !d { print "COMPOSIO_USER_ID=" v; d=1; next } { print }' "${ENV_FILE}" > "${tmp}"
		mv "${tmp}" "${ENV_FILE}"
	else
		printf 'COMPOSIO_USER_ID=%s\n' "${uid}" >> "${ENV_FILE}"
	fi
	GENERATED=$((GENERATED + 1))
	green "Generated COMPOSIO_USER_ID=${uid}"
fi

green "Auto-secrets: ${GENERATED} generated, ${KEPT} kept (already set)."
bold ""
green "Bootstrap complete. Next:  docker compose up -d"
green "(Vexa is opt-in:           docker compose --profile vexa up -d)"
