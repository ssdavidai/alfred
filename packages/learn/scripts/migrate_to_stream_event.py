"""One-shot migrator: vault/event/ + vault/conversation/ → vault/stream_event/.

Phase 6.6 unifies the legacy ``event/`` (gmail, slack, notion, gcal,
github, openclaw-chat audit, generic) and ``conversation/`` (omi-audio,
voice-call, openclaw-chat) directories into a single ``stream_event/``
directory. Each migrated record gets a ``source_type`` frontmatter
field disambiguating the origin (gmail / slack / omi / openclaw-chat /
vexa / sure / gcal / plane / vault_edit / generic).

Stream-event records under ``event/`` are migrated; **steward-audit**
records (``steward-action-*``, ``signal-action-*``,
``auto-task-created-*``, ``needs_attention_action-*``,
``signal-mutation-*``), **daily-digest-*** reports, and the on-disk
nested daily-digest tree under ``event/<year>/<mm>/<dd>/`` are LEFT
WHERE THEY ARE — they are not stream events.

All ``conversation/`` records are migrated unconditionally. Default
``source_type`` is inferred from the existing ``stream_type`` /
``source_ref`` / ``tags`` fields and falls through to ``"omi"`` for
legacy records that pre-date the field.

Idempotency: re-running is safe. A record already at the target path
with identical content is skipped (counted as "already at target"). A
target with DIFFERENT content is treated as an error and aborts the
move so we never silently overwrite.

Reversibility: before every move the source file is copied to
``vault/.backup/migrate-stream-event-<utc-timestamp>/<old-relative-
path>``. The backup tree mirrors the original layout so an operator
can restore by copying it back.

Wikilink rewriting: after all moves complete, every record under
``matter/``, ``task/``, ``signal/``, ``instinct/``, ``intuition/``,
``event/``, ``stream_event/``, ``needs_attention/`` is scanned for
``[[event/<stem>]]`` and ``[[conversation/<stem>]]`` references that
match a migrated record and rewritten in-place to
``[[stream_event/<source_type>-<stem>]]``. Aliased links
(``[[old|alias]]``) preserve the alias verbatim.

The migrator is the SOLE exception to the "vault writes go through
ctrl-api" rule because:

  * Thousands of moves through the HTTP API would be ~5-10x slower.
  * We need atomic-feeling rename semantics — a single read → write →
    delete cycle, executed under no other concurrent writers (the
    operator stops the alfred-learn worker before invoking us).

USAGE
-----

Invoke from inside the alfred-learn container::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.migrate_to_stream_event [--dry-run] [--verbose]

Flags:

    --dry-run     Print what would happen, make no changes.
    --verbose     Log every operation (per-file moves and link rewrites).
    --batch-size  Process at most N records this run (resumability).

Output: a summary with counts of records migrated, skipped (already at
target), errors, and wikilink rewrites.
"""

from __future__ import annotations

import argparse
import filecmp
import logging
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger("migrate-to-stream-event")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VAULT_PATH_DEFAULT = "/vault"

# Steward-audit and digest record prefixes — these are NOT stream events.
# Filenames matching any of these prefixes under ``event/`` stay where
# they are. ``conversation/`` has no such carve-outs (every record is
# a stream event).
STEWARD_AUDIT_PREFIXES: tuple[str, ...] = (
    "steward-action-",
    "signal-action-",
    "auto-task-created-",
    "needs_attention_action-",
    "signal-mutation-",
    "daily-digest-",
    "First Brief",
)

# Source-type values written into frontmatter on the new
# ``stream_event/`` records. Matches the Phase 6.0 PRE_FILTER_ALLOWLIST
# in src/activities/signals.py PLUS a "generic" sentinel for events
# whose stream_type didn't match anything (e.g. notion/github/payment
# records that pre-date Phase 6).
KNOWN_SOURCE_TYPES: set[str] = {
    "gmail",
    "slack",
    "omi",
    "openclaw-chat",
    "vexa",
    "sure",
    "gcal",
    "plane",
    "vault_edit",
    "generic",
}

# Legacy stream_type → source_type alias map. Mirrors the normalization
# in src/activities/signals.py:_normalize_source_type so a record
# carrying ``stream_type: agentmail`` still ends up classified as gmail.
STREAM_TYPE_ALIASES: dict[str, str] = {
    "email": "gmail",
    "agentmail": "gmail",
    "gmail-event": "gmail",
    "omi-audio": "omi",
    "voice-call": "omi",
    "openclaw_chat": "openclaw-chat",
    "openclaw": "openclaw-chat",
    "openclaw-session": "openclaw-chat",
    "vexa-transcript": "vexa",
    "vexa-meeting": "vexa",
    "calendar": "gcal",
    "google-calendar": "gcal",
    "google_calendar": "gcal",
    "scheduled": "gcal",
    "plane-issue": "plane",
    "plane_issue": "plane",
    "plane-comment": "plane",
    "plane-event": "plane",
    "vault-edit": "vault_edit",
    "vault-record-edit": "vault_edit",
    # Notion / github / payment / sms / conversation — pre-Phase-6
    # records that don't map cleanly to a Phase 6 source type. Tag as
    # "generic" so the migrator still relocates them; downstream
    # signal extraction will pre-filter them out.
}

# Frontmatter regex — matches the leading ``---\n...\n---`` block.
# We deliberately do NOT parse YAML (avoids a pyyaml dep + reduces
# scope for misformatted records). We instead use a line-by-line
# regex over the frontmatter chunk.
FRONTMATTER_RE = re.compile(
    r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL,
)
# Match a single frontmatter scalar key. Tolerates quoted + unquoted
# values, allows the value to be empty (which YAML treats as null).
FM_FIELD_RE = re.compile(
    r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$"
)

# Wikilink regex. Captures group(1)=type ("event" or "conversation"),
# group(2)=stem (no extension), group(3)=optional ``|alias`` suffix.
WIKILINK_RE = re.compile(
    r"\[\[(event|conversation)/([^\]\|]+?)(\|[^\]]+)?\]\]"
)

# Directories whose records can host wikilinks pointing at migrated
# stream events. We rewrite link targets in any of these.
WIKILINK_SCAN_DIRS: tuple[str, ...] = (
    "matter",
    "task",
    "signal",
    "instinct",
    "intuition",
    "event",
    "stream_event",
    "needs_attention",
    "note",
    "decision",
    "session",
    "synthesis",
    "reflection",
    "observation",
)


# ---------------------------------------------------------------------------
# Frontmatter helpers (string-level, no YAML parser)
# ---------------------------------------------------------------------------

def parse_frontmatter(content: str) -> tuple[dict[str, str], str, str]:
    """Return ``(scalars, fm_block_text, body_text)``.

    ``scalars`` maps top-level frontmatter keys to their RAW string
    values (quotes preserved). Multi-line / list / dict values are
    stored as the empty string — we only need scalar fields for the
    routing decision (``stream_type``, ``source_ref``, ``tags`` for
    inline-list tags).

    Records without a frontmatter block return ``({}, "", content)``.
    """
    m = FRONTMATTER_RE.match(content)
    if not m:
        return {}, "", content

    fm_block = m.group(1)
    body = content[m.end():]

    scalars: dict[str, str] = {}
    current_key: str | None = None
    for line in fm_block.splitlines():
        if not line.strip():
            current_key = None
            continue
        if line.startswith(" ") or line.startswith("\t") or line.startswith("-"):
            # Continuation of a list/dict — skip; scalars only.
            continue
        match = FM_FIELD_RE.match(line)
        if not match:
            current_key = None
            continue
        key, val = match.group(1), match.group(2)
        scalars[key] = val
        current_key = key

    return scalars, fm_block, body


def strip_quotes(val: str) -> str:
    """Trim matching outer single/double quotes from a frontmatter scalar."""
    val = val.strip()
    if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
        return val[1:-1]
    return val


def has_field(fm_block: str, field: str) -> bool:
    """True if ``field:`` appears at the start of any frontmatter line."""
    if not fm_block:
        return False
    for line in fm_block.splitlines():
        if FM_FIELD_RE.match(line):
            key = line.split(":", 1)[0].strip()
            if key == field:
                return True
    return False


def add_or_update_fm_field(
    fm_block: str, field: str, value: str,
) -> str:
    """Return ``fm_block`` with ``field`` set to ``value``.

    If the field is absent it's appended at the end of the block. If
    present, the existing line is replaced. ``value`` is written
    verbatim — caller is responsible for any quoting needed.
    """
    if not fm_block:
        return f"{field}: {value}"

    lines = fm_block.splitlines()
    out: list[str] = []
    replaced = False
    for line in lines:
        m = FM_FIELD_RE.match(line)
        if m and m.group(1) == field:
            out.append(f"{field}: {value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(f"{field}: {value}")
    return "\n".join(out)


def render_frontmatter(fm_block: str, body: str) -> str:
    """Reassemble the full record content from a frontmatter block + body."""
    return f"---\n{fm_block}\n---\n{body}"


# ---------------------------------------------------------------------------
# Source type inference
# ---------------------------------------------------------------------------

def infer_source_type(
    record_type_dir: str,
    scalars: dict[str, str],
    fm_block: str,
    filename_stem: str,
) -> str:
    """Determine the ``source_type`` for a migrated record.

    Inspection order (matches the runtime inference in
    ``src/activities/signals.py:_infer_source_type`` so already-migrated
    records and freshly-migrated records get the same classification):

      1. Existing ``source_type`` frontmatter scalar (already set by
         the new stream_vault.py path; idempotent re-runs hit this).
      2. ``stream_type`` scalar — canonical pre-6.6 field.
      3. ``source`` scalar — legacy alias for stream_type.
      4. Filename prefix (e.g. "openclaw-chat-..." or "gmail-...").
      5. ``tags:`` inline list line — last-resort scan for "slack",
         "gmail", "omi-audio", "openclaw-chat" tokens.
      6. Directory of origin: ``conversation/`` records default to
         "omi" (the dominant pre-6.6 conversation source). ``event/``
         records default to "generic".

    The output is always a member of KNOWN_SOURCE_TYPES.
    """
    # 1. Existing source_type — idempotent re-run path.
    existing = strip_quotes(scalars.get("source_type", ""))
    if existing:
        normalized = STREAM_TYPE_ALIASES.get(existing.lower(), existing.lower())
        if normalized in KNOWN_SOURCE_TYPES:
            return normalized

    # 2-3. stream_type / source.
    for key in ("stream_type", "source"):
        raw = strip_quotes(scalars.get(key, "")).lower()
        if raw and raw in KNOWN_SOURCE_TYPES:
            return raw
        if raw and raw in STREAM_TYPE_ALIASES:
            return STREAM_TYPE_ALIASES[raw]

    # 4. Filename prefix — handles records like
    # "openclaw-chat-2026-04-..." or "gmail-19c2..." that the
    # stream_vault layer has historically minted.
    stem_lower = filename_stem.lower()
    for src_type in sorted(KNOWN_SOURCE_TYPES, key=len, reverse=True):
        if stem_lower.startswith(f"{src_type}-"):
            return src_type

    # 5. Tags inline list scan. We only handle the inline form
    # ``tags: [...]`` here — block-list tags would need a real YAML
    # parser. The stream_vault.py templates emit inline form so this
    # is sufficient for nearly every record.
    for line in fm_block.splitlines():
        m = FM_FIELD_RE.match(line)
        if not m or m.group(1) != "tags":
            continue
        tags_text = m.group(2).lower()
        if "openclaw-chat" in tags_text:
            return "openclaw-chat"
        if "slack" in tags_text:
            return "slack"
        if "gmail" in tags_text or "email" in tags_text:
            return "gmail"
        if "omi-audio" in tags_text or "voice-call" in tags_text:
            return "omi"
        if "calendar" in tags_text:
            return "gcal"
        if "vexa" in tags_text:
            return "vexa"
        if "plane" in tags_text:
            return "plane"
        if "sure" in tags_text:
            return "sure"
        break

    # 6. Directory default.
    if record_type_dir == "conversation":
        return "omi"
    return "generic"


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

def is_steward_audit(filename: str) -> bool:
    """True if ``filename`` is a steward-audit / digest record."""
    return any(filename.startswith(p) for p in STEWARD_AUDIT_PREFIXES)


def discover_source_files(vault_root: Path) -> list[Path]:
    """Return absolute paths of every stream-event record to migrate.

    Walks ``event/`` and ``conversation/`` recursively (so nested
    ``event/<year>/<mm>/<dd>/`` daily-digest trees are caught and
    correctly skipped). For ``event/`` records, filters out steward
    audits and daily digests by filename prefix. ``conversation/``
    records all qualify.
    """
    out: list[Path] = []
    for sub in ("event", "conversation"):
        root = vault_root / sub
        if not root.is_dir():
            continue
        for path in root.rglob("*.md"):
            if not path.is_file():
                continue
            if sub == "event" and is_steward_audit(path.name):
                continue
            out.append(path)
    out.sort()
    return out


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------

class MigrationStats:
    """Accumulator for end-of-run summary."""

    def __init__(self) -> None:
        self.candidates: int = 0
        self.migrated: int = 0
        self.skipped_already: int = 0
        self.errors: int = 0
        self.error_paths: list[str] = []
        self.path_remap: dict[str, str] = {}  # old vault rel -> new vault rel
        self.wikilinks_rewritten: int = 0
        self.wikilink_files_touched: int = 0
        self.backup_dir: Path | None = None

    def record_error(self, label: str, exc: Exception) -> None:
        self.errors += 1
        if len(self.error_paths) < 25:
            self.error_paths.append(f"{label}: {exc}")


def vault_rel(vault_root: Path, path: Path) -> str:
    """Return path relative to vault root, posix-style."""
    return path.relative_to(vault_root).as_posix()


def compute_target_path(
    vault_root: Path,
    source: Path,
    source_type: str,
) -> Path:
    """Build the target ``stream_event/<source_type>-<old-stem>.md`` path.

    The stem is the original filename stem; we DO NOT include the
    nested year/month/day directory prefix because there shouldn't be
    nested layout under ``stream_event/`` and the original filename is
    already date-prefixed for genuine stream events. Stems that
    already start with the source-type prefix (e.g. "openclaw-chat-...")
    are NOT double-prefixed — produces "openclaw-chat-..." not
    "openclaw-chat-openclaw-chat-...".
    """
    stem = source.stem
    if stem.lower().startswith(f"{source_type.lower()}-"):
        new_name = f"{stem}.md"
    else:
        new_name = f"{source_type}-{stem}.md"
    return vault_root / "stream_event" / new_name


def migrate_one(
    vault_root: Path,
    source: Path,
    backup_dir: Path,
    *,
    dry_run: bool,
    verbose: bool,
    stats: MigrationStats,
) -> None:
    """Migrate one source file. Updates ``stats`` in place.

    Steps (all-or-nothing per file):

      1. Read source content.
      2. Parse frontmatter; infer ``source_type`` if absent.
      3. Compute target path. If exists with identical content →
         skipped_already. If exists with different content → error.
      4. Build new content: add ``source_type`` and
         ``signal_extracted_at: null`` to frontmatter when missing.
      5. Backup the source to ``backup_dir/<old-relative>``.
      6. Write the new file at the target path (mkdir -p first).
      7. Delete the source file.

    Errors at any step abort the migration of THIS record but do NOT
    affect others. The error is recorded on ``stats``.
    """
    rel_old = vault_rel(vault_root, source)
    record_type_dir = source.relative_to(vault_root).parts[0]

    try:
        content = source.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        stats.record_error(f"read {rel_old}", exc)
        logger.warning("migrate: read failed %s err=%s", rel_old, exc)
        return

    scalars, fm_block, body = parse_frontmatter(content)
    if not fm_block:
        stats.record_error(f"no frontmatter {rel_old}", ValueError("no fm"))
        logger.warning("migrate: no frontmatter at %s — skipping", rel_old)
        return

    source_type = infer_source_type(
        record_type_dir, scalars, fm_block, source.stem,
    )

    target = compute_target_path(vault_root, source, source_type)
    rel_new = vault_rel(vault_root, target)

    # Build new content with type=stream_event, source_type, and
    # signal_extracted_at set.
    #
    # The ``type:`` field is what ctrl-api's
    # ``GET /api/v1/vault/list/<type>`` filters on (server-side), so a
    # migrated record that still says ``type: event`` would be invisible
    # to ``list/stream_event``. We unconditionally rewrite the type to
    # ``stream_event`` — this is safe because the source_type field
    # carries the original origin metadata and any downstream consumer
    # that genuinely needs the legacy "event" / "conversation" type
    # value should be reading source_type instead.
    new_fm = add_or_update_fm_field(fm_block, "type", "stream_event")
    new_fm = add_or_update_fm_field(new_fm, "source_type", source_type)
    if not has_field(new_fm, "signal_extracted_at"):
        new_fm = add_or_update_fm_field(
            new_fm, "signal_extracted_at", "null",
        )
    new_content = render_frontmatter(new_fm, body)

    # Idempotency / collision checks.
    if target.exists():
        try:
            existing_content = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            stats.record_error(f"read existing {rel_new}", exc)
            return

        if existing_content == new_content:
            # Already at target with identical body — true idempotent
            # case (re-run on already-migrated record). Delete the
            # stale source if it's still present.
            stats.skipped_already += 1
            stats.path_remap[rel_old] = rel_new
            if verbose:
                logger.info(
                    "migrate: already at target %s (skipping)", rel_new,
                )
            if not dry_run:
                try:
                    source.unlink()
                except OSError as exc:
                    logger.warning(
                        "migrate: cleanup of stale source %s failed: %s",
                        rel_old, exc,
                    )
            return

        # Target exists with DIFFERENT content — refuse to overwrite.
        stats.record_error(
            f"target exists with different content {rel_new}",
            FileExistsError(rel_new),
        )
        logger.warning(
            "migrate: refusing overwrite — target %s differs from new content",
            rel_new,
        )
        return

    if dry_run:
        if verbose:
            logger.info(
                "migrate(dry-run): %s -> %s (source_type=%s)",
                rel_old, rel_new, source_type,
            )
        stats.migrated += 1
        stats.path_remap[rel_old] = rel_new
        return

    # Real migration: backup → write target → delete source.
    backup_path = backup_dir / rel_old
    try:
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, backup_path)
    except OSError as exc:
        stats.record_error(f"backup {rel_old}", exc)
        return

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temp file then rename — protects against a partial
        # write leaving stream_event/ with a half-written record.
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_text(new_content, encoding="utf-8")
        tmp.replace(target)
    except OSError as exc:
        stats.record_error(f"write {rel_new}", exc)
        return

    try:
        source.unlink()
    except OSError as exc:
        # Source-delete failure is non-fatal for the migration itself
        # but means the wikilink rewrite will see TWO records pointing
        # at the same logical event. Log loudly.
        logger.warning(
            "migrate: source unlink failed %s err=%s — manual cleanup needed",
            rel_old, exc,
        )

    stats.migrated += 1
    stats.path_remap[rel_old] = rel_new
    if verbose:
        logger.info(
            "migrate: %s -> %s (source_type=%s)",
            rel_old, rel_new, source_type,
        )


# ---------------------------------------------------------------------------
# Wikilink rewriting
# ---------------------------------------------------------------------------

def build_wikilink_lookup(
    path_remap: dict[str, str],
) -> dict[tuple[str, str], str]:
    """Build a lookup table from ``(type, stem)`` → ``stream_event/<new-stem>``.

    ``type`` is "event" or "conversation"; ``stem`` is the original
    filename stem (no ".md", no leading directory). The value is the
    new vault path WITHOUT the ".md" suffix because wikilinks omit it.
    """
    out: dict[tuple[str, str], str] = {}
    for old_rel, new_rel in path_remap.items():
        # old_rel is e.g. "event/2026-04-18-ddd7079cadff.md" or
        # "event/2026/04/17/daily-digest-2026-04-17.md" (steward audits
        # are filtered upstream so we shouldn't see those, but be
        # defensive).
        old_path = Path(old_rel)
        if not old_path.parts:
            continue
        rec_type = old_path.parts[0]
        if rec_type not in ("event", "conversation"):
            continue
        # The link target uses the BARE stem (no nested dirs) because
        # the legacy vault wikilinks were always flat (verified on
        # david — every `[[event/<stem>]]` reference is a flat slug).
        stem = old_path.stem
        new_target = new_rel
        if new_target.endswith(".md"):
            new_target = new_target[:-3]
        out[(rec_type, stem)] = new_target
    return out


def rewrite_wikilinks_in_file(
    path: Path,
    lookup: dict[tuple[str, str], str],
    *,
    dry_run: bool,
    verbose: bool,
) -> int:
    """Rewrite matching wikilinks in ``path``. Returns count rewritten."""
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        logger.warning(
            "wikilinks: read failed %s err=%s", path, exc,
        )
        return 0

    def _sub(m: re.Match[str]) -> str:
        rec_type = m.group(1)
        stem = m.group(2).strip()
        alias_suffix = m.group(3) or ""
        new_target = lookup.get((rec_type, stem))
        if not new_target:
            return m.group(0)  # No match — leave as-is.
        return f"[[{new_target}{alias_suffix}]]"

    new_content, n = WIKILINK_RE.subn(_sub, content)
    if n == 0:
        return 0
    if verbose:
        logger.info("wikilinks: %s — %d rewrites", path, n)
    if not dry_run:
        try:
            path.write_text(new_content, encoding="utf-8")
        except OSError as exc:
            logger.warning(
                "wikilinks: write failed %s err=%s", path, exc,
            )
            return 0
    return n


def rewrite_wikilinks(
    vault_root: Path,
    path_remap: dict[str, str],
    *,
    dry_run: bool,
    verbose: bool,
    stats: MigrationStats,
) -> None:
    """Walk WIKILINK_SCAN_DIRS and rewrite legacy event/ + conversation/ refs.

    Only files whose body actually contains the legacy prefix are
    rewritten; the regex pre-check makes the common case (no matches)
    a fast path.
    """
    lookup = build_wikilink_lookup(path_remap)
    if not lookup:
        return

    for sub in WIKILINK_SCAN_DIRS:
        root = vault_root / sub
        if not root.is_dir():
            continue
        for path in root.rglob("*.md"):
            if not path.is_file():
                continue
            n = rewrite_wikilinks_in_file(
                path, lookup, dry_run=dry_run, verbose=verbose,
            )
            if n > 0:
                stats.wikilinks_rewritten += n
                stats.wikilink_files_touched += 1


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--vault-path",
        default=os.environ.get("VAULT_PATH", VAULT_PATH_DEFAULT),
        help="Path to vault root (default: $VAULT_PATH or /vault)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would happen, make no changes.",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Log every operation.",
    )
    parser.add_argument(
        "--batch-size", type=int, default=0,
        help="Process at most N records this run (0 = no limit).",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    vault_root = Path(args.vault_path)
    if not vault_root.is_dir():
        logger.error("vault path does not exist: %s", vault_root)
        return 2

    stats = MigrationStats()

    # Discover source files.
    sources = discover_source_files(vault_root)
    stats.candidates = len(sources)
    logger.info(
        "discovered %d candidate stream-event records under event/ + conversation/",
        stats.candidates,
    )
    if args.batch_size > 0 and len(sources) > args.batch_size:
        logger.info(
            "batch-size=%d limiting to first %d records",
            args.batch_size, args.batch_size,
        )
        sources = sources[: args.batch_size]

    # Backup directory (created lazily — even in dry-run we compute the
    # path so it shows up in logs).
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = vault_root / ".backup" / f"migrate-stream-event-{ts}"
    stats.backup_dir = backup_dir
    if not args.dry_run:
        backup_dir.mkdir(parents=True, exist_ok=True)
        logger.info("backup dir: %s", backup_dir)
    else:
        logger.info("backup dir (dry-run): %s", backup_dir)

    # Per-record migration.
    for source in sources:
        try:
            migrate_one(
                vault_root, source, backup_dir,
                dry_run=args.dry_run,
                verbose=args.verbose,
                stats=stats,
            )
        except Exception as exc:  # noqa: BLE001
            stats.record_error(vault_rel(vault_root, source), exc)
            logger.warning(
                "migrate: unhandled error %s err=%s",
                vault_rel(vault_root, source), exc,
            )

    # Wikilink rewrite — only when at least one record was migrated.
    if stats.path_remap:
        logger.info(
            "rewriting wikilinks across %s",
            ", ".join(WIKILINK_SCAN_DIRS),
        )
        rewrite_wikilinks(
            vault_root, stats.path_remap,
            dry_run=args.dry_run,
            verbose=args.verbose,
            stats=stats,
        )

    # Summary.
    logger.info("=" * 60)
    logger.info("migration summary (dry-run=%s):", args.dry_run)
    logger.info("  candidates           : %d", stats.candidates)
    logger.info("  migrated             : %d", stats.migrated)
    logger.info("  already at target    : %d", stats.skipped_already)
    logger.info("  errors               : %d", stats.errors)
    logger.info(
        "  wikilinks rewritten  : %d (across %d files)",
        stats.wikilinks_rewritten, stats.wikilink_files_touched,
    )
    if stats.errors:
        logger.warning("first errors:")
        for err in stats.error_paths[:10]:
            logger.warning("  %s", err)
    return 0 if stats.errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
