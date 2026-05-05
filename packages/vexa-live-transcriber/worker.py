"""vexa-live-transcriber — chunk-watcher for near-live transcripts via Groq.

Polls postgres for active meetings + recordings, lists MinIO chunks under
recordings/{user_id}/{recording_id}/{session_uid}/audio/, transcribes each
new chunk via Groq whisper-large-v3-turbo, XADDs segments to the
transcription_segments Redis stream so meeting-api's collector picks them
up and they flow to the dashboard's live view.

Chunk timing: bot's MediaRecorder produces 30s chunks. Worker polls every
8s, so worst-case lag from speech to transcript = 30s + 8s + ~2s Groq
latency = ~40s. Good enough for "near-live"; not realtime.
"""
import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone

import asyncpg
import httpx
from minio import Minio
from redis import asyncio as aioredis

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("transcriber")

GROQ_URL = os.environ["GROQ_URL"]
GROQ_TOKEN = os.environ["GROQ_TOKEN"]
GROQ_MODEL = os.environ.get("GROQ_MODEL", "whisper-large-v3-turbo")
REDIS_URL = os.environ["REDIS_URL"]
PG_DSN = os.environ["PG_DSN"]
MINIO_ENDPOINT = os.environ["MINIO_ENDPOINT"]
MINIO_BUCKET = os.environ["MINIO_BUCKET"]
MINIO_ACCESS = os.environ["MINIO_ACCESS_KEY"]
MINIO_SECRET = os.environ["MINIO_SECRET_KEY"]
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "8"))
CHUNK_DURATION = float(os.environ.get("CHUNK_DURATION_S", "30.0"))

processed: dict[str, set[int]] = {}


async def fetch_speaker_events(redis_c, session_uid: str) -> list[dict]:
    """Read SPEAKER_START events for ``session_uid`` from the Redis stream.

    The vexa bot pushes events into ``speaker_events_relative`` as they
    occur (relative_client_timestamp_ms measured from session start).
    We filter by ``uid`` and return events sorted by timestamp.
    """
    out: list[dict] = []
    try:
        entries = await redis_c.xrange("speaker_events_relative", min="-", max="+", count=5000)
    except Exception as e:
        log.warning("xrange speaker_events_relative err=%s", e)
        return out
    for _msg_id, fields in entries:
        if fields.get("uid") != session_uid:
            continue
        try:
            ts_ms = float(fields.get("relative_client_timestamp_ms") or 0)
        except (TypeError, ValueError):
            continue
        out.append({
            "ts_ms": ts_ms,
            "event_type": fields.get("event_type"),
            "participant_name": fields.get("participant_name"),
        })
    out.sort(key=lambda e: e["ts_ms"])
    return out


def speaker_for_segment(events: list[dict], seg_end_s: float) -> str | None:
    """Pick the most recent SPEAKER_START before seg_end. Vexa often
    emits one SPEAKER_START per participant per session, so the latest
    one before our segment ends is the active speaker for that segment.
    """
    if not events:
        return None
    seg_end_ms = seg_end_s * 1000.0
    last: dict | None = None
    for e in events:
        if e["ts_ms"] > seg_end_ms:
            break
        if e.get("event_type") == "SPEAKER_START":
            last = e
    return last.get("participant_name") if last else None


async def fetch_active_recordings(pool):
    sql = """
    SELECT m.id AS meeting_id,
           m.user_id,
           m.platform,
           m.platform_specific_id AS native_meeting_id,
           r->>'id' AS recording_id,
           r->>'session_uid' AS session_uid,
           r->>'first_chunk_at' AS first_chunk_at
    FROM meetings m,
         jsonb_array_elements(COALESCE(m.data->'recordings', '[]'::jsonb)) r
    WHERE m.status IN ('active', 'requested', 'awaiting_admission')
      AND r->>'completed_at' IS NULL
      AND r->>'session_uid' IS NOT NULL
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql)
    return [dict(r) for r in rows]


async def transcribe_audio(http: httpx.AsyncClient, audio: bytes, fmt: str) -> list[dict]:
    files = {"file": (f"chunk.{fmt}", audio, f"audio/{fmt}")}
    data = {
        "model": GROQ_MODEL,
        "response_format": "verbose_json",
        "timestamp_granularities[]": "segment",
    }
    headers = {"Authorization": f"Bearer {GROQ_TOKEN}"}
    r = await http.post(GROQ_URL, files=files, data=data, headers=headers, timeout=120.0)
    r.raise_for_status()
    payload = r.json()
    return payload.get("segments") or []


async def publish_segments(redis_c, meeting: dict, chunk_seq: int, segments: list[dict]):
    if not segments:
        return 0
    chunk_offset = chunk_seq * CHUNK_DURATION
    speaker_events = await fetch_speaker_events(redis_c, meeting["session_uid"])
    out = []
    for s in segments:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        try:
            start = chunk_offset + float(s.get("start", 0))
            end = chunk_offset + float(s.get("end", 0))
        except (TypeError, ValueError):
            continue
        if end - start < 1e-3:
            continue
        speaker_name = speaker_for_segment(speaker_events, end)
        seg_out = {
            "text": text,
            "start": start,
            "end": end,
            "language": payload_lang(s),
            "completed": True,
            "segment_id": f"live:{meeting['meeting_id']}:{chunk_seq}:{s.get('id', uuid.uuid4().hex[:8])}",
        }
        if speaker_name:
            seg_out["speaker"] = speaker_name
        out.append(seg_out)
    if not out:
        return 0
    payload = json.dumps({
        "type": "transcription",
        "meeting_id": meeting["meeting_id"],
        "platform": meeting["platform"],
        "native_meeting_id": meeting["native_meeting_id"],
        "uid": meeting["session_uid"],
        "segments": out,
    })
    await redis_c.xadd("transcription_segments", {"payload": payload})
    return len(out)


def payload_lang(seg: dict) -> str:
    return seg.get("language") or "en"


async def process_meeting(meeting: dict, minio_c: Minio, http: httpx.AsyncClient, redis_c):
    rid = meeting["recording_id"]
    sid = meeting["session_uid"]
    uid = meeting["user_id"]
    if not rid or not sid:
        return
    state = processed.setdefault(rid, set())
    prefix = f"recordings/{uid}/{rid}/{sid}/audio/"
    try:
        objects = list(minio_c.list_objects(MINIO_BUCKET, prefix=prefix))
    except Exception as e:
        log.warning("list_objects %s err=%s", prefix, e)
        return
    chunks = []
    for o in objects:
        name = o.object_name.rsplit("/", 1)[-1]
        if name == "master.webm":
            continue
        stem = name.rsplit(".", 1)[0]
        try:
            seq = int(stem)
        except ValueError:
            continue
        chunks.append((seq, o.object_name, name.rsplit(".", 1)[-1]))
    chunks.sort()
    # Skip the most recent chunk — it may still be uploading. Wait one pass.
    if chunks:
        chunks = chunks[:-1]
    for seq, key, fmt in chunks:
        if seq in state:
            continue
        try:
            blob = minio_c.get_object(MINIO_BUCKET, key)
            audio = blob.read()
            blob.close()
            blob.release_conn()
        except Exception as e:
            log.warning("get_object %s err=%s", key, e)
            continue
        if not audio:
            continue
        try:
            segs = await transcribe_audio(http, audio, fmt)
        except Exception as e:
            log.warning("transcribe meeting=%s seq=%s err=%s", meeting["meeting_id"], seq, e)
            continue
        n = await publish_segments(redis_c, meeting, seq, segs)
        state.add(seq)
        log.info("meeting=%s seq=%s segments=%d bytes=%d", meeting["meeting_id"], seq, n, len(audio))


async def main():
    log.info("vexa-live-transcriber starting (poll=%ss model=%s)", POLL_INTERVAL, GROQ_MODEL)
    pool = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=4)
    redis_c = aioredis.from_url(REDIS_URL, decode_responses=True)
    minio_host = MINIO_ENDPOINT.replace("http://", "").replace("https://", "")
    minio_c = Minio(minio_host, access_key=MINIO_ACCESS, secret_key=MINIO_SECRET, secure=False)
    async with httpx.AsyncClient() as http:
        while True:
            t0 = time.time()
            try:
                meetings = await fetch_active_recordings(pool)
                if meetings:
                    log.info("active recordings: %d", len(meetings))
                for m in meetings:
                    await process_meeting(m, minio_c, http, redis_c)
            except Exception as e:
                log.exception("loop error: %s", e)
            elapsed = time.time() - t0
            await asyncio.sleep(max(0.5, POLL_INTERVAL - elapsed))


if __name__ == "__main__":
    asyncio.run(main())
