# vexa-dashboard fork — adds `stopping` + `joining` entries to the
# status-color maps so clicking Stop in the UI doesn't crash with
# `Cannot read properties of undefined (reading 'bgColor')`.
#
# Two static chunks need patching (both of which read the status map):
#   - afb3e188b168113b.js — primary status badge component
#   - 88aee780a629308d.js — secondary status icon component
#
# We pin the upstream image to a SHA digest in the FROM line because the
# dashboard's static chunk filenames are content-hashed by Next.js. If
# we pinned to the floating `:latest` tag a future upstream rebuild
# would silently rename the chunks and our COPY targets would land on
# nonexistent paths — patches lost. The digest below matches the
# 2025-12-16 build (verified by `docker manifest inspect` — see
# packages/vexa-dashboard/scripts/check-upstream.sh).
FROM synapsr/vexa-dashboard:latest@sha256:8aabde0b5f3a7a508a108b076e1ea1e3bc66a266383c060f97b4f3a50e92eb01

COPY --chown=nextjs:nodejs afb3e188b168113b.js /app/.next/static/chunks/afb3e188b168113b.js
COPY --chown=nextjs:nodejs 88aee780a629308d.js /app/.next/static/chunks/88aee780a629308d.js
