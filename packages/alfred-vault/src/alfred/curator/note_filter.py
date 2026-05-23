"""Pre-write filter for per-service-sender summary notes.

Stage-1 of the curator pipeline occasionally produces aggregator notes
named after a single mail sender — "GitHub Activity Summary", "Canva
Service Emails Summary", "Replit Email Digest - May 23, 2026", etc.
These are *bookkeeping* (per-domain volume already lives in
``onboard.json[top_domains]``), not principal content. Per the
promotion contract (``CLAUDE.md``: *the vault is the principal's
surface; machine bookkeeping → SQLite/log*), they must not be written
as canonical vault notes.

Centralising the rule here keeps it stdlib-only — no ``structlog``,
no vault-ops import — so the test environment can exercise it
without dragging in the wider curator stack.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

log = logging.getLogger(__name__)


# C-OB1: per-service-sender summary names.
# Leading ``[A-Za-z0-9.]+`` is the single-word service identifier
# ("GitHub", "Canva", "Kit.com", ...); the alternation is the digest
# phrasing the LLM keeps reaching for. We deliberately do *not* anchor
# the end of the string — "Canva Service Emails Summary" and bare
# "Canva Service Emails" both match, as do dated forms like
# "Replit Email Digest - May 23, 2026".
_PER_SERVICE_SUMMARY_RE = re.compile(
    r"^[A-Za-z0-9.]+ "
    r"(Service Emails"
    r"|Email Digest"
    r"|Activity"
    r"|Notifications? Summary"
    r"|Service & Notification Summary)"
)


def _is_per_service_summary_note(name: str) -> bool:
    """True iff ``name`` is a per-service-sender summary that must not
    be written as a principal vault note. Empty/whitespace input
    returns False (that's a stage-1 failure, not a junk match)."""
    if not name or not name.strip():
        return False
    return _PER_SERVICE_SUMMARY_RE.match(name) is not None


def _suppress_per_service_summary(vault_path: Path, note_path: str) -> str:
    """If ``note_path`` points at a junk per-service-sender summary,
    delete the freshly-created file and return "" so the caller treats
    it as no-note-created. Otherwise return ``note_path`` unchanged.

    ``note_path`` is the vault-relative path ("note/<name>.md") returned
    by ``_find_created_note``. The file was written milliseconds ago by
    stage 1 — we remove it before interlink/enrich wire it into the
    principal's graph. ``unlink(missing_ok=True)`` keeps the call safe
    if the path doesn't exist on disk for any reason.
    """
    if not note_path:
        return ""

    name = Path(note_path).stem
    if not _is_per_service_summary_note(name):
        return note_path

    target = vault_path / note_path
    try:
        target.unlink(missing_ok=True)
    except OSError as exc:
        # Worst case: a junk note survives one cycle; the janitor will
        # clean it up. Never crash the pipeline on a delete failure.
        log.warning(
            "curator: failed to delete per-service-sender note %s: %s",
            note_path,
            exc,
        )

    log.info(
        "curator: dropping per-service-sender note %s "
        "(belongs in observations log, not principal vault)",
        note_path,
    )
    return ""
