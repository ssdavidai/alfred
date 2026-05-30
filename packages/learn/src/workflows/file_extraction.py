"""FileExtractionWorkflow — one-shot per-upload extraction pipeline.

Background
----------

Issue #114 Lane B closes the principal-visible UX promise of §14
step 3: a file dropped on /files gets read by Alfred within 30 seconds,
a one-paragraph summary appears, and the "Alfred read it" badge lights
up on the row.

This workflow is a **one-shot, fire-and-forget** chain triggered by
ctrl-api's upload route (``triggerFileExtraction`` in
``packages/ctrl/src/api/routes/files.ts``). It is not on a Temporal
Schedule — there is one workflow execution per file. The workflow id is
``file-extract-<file_id>``, so a duplicate trigger on the same upload
is a no-op (Temporal rejects with ALREADY_EXISTS, which the trigger
swallows).

Flow
----

1. ``read_file_metadata(file_id)`` — fetch the row's mime + path. If
   the file is gone (404) or the mime is unsupported, jump to step 3
   with ``extraction_error="unsupported_mime"``.
2. ``fetch_and_extract_text(file_id, content_type, path)`` — fetch the
   blob bytes, run the per-mime extractor, return the trimmed text.
3. ``summarise_extracted_text(...)`` — workers gateway one-shot
   summary. Returns a single short paragraph.
4. ``stamp_extraction_result(file_id, alfred_read_at, summary,
   extraction_error)`` — PATCH the row.

Any step that raises ``ExtractionError`` (the classified taxonomy from
``src.activities.file_extraction``) routes straight to step 4 with the
corresponding error code. Genuine Temporal-retryable failures
(network, 5xx) leverage the activity's default RetryPolicy until the
envelope expires.

Design notes
------------

* Pure orchestration — all blob / clerk / state.db interaction lives
  in the activity layer, exactly as ``FilesColdArchiveWorkflow``
  follows.
* Idempotent — workflow id keyed on ``file_id``. A duplicate trigger
  is silently rejected by Temporal. A re-fire via
  ``POST /api/v1/files/:file_id/extract`` uses a fresh start (ctrl-api
  side clears the prior error first; the workflow id collides only
  while the previous run is still in flight, which is the desired
  semantics — one extraction at a time per file).
* Bounded — the whole run has to land inside 30s of wall-clock for
  the §14 promise. The summary call dominates; we give it the same
  900s clerk budget as every other workers-gateway shot, but the
  typical case is single-digit seconds for a small PDF.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.clerk import (
        CLERK_ACTIVITY_HEARTBEAT_SECONDS,
        CLERK_ACTIVITY_TIMEOUT_SECONDS,
    )
    from src.activities.file_extraction import (
        fetch_and_extract_text,
        read_file_metadata,
        stamp_extraction_result,
        summarise_extracted_text,
    )


@dataclass
class FileExtractionInput:
    """Workflow argument shape.

    ctrl-api's trigger sends ``{file_id: "<ULID>"}``; the dataclass
    keeps the schema explicit + future-proofs for adding a forced
    re-extract flag later.
    """

    file_id: str


@dataclass
class FileExtractionResult:
    file_id: str
    alfred_read_at: int | None = None
    summary: str | None = None
    extraction_error: str | None = None
    extractor: str | None = None
    char_count: int = 0


# Light retry policy for the meta + stamp activities — both are quick
# ctrl-api HTTP calls. The extraction + summariser activities each
# manage their own retry envelope (extraction is mostly pure; summariser
# uses the clerk timeout).
_QUICK_RETRY = RetryPolicy(
    maximum_attempts=3,
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=5),
)


def _is_extraction_error(exc: BaseException) -> bool:
    """Match the activity's ``ExtractionError`` even after Temporal
    rewraps it as an ApplicationError. The error's ``type`` survives
    the wrap, and the message carries the code at the head."""
    cls = type(exc).__name__
    if cls == "ExtractionError":
        return True
    # Temporal wraps activity failures in ActivityError; the cause
    # exposes the original ApplicationError whose `type` attribute equals
    # the original class name.
    cause = getattr(exc, "cause", None)
    if cause is not None:
        cause_type = getattr(cause, "type", None) or type(cause).__name__
        if cause_type == "ExtractionError":
            return True
    return False


def _extraction_error_code(exc: BaseException) -> str:
    """Extract the short `code` from an ExtractionError or its
    Temporal-wrapped envelope. Falls back to ``extractor_failed``.

    ``ExtractionError.__str__`` is contracted to emit ``"<code>: <msg>"``
    (or just ``"<code>"`` if no message), so a head-split before the
    first colon always recovers the original code. We walk a chain of
    candidate sources in order: the direct ``.code`` attr, the
    ``.cause.code`` attr (Temporal's ActivityError wraps an
    ApplicationError), then the head-split fallbacks on each str.
    """
    code = getattr(exc, "code", None)
    if isinstance(code, str) and code:
        return code
    cause = getattr(exc, "cause", None)
    if cause is not None:
        c2 = getattr(cause, "code", None)
        if isinstance(c2, str) and c2:
            return c2
        # The wrapped message tends to look like "unsupported_mime: ...".
        msg = str(cause).strip()
        head = _split_code_head(msg)
        if head:
            return head
    head = _split_code_head(str(exc).strip())
    if head:
        return head
    return "extractor_failed"


_VALID_CODE_HEADS = (
    "unsupported_mime",
    "extractor_failed",
    "empty_pdf",
    "empty_docx",
    "empty_xlsx",
    "empty_extraction",
    "summariser_failed",
    "stamp_failed",
    "metadata_fetch_failed",
    "missing_path",
    "missing_file_id",
    "not_found",
)


def _split_code_head(s: str) -> str | None:
    """Take the head of ``s`` before the first colon and return it
    if it looks like one of our known reason codes.

    The Temporal-wrapped str typically looks like::

        "ExtractionError: unsupported_mime: test mime"

    So we walk colon-splits and return the first head that matches
    the known set."""
    if not s:
        return None
    parts = [p.strip() for p in s.split(":")]
    for p in parts:
        if p in _VALID_CODE_HEADS:
            return p
    return None


@workflow.defn(name="FileExtractionWorkflow")
class FileExtractionWorkflow:
    """Single-pass extract → summarise → stamp chain."""

    @workflow.run
    async def run(self, arg: FileExtractionInput | dict) -> FileExtractionResult:
        # ctrl-api sends a plain dict over the wire (temporal CLI
        # serialises the --input JSON verbatim); the test harness uses
        # the dataclass. Accept both.
        if isinstance(arg, dict):
            file_id = str(arg.get("file_id") or "")
        else:
            file_id = arg.file_id
        if not file_id:
            return FileExtractionResult(
                file_id="",
                extraction_error="missing_file_id",
            )

        workflow.logger.info("file_extraction.start file_id=%s", file_id)
        result = FileExtractionResult(file_id=file_id)

        # ── step 1: read metadata ────────────────────────────────────
        try:
            row = await workflow.execute_activity(
                read_file_metadata,
                args=[file_id],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=_QUICK_RETRY,
            )
        except Exception as exc:  # noqa: BLE001
            workflow.logger.warning(
                "file_extraction: metadata fetch failed for %s: %s",
                file_id, exc,
            )
            code = (
                _extraction_error_code(exc)
                if _is_extraction_error(exc)
                else "metadata_fetch_failed"
            )
            return await self._stamp_error(file_id, code, result)

        content_type = row.get("content_type") if isinstance(row, dict) else None
        path = row.get("path") if isinstance(row, dict) else None
        original_filename = (
            row.get("original_filename") if isinstance(row, dict) else None
        )
        if not isinstance(path, str) or not path:
            return await self._stamp_error(file_id, "missing_path", result)

        # ── step 2: fetch + extract ─────────────────────────────────
        try:
            extracted = await workflow.execute_activity(
                fetch_and_extract_text,
                args=[file_id, content_type, path],
                # Extraction is mostly pure Python over a bounded blob;
                # 90s envelope covers a multi-page PDF on a small VM.
                start_to_close_timeout=timedelta(seconds=90),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as exc:  # noqa: BLE001
            code = (
                _extraction_error_code(exc)
                if _is_extraction_error(exc)
                else "extractor_failed"
            )
            workflow.logger.info(
                "file_extraction: extract failed for %s (code=%s): %s",
                file_id, code, exc,
            )
            return await self._stamp_error(file_id, code, result)

        text = str(extracted.get("text") or "")
        char_count = int(extracted.get("char_count") or 0)
        truncated = bool(extracted.get("truncated_for_summary"))
        extractor = str(extracted.get("extractor") or "")
        result.char_count = char_count
        result.extractor = extractor
        if not text.strip():
            return await self._stamp_error(file_id, "empty_extraction", result)

        # ── step 3: summarise via workers gateway ───────────────────
        try:
            summary = await workflow.execute_activity(
                summarise_extracted_text,
                args=[file_id, text, original_filename, content_type, truncated],
                start_to_close_timeout=timedelta(
                    seconds=int(CLERK_ACTIVITY_TIMEOUT_SECONDS),
                ),
                heartbeat_timeout=timedelta(
                    seconds=int(CLERK_ACTIVITY_HEARTBEAT_SECONDS),
                ),
                retry_policy=RetryPolicy(
                    # The clerk classifies 401/402/403/billing as
                    # non-retryable already; one extra attempt covers
                    # transient gateway 5xx.
                    maximum_attempts=2,
                    initial_interval=timedelta(seconds=2),
                    backoff_coefficient=2.0,
                ),
            )
        except Exception as exc:  # noqa: BLE001
            code = (
                _extraction_error_code(exc)
                if _is_extraction_error(exc)
                else "summariser_failed"
            )
            workflow.logger.info(
                "file_extraction: summarise failed for %s (code=%s): %s",
                file_id, code, exc,
            )
            return await self._stamp_error(file_id, code, result)

        # ── step 4: stamp success ───────────────────────────────────
        # workflow.now() is the deterministic clock; convert to unix
        # milliseconds for ctrl-api parity.
        now_ms = int(workflow.now().timestamp() * 1000)
        try:
            await workflow.execute_activity(
                stamp_extraction_result,
                args=[file_id, now_ms, summary, None],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=_QUICK_RETRY,
            )
        except Exception as exc:  # noqa: BLE001
            # Stamp failure is the WORST — we did the work but couldn't
            # write the result. Log loudly; the row will retry on the
            # operator's next manual extract.
            workflow.logger.error(
                "file_extraction: stamp failed for %s: %s", file_id, exc,
            )
            result.extraction_error = "stamp_failed"
            return result

        result.alfred_read_at = now_ms
        result.summary = summary
        workflow.logger.info(
            "file_extraction.done file_id=%s extractor=%s chars=%d summary_chars=%d",
            file_id, extractor, char_count, len(summary),
        )
        return result

    async def _stamp_error(
        self,
        file_id: str,
        code: str,
        result: FileExtractionResult,
    ) -> FileExtractionResult:
        """Record a classified failure on the row.

        The stamp itself is best-effort; if even THAT fails we just
        return the in-memory result so Temporal records the run.
        """
        result.extraction_error = code
        try:
            await workflow.execute_activity(
                stamp_extraction_result,
                args=[file_id, None, None, code],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=_QUICK_RETRY,
            )
        except Exception as exc:  # noqa: BLE001
            workflow.logger.warning(
                "file_extraction: error-stamp failed for %s (code=%s): %s",
                file_id, code, exc,
            )
        return result
