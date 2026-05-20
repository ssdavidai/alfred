FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
# hdbscan (surveyor clustering) ships no arm64 wheel — it compiles from
# source, so a C toolchain is required. Install it, build, then purge to
# keep the image lean.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3-dev \
 && pip install --no-cache-dir -r requirements.txt \
 && apt-get purge -y build-essential python3-dev \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# NOTE: no local Whisper model is baked. Audio transcription runs through
# Groq's hosted whisper-large-v3 (see src/activities/omi_audio.py and
# transcript.py) — set GROQ_API_KEY in .env. The old ~3 GB faster-whisper
# bundle was vestigial and has been removed.

COPY src/ src/
COPY scripts/ scripts/
COPY templates/ templates/

# alfred-learn runs as uid 1000 (shared-volume parity) but the dynamic chore
# loader materialises a package dir under src/workflows/ at runtime — make
# that subtree writable by non-root.
RUN chmod -R a+rwX /app/src/workflows
COPY entrypoint.sh .

RUN chmod +x entrypoint.sh

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV USE_DATE_PATHS=true
ENV CLERK_AGENT_ID=learn-clerk

CMD ["./entrypoint.sh"]
