"""Chore activity manifest — what Opus is allowed to call from generated workflows.

This module introspects `src.worker.ALL_ACTIVITIES` at import time and
produces a structured manifest describing every activity's name, signature,
type hints, docstring, and classification (pure_python | vault_read |
vault_write | llm | notification | external).

The manifest is consumed by:
  - chore_matching.py (Step 3): so Opus knows what activities exist when
    deciding which template fits each opportunity
  - chore_generation.py (Step 4): so Opus knows what activities it can call
    when generating a new template's Python source

The manifest is generated at module-import time, never serialized to disk.
This guarantees the manifest is always in sync with the actual registered
activities — no chance of drift between a static JSON file and the live
worker. Cost is ~10-100ms of inspect calls at startup.

Public API:
  CHORE_ACTIVITY_MANIFEST    — dict of {name -> ActivityDescriptor}
  CHORE_ACTIVITY_LIST        — list of ActivityDescriptor (stable order)
  USER_CHORES_DIR            — constant directory path for generated templates
  FORBIDDEN_IMPORTS          — set of import names blocked in generated code

Used by Step 3+4 PRs (#294, #300, #301, etc).
"""
from __future__ import annotations

import inspect
import logging
import typing
from dataclasses import asdict, dataclass, field
from typing import Any

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Constants reused across the chore system
# ---------------------------------------------------------------------------

USER_CHORES_DIR = "/alfred-data/user-chores"
"""Filesystem location for generated chore template Python files (Step 4)."""

# Imports that generated chore template code is NOT allowed to use.
# Enforced by validate_generated_template (S4-5). Anything not on this list
# AND not on the ALLOWED_IMPORTS list (defined in chore_generation.py) will
# be rejected.
FORBIDDEN_IMPORTS: frozenset[str] = frozenset({
    "os", "sys", "subprocess", "socket", "ctypes", "pickle", "marshal",
    "shutil", "tempfile", "pathlib",
    "requests", "urllib", "urllib2", "urllib3", "http",
    "ftplib", "smtplib", "telnetlib", "imaplib", "poplib",
    "asyncio.subprocess", "asyncio.streams",
    "importlib", "imp", "runpy",
    "__builtin__", "builtins",
})


# ---------------------------------------------------------------------------
# Manifest data structures
# ---------------------------------------------------------------------------

@dataclass
class ActivityParameter:
    """One parameter of an activity function signature."""
    name: str
    annotation: str = ""           # rendered type hint (e.g. "list[str]")
    default: str | None = None     # rendered default if any
    kind: str = "POSITIONAL_OR_KEYWORD"


@dataclass
class ActivityDescriptor:
    """Structured description of one registered activity.

    Used for two purposes:
      1. As context for Opus when matching opportunities to templates (Step 3)
      2. As an allowed-call manifest for the static validator (Step 4)

    Lives in memory only — never serialized to disk to prevent drift.
    """
    name: str
    module: str
    qualname: str
    parameters: list[ActivityParameter] = field(default_factory=list)
    return_annotation: str = ""
    docstring: str = ""
    classification: str = "pure_python"   # see _classify_activity
    is_async: bool = True
    side_effects: str = "none"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d

    def to_prompt_block(self) -> str:
        """Render as a single-block string for inclusion in an Opus prompt.

        Format:
          name(arg1: type, arg2: type) -> return_type
            description (first line of docstring)
            classification: pure_python  side_effects: none
        """
        param_str = ", ".join(
            f"{p.name}: {p.annotation}" if p.annotation else p.name
            for p in self.parameters
        )
        sig = f"{self.name}({param_str})"
        if self.return_annotation:
            sig += f" -> {self.return_annotation}"
        first_doc_line = self.docstring.split("\n", 1)[0].strip() if self.docstring else ""
        return (
            f"{sig}\n"
            f"  description: {first_doc_line}\n"
            f"  classification: {self.classification}  side_effects: {self.side_effects}"
        )


# ---------------------------------------------------------------------------
# Internal: classification heuristics
# ---------------------------------------------------------------------------

# Module → default classification. Order matters: longer/more-specific module
# names MUST come BEFORE shorter prefixes that would substring-match them.
# E.g. "src.activities.onboarding_v3" before "src.activities.onboarding".
_MODULE_CLASSIFICATION_RULES: list[tuple[str, str, str]] = [
    # (module_substring, classification, side_effects)
    ("src.activities.clerk", "llm", "calls clerk subagent through OpenClaw gateway"),
    ("src.activities.notify", "notification", "delivers messages via ctrl-api"),
    ("src.activities.chore_actions", "pure_python", "see individual function docs"),
    ("src.activities.vault", "vault_write", "vault HTTP write via ctrl-api"),
    ("src.activities.observe", "vault_read", "vault HTTP read via ctrl-api"),
    ("src.activities.judge", "vault_read", "vault HTTP read via ctrl-api"),
    ("src.activities.streams", "external", "external stream API access"),
    ("src.activities.pull", "external", "external API pull"),
    ("src.activities.profiler", "pure_python", "ML/Python computation"),
    ("src.activities.packs", "vault_write", "writes vault records"),
    ("src.activities.assign_chores", "vault_write", "writes vault chore records"),
    ("src.activities.batch_processor", "pure_python", "stream batch processing"),
    ("src.activities.session", "vault_write", "session state writes"),
    ("src.activities.classify", "pure_python", "classification logic"),
    ("src.activities.tasks", "vault_write", "task execution writes"),
    ("src.activities.reflect", "pure_python", "reflection validation"),
    ("src.activities.media", "external", "media file processing"),
    ("src.activities.omi_audio", "external", "Whisper transcription"),
    # MORE-SPECIFIC FIRST: onboarding_v3 must beat onboarding by substring match
    ("src.activities.onboarding_v3", "llm", "Opus onboarding pipeline"),
    ("src.activities.onboarding", "pure_python", "onboarding state"),
    ("src.workflows.chores._base", "vault_write", "chore record I/O"),
]


def _classify_activity(module: str, name: str) -> tuple[str, str]:
    """Return (classification, side_effects) for an activity."""
    name_lower = name.lower()

    # Name-based overrides take precedence — they're more specific
    if name_lower.startswith("clerk_") or "_clerk" in name_lower or "_via_llm" in name_lower:
        return "llm", "calls clerk subagent through OpenClaw gateway"
    if "ask_alfred" in name_lower:
        return "llm", "calls clerk subagent through OpenClaw gateway"
    if name_lower.startswith("notify_") or name_lower == "send_chore_notification":
        return "notification", "delivers messages via ctrl-api notification route"
    if name_lower.startswith("write_") or name_lower.startswith("save_") or name_lower.startswith("create_"):
        if "vault" in module or "chore" in module:
            return "vault_write", "writes to vault via ctrl-api"
    if name_lower.startswith("fetch_") or name_lower.startswith("read_") or name_lower.startswith("load_"):
        return "vault_read", "reads from vault via ctrl-api"

    # Module-based fallback
    for module_pat, classification, side_effects in _MODULE_CLASSIFICATION_RULES:
        if module_pat in module:
            return classification, side_effects
    return "pure_python", "none"


def _render_annotation(annotation: Any) -> str:
    """Convert a typing annotation to a readable string."""
    if annotation is inspect.Signature.empty or annotation is None:
        return ""
    # Use typing's repr-friendly forms when possible
    if hasattr(annotation, "__name__"):
        # Built-in types like int, str, dict, list
        return annotation.__name__
    return str(annotation).replace("typing.", "")


def _render_default(default: Any) -> str | None:
    if default is inspect.Parameter.empty:
        return None
    return repr(default)


def _build_descriptor(activity_fn: Any) -> ActivityDescriptor | None:
    """Inspect a function decorated with @activity.defn and build a descriptor.

    Returns None on inspection failure (logs a warning instead of raising).
    """
    try:
        # @activity.defn doesn't always wrap — sometimes the function passes through
        target = activity_fn
        # If it has __wrapped__, follow once to get to the real function
        if hasattr(target, "__wrapped__"):
            target = target.__wrapped__

        name = getattr(activity_fn, "__name__", None) or getattr(target, "__name__", "")
        if not name:
            return None

        module = getattr(target, "__module__", "") or getattr(activity_fn, "__module__", "") or ""
        qualname = getattr(target, "__qualname__", "") or name

        sig = inspect.signature(target)
        parameters: list[ActivityParameter] = []
        for pname, param in sig.parameters.items():
            parameters.append(
                ActivityParameter(
                    name=pname,
                    annotation=_render_annotation(param.annotation),
                    default=_render_default(param.default),
                    kind=str(param.kind),
                )
            )
        return_annotation = _render_annotation(sig.return_annotation)

        doc = inspect.getdoc(target) or ""
        is_async = inspect.iscoroutinefunction(target)

        classification, side_effects = _classify_activity(module, name)

        return ActivityDescriptor(
            name=name,
            module=module,
            qualname=qualname,
            parameters=parameters,
            return_annotation=return_annotation,
            docstring=doc,
            classification=classification,
            is_async=is_async,
            side_effects=side_effects,
        )
    except Exception as exc:
        logger.warning("chore_manifest: failed to introspect activity %r: %s", activity_fn, exc)
        return None


def _build_manifest() -> tuple[dict[str, ActivityDescriptor], list[ActivityDescriptor]]:
    """Build the manifest by introspecting src.worker.ALL_ACTIVITIES.

    Lazy import of src.worker to avoid circular import at module load time.
    """
    try:
        # Lazy import — chore_manifest.py is sometimes imported by activities
        # that worker.py also imports, so we can't unconditionally import worker
        # at the top of this file.
        from src import worker as _worker
    except Exception as exc:
        logger.error("chore_manifest: failed to import src.worker: %s", exc)
        return {}, []

    activities = getattr(_worker, "ALL_ACTIVITIES", [])
    descriptors_by_name: dict[str, ActivityDescriptor] = {}
    descriptors_list: list[ActivityDescriptor] = []
    for fn in activities:
        desc = _build_descriptor(fn)
        if desc is None:
            continue
        if desc.name in descriptors_by_name:
            # Same activity registered twice (shouldn't happen but be defensive)
            continue
        descriptors_by_name[desc.name] = desc
        descriptors_list.append(desc)
    return descriptors_by_name, descriptors_list


# ---------------------------------------------------------------------------
# Public API — built once at first import
# ---------------------------------------------------------------------------

CHORE_ACTIVITY_MANIFEST: dict[str, ActivityDescriptor]
CHORE_ACTIVITY_LIST: list[ActivityDescriptor]


def get_manifest() -> dict[str, ActivityDescriptor]:
    """Return the built manifest dict. Idempotent — built lazily on first call."""
    global CHORE_ACTIVITY_MANIFEST, CHORE_ACTIVITY_LIST
    if "CHORE_ACTIVITY_MANIFEST" not in globals() or not CHORE_ACTIVITY_MANIFEST:
        m, l = _build_manifest()
        CHORE_ACTIVITY_MANIFEST = m
        CHORE_ACTIVITY_LIST = l
    return CHORE_ACTIVITY_MANIFEST


def get_manifest_list() -> list[ActivityDescriptor]:
    """Return the manifest as an ordered list (registration order)."""
    get_manifest()  # ensure built
    return CHORE_ACTIVITY_LIST


def render_manifest_for_prompt(filter_classifications: set[str] | None = None) -> str:
    """Render the manifest as a string suitable for embedding in an Opus prompt.

    `filter_classifications` lets callers limit to e.g. {"pure_python", "vault_read",
    "llm"} when generating chore templates so the menu stays focused.
    """
    m = get_manifest_list()
    if filter_classifications:
        m = [d for d in m if d.classification in filter_classifications]
    return "\n\n".join(d.to_prompt_block() for d in m)


# Build the manifest eagerly at first import. This catches errors early
# rather than at the first chore_generation call.
try:
    CHORE_ACTIVITY_MANIFEST, CHORE_ACTIVITY_LIST = _build_manifest()
    logger.info(
        "chore_manifest: built manifest with %d activities",
        len(CHORE_ACTIVITY_LIST),
    )
except Exception as exc:  # noqa: BLE001
    logger.error("chore_manifest: eager build failed: %s", exc)
    CHORE_ACTIVITY_MANIFEST = {}
    CHORE_ACTIVITY_LIST = []
