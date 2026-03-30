"""Singleton Whisper model loader for local transcription.

Uses faster-whisper with whisper-large-v3 (int8 quantized, CPU).
Model is loaded once on first call and cached in memory.
"""

import logging
import os
from functools import lru_cache

logger = logging.getLogger("alfred-learn")

# Defaults — can be overridden via environment
DEFAULT_MODEL_SIZE = "large-v3"
DEFAULT_MODEL_PATH = "/app/models/whisper-large-v3"
DEFAULT_COMPUTE_TYPE = "int8"
DEFAULT_CPU_THREADS = 4


@lru_cache(maxsize=1)
def get_whisper_model():
    """Load and cache the Whisper model. Called once, stays in memory."""
    from faster_whisper import WhisperModel

    model_path = os.environ.get("WHISPER_MODEL_PATH", DEFAULT_MODEL_PATH)
    model_size = os.environ.get("WHISPER_MODEL_SIZE", DEFAULT_MODEL_SIZE)
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", DEFAULT_COMPUTE_TYPE)
    cpu_threads = int(os.environ.get("WHISPER_CPU_THREADS", str(DEFAULT_CPU_THREADS)))

    # Use local path if it exists (baked into image), otherwise download by name
    use_path = model_path if os.path.isdir(model_path) else model_size

    logger.info(
        "Loading Whisper model: %s (compute_type=%s, threads=%d)",
        use_path, compute_type, cpu_threads,
    )

    model = WhisperModel(
        use_path,
        device="cpu",
        compute_type=compute_type,
        cpu_threads=cpu_threads,
    )

    logger.info("Whisper model loaded successfully")
    return model
