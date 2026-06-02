# Home Assistant voice pipeline → alfred-voice-bridge

End-to-end setup for routing ESPHome voice-assistant devices (Voice Preview
Edition, S3-Box-3, Atom Echo, etc.) through Home Assistant Assist into
`alfred-voice-bridge`. Once wired, the principal says "hey jarvis, ..." at
a satellite and the audio reaches the same GPT-Realtime butler persona that
answers Twilio calls.

This document is the operator-side companion to:

- issue #112 PR 1 (ESPHome Native API listener inside `alfred-voice-bridge`)
- issue #112 PR 2/PR 3 (the audio pipe end-to-end)
- issue #112 PR 4 (this PR — `ESPHOME_API_ENABLED=1` default + this doc)

The pipeline below uses the **ESPHome Native API** as the audio channel
between satellite ↔ voice-bridge. There is a parallel-but-different
option called **Wyoming Protocol** that HA Assist commonly uses for
`whisper.cpp` / `piper` workers; we picked Native API because the
voice-bridge already speaks it (issue #112 PR 1) and skipping the Wyoming
hop saves a transcoder round-trip per turn. Wyoming would force one more
serialisation pass between the satellite (Native API) → HA conversation
processor → Wyoming server (voice-bridge) and adds nothing for our setup.

---

## What you need

- An ESPHome voice-assistant capable device. The Home Assistant Voice
  Preview Edition is the reference target; S3-Box-3 + Atom Echo are
  proven; any ESP32-S3 with a microphone + speaker will work.
- Home Assistant 2024.6 or newer (Assist pipelines + ESPHome integration).
- `alfred-voice-bridge` running with `ESPHOME_API_ENABLED=1` (the default
  since #112 PR 4) and `:6053` reachable from HA. The compose service
  binds 127.0.0.1:6053 by default — see "Reachability" below for the
  three supported topologies.

## Reachability — three supported topologies

`alfred-voice-bridge`'s ESPHome Native API listener is bound to
**127.0.0.1:6053** on the host. Home Assistant's ESPHome integration must
be able to reach `<host>:6053` for pairing to succeed. Pick whichever
matches your network:

| Topology | How HA reaches :6053 | Notes |
| --- | --- | --- |
| **A · Tailscale sidecar** | `https://<vm>.<tailnet>.ts.net` resolves to the VM, port `6053` is open via `tailscale serve --bg 6053`. | Recommended. Enable via `docker compose --profile tailscale up -d` and the Connect button on the `/channels` Tailscale card; then call `POST /api/v1/channels/tailscale/serve` with `{port: 6053, path: "/"}`. |
| **B · Same-subnet HA** | HA is on the same LAN as the VM and addresses it by LAN IP. | mDNS announcement (`_esphomelib._tcp.local.`, issue #112 PR 1) requires HA's container to share the LAN broadcast domain. Bridge networks block this — host networking on the HA side works. |
| **C · Reverse-tunnel via HA add-on** | The HA install runs the `alfred-voice-bridge` connector add-on (out of scope here). | For HA-Cloud / HA-OS users who can't reach the VM directly. Tracked separately. |

Do **not** publish 6053 on a public IP — the Native API has no TLS in
the noise-encrypted-off code path we ship; remote ingress goes via
Tailscale.

---

## YAML you paste — there are three files

### 1. The ESPHome device YAML (`.yaml` per satellite)

This goes onto the satellite — paste it into the ESPHome dashboard for
the device, recompile, flash. The wake-word block at the bottom is the
output of the `/channels` "Voice satellites & wake words" card's
generator (`selectedWakeWordsToManifest` in
`packages/web/src/dashboard/voiceWakeWordsCardCore.ts`); the eight
catalogue entries are listed at the bottom of this doc for reference.

```yaml
# alfred-voice-pe.yaml — example ESPHome device YAML for a HA Voice PE
# satellite that routes through alfred-voice-bridge.

substitutions:
  device_name: alfred-voice-pe
  friendly_name: Alfred Voice (PE)

esphome:
  name: ${device_name}
  friendly_name: ${friendly_name}

esp32:
  board: esp32-s3-devkitc-1
  framework:
    type: esp-idf

# ── Native API — this is the channel HA Assist talks over ──────────────────
api:
  # No `encryption.key:` — alfred-voice-bridge speaks the plaintext
  # Native API today (the noise-encrypted variant is on the roadmap).
  # ESPHome's CI lints emit a warning for missing encryption; ignore it.
  reboot_timeout: 0s

ota:
  - platform: esphome

logger:
  level: INFO

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password

# ── voice_assistant: routes audio to HA Assist, which then forwards
#    to alfred-voice-bridge over the conversation agent below. ──────────────
voice_assistant:
  microphone: mic
  speaker: speaker
  use_wake_word: true
  noise_suppression_level: 2
  auto_gain: 31dBFS
  volume_multiplier: 2.0
  vad_threshold: 3
  # The ID HA logs under — useful when there are several satellites.
  id: voice_assistant_${device_name}
  on_listening:
    - light.turn_on:
        id: led
        effect: pulse
  on_stt_end:
    - light.turn_off: led
  on_error:
    - logger.log: "voice_assistant error"

# ── Wake-word block — paste output from the /channels "Voice satellites
#    & wake words" card here. Example for "Ok Nabu" + "Hey Jarvis": ─────────
micro_wake_word:
  models:
    - model: ok_nabu
    - model: jarvis

# (openWakeWord entries — those run on the voice-bridge, not on this
# device — are documented at the end of this file as comments.)

# I2S audio pinout, light, speaker — copy from the HA Voice PE template
# in the upstream ESPHome examples. Pinout is board-specific.
```

### 2. The HA `configuration.yaml` snippet

This goes into Home Assistant — append to your `configuration.yaml`,
restart HA. It registers `alfred-voice-bridge` as a conversation agent
so HA Assist forwards transcripts to it.

```yaml
# configuration.yaml — alfred-voice-bridge conversation agent.

# `alfred_voice_bridge` is the HA REST-command HA Assist hits when the
# pipeline below routes a transcript its way. The bridge's
# /api/v1/channels/ha/turn endpoint validates a per-installation bearer
# (channel_tokens table, channel='ha-conversation'; see ctrl-api
# routes/channels_ha_turn.ts).
rest_command:
  alfred_voice_bridge_turn:
    url: "https://home-alfred-black.<your-tailnet>.ts.net/api/v1/channels/ha/turn"
    method: post
    content_type: "application/json"
    headers:
      Authorization: !secret alfred_voice_bridge_token
    payload: >
      {
        "transcript": "{{ trigger.payload.transcript }}",
        "device_id": "{{ trigger.payload.device_id }}",
        "language": "{{ trigger.payload.language | default('en') }}"
      }

# Pipeline binding — wire HA Assist to use the rest_command above as
# the conversation engine. The `external_url` flag tells HA to bypass
# its built-in conversation agent and forward to alfred-voice-bridge.
conversation:
  intents: !include_dir_named intents
homeassistant:
  external_url: "https://home-alfred-black.<your-tailnet>.ts.net"
```

`secrets.yaml`:

```yaml
# secrets.yaml — alfred-voice-bridge inbound bearer.
# Mint this via:
#   curl -X POST https://<your-tenant>/api/v1/channels/ha/token \
#        -H "Authorization: Bearer $AAS_API_KEY"
# It returns {token: "Bearer ha_..." } — paste that here including the
# "Bearer " prefix.
alfred_voice_bridge_token: "Bearer ha_<token>"
```

### 3. HA Assist pipeline config

In the HA UI (no YAML edit needed — but the JSON is here for completeness):

`Settings → Voice Assistants → Add assistant`:

- **Conversation agent**: "Alfred Voice Bridge" (the REST command above
  registers under this label; it appears in the dropdown after restart).
- **Speech-to-text**: leave on the HA default (`whisper.cpp` / Cloud STT
  — your call). The voice-bridge expects a finished transcript on the
  REST `/ha/turn` call; it doesn't re-do STT.
- **Text-to-speech**: leave on the HA default (`piper` / Cloud TTS) for
  the satellite's response audio. The bridge returns a text-only
  response; HA's TTS pipeline reads it back through the satellite's
  speaker.
- **Wake-word service**: pick `microWakeWord` if every wake word you
  selected in the `/channels` "Voice satellites & wake words" card is in
  the `microWakeWord` column below, OR `openWakeWord` (running on the
  voice-bridge — set this up via HA's openWakeWord add-on) if any of
  your selections are from the `openWakeWord` column.

Bind the assistant to each satellite in `Settings → Devices & Services →
ESPHome → <satellite> → Configure → Voice assistant`.

---

## Wake-word catalogue (mirrors `voiceWakeWordsCardCore.ts`)

These are the eight pre-selected entries the `/channels` card exposes.
The full upstream catalogue lives at
<https://github.com/fwartner/home-assistant-wakewords-collection> —
pick more from there if these don't suit, and the card's manifest
generator will emit them too.

| Slug | Display name | Engine | Where it runs |
| --- | --- | --- | --- |
| `alexa` | Alexa | openWakeWord | voice-bridge |
| `computer` | Computer | microWakeWord | on-device |
| `hey_jarvis` | Hey Jarvis | openWakeWord | voice-bridge |
| `hey_mycroft` | Hey Mycroft | openWakeWord | voice-bridge |
| `hey_rhasspy` | Hey Rhasspy | openWakeWord | voice-bridge |
| `jarvis` | Jarvis | microWakeWord | on-device |
| `ok_nabu` | Ok Nabu | microWakeWord | on-device |
| `sherlock` | Sherlock | microWakeWord | on-device |

`microWakeWord` runs on the ESP32-S3 — zero per-detection latency, zero
network round-trip, free. `openWakeWord` runs on the voice-bridge — more
robust to background noise, costs ~150ms latency + a couple of CPU
cores while the listener is active. Pick the mix that matches your
deploy.

---

## Verification

After all three are pasted, restart HA, recompile-and-flash the
satellite, then:

1. The satellite reboots, `voice_assistant` block boots, HA's ESPHome
   integration auto-discovers it via mDNS and shows it under
   `Settings → Devices & Services → ESPHome`.
2. Say a wake word ("hey jarvis"). The satellite's LED ring should
   pulse (`on_listening`).
3. Say a query ("what's on my desk today?"). The transcript goes to
   `alfred-voice-bridge` `/api/v1/channels/ha/turn`; the response comes
   back through HA TTS and plays on the satellite's speaker.

Failure to reach `:6053` from HA surfaces as
`Failed to connect to esphome:6053 → connection refused` in HA's ESPHome
integration logs — that's the topology test. Re-read the
"Reachability" table above and confirm your topology is correct.

### Operator-side smoke test (issue #112 PR5)

From your laptop, while on the tailnet, you can probe a satellite IP
without leaving the shell:

```bash
# Probe a specific satellite — opens an ESPHome Native API connection,
# runs Hello → DeviceInfo → ListEntities, looks for `voice_assistant:`,
# reports back with recommendations.
curl -s -X POST \
     -H "Authorization: Bearer $AAS_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"ip":"192.168.1.50","hostname":"voice-pe-living-room.local"}' \
     https://home.alfred.black/api/v1/channels/voice/esphome/devices/test \
| jq .

# Output shape:
# {
#   "ok": true,
#   "info": {
#     "reachable": true,
#     "esphome_version": "2024.10.3",
#     "voice_assistant_present": true,
#     "codec": "pcm16 mono @ 16 kHz (assumed from voice_assistant)",
#     "recommendations": []
#   },
#   "hostname": "voice-pe-living-room.local"
# }

# List HA installs that have paired with voice-bridge so far:
curl -s -H "Authorization: Bearer $AAS_API_KEY" \
     https://home.alfred.black/api/v1/channels/voice/esphome/devices | jq .

# Wyoming-fallback readiness — `enabled: true` iff WYOMING_ENABLED=1
# was set when voice-bridge last booted:
curl -s -H "Authorization: Bearer $AAS_API_KEY" \
     https://home.alfred.black/api/v1/channels/voice/wyoming/status | jq .
```

The same routes power the `/channels` dashboard's **Voice satellites**
card — the `[Test]` button next to each detected device calls the same
probe and renders the recommendations inline.

There's also a CLI helper for the bare ESPHome Native API probe (skips
ctrl-api entirely — useful when you're SSH'd into the VM and don't have
`$AAS_API_KEY` handy):

```bash
packages/voice-bridge/scripts/smoke-esphome-device.sh --ip 192.168.1.50
```

---

## Alternative — the Wyoming Protocol route

The default path above uses the **ESPHome Native API** (`:6053`). Issue
#112 PR5 adds a parallel **Wyoming Protocol** listener on `:10300` that
HA's `wyoming` integration calls into. The voice-bridge supports both —
they terminate at the same brain — so the operator picks whichever
matches their HA install.

When to pick which:

| Path | Pros | Cons |
| --- | --- | --- |
| **ESPHome Native API** (default) | Shorter audio path (~30 ms latency saving), wake word stays on-device for free, no extra HA-side config. | Requires HA to reach `:6053` over the LAN OR the tailnet. HA-OS / HA-Cloud installs that can't reach :6053 hit a wall. |
| **Wyoming Protocol** (`:10300`, opt-in) | Works wherever HA's `wyoming` integration works — including HA-Cloud / HA-OS where the ESPHome Native API path is closed. Speaks the same JSONL grammar as Whisper / Piper, so HA treats us like any other satellite worker. | One extra serialisation round-trip per turn; HA owns the wake/STT/intent/TTS pipeline so the wake word + STT happen HA-side first. |

Enable on a tenant:

```bash
# /opt/alfred/.env
WYOMING_ENABLED=1
```

Then restart `voice-bridge`:

```bash
docker compose --profile voice restart voice-bridge
```

In HA: `Settings → Add-ons / Integrations → Wyoming Protocol → Add`.
Use the same hostname you'd point ESPHome at (typically the tailnet name
or `voice.<your-domain>` if you've set up the Caddy reverse-proxy). HA
will probe the listener with a Wyoming `describe` event; our reply
advertises a `satellite` service at 16 kHz pcm16 mono on both mic and
sound directions. HA wires us as the satellite + the conversation agent
in one step.

The wake-word selection card on `/channels` still applies — the
microWakeWord entries run on-device (whether you came in via ESPHome
Native or via Wyoming through a Pi running `wyoming-satellite`); the
openWakeWord entries run on the voice-bridge regardless of transport.

### Wake-word handling differences

- **ESPHome Native path**: wake stays on the ESP32-S3, voice-bridge
  receives a `VoiceAssistantRequest(start=true, wake_word_phrase=...)`
  with the phrase already detected. We don't run wake detection at all.
- **Wyoming path**: HA's Assist pipeline runs wake detection first
  (either via its `openwakeword` add-on or per-satellite firmware), then
  forwards post-wake audio to us as a `audio-start` → `audio-chunk*` →
  `audio-stop` stream. We never see the wake word itself.

Either way the principal's experience is identical — say the wake word,
ask a question, get a Received-Pronunciation butler reply.
