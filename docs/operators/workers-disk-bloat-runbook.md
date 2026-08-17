# Workers disk-bloat — incident runbook + fleet rollout

**Date:** 2026-06-19
**Severity:** S1 (single-VM, no HA — a full disk takes the whole tenant down)
**Trigger tenant:** `a client tenant` (disk 100%, all healthchecks unhealthy,
sure-web 500). Stopgap already applied on zsolt (curator disabled + restart +
cleanup); zsolt is now healthy (state.db 57M, sessions/ 211M).

---

## Root cause (summary)

The Hermes **workers** profile (and to a lesser extent **heavy**) runs
high-volume autonomous background agents (clerk / vault-curator / vault-janitor
/ vault-distiller). Three compounding defects:

1. **No session/state pruning.** Every background run writes a
   `sessions/session_*.json` transcript (plus `sessions/request_dump_*.json`
   when a tool errors with the upstream debug-dump path active) and appends to
   the profile's `state.db`. Nothing ever prunes either store. This is the
   already-documented **[S1] "Session store growth / leak — must be verified
   under load"** (docs/FAILURE-MODES.md). It is **fleet-wide**.

2. **No Docker log rotation.** The default `json-file` driver has no size cap,
   so the Hermes container's `*-json.log` grows unbounded (19G on rami, 5.4G
   on rj, 7.2G on miguel, 3.4G on joe).

3. **A cross-session retry loop (upstream).** On zsolt a curator agent
   retried two failing tool calls indefinitely, accelerating the fill:
   - `Tool terminal returned error: usage: hermes [-h] ...` — the agent shells
     out to the `hermes` CLI with wrong args.
   - `mcp_alfred_update_vault_record returned error: ctrl-api 422
     PROMOTION_CONTRACT_VIOLATION "Record type MEMORY.md is not a canonical
     vault type"` — the agent tries to write `MEMORY.md` as a vault record.
   The per-run `tool_loop_guardrails.hard_stop_after` IS configured (and present
   in the live config) but does not stop this loop because the failure recurs
   **across sessions** — each invocation is a fresh session, so the per-run
   counters reset every time. Making the guardrail task-scoped (cap retries of
   the *same failing task* across sessions) is an upstream change in
   NousResearch/hermes-agent — see "Follow-ups" below.

---

## Live fleet state (du, 2026-06-19)

`/var/lib/docker/volumes/alfred-black_hermes_data/_data/profiles/workers`

| tenant | disk used | workers state.db | sessions/ | session files | biggest json.log |
|--------|-----------|------------------|-----------|---------------|------------------|
| zsolt  | 14% (cleaned) | 57M | 211M | 340 | 3.4M |
| joe    | 37% | **52G** | 1.6G | 3,965 | 2.8G |
| rj     | 40% | **59G** | 50M | 0 | **5.4G** |
| rami   | 43% | 5.8G | **37G** | **92,712** | **19G** |
| home   | 49% | 6.0G | **19G** | **54,537** | 1.1G |
| miguel | 32% | 1.8G | 1.4M | 0 | 7.2G |

**Needs cleanup now:** rami, home (sessions), joe, rj (state.db), miguel (log).
zsolt already done.

---

## Durable fixes (PRs — land first, then roll out cleanup)

- **PR A — log rotation:** `docker-compose.yaml` gains an `x-default-logging`
  anchor (`json-file`, `max-size: 50m`, `max-file: 5` → 250M cap/container)
  attached to every service. Reaches every tenant via the existing
  `deploy-compose.yml` sync.
- **PR B — session/state pruning:** the workers/heavy branch of
  `hermes-config.yaml.njk` renders a `cron:` block with `prune-old-sessions`
  (delete `session_*`/`request_dump_*` > 7 days) + `vacuum-state-db`. A new
  idempotent ADD-only converger `render_workers_pruning.py` backfills the same
  jobs onto already-seeded tenants' config.yaml on every init boot.

After PR A merges + `make sync-compose-fleet`, a `docker compose up -d` rolls
the new logging. After PR B merges + image pull + init re-run, the GC cron is
backfilled — but the GC only prunes *future* growth on the natural schedule, so
the **manual cleanup below is still required once per affected tenant** to
reclaim the already-accumulated bloat.

---

## Per-tenant cleanup runbook (manual, one-time)

> Run on a tenant only after a snapshot of the volume is acceptable to skip
> (these files are dead transcripts + a rebuildable DB). Order matters: free
> the cheap stuff first (logs), then sessions, then the DB (needs the container
> stopped). DO NOT delete `state.db` — VACUUM it.

```bash
ssh -o IdentityAgent=none -i ~/.ssh/alfred-black-verify root@<tenant>.alfred.black
cd /opt/alfred
W=/var/lib/docker/volumes/alfred-black_hermes_data/_data/profiles/workers
H=/var/lib/docker/volumes/alfred-black_hermes_data/_data/profiles/heavy

# 0. Snapshot the before-state.
df -h /; du -sh "$W"/state.db "$W"/sessions "$H"/state.db "$H"/sessions 2>/dev/null

# 1. Truncate the largest container json.logs (safe on a live container —
#    truncate keeps the inode the daemon holds open).
for f in $(ls -S /var/lib/docker/containers/*/*-json.log); do
  sz=$(du -m "$f" | cut -f1); [ "$sz" -gt 200 ] && : > "$f" && echo "truncated $f (${sz}M)";
done

# 2. Delete old session + request_dump transcripts (> 1 day = already dead;
#    worker sessions reset on 30-min idle). Both profiles.
find "$W"/sessions "$H"/sessions -maxdepth 1 -type f \
  \( -name 'session_*.json' -o -name 'request_dump_*.json' \) -mtime +1 -delete

# 3. VACUUM state.db — but ONLY with the hermes container stopped, so no
#    writer holds a lock and the WAL is clean. (state.db is the agent run
#    store; the gateway rebuilds working state on next run.)
docker stop alfred-black-hermes-1
for db in "$W"/state.db "$H"/state.db; do
  [ -f "$db" ] && python3 -c "import sqlite3; c=sqlite3.connect('$db'); c.execute('VACUUM'); c.close()" \
    && echo "vacuumed $db";
done
docker start alfred-black-hermes-1

# 4. Verify recovery + health.
df -h /; du -sh "$W"/state.db "$W"/sessions 2>/dev/null
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'hermes|ctrl|sure'
curl -fsS -o /dev/null -w '%{http_code}\n' https://<tenant>.alfred.black/ || true
```

**Notes / gotchas**
- If `df` does not drop after the json.log truncate, a *deleted-but-open* log
  is still held by the daemon — `docker restart <container>` releases it.
- The VACUUM step needs free disk roughly equal to the DB size (it rewrites the
  file). On a near-full box, do step 1+2 first to free headroom before the
  VACUUM. If a state.db VACUUM still can't fit, stop hermes, `mv state.db
  state.db.bak`, let the gateway recreate a fresh one on start, then delete the
  `.bak` once healthy (loses background run history only — no principal data).
- `state.db` and `sessions/` hold **no principal vault data** — the vault lives
  in the separate `vault_data` volume. These are agent runtime artifacts.

---

## Fleet rollout plan (order)

1. **Land + merge PR A (log rotation)**, then `make sync-compose-fleet` and on
   each tenant `docker compose up -d` (re-creates containers with the log cap).
2. **Land + merge PR B (pruning)**, let CI rebuild the init image, then on each
   tenant pull + re-run init (`docker compose up -d` triggers the init
   one-shot, which runs `render_workers_pruning.py` and backfills the GC cron).
3. **Manual cleanup**, worst-first to relieve disk pressure fastest:
   1. **rami** — 19G log + 37G/92k sessions (heaviest combined).
   2. **rj** — 59G state.db + 5.4G log.
   3. **joe** — 52G state.db + 2.8G log.
   4. **home** — 19G/54k sessions + 6G state.db (operator box; do during a
      quiet window — also runs codex-builder).
   5. **miguel** — 7.2G log only (sessions/state already small).
   - zsolt — already cleaned; just re-enable curator once PR B is rolled and
     the upstream loop follow-up is tracked.
4. **Re-enable the curator on zsolt** (the stopgap set `curator.enabled: false`)
   only after PR B is on zsolt AND the upstream loop follow-up below is filed,
   so a recurrence is bounded by the GC + the (future) task-scoped cap.

---

## Follow-ups (upstream — NousResearch/hermes-agent, not landable here)

1. **Task-scoped loop cap.** `tool_loop_guardrails.hard_stop_after` is per-run;
   the observed loop recurs across fresh sessions, so the counters reset and the
   hard stop never trips. Upstream needs a cap/backoff keyed by *task identity*
   (e.g. same inbox item / same tool+args signature) that persists across
   sessions, so a repeatedly-failing background task is quarantined instead of
   re-spawned forever. File against hermes-agent's run-loop / cron re-enqueue.
2. **`request_dump_*.json` debug writes.** These look like a debug-dump flag
   left on in the upstream tool-error path (not controlled by any knob in this
   repo — no `request_dump` string exists in ssdavidai/alfred). Confirm the
   upstream env/flag that gates them and turn it off for the background
   profiles; until then the `prune-old-sessions` job (PR B) sweeps them.
3. **Two agent-behaviour bugs feeding the loop** (skill/prompt level — could be
   fixed in this repo if the curator skill is the source, but the curator skill
   ships from the vendored `packages/alfred-vault` `_bundled/` data, so confirm
   ownership first):
   - the curator shelling out to the `hermes` CLI with wrong args (it should use
     the MCP `hermes__*` tools, not the terminal);
   - the curator writing `MEMORY.md` as a vault record (ctrl-api correctly
     rejects it 422 — the agent should not attempt a non-canonical vault write;
     the workers profile has `memory_enabled: false` so there is no MEMORY.md to
     persist).
