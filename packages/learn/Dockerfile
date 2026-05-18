FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download whisper-large-v3 model during build (cached in Docker layer).
# This makes the image ~3GB larger but ensures zero-config deployment.
# faster-whisper uses CTranslate2 format from Hugging Face.
RUN python -c "\
from huggingface_hub import snapshot_download; \
snapshot_download('Systran/faster-whisper-large-v3', local_dir='/app/models/whisper-large-v3')"

COPY src/ src/
COPY scripts/ scripts/
COPY templates/ templates/
COPY entrypoint.sh .

RUN chmod +x entrypoint.sh

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV USE_DATE_PATHS=true
ENV CLERK_AGENT_ID=learn-clerk
ENV WHISPER_MODEL_PATH=/app/models/whisper-large-v3

CMD ["./entrypoint.sh"]
