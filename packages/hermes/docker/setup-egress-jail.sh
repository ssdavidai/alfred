#!/usr/bin/env bash
# =============================================================================
# setup-egress-jail.sh — iptables egress allowlist for the codex-builder
# Hermes profile (uid 10001).
#
# Run at supervisor boot ONLY when ENABLE_CODEX_BUILDER=1. Installs OUTPUT
# rules scoped to uid 10001 that allow:
#   * loopback (127.0.0.0/8) — Hermes' own intra-process IPC
#   * compose-network reach to the container's own IP (so the gateway can
#     bind 0.0.0.0:18793 and answer health-checks from inside)
#   * DNS (UDP/TCP 53) — codex CLI + git resolve names
#   * api.openai.com / chatgpt.com — the codex CLI's only LLM provider
#   * github.com / api.github.com / codeload.github.com (TCP 22 + 443) —
#     git clone + push for the alfred repo
#   * registry.npmjs.org, pypi.org / files.pythonhosted.org, static.crates.io —
#     codex's own test runs may need a `pip install` / `npm ci` / `cargo build`
#   * <extra hosts read from /hermes-state/profiles/codex-builder/network-
#     allowlist.txt>, one host per line, '#' comments — operator override
# REJECT everything else for uid 10001.
#
# Uid 10000 (main/workers/heavy gateways) is UNTOUCHED — their egress is
# fully open today and this script does NOT change that.
#
# Idempotent: the codex-builder OUTPUT rules are tagged with a `CODEX_BUILDER`
# iptables comment; on re-run we delete every rule with that comment first
# and re-install. Safe to call from a supervisor restart loop.
#
# This script REQUIRES NET_ADMIN. PR 2 #101 added cap_add: NET_ADMIN to the
# hermes service. Without it, `iptables` exits 4 ("Permission denied") and
# this script bails non-zero.
#
# Sir 2026-05-28 — PR 4 of docs/codex-builder-runtime.md.
# =============================================================================
set -uo pipefail

CODEX_UID="${CODEX_BUILDER_UID:-10001}"
ALLOWLIST_FILE="${CODEX_NETWORK_ALLOWLIST_FILE:-/hermes-state/profiles/codex-builder/network-allowlist.txt}"
COMMENT_TAG="CODEX_BUILDER"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [egress-jail] $*"; }

# Verify NET_ADMIN actually works. If not, the rest of this script is a no-op
# wearing a costume; surface the failure so a future operator can spot it.
if ! iptables -L OUTPUT -n >/dev/null 2>&1; then
    log "FATAL: iptables OUTPUT chain unreachable — NET_ADMIN missing on container?"
    log "       (re-check docker-compose.yaml hermes service cap_add: NET_ADMIN)"
    exit 4
fi

# --- 1. Clean old codex-builder rules (idempotency) --------------------------
# `iptables -S OUTPUT` lists current rules; grep for our tag; convert each
# `-A` line into a `-D` and feed it back to iptables.
clean_old_rules() {
    local stale
    stale=$(iptables -S OUTPUT 2>/dev/null | grep -F -- "--comment ${COMMENT_TAG}" || true)
    if [[ -z "$stale" ]]; then
        return 0
    fi
    log "removing $(echo "$stale" | wc -l) stale ${COMMENT_TAG} rule(s) before re-install"
    while read -r line; do
        # Convert e.g. "-A OUTPUT -m owner --uid-owner 10001 -j REJECT ..."
        # to "-D OUTPUT -m owner --uid-owner 10001 -j REJECT ...".
        local del
        del="${line/-A /-D }"
        # shellcheck disable=SC2086
        iptables $del 2>/dev/null || log "  warn: failed to delete: $line"
    done <<< "$stale"
}

# --- 2. Resolve allowlist hosts to CIDRs -------------------------------------
# `dig +short A <host>` for IPv4. We pin to A records only — IPv6 outbound is
# rejected by the default-deny REJECT rule at the bottom (no INPUT-OUTPUT pair
# for ::), so a host with only AAAA records would be unreachable. This is
# acceptable because every host on the allowlist publishes an A record.
resolve_host() {
    local host="$1"
    dig +short +time=3 +tries=1 A "$host" 2>/dev/null | grep -E '^[0-9.]+$' || true
}

# Built-in allowlist hosts. Operators can extend via network-allowlist.txt
# without rebuilding the image.
BUILTIN_HOSTS=(
    # OpenAI (codex CLI's only LLM provider)
    api.openai.com
    auth.openai.com         # device-auth flow (codex login --device-auth)
    platform.openai.com     # codex login follow-up
    chatgpt.com
    # Package registries (a codex-driven `npm ci` / `pip install` / etc).
    registry.npmjs.org
    pypi.org
    files.pythonhosted.org
    static.crates.io
    crates.io
)

# GitHub's published CIDR ranges for git push/pull. GitHub uses anycast and
# rotates the per-host A record IPs across a CDN footprint; a `dig +short A
# github.com` at boot returns only one snapshot, and a clone two minutes
# later may resolve to a DIFFERENT IP outside the rule (live-observed on
# home 2026-05-28). We fetch the canonical CIDR set from
# https://api.github.com/meta (the `git` array) once at boot and add CIDR
# ACCEPT rules for the whole range. Falls back to a hardcoded set the
# upstream API documents publicly (192.30.252.0/22, 185.199.108.0/22,
# 140.82.112.0/20, 143.55.64.0/20) when /meta is unreachable.
GITHUB_META_FALLBACK_CIDRS=(
    192.30.252.0/22
    185.199.108.0/22
    140.82.112.0/20
    143.55.64.0/20
)

EXTRA_HOSTS=()
if [[ -f "$ALLOWLIST_FILE" ]]; then
    while read -r raw; do
        # Strip comments + whitespace; skip empty lines.
        trimmed="${raw%%#*}"
        trimmed="${trimmed#"${trimmed%%[![:space:]]*}"}"
        trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
        [[ -n "$trimmed" ]] && EXTRA_HOSTS+=("$trimmed")
    done < "$ALLOWLIST_FILE"
fi

# Fetch GitHub's published `git` CIDR ranges. Returns the array on stdout
# (newline-separated). Falls back to GITHUB_META_FALLBACK_CIDRS when /meta
# is unreachable (network blip during the supervisor's first boot — the
# fallback list is good enough to clone + push). Anonymous /meta calls are
# rate-limited (60/hour per IP), but we only hit it once per supervisor
# boot per tenant, so the per-tenant budget is fine.
fetch_github_cidrs() {
    local body
    body=$(curl -fsS --max-time 5 https://api.github.com/meta 2>/dev/null || true)
    if [[ -n "$body" ]]; then
        # Try to extract the `git` array as one IP per line. Light Python
        # is in every Hermes image so we don't need to add jq.
        python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    for c in d.get("git", []):
        if ":" not in c:  # skip IPv6 — our rules are IPv4-only today
            print(c)
except Exception:
    pass
' <<< "$body" || true
    fi
}

# --- 3. Install rules --------------------------------------------------------
install_rules() {
    # 3a. Loopback always allowed (Hermes internal IPC, the gateway's own
    # /v1 listener answering /health from inside the same container).
    iptables -A OUTPUT -m owner --uid-owner "${CODEX_UID}" \
        -d 127.0.0.0/8 -j ACCEPT \
        -m comment --comment "${COMMENT_TAG}"

    # 3b. DNS — outbound to whatever resolver(s) the container is configured
    # with. We allow ANY destination on UDP/53 + TCP/53 for uid 10001 so a
    # later resolv.conf change doesn't break codex/git/npm.
    iptables -A OUTPUT -m owner --uid-owner "${CODEX_UID}" \
        -p udp --dport 53 -j ACCEPT \
        -m comment --comment "${COMMENT_TAG}"
    iptables -A OUTPUT -m owner --uid-owner "${CODEX_UID}" \
        -p tcp --dport 53 -j ACCEPT \
        -m comment --comment "${COMMENT_TAG}"

    # 3b'. GitHub `git` CIDR ranges (TCP 443 for HTTPS, TCP 22 for SSH).
    # github.com / api.github.com / codeload.github.com all sit inside
    # these CIDRs per the upstream meta API. CIDRs (not /32s) so a fresh
    # IP at clone-time still hits an ACCEPT.
    local github_cidrs
    mapfile -t github_cidrs < <(fetch_github_cidrs)
    if [[ ${#github_cidrs[@]} -eq 0 ]]; then
        log "  warn: github.com /meta unreachable — using hardcoded fallback CIDRs"
        github_cidrs=("${GITHUB_META_FALLBACK_CIDRS[@]}")
    fi
    local github_count=0
    for cidr in "${github_cidrs[@]}"; do
        iptables -A OUTPUT -m owner --uid-owner "${CODEX_UID}" \
            -p tcp -d "$cidr" --dport 443 -j ACCEPT \
            -m comment --comment "${COMMENT_TAG}"
        iptables -A OUTPUT -m owner --uid-owner "${CODEX_UID}" \
            -p tcp -d "$cidr" --dport 22 -j ACCEPT \
            -m comment --comment "${COMMENT_TAG}"
        github_count=$((github_count + 1))
    done
    log "  github: ${github_count} CIDR(s) → 443 + 22"

    # 3c. Resolved per-host rules — one ACCEPT per (host, IP) pair, TCP 443
    # + TCP 22. HTTPS is the only outbound HTTP we allow; plain HTTP egress
    # to allowlisted hosts is unnecessary and this script does not grant it.
    local accepted_count=0
    local resolved_count=0
    for host in "${BUILTIN_HOSTS[@]}" "${EXTRA_HOSTS[@]}"; do
        local ips
        ips=$(resolve_host "$host")
        if [[ -z "$ips" ]]; then
            log "  warn: DNS resolved no A records for $host (skipping)"
            continue
        fi
        resolved_count=$((resolved_count + 1))
        for ip in $ips; do
            # TCP 443 — HTTPS
            iptables -A OUTPUT -m owner --uid-owner "${CODEX_UID}" \
                -p tcp -d "${ip}/32" --dport 443 -j ACCEPT \
                -m comment --comment "${COMMENT_TAG}"
            accepted_count=$((accepted_count + 1))
            # TCP 22 — git push over SSH (github.com, gitlab.com if added)
            iptables -A OUTPUT -m owner --uid-owner "${CODEX_UID}" \
                -p tcp -d "${ip}/32" --dport 22 -j ACCEPT \
                -m comment --comment "${COMMENT_TAG}"
            accepted_count=$((accepted_count + 1))
        done
    done

    # 3d. Default DENY for uid 10001 — REJECT with icmp-net-prohibited so
    # the codex CLI sees a clean "Network is unreachable" rather than a
    # silent timeout (better operator signal in the run audit log).
    iptables -A OUTPUT -m owner --uid-owner "${CODEX_UID}" \
        -j REJECT --reject-with icmp-net-prohibited \
        -m comment --comment "${COMMENT_TAG}"

    log "installed ${accepted_count} ACCEPT rules covering ${resolved_count} host(s) + 1 REJECT default"
    log "  builtin hosts:   ${BUILTIN_HOSTS[*]}"
    [[ ${#EXTRA_HOSTS[@]} -gt 0 ]] && log "  extra hosts:     ${EXTRA_HOSTS[*]}"
}

# --- main --------------------------------------------------------------------
log "uid=${CODEX_UID} allowlist=${ALLOWLIST_FILE}"
clean_old_rules
install_rules
log "done"
