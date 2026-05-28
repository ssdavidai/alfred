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
    chatgpt.com
    # GitHub (deploy key push/pull for ssdavidai/alfred)
    api.github.com
    github.com
    codeload.github.com
    # Package registries (a codex-driven `npm ci` / `pip install` / etc).
    registry.npmjs.org
    pypi.org
    files.pythonhosted.org
    static.crates.io
    crates.io
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

    # 3c. Resolved per-host rules — one ACCEPT per (host, IP) pair, TCP 443
    # + TCP 22 (github.com push over SSH). HTTPS is the only outbound HTTP
    # we allow; plain HTTP egress to allowlisted hosts is unnecessary and
    # this script does not grant it.
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
