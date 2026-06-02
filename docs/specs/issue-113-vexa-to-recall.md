# issue-113 — Replace Vexa with Recall.ai

**Status:** spec (no code yet)
**Source issue:** ssdavidai/alfred#113
**Owner lanes:** ctrl + learn + voice-bridge + web + compose
**Hard dependencies:** none
**Soft overlaps:** #109 (Tailscale), #110/#111/#112 (HA voice path), debug/0522/vexa-meetingbot-findings.md, PR #93/#94 (voice-bridge persona + VAD), PR #80 (reveal pattern), Paperclip auto-bootstrap pattern.

---

## 1 · Problem statement

Today Vexa is a nine-container self-hosted profile (`profiles: ["vexa"]` in `docker-compose.yaml:1453-1700`) that adds ~3 GB resident, two `ssdavidai00/*` images we maintain, and a `vexa-runtime-api` container that mounts the host docker socket to spawn per-meeting bot siblings. The `/channels` auto-join toggle has been **structurally broken since the single-VM cutover** — `POST /api/v1/admin/vexa/auto-join` synchronously throws `ENOENT: /srv/alfred-black/.env` (the bind-mount path doesn't exist inside the ctrl-api container), the Temporal schedules it tries to pause are deleted-on-disable rather than paused (`register_schedules.py` create-or-delete vs `routes/vexa.ts` pause/unpause), and no production tenant has had `vexa-*` containers up since the cutover. Recall.ai is a hosted SaaS that fans out per-meeting bots to Zoom / Google Meet / Microsoft Teams / Cisco Webex, hands us a real-time transcript over wss, **and** lets us push our own audio _into_ the meeting via the Output Media webpage feature — which means Alfred can speak in meetings, not just listen. The trade-off is a monthly recurring cost (~$0.50/hour of bot time + $0.15/hour transcription) and a third-party data-residency surface for the audio. Sir wants the migration spec, and the new "live in-meeting voice" capability designed in the same pass. **The principal does NOT need to visit recall.ai; everything is configured through `/channels`** — key paste + validation, region, bot name, announcement toggle, auto-join policy, calendar source, cost ceiling, per-meeting cap, respond mode, wake word, active-bots panel with mid-meeting terminate, webhook delivery test, and cost-alert thresholds all live on the card.

---

## 2 · Current state

### 2.1 Vexa stack inventory

Nine services, all gated `profiles: ["vexa"]` in `/Users/ssd/dev/alfred/docker-compose.yaml:1453-1696`. Four named volumes (`vexa_redis`, `vexa_postgres`, `vexa_minio`, `vexa_recordings`).

(Retired in PR1; this section is preserved as historical record of what we removed.)

### 2.2 Code touching Vexa (pre-PR1)

- **ctrl-api:**
  - `packages/ctrl/src/api/routes/vexa.ts` — `GET/POST /api/v1/admin/vexa/auto-join` (the broken toggle; reads `${COMPOSE_DIR}/.env`).
  - `packages/ctrl/src/api/routes/webhooks/vexa.ts` — `POST /api/v1/webhooks/vexa` (HMAC-verified inbound transcript).
  - Registrations in `packages/ctrl/src/api/server.ts:40,48,156,164,222,266`.
  - `packages/ctrl/src/templates/vexa-profiles.yaml`, `vexa-stack.yaml.njk` (compose render templates).
  - `packages/ctrl/tests/vexa-toggle-resilient.test.ts`.
- **alfred-learn:**
  - `packages/learn/src/workflows/meeting_capture.py` — gcal poll → dispatch bot, gated on `VEXA_ENABLED`.
  - `packages/learn/src/workflows/transcript_intake.py` — reads `streams/vexa-transcripts.jsonl`, calls `vexa_get_transcript`, fans actions into Steward signals.
  - `packages/learn/src/activities/transcript.py` — `vexa_join_meeting`, `vexa_get_transcript`, `find_upcoming_meet_events`, `is_sir_attendee`, `extract_meet_native_id`, `_parse_gcal_start`, `extract_actions_from_transcript`, `apply_transcript_action`, `appendTranscriptRecord` helpers. Base URL constant `DEFAULT_VEXA_API_URL = "http://vexa-api-gateway:8000"`.
  - `register_schedules.py` — `al-meeting-capture` + `al-transcript-intake` create-or-delete gated on `VEXA_ENABLED`.
- **web (Wasp):**
  - `packages/web/src/dashboard/ChannelsPage.tsx:363-381` — Meeting bot card.
  - `packages/web/src/dashboard/operations.ts:1032-1054` — `getVexaAutoJoin` / `setVexaAutoJoin` Wasp actions.
  - `packages/web/public/app-icons/vexa.svg`.
- **caddy:**
  - `caddy/Caddyfile:57` — `/api/v1/webhooks/vexa` is in the `@public_webhooks` matcher.
- **docs:**
  - `/Users/ssd/dev/alfred-docs/integrations/vexa.mdx`.

### 2.3 Composio Google Meet overlap

Composio's gcal stream (`composio-googlecalendar.jsonl`) is **already** how we discover meetings — `find_upcoming_meet_events` reads it, filters on `is_sir_attendee` (`ALFRED_OWNER_EMAIL` match), and extracts `meet_native_id`. There is no separate Composio "Google Meet bot" — Composio is the calendar source, Vexa is the bot. Recall replaces only the bot half. The gcal stream stays.

### 2.4 Existing transcripts

`/alfred-data/streams/vexa-transcripts.jsonl` is append-only on tenants that ran the profile. In production, the audit (debug/0522) shows the profile has not been up on any live tenant — `docker ps -a` shows zero `vexa-*` containers fleet-wide, so the stream is either empty or missing. **There is no historical transcript corpus to migrate.**

### 2.5 Failure-mode summary (debug/0522/vexa-meetingbot-findings.md)

1. **BLOCKER** — `POST /api/v1/admin/vexa/auto-join` reads `/srv/alfred-black/.env`, that path is the host path, ctrl-api runs in a container without that mount → hard 500 → SaaS-proxy collapses to "Internal ctrl-api error" → toggle has never worked post-cutover.
2. **HIGH** — Two-mechanism disagreement: `register_schedules.py` create-or-deletes the two schedules at boot from `VEXA_ENABLED`; `routes/vexa.ts` pauses/unpauses them at runtime. Even with #1 fixed, on disable the schedules are gone, and unpause-on-enable would `NOT_FOUND` until a learn redeploy.
3. **MED** — `routes/vexa.ts` only manages `al-meeting-capture`; `al-transcript-intake` ticks against an empty stream.
4. **MED** — `apply_transcript_action` is write-only; action extraction doesn't wire into state-mutator.
5. **S3** — `vexa-runtime-api` has docker.sock RW + no `no-new-privileges` + no `cap_drop`. Bot siblings unbounded.

---

## 3 · Architecture design

### 3.1 The replacement, in one diagram

```
                          principal pastes Recall API key
                                       │
                                       ▼
       ┌──────────────────────────  /channels Recall card  ─────────────────────────┐
       │ web: ChannelsPage.tsx → recallCardCore.ts → operations.ts (Wasp actions)   │
       └────────────────────────────────────┬───────────────────────────────────────┘
                                            ▼  proxyToTenant
       ┌──────────────────────────────  ctrl-api  ──────────────────────────────────┐
       │  routes/channels_recall.ts                                                 │
       │    POST /api/v1/channels/recall/api-key   ← validate + persist + bootstrap │
       │    GET  /api/v1/channels/recall/status    ← card state derivation          │
       │    POST /api/v1/channels/recall/test      ← dry-run bot dispatch           │
       │    PATCH /api/v1/channels/recall/policy   ← auto-join policy + cost cap    │
       │    POST /api/v1/channels/recall/confirm-webhook                            │
       │    DELETE /api/v1/channels/recall/api-key ← disconnect                     │
       │  routes/webhooks/recall.ts                                                 │
       │    POST /api/v1/webhooks/recall           ← Svix-signed; appends to        │
       │                                            streams/recall-events.jsonl     │
       └────────────────────────────────────┬───────────────────────────────────────┘
                                            ▼ Temporal schedules
       ┌──────────────────────────  alfred-learn  ──────────────────────────────────┐
       │  workflows/meeting_capture.py   → activities/recall.py::recall_join_meeting│
       │    every 60s; reads composio-googlecalendar.jsonl (no second OAuth)        │
       │  workflows/transcript_intake.py → activities/recall.py::recall_get_transcript│
       │    every 60s; reads streams/recall-events.jsonl (bot.done events)          │
       └────────────────────────────────────┬───────────────────────────────────────┘
                                            ▼ POST /api/v1/bot/  (+ output_media)
       ┌──────────────────────────  Recall.ai SaaS  ────────────────────────────────┐
       │  bot joins meeting, streams transcript+events out to /recall/transcript    │
       │  loads OUR /recall/agent webpage as camera/screenshare for outbound audio  │
       └────────────────────────────────────┬───────────────────────────────────────┘
                  ┌──────────── outbound ────┼──── inbound transcript stream ────┐
                  ▼                          ▼                                   ▼
       ┌──────────────────────────  voice-bridge (recall mode)  ────────────────────┐
       │  RESOLVED: option B — extend packages/voice-bridge with a recall transport │
       │  adapter. The OpenAI Realtime client, instructions, MCP catalog, and       │
       │  tool dispatcher are 100% reusable — only the I/O adapter is per-transport │
       │  Serves:                                                                   │
       │   • GET /recall/agent?bot_id=…&token=…   ← page Recall renders in the bot, │
       │                                            runs Web Audio API ↔ Realtime   │
       │   • WSS /recall/transcript               ← Recall posts realtime transcript│
       │                                            + speech-on/off events here     │
       └────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 – 3.7

(Full architecture, contracts, sequencing, risks, open questions, and
acceptance criteria — see issue #113 on GitHub. The PR1 retirement-only
content above is what PR1 implements; PR2 onwards land the Recall.ai
side per the sequencing table below.)

---

## 6 · Sequencing — 8 PRs

| # | Title | Lane | Notes |
|---|---|---|---|
| **PR 1** | `chore(vexa): retire the Vexa stack` | compose + ctrl + web + caddy + docs | Deletions + 410 Gone stubs. ~244 lines from compose, 9 services, 4 volumes, 2 routes (stubbed), 2 SaaS actions, 1 ChannelsPage card → placeholder, 4 template files, 10 env vars, 1 caddy matcher entry. **THIS PR.** |
| **PR 2** | `feat(ctrl): Recall channel routes + DB migration` | ctrl | New `recall_bot` + `recall_event` + `recall_config` tables; `routes/channels_recall.ts`; `routes/webhooks/recall.ts` (Svix verify); caddy matcher. No dashboard surface yet. |
| **PR 3a** | `feat(web): /channels Recall card — paste + validate + region` | web | Minimum viable card: paste/validate/region. ~250-300 LoC. |
| **PR 3b** | `feat(web): /channels Recall card — full config + active bots` | web | Policy form, active-bots panel, usage meter, webhook test, cost-alerts. ~400-500 LoC. |
| **PR 4** | `feat(learn): Recall calendar polling + bot dispatch` | learn | `activities/recall.py` (replacing the vexa_* activities); rename workflows; flag swap. End-state: feature parity with old Vexa — silent transcript capture works end-to-end. |
| **PR 5** | `feat(voice-bridge): IDLE Recall webpage + transcript wss` | voice-bridge | Recall-mode adapter. Bot created with `output_media.camera.kind: "webpage"`; page silent; wss handler ingests transcript without turning the LLM loop. **Proves the round-trip without LLM cost.** |
| **PR 6** | `feat(voice-bridge): on-mention LLM turn + tool catalog` | voice-bridge | Wake-word detector, 22+5 tool catalog, Realtime turn loop, barge-in clear. End-state: live in-meeting voice. |
| **PR 7** | `feat(ctrl,web): cost ceiling enforcement + privacy compliance` | ctrl + web + learn | Hours-cap enforcement (auto-flip to `off` at 100%); cost-alert notifications; silent-skip keywords; announce-on-join enforcement; eject-on-objection. |

Optional PR 8 (post-launch, not in scope): drop Composio gcal in favour of Recall's Calendar V2 OAuth.

---

## Notes for the agent picking up PR 1

- Repo: `/Users/ssd/dev/alfred`.
- `make ci-check` before pushing.
- PR 1 is mechanically the largest but the easiest — almost entirely deletions + thin 410 stubs.
- After: `rg -i 'vexa' packages docs deploy` should return zero hits except `CHANGELOG.md`, this spec file, the two 410-stub files (+ tests), and a small set of migration-note comments where load-bearing.
- PR 5+ (live-voice path) is the hardest. Re-read `packages/voice-bridge/src/openai-realtime.ts` carefully — the PR #94 lessons (`server_vad` threshold, `session.updated` ACK race, barge-in clear) are easy to forget and load-bearing.

---

(Full §3–§5 / §7–§9 of the spec — architecture detail, contracts to
freeze, risks, open questions, acceptance criteria, related work — see
the GitHub issue #113. They are the source of truth for PR2 onwards and
are intentionally kept off the PR1 commit to keep this prep PR small
and reviewable.)
