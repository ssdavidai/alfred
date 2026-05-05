# vexa-meeting-api fork — patches three production bugs we hit on david:
#
#   1. Hardcoded model name "large-v3-turbo" → "whisper-large-v3-turbo".
#      Groq's Whisper endpoint requires the longer name; upstream targets
#      OpenAI's API where the short name works.
#   2. POST to transcription endpoint missing `response_format=verbose_json`
#      and `timestamp_granularities[]=segment`. Without them, Groq returns
#      `{text}` only — no `segments[]` — and meeting-api's deferred-
#      transcribe path stores zero segments.
#   3. Default bot name `VexaBot-{random}` when client doesn't pass
#      `bot_name` → "Alfred". Used only by the dashboard's manual
#      "Join Meeting" form; alfred-learn's auto-dispatch always sends
#      bot_name="Alfred" explicitly.
#
# All three patches are confined to /app/meeting_api/meetings.py, so this
# Dockerfile is a one-liner: layer the patched file on top of the upstream
# image and call it a day. When upstream cuts a new tag we just bump
# FROM and re-run the patch script (see scripts/patch-vexa-meeting-api.sh
# in packages/vexa-meeting-api/).
ARG VEXA_MEETING_API_TAG=0.10.6
FROM vexaai/meeting-api:${VEXA_MEETING_API_TAG}

COPY meetings.py /app/meeting_api/meetings.py
