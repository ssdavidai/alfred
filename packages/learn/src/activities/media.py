"""Media file processing activities."""

from __future__ import annotations

import mimetypes
from typing import Any

from temporalio import activity

# File type categories
AUDIO_MIMES = {"audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm", "audio/x-m4a"}
DOCUMENT_MIMES = {"application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"}
IMAGE_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
VIDEO_MIMES = {"video/mp4", "video/webm", "video/quicktime"}


@activity.defn
async def detect_file_type(event: dict[str, Any]) -> str:
    """Detect file type category from MIME type or extension (Python — deterministic).

    Returns one of: audio, document, image, video, unknown
    """
    mime_type = event.get("mime_type", "")
    file_name = event.get("file_name", "")

    if not mime_type and file_name:
        mime_type, _ = mimetypes.guess_type(file_name)
        mime_type = mime_type or ""

    if mime_type in AUDIO_MIMES:
        return "audio"
    if mime_type in DOCUMENT_MIMES:
        return "document"
    if mime_type in IMAGE_MIMES:
        return "image"
    if mime_type in VIDEO_MIMES:
        return "video"

    # Fallback: check extension
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    ext_map = {
        "mp3": "audio", "wav": "audio", "ogg": "audio", "m4a": "audio",
        "pdf": "document", "doc": "document", "docx": "document", "txt": "document",
        "png": "image", "jpg": "image", "jpeg": "image", "gif": "image", "webp": "image",
        "mp4": "video", "webm": "video", "mov": "video",
    }
    return ext_map.get(ext, "unknown")


@activity.defn
async def process_audio(event: dict[str, Any]) -> dict[str, Any]:
    """Process audio file — call Clerk for transcription/summarization."""
    from src.activities.clerk import clerk_process_media

    return await clerk_process_media(
        "audio",
        event.get("file_path", ""),
        event.get("context", {}),
    )


@activity.defn
async def process_document(event: dict[str, Any]) -> dict[str, Any]:
    """Process document file — call Clerk to extract text + classify."""
    from src.activities.clerk import clerk_process_media

    return await clerk_process_media(
        "document",
        event.get("file_path", ""),
        event.get("context", {}),
    )


@activity.defn
async def process_image(event: dict[str, Any]) -> dict[str, Any]:
    """Process image file — call Clerk to describe + OCR."""
    from src.activities.clerk import clerk_process_media

    return await clerk_process_media(
        "image",
        event.get("file_path", ""),
        event.get("context", {}),
    )
