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

# Strip leading + trailing whitespace from a value. Used so a "present but
# blank" field — e.g. `DOMAIN= ` with a stray space, which `[[ -z ]]` alone
# treats as set — is caught as empty and regenerated rather than passing
# validation and leaking the space into the container env.
trim() {
	local s="$1"
	s="${s#"${s%%[![:space:]]*}"}"   # leading
	s="${s%"${s##*[![:space:]]}"}"   # trailing
	printf '%s' "${s}"
}

# Self-check: trim() must reduce a whitespace-only string to empty. A broken
# trim would silently re-enable the blank-field bug, so fail loud at boot.
if [[ -n "$(trim "   ")" || "$(trim "  x  ")" != "x" ]]; then
	red "ERROR: bootstrap trim() self-check failed — refusing to validate."
	exit 1
fi

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
	value="$(trim "$(env_get "${key}")")"
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

# ── 1.5 ensure swap ────────────────────────────────────────
# Container mem_limits sum to tens of GB; a swapfile is a cheap cushion so a
# transient spike past a cgroup cap (e.g. the hermes workers gateway on a
# multi-minute LLM job) becomes a slowdown, not an instant OOM-kill.
# Idempotent; needs root; skipped with a warning otherwise. Override size
# with SWAP_SIZE_GB.
SWAP_SIZE_GB="${SWAP_SIZE_GB:-8}"
if swapon --show 2>/dev/null | grep -q .; then
	green "Swap already active — skipping swapfile creation."
elif [[ "$(id -u)" -ne 0 ]]; then
	red "WARNING: not root — cannot create swap. Add ${SWAP_SIZE_GB}G manually or re-run as root."
else
	green "Creating ${SWAP_SIZE_GB}G swapfile at /swapfile…"
	if dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_SIZE_GB*1024)) status=none 2>/dev/null; then
		chmod 600 /swapfile
		mkswap /swapfile >/dev/null
		swapon /swapfile
		grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
		green "Swap enabled (${SWAP_SIZE_GB}G) + persisted in /etc/fstab."
	else
		red "WARNING: swapfile creation failed — continuing without swap."
	fi
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
	SURE_SECRET_KEY_BASE
	SURE_POSTGRES_PASSWORD
	SURE_REDIS_PASSWORD
	SURE_API_KEY
	PAPERCLIP_BETTER_AUTH_SECRET
	PAPERCLIP_HEARTBEAT_SECRET
	VOICE_BRIDGE_INTERNAL_TOKEN
	# PAPERCLIP_API_KEY is NOT auto-generated — Paperclip's better-auth
	# issues API keys through its own UI flow (signup → settings → keys),
	# and the value must be one Paperclip itself recognises. Leave the
	# key blank in .env; after first signup at https://paperclip.<DOMAIN>,
	# generate a key in Paperclip's UI and paste it into /opt/alfred/.env.
	# Hermes' MCP server will return NOT_CONFIGURED-style errors until the
	# value is real; that's the right loud-failure mode.
)

# Ensure the file ends with a newline before we append.
if [[ -n "$(tail -c1 "${ENV_FILE}" 2>/dev/null)" ]]; then
	printf '\n' >> "${ENV_FILE}"
fi

bold "Generating auto-secrets ..."
GENERATED=0
KEPT=0
for key in "${AUTO_SECRETS[@]}"; do
	# An existing non-blank `KEY=value` line means "already set" — skip.
	# Trim first so a whitespace-only secret is regenerated, not kept.
	existing="$(trim "$(env_get "${key}")")"
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
existing_uid="$(trim "$(env_get COMPOSIO_USER_ID)")"
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

# ── TRUST_PROXY_HOPS ────────────────────────────────────────────────
# Not a secret — the number of reverse proxies in front of mcp-server, used
# to pick the right client IP out of X-Forwarded-For. mcp-server REFUSES TO
# START in production without it (`TRUST_PROXY_HOPS must be set in
# production`), so an unset value is not a soft default: it is a crash loop
# on a fresh deploy. Found 2026-08-17 on a tenant that had never been through
# this script. The stack puts exactly one proxy in front — Caddy — so 1 is
# correct for every standard deploy; raise it only if you front Caddy with
# another proxy or a CDN that appends its own hop.
existing_hops="$(trim "$(env_get TRUST_PROXY_HOPS)")"
if [[ -z "${existing_hops}" ]]; then
	if grep -qE "^#?TRUST_PROXY_HOPS=" "${ENV_FILE}" 2>/dev/null; then
		tmp="$(mktemp)"
		awk '$0 ~ "^#?TRUST_PROXY_HOPS=" && !d { print "TRUST_PROXY_HOPS=1"; d=1; next } { print }' "${ENV_FILE}" > "${tmp}"
		mv "${tmp}" "${ENV_FILE}"
	else
		printf 'TRUST_PROXY_HOPS=1\n' >> "${ENV_FILE}"
	fi
	green "Set TRUST_PROXY_HOPS=1 (one proxy in front: Caddy)."
fi

# ── 4. TAILSCALE_HOSTNAME_PREFIX (issue #109 PR 1) ──────────────────
# The Tailscale sidecar runs only with `--profile tailscale` and is OFF on
# every fresh tenant; the principal opts in via the /connections card. We
# still derive the tailnet hostname here, though: compose's variable
# interpolation does not support Bash-style `${VAR//./-}`, so the dotted
# DOMAIN has to be transformed in shell. Writing the result to .env keeps
# the value visible + predictable across `docker compose pull` and makes
# the tailnet device name an operator-tunable knob (override by editing).
# TAILSCALE_AUTHKEY is intentionally NOT auto-generated — it is either
# pasted by the principal (path A) or unused (path C: device-auth URL).
existing_prefix="$(trim "$(env_get TAILSCALE_HOSTNAME_PREFIX)")"
if [[ -z "${existing_prefix}" ]]; then
	domain_value="$(trim "$(env_get DOMAIN)")"
	if [[ -n "${domain_value}" ]]; then
		prefix="${domain_value//./-}"
		if grep -qE "^#?TAILSCALE_HOSTNAME_PREFIX=" "${ENV_FILE}" 2>/dev/null; then
			tmp="$(mktemp)"
			awk -v v="${prefix}" '
				$0 ~ "^#?TAILSCALE_HOSTNAME_PREFIX=" && !d { print "TAILSCALE_HOSTNAME_PREFIX=" v; d=1; next }
				{ print }
			' "${ENV_FILE}" > "${tmp}"
			mv "${tmp}" "${ENV_FILE}"
		else
			printf 'TAILSCALE_HOSTNAME_PREFIX=%s\n' "${prefix}" >> "${ENV_FILE}"
		fi
		green "Derived TAILSCALE_HOSTNAME_PREFIX=${prefix} from DOMAIN."
	fi
fi

# ── host watchdog cron ───────────────────────────────────────────────────────
# Installs scripts/ops/alfred-watchdog.sh on a 5-minute cron. It records
# pids.current vs live threads per container (the number that diagnoses a PID
# exhaustion) and restarts containers Docker has flagged unhealthy.
#
# Why: on 2026-08-17 ctrl-api filled its 1024-PID budget with unreaped
# healthcheck zombies. Docker flagged it `unhealthy` for 2.5 days and did
# nothing, while vault WRITES silently degraded (writes fork a helper; reads do
# not) — ~50/day down to 20-30 with no error anywhere the principal could see.
# `init: true` now prevents the zombies; this catches the next one of whatever
# shape it takes.
WATCHDOG_SRC="${SCRIPT_DIR}/ops/alfred-watchdog.sh"
if [[ -f "${WATCHDOG_SRC}" ]]; then
	install -m 0755 "${WATCHDOG_SRC}" /usr/local/bin/alfred-watchdog 2>/dev/null || true
	if command -v crontab >/dev/null 2>&1; then
		# Idempotent: drop any previous line, re-add exactly one.
		if { crontab -l 2>/dev/null | grep -v 'alfred-watchdog' || true; \
		     echo '*/5 * * * * /usr/local/bin/alfred-watchdog >/dev/null 2>&1'; } \
		     | crontab - 2>/dev/null; then
			green "Installed alfred-watchdog cron (every 5 min)."
		else
			red "Could not install alfred-watchdog cron — add it by hand."
		fi
	fi
fi

bold ""
green "Bootstrap complete. Next:  docker compose up -d"
green "(Tailscale is opt-in:      docker compose --profile tailscale up -d tailscale"
green "                            — set TAILSCALE_ENABLED=true first; PR 3 will"
green "                              wire the /connections card.)"
