#!/usr/bin/env bash
# Read-only drift check, run ON a tenant via `ssh <host> 'bash -s' < this`.
#
# Exits 0 and prints CLEAN when the tenant matches what the registry serves
# and everything is running. Exits 1 and prints one line per problem
# otherwise. Makes no changes: no pull, no up -d, no writes.
set -uo pipefail
drift=0

# 1. Services that are not running. Catches the missing-env-key crash loops
#    that bit two tenants on 2026-08-17 (mcp-server without TRUST_PROXY_HOPS,
#    voice-bridge without VOICE_BRIDGE_INTERNAL_TOKEN).
bad=$(docker compose -p alfred-black ps --format '{{.Service}} {{.State}}' 2>/dev/null \
      | grep -v ' running' | awk '{print $1}' | tr '\n' ' ')
if [ -n "$bad" ]; then echo "NOT RUNNING: $bad"; drift=1; fi

# 2. Containers in a restart loop. A healthy container sits near 0; the
#    hermes dashboard loop reached 5,747 over ten days without anyone
#    noticing. 20 is comfortably clear of a legitimate flap.
loops=$(for c in $(docker ps -q 2>/dev/null); do
          n=$(docker inspect --format '{{.RestartCount}}' "$c" 2>/dev/null || echo 0)
          if [ "$n" -gt 20 ]; then
            echo "$(docker inspect --format '{{.Name}}' "$c" | tr -d /)=$n"
          fi
        done | tr '\n' ' ')
if [ -n "$loops" ]; then echo "RESTART LOOP: $loops"; drift=1; fi

# 3. Images behind what the registry serves.
stale=""
for img in alfred-learn alfred-worker alfred-ctrl-api alfred-black-hermes \
           alfred-mcp-server alfred-web alfred-web-client alfred-vault-init \
           alfred-black-paperclip alfred-voice-bridge alfred-init; do
  full="ssdavidai00/${img}:latest"
  rd=$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$full" 2>/dev/null \
       | sed 's/.*@//' | cut -c8-19)
  [ -z "$rd" ] && continue
  tok=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:ssdavidai00/${img}:pull" 2>/dev/null \
        | sed -E 's/.*"token":"([^"]+)".*/\1/')
  [ -z "$tok" ] && continue
  reg=$(curl -fsS -H "Authorization: Bearer ${tok}" \
             -H "Accept: application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.index.v1+json" \
             -I "https://registry-1.docker.io/v2/ssdavidai00/${img}/manifests/latest" 2>/dev/null \
        | grep -i '^docker-content-digest' | tr -d '\r' | sed 's/.*sha256://' | cut -c1-12)
  # A registry lookup that fails is not drift — say nothing rather than cry wolf.
  [ -z "$reg" ] && continue
  [ "$rd" != "$reg" ] && stale="${stale} ${img}"
done
if [ -n "$stale" ]; then echo "IMAGES BEHIND:$stale"; drift=1; fi

[ "$drift" -eq 0 ] && echo "CLEAN"
exit "$drift"
