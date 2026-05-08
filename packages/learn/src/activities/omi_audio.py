"""Omi audio pipeline activities — scan, group, transcribe, ingest."""

from __future__ import annotations

import io
import json
import logging
import math
import os
import shutil
import struct
import time
import wave
from pathlib import Path
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("alfred-learn")

OMI_AUDIO_DIR = os.environ.get("OMI_AUDIO_DIR", "/alfred-data/streams/omi-audio")

# Grouping constants
SPEECH_GAP_SECONDS = 60  # 60s of silence between speech = new conversation
MIN_SPEECH_CHUNKS = 3  # need at least 3 speech chunks to form a group
MAX_GROUP_DURATION_SECONDS = 5 * 60  # cap groups at 5 min to keep transcription fast
SILENCE_RMS_THRESHOLD = 300  # PCM16 RMS below this = silence (range 0-32768)
READY_AGE_SECONDS = 30  # group is ready if last speech chunk is 30s+ old
RETENTION_SECONDS = 48 * 60 * 60  # delete processed audio after 48 hours


def _pcm_rms(pcm_bytes: bytes) -> float:
    """Compute RMS energy of PCM16 audio. Returns 0-32768 range."""
    if len(pcm_bytes) < 2:
        return 0.0
    n_samples = len(pcm_bytes) // 2
    samples = struct.unpack(f"<{n_samples}h", pcm_bytes[:n_samples * 2])
    sum_sq = sum(s * s for s in samples)
    return math.sqrt(sum_sq / n_samples)


def _has_speech(pcm_path: str, threshold: float = SILENCE_RMS_THRESHOLD) -> bool:
    """Check if a PCM file contains speech (above silence threshold)."""
    try:
        data = Path(pcm_path).read_bytes()
        return _pcm_rms(data) > threshold
    except Exception:
        return False


def pcm_to_wav(pcm_bytes: bytes, sample_rate: int = 16000, channels: int = 1) -> bytes:
    """Convert raw PCM16 audio bytes to WAV format in memory."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


@activity.defn
async def scan_audio_buffer() -> list[dict[str, Any]]:
    """Walk the audio buffer directory, return list of unprocessed PCM file metadata.

    Returns list of {path, uid, timestamp, size, sample_rate, stream_id}.

    Capped at OMI_SCAN_MAX files per call (default 500). Sorts by filename
    timestamp ascending so the oldest backlog drains first. Without the cap,
    this activity reads every .pcm file in the buffer to run a VAD/RMS
    silence check (`_has_speech`), which is O(total_buffer_bytes) per scan
    and can take many minutes when the backlog grows into thousands of
    files. Surfaced 2026-05-08 on david: 37,480 files / 6.4 GB had
    accumulated during a 25-day stall, every scan timed out at the
    workflow's 30s budget, every retry timed out, the workflow wedged
    permanently.
    """
    audio_dir = Path(OMI_AUDIO_DIR)
    if not audio_dir.exists():
        logger.info("[omi] Audio buffer directory does not exist: %s", OMI_AUDIO_DIR)
        return []

    scan_max = int(os.environ.get("OMI_SCAN_MAX", "500"))

    # First pass: gather (timestamp, uid_dir, pcm_file, meta_file) tuples
    # cheaply (no .pcm reads, no .json parses). The cap is applied AFTER
    # sorting so we always drain oldest-first across all uids, not just
    # the first uid we happen to iterate.
    candidates: list[tuple[int, str, Path, Path]] = []
    for uid_dir in audio_dir.iterdir():
        if not uid_dir.is_dir():
            continue
        if uid_dir.name == "processed":
            continue
        uid = uid_dir.name
        for pcm_file in uid_dir.glob("*.pcm"):
            try:
                timestamp_ms = int(pcm_file.stem)
            except ValueError:
                logger.warning("[omi] Skipping file with non-numeric name: %s", pcm_file)
                continue
            candidates.append((timestamp_ms, uid, pcm_file, pcm_file.with_suffix(".meta.json")))

    total_unprocessed = len(candidates)
    candidates.sort(key=lambda c: c[0])
    capped = candidates[:scan_max]

    if total_unprocessed > scan_max:
        logger.info(
            "[omi] %d unprocessed files; processing oldest %d this run (will drain on subsequent runs)",
            total_unprocessed,
            scan_max,
        )

    results: list[dict[str, Any]] = []
    for timestamp_ms, uid, pcm_file, meta_file in capped:
        meta: dict[str, Any] = {}
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text())
            except Exception:
                pass

        try:
            size = pcm_file.stat().st_size
        except FileNotFoundError:
            # File disappeared between glob and stat — skip
            continue

        results.append({
            "path": str(pcm_file),
            "meta_path": str(meta_file),
            "uid": uid,
            "timestamp": timestamp_ms,
            "size": size,
            "sample_rate": meta.get("sample_rate", 16000),
            "stream_id": meta.get("stream_id", ""),
            "has_speech": _has_speech(str(pcm_file)),
        })

    # Purge processed files older than retention period
    _purge_old_processed(audio_dir)

    logger.info(
        "[omi] Scanned audio buffer: %d files returned (of %d unprocessed total)",
        len(results), total_unprocessed,
    )
    return results


def _purge_old_processed(audio_dir: Path) -> None:
    """Delete processed audio files older than RETENTION_SECONDS."""
    now = time.time()
    purged = 0
    for uid_dir in audio_dir.iterdir():
        if not uid_dir.is_dir():
            continue
        processed_dir = uid_dir / "processed"
        if not processed_dir.is_dir():
            continue
        for f in processed_dir.iterdir():
            try:
                if now - f.stat().st_mtime > RETENTION_SECONDS:
                    f.unlink()
                    purged += 1
            except Exception:
                continue
        # Remove empty processed/ dirs
        try:
            if processed_dir.is_dir() and not any(processed_dir.iterdir()):
                processed_dir.rmdir()
        except Exception:
            pass
    if purged:
        logger.info("[omi] Purged %d processed audio files (>48h old)", purged)


@activity.defn
async def group_audio_segments(files: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Group PCM files by speech activity.

    Only files with detected speech are included. A silence gap longer than
    SPEECH_GAP_SECONDS between speech chunks starts a new conversation group.
    Groups are ready when the last speech chunk is READY_AGE_SECONDS old.
    Silent-only files are moved to processed/ immediately.
    """
    if not files:
        return []

    # Separate speech from silence
    sorted_files = sorted(files, key=lambda f: (f["uid"], f["timestamp"]))
    speech_files = [f for f in sorted_files if f.get("has_speech", False)]
    silent_files = [f for f in sorted_files if not f.get("has_speech", False)]

    # Move silent files to processed/ immediately (they'll never be transcribed)
    if silent_files:
        _move_to_processed(silent_files)
        logger.info("[omi] Discarded %d silent chunks", len(silent_files))

    if not speech_files:
        logger.info("[omi] No speech detected in %d files", len(files))
        return []

    # Group speech files: new group when uid changes or silence gap > threshold
    groups: list[list[dict[str, Any]]] = []
    current_group: list[dict[str, Any]] = []

    for f in speech_files:
        if not current_group:
            current_group = [f]
            continue

        prev = current_group[-1]
        gap_ms = f["timestamp"] - prev["timestamp"]
        if f["uid"] != prev["uid"] or gap_ms > SPEECH_GAP_SECONDS * 1000:
            groups.append(current_group)
            current_group = [f]
        else:
            current_group.append(f)

    if current_group:
        groups.append(current_group)

    # Split large groups into ≤5 min chunks, tagged with a shared conversation_id
    import uuid as _uuid
    chunked_groups: list[list[dict[str, Any]]] = []
    for group in groups:
        if not group:
            continue
        first_ts = group[0]["timestamp"]
        last_ts = group[-1]["timestamp"]
        duration_ms = last_ts - first_ts
        conv_id = str(_uuid.uuid4())[:8]

        if duration_ms <= MAX_GROUP_DURATION_SECONDS * 1000:
            # Small enough — tag and keep as one
            for f in group:
                f["conversation_id"] = conv_id
                f["part"] = 1
                f["total_parts"] = 1
            chunked_groups.append(group)
        else:
            # Split into 5-min chunks
            chunk: list[dict[str, Any]] = []
            chunk_start_ts = group[0]["timestamp"]
            part = 0
            for f in group:
                if f["timestamp"] - chunk_start_ts > MAX_GROUP_DURATION_SECONDS * 1000 and chunk:
                    chunked_groups.append(chunk)
                    part += 1
                    chunk = []
                    chunk_start_ts = f["timestamp"]
                f["conversation_id"] = conv_id
                chunk.append(f)
            if chunk:
                chunked_groups.append(chunk)
                part += 1
            # Set part numbers
            total_parts = part
            current_part = 0
            for cg in chunked_groups[-total_parts:]:
                current_part += 1
                for f in cg:
                    f["part"] = current_part
                    f["total_parts"] = total_parts
            logger.info("[omi] Split conversation %s into %d parts (%.0fs total)",
                        conv_id, total_parts, duration_ms / 1000)

    groups = chunked_groups

    # Ready check: groups with enough speech chunks AND a "conversation
    # ended" gap (last chunk old enough) are ready to transcribe.
    #
    # Stale-group escape hatch: if the last chunk is older than
    # OMI_STALE_AFTER_SECONDS (default 1h), no new chunks will ever arrive
    # to grow the group, so we bypass the MIN_SPEECH_CHUNKS gate as long
    # as there's at least 1 speech chunk. Without this, single-chunk
    # groups in stale audio backlogs jam the queue forever — the cap-500
    # oldest-first scan keeps re-encountering them every run, never
    # makes progress.
    #
    # Surfaced 2026-05-08 on david: 37,480-file backlog included 337
    # speech chunks scattered into 269 single/double-chunk groups
    # (likely OMI was put on for short bursts then taken off). With
    # MIN_SPEECH_CHUNKS=3, all 269 were rejected, none moved to
    # processed/, and they permanently sat at the head of the
    # oldest-first scan queue blocking forward progress.
    now_ms = int(time.time() * 1000)
    stale_threshold_ms = (
        int(os.environ.get("OMI_STALE_AFTER_SECONDS", "3600")) * 1000
    )
    ready_groups: list[list[dict[str, Any]]] = []

    for group in groups:
        if not group:
            continue
        latest_speech_ts = max(f["timestamp"] for f in group)
        age_ms = now_ms - latest_speech_ts

        # Below the chunk-count gate AND fresh enough that new chunks
        # might still arrive: defer.
        if len(group) < MIN_SPEECH_CHUNKS and age_ms < stale_threshold_ms:
            logger.info(
                "[omi] Group not ready (waiting for more chunks): uid=%s, %d speech chunks, last speech %ds ago",
                group[0]["uid"], len(group), age_ms // 1000,
            )
            continue

        # Conversation-ended gate: last chunk must be old enough.
        if age_ms < READY_AGE_SECONDS * 1000:
            logger.info(
                "[omi] Group not ready (still active): uid=%s, %d speech chunks, last speech %ds ago",
                group[0]["uid"], len(group), age_ms // 1000,
            )
            continue

        # Ready: either ≥MIN_SPEECH_CHUNKS or stale enough that we
        # accept a smaller group as final.
        ready_groups.append(group)
        if len(group) < MIN_SPEECH_CHUNKS:
            logger.info(
                "[omi] Stale group accepted with only %d chunks (last speech %ds ago > %ds threshold)",
                len(group), age_ms // 1000, stale_threshold_ms // 1000,
            )

    logger.info(
        "[omi] Grouped: %d files scanned, %d speech, %d silent discarded, %d groups, %d ready",
        len(files), len(speech_files), len(silent_files), len(groups), len(ready_groups),
    )
    return ready_groups


@activity.defn
async def transcribe_audio_group(group: list[dict[str, Any]]) -> dict[str, Any]:
    """Read and concatenate PCM files in a group, transcribe via Groq Whisper API.

    Uses Groq's hosted whisper-large-v3 for fast transcription (~3s per 5min).
    Platform-level API key — tenants don't need to provide their own.
    Returns {text, language, duration_seconds, segment_count}.
    """
    if not group:
        return {"text": "", "language": "", "duration_seconds": 0, "segment_count": 0}

    # Concatenate PCM bytes in timestamp order
    sorted_group = sorted(group, key=lambda f: f["timestamp"])
    pcm_chunks: list[bytes] = []
    sample_rate = sorted_group[0].get("sample_rate", 16000)

    for seg in sorted_group:
        pcm_path = Path(seg["path"])
        if pcm_path.exists():
            pcm_chunks.append(pcm_path.read_bytes())

    if not pcm_chunks:
        return {"text": "", "language": "", "duration_seconds": 0, "segment_count": 0}

    pcm_bytes = b"".join(pcm_chunks)

    # Calculate duration: PCM16 = 2 bytes per sample
    duration_seconds = len(pcm_bytes) / (sample_rate * 2)

    # Convert to WAV for the API
    wav_bytes = pcm_to_wav(pcm_bytes, sample_rate=sample_rate)

    # Transcribe via Groq Whisper API
    result = await _transcribe_groq(wav_bytes, duration_seconds)

    text = result.get("text", "")
    language = result.get("language", "")

    logger.info(
        "[omi] Transcribed group: uid=%s, %d segments, %.1fs, %d chars, lang=%s",
        sorted_group[0]["uid"],
        len(sorted_group),
        duration_seconds,
        len(text),
        language,
    )

    return {
        "text": text,
        "language": language,
        "language_probability": result.get("language_probability", 0),
        "duration_seconds": round(duration_seconds, 1),
        "segment_count": len(sorted_group),
    }


# Platform-level Groq API key — shared across all tenants.
# Groq runs whisper-large-v3 on their LPU hardware (~3s per 5min audio).
# Set GROQ_API_KEY in the tenant's .env file. The init container provisions it.
_GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
_GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions"


async def _transcribe_groq(wav_bytes: bytes, duration_seconds: float) -> dict[str, Any]:
    """Transcribe audio via Groq's Whisper API (OpenAI-compatible).

    Sends WAV bytes as multipart form upload. Returns {text, language, language_probability}.
    """
    import tempfile

    # Write temp file — httpx needs a file path for multipart upload
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(wav_bytes)
        tmp_path = tmp.name

    if not _GROQ_API_KEY:
        logger.error("[omi] GROQ_API_KEY not set — cannot transcribe audio")
        return {"text": "", "language": "", "language_probability": 0}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            with open(tmp_path, "rb") as audio_file:
                resp = await client.post(
                    _GROQ_API_URL,
                    headers={"Authorization": f"Bearer {_GROQ_API_KEY}"},
                    data={
                        "model": "whisper-large-v3",
                        "response_format": "verbose_json",
                    },
                    files={"file": ("audio.wav", audio_file, "audio/wav")},
                )

            if resp.status_code != 200:
                logger.error("[omi] Groq API error %d: %s", resp.status_code, resp.text[:200])
                return {"text": "", "language": "", "language_probability": 0}

            data = resp.json()
            return {
                "text": data.get("text", ""),
                "language": data.get("language", ""),
                "language_probability": 0.95,  # Groq doesn't return probability
            }
    except Exception as exc:
        logger.error("[omi] Groq transcription failed: %s", exc)
        return {"text": "", "language": "", "language_probability": 0}
    finally:
        os.unlink(tmp_path)


@activity.defn
async def ingest_omi_transcription(
    stream_id: str,
    transcription: dict[str, Any],
    group: list[dict[str, Any]],
) -> str:
    """Create stream event in omi conversation format and POST to ctrl /api/v1/streams/ingest.

    Marks audio files as processed by moving them to a processed/ subdirectory.
    Returns the event_id from ctrl, or empty string on failure.
    """
    text = transcription.get("text", "")
    lang_prob = transcription.get("language_probability", 0)
    word_count = len(text.split()) if text.strip() else 0

    # Quality gate — discard hallucinated / noise transcriptions
    discard_reason = ""
    if not text.strip():
        discard_reason = "empty transcription"
    elif lang_prob < 0.5:
        discard_reason = f"low language confidence ({lang_prob})"
    elif word_count < 5:
        discard_reason = f"too few words ({word_count})"

    if discard_reason:
        logger.info("[omi] Discarding transcription: %s — text: %s", discard_reason, text[:80])
        _move_to_processed(group)
        return ""

    language = transcription.get("language", "")
    duration_seconds = transcription.get("duration_seconds", 0)
    segment_count = transcription.get("segment_count", 0)

    sorted_group = sorted(group, key=lambda f: f["timestamp"])
    first_ts = sorted_group[0]["timestamp"]
    last_ts = sorted_group[-1]["timestamp"]
    uid = sorted_group[0]["uid"]
    conv_id = sorted_group[0].get("conversation_id", "")
    part = sorted_group[0].get("part", 1)
    total_parts = sorted_group[0].get("total_parts", 1)

    from datetime import datetime, timezone

    start_dt = datetime.fromtimestamp(first_ts / 1000, tz=timezone.utc)
    end_dt = datetime.fromtimestamp(last_ts / 1000, tz=timezone.utc)
    date_str = start_dt.strftime("%Y-%m-%d")
    time_range = f"{start_dt.strftime('%H:%M')}-{end_dt.strftime('%H:%M')}"

    source_ref = f"omi-audio:{uid}:{first_ts}"
    word_count = len(text.split())

    part_label = f" (part {part}/{total_parts})" if total_parts > 1 else ""

    raw_payload = {
        "date": date_str,
        "time_range": time_range,
        "languages": [language] if language else [],
        "segments": segment_count,
        "duration_seconds": duration_seconds,
        "word_count": word_count,
        "conversation_id": conv_id,
        "part": part,
        "total_parts": total_parts,
        "text": f"Date: {date_str} | Time: {time_range} | Language: {language}{part_label}\n\n{text}",
    }

    # Build summary
    duration_str = f"{int(duration_seconds) // 60}m{int(duration_seconds) % 60}s"
    summary = f"Omi conversation ({date_str} {time_range}, {duration_str}, {word_count} words, {language}){part_label}"

    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    event_id = ""
    async with httpx.AsyncClient(
        base_url=config.alfred_ctrl_url,
        timeout=30.0,
        headers=headers,
    ) as client:
        try:
            resp = await client.post(
                "/api/v1/streams/ingest",
                json={
                    "stream_id": stream_id,
                    "stream_type": "omi-audio",
                    "source_ref": source_ref,
                    "received_at": start_dt.isoformat(),
                    "raw": raw_payload,
                    "summary": summary,
                    "metadata": {
                        "uid": uid,
                        "date": date_str,
                        "time_range": time_range,
                        "languages": [language] if language else [],
                        "segments": segment_count,
                        "duration_seconds": duration_seconds,
                        "word_count": word_count,
                        "parser": "omi",
                        "event_type": "omi-conversation",
                        "source": "omi-audio-pipeline",
                        "conversation_id": conv_id,
                        "part": part,
                        "total_parts": total_parts,
                    },
                },
            )
            if resp.status_code in (200, 201):
                event_id = resp.json().get("event_id", "")
                logger.info("[omi] Ingested transcription: event_id=%s", event_id)
            else:
                logger.warning("[omi] Ingest returned %d: %s", resp.status_code, resp.text)
        except Exception as exc:
            logger.error("[omi] Ingest failed: %s", exc)

    # Move processed audio files
    _move_to_processed(group)

    return event_id


def _move_to_processed(group: list[dict[str, Any]]) -> None:
    """Move audio files to a processed/ subdirectory."""
    for seg in group:
        pcm_path = Path(seg["path"])
        if not pcm_path.exists():
            continue

        processed_dir = pcm_path.parent / "processed"
        processed_dir.mkdir(exist_ok=True)

        # Move PCM file
        dest = processed_dir / pcm_path.name
        try:
            shutil.move(str(pcm_path), str(dest))
        except Exception as exc:
            logger.warning("[omi] Failed to move %s: %s", pcm_path, exc)

        # Move metadata file if exists
        meta_path = pcm_path.with_suffix(".meta.json")
        if meta_path.exists():
            meta_dest = processed_dir / meta_path.name
            try:
                shutil.move(str(meta_path), str(meta_dest))
            except Exception as exc:
                logger.warning("[omi] Failed to move %s: %s", meta_path, exc)
