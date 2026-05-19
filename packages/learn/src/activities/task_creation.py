"""Auto-create tasks from signals that don't resolve to an existing target.

Phase 6.5 (T6.5.1 + T6.5.2 + T6.5.3): when ``extract_signal_from_event``
finds no matching task or matter for a signal AND auto-creation is
enabled AND the idempotency cache hasn't seen this source_event before,
an LLM proposes ``{title, description, due_at?}`` and we write a fresh
``task/<slug>.md`` record with full Steward frontmatter so the next
Steward tick picks it up cleanly.

Why this lives in its own file
------------------------------
``signals.py`` already runs >1500 LOC and owns the signal extraction
pipeline + write helpers. Auto-creation is a distinct concern (LLM
prompt + idempotency cache + audit emitter) that we want to iterate on
without touching the signal pipeline. Keeping the activity here also
means the new ``create_task_from_signal`` is the only export the worker
has to register for Phase 6.5 — the existing signal activities
unchanged.

Hard rules (mirroring the alfred-learn contract)
------------------------------------------------
* All LLM calls go through ``clerk._call_clerk`` (NEVER direct
  Anthropic). The clerk's JSON-extraction layer parses the
  ``{title, description, due_at, parent_matter, should_create}`` shape
  this module asks for.
* All vault writes go through ``VaultClient.write_record`` (NEVER
  direct filesystem writes to the vault). The on-disk idempotency
  cache + the audit record live in ``/alfred-data/state/steward/`` —
  alfred-learn's writable scratch dir, NOT the vault.
* Lazy imports for httpx + heavy deps inside the activity body so
  Temporal's workflow sandbox doesn't see them at module import.
* Idempotent: same ``signal.source_event_path`` MUST NOT produce a
  duplicate task. The cache at
  ``/alfred-data/state/steward/signal-task-creation.json`` maps
  ``source_event_path -> task_path``; a hit returns the prior path.
* Gated by ``STEWARD_SIGNAL_AUTOCREATE_TASKS=true`` env. When false the
  activity is a no-op even on no-target signals.

Frontmatter shape
-----------------
Auto-created tasks must mirror the Steward task frontmatter on david so
the next Steward tick picks them up without surprises::

    blocked_on: ''
    created: <UTC ISO>
    description: <LLM-generated 1-3 sentence description>
    enrichment_status: pending
    janitor_note: ''
    last_steward_check_at: ''
    last_steward_outcome: null
    name: <LLM-generated ≤60-char title>
    next_check_after: <UTC ISO; same as created so Steward picks up next tick>
    parent_matter: matter/inbox.md
    pending_confirmation: false
    related_matters: []
    related_orgs: []
    related_persons: []
    signal_sources:
      - source_event_path: <event/...md>
        source_signal_path: <signal/...md or null at creation time>
        source_type: <gmail|slack|...>
    source_event: <event/...md — single canonical link>
    staleness_score: 0
    state: open
    status: todo
    surface_class: normal
    tags: ['auto-from-signal']
    type: task
    due_at: <ISO or omitted>

Schema parity with the existing enrichment-created tasks is critical:
the steward.evaluate_task activity reads ``signal_sources``,
``parent_matter``, ``surface_class`` directly. Diverging here means
auto-created tasks would be silently filtered out of the perception
loop.
"""
from __future__ import annotations

import logging
from typing import Any

from temporalio import activity

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Idempotency cache path. Lives next to rate-guard.json /
# matter-cadence.json under ``/alfred-data/state/steward/`` (alfred-learn's
# writable scratch dir). Never put this under the vault — the vault is
# durable user content; this is internal bookkeeping.
CACHE_PATH = "/alfred-data/state/steward/signal-task-creation.json"

# Default parent matter for auto-created tasks. Tasks land here when no
# parent_matter can be inferred — Steward's inbox matter is the canonical
# orphan home (see ``matter/inbox.md`` body: "Steward home for orphan
# tasks. Tasks land here automatically when they're created without an
# explicit parent_matter."). Sir / Steward can move them later by
# editing the task's parent_matter field.
DEFAULT_PARENT_MATTER = "matter/inbox.md"

# Hard ceiling on slug length so vault filenames stay sane on every
# platform. 80 chars matches the existing task-creation pattern in
# stream_vault / enrichment.
SLUG_MAX_CHARS = 80

# Title cap the LLM is asked to respect. Mirrors the existing
# enrichment task titles which are all <60 chars in practice.
TITLE_MAX_CHARS = 60

# Maximum retained cache entries before we trim. The cache is keyed by
# source_event_path; a few hundred entries is the realistic ceiling on a
# single tenant. We cap above 10x that so trimming never bites under
# normal load.
CACHE_MAX_ENTRIES = 10_000

# Env var gating Phase 6.5. Default false — flip to "true" once smoke
# tests confirm the LLM is producing sane title/description pairs.
ENV_AUTOCREATE_FLAG = "STEWARD_SIGNAL_AUTOCREATE_TASKS"


# ---------------------------------------------------------------------------
# Activity: create_task_from_signal
# ---------------------------------------------------------------------------

@activity.defn
async def create_task_from_signal(signal: dict[str, Any]) -> str | None:
    """Auto-create a vault ``task/`` record from a no-target signal.

    Returns the new task vault path (e.g. ``"task/<slug>.md"``) on
    success. Returns ``None`` when:
      * ``STEWARD_SIGNAL_AUTOCREATE_TASKS`` env is not ``"true"``,
      * the idempotency cache already has an entry for this
        ``source_event_path`` (returns the cached path? No — returns
        ``None`` to signal "no NEW task created" while the cached
        path is logged. Caller checks the cache via the same key when
        it wants the existing path),
      * the LLM returned ``should_create=false`` (the LLM judged the
        signal didn't warrant a tracked task),
      * the signal dict is malformed (no ``source_event_path``).

    Steps:
      1. Lazy import the heavy deps.
      2. Gate on the env var. Off → return None.
      3. Idempotency check: if the cache already holds a task path for
         this source_event_path, return that PRIOR path (signals.py
         will stamp the existing task as the target).
      4. Build the creation prompt (title/description/due_at LLM call).
      5. Call ``clerk._call_clerk`` and parse the JSON.
      6. If ``should_create=false`` → return None (LLM declined).
      7. Slug from title; disambiguate via timestamp suffix if a
         vault record with the same slug already exists.
      8. Render task content (frontmatter + body).
      9. ``VaultClient.write_record("task", slug, content)``.
      10. Update the idempotency cache.
      11. Emit ``event/auto-task-created-<ts>-<slug>.md`` audit
          record citing source signal + source event paths + LLM
          prompt + LLM response.
      12. Return the task path.

    Errors are logged + swallowed — auto-creation failure should never
    block the rest of the signal-extraction tick. The signal still
    gets written with ``target_path=None`` and the workflow continues.
    """
    # --- Lazy imports (Temporal sandbox restriction + cheap startup) ---
    import hashlib
    import json
    import os
    import re
    from datetime import datetime, timezone

    import httpx

    from src.activities.clerk import _call_clerk
    from src.config import load_config
    from src.utils.vault_client import VaultClient

    # --- Validate input shape early ---
    if not isinstance(signal, dict):
        logger.warning(
            "task_creation: input not a dict (type=%s) — no-op",
            type(signal).__name__,
        )
        return None

    source_event_path = str(signal.get("source_event_path") or "").strip()
    if not source_event_path:
        logger.warning(
            "task_creation: signal missing source_event_path — no-op"
        )
        return None

    # --- Step 2: env gate ---
    enabled = (os.environ.get(ENV_AUTOCREATE_FLAG, "") or "").strip().lower()
    if enabled != "true":
        logger.info(
            "task_creation: %s != 'true' — no-op (source_event=%s)",
            ENV_AUTOCREATE_FLAG, source_event_path,
        )
        return None

    # --- Step 3: idempotency check ---
    cached_path = await _get_cached_task_for_event(source_event_path)
    if cached_path:
        logger.info(
            "task_creation: idempotency hit source_event=%s -> %s",
            source_event_path, cached_path,
        )
        return cached_path

    # --- Step 4: build the LLM prompt ---
    prompt = _build_creation_prompt(signal)

    # --- Step 5: clerk call ---
    try:
        llm_response = await _call_clerk(prompt, raw=False)
    except Exception as exc:  # noqa: BLE001
        # Clerk failures are best-effort — log + drop. The signal
        # pipeline will still write the signal with target_path=None
        # so Sir's signal isn't lost; auto-creation is just unavailable
        # for this tick.
        logger.warning(
            "task_creation: clerk call failed source_event=%s err=%s",
            source_event_path, exc,
        )
        return None

    # --- Validate LLM response shape ---
    if not isinstance(llm_response, dict):
        logger.warning(
            "task_creation: clerk returned non-dict (type=%s) source_event=%s",
            type(llm_response).__name__, source_event_path,
        )
        return None

    should_create = bool(llm_response.get("should_create"))
    if not should_create:
        # Step 6: LLM declined — record the decline in logs but DO NOT
        # cache (a future signal from the same event might warrant a
        # task once the LLM has more context, e.g. a follow-up email).
        reason = str(llm_response.get("reasoning") or "no reason given")[:200]
        logger.info(
            "task_creation: LLM declined source_event=%s reason=%s",
            source_event_path, reason,
        )
        return None

    title = str(llm_response.get("title") or "").strip()
    description = str(llm_response.get("description") or "").strip()
    if not title or not description:
        logger.warning(
            "task_creation: LLM response missing title/description "
            "source_event=%s title=%r description=%r",
            source_event_path,
            title[:40] if title else "",
            description[:40] if description else "",
        )
        return None

    # Cap title length defensively (the prompt asks for ≤60 chars but
    # LLMs sometimes overshoot — better truncate than reject).
    if len(title) > TITLE_MAX_CHARS:
        title = title[:TITLE_MAX_CHARS].rstrip()

    parent_matter = str(
        llm_response.get("parent_matter") or DEFAULT_PARENT_MATTER
    ).strip() or DEFAULT_PARENT_MATTER
    # Defensive: if the LLM returned something silly, fall back.
    if not parent_matter.startswith("matter/") or not parent_matter.endswith(".md"):
        parent_matter = DEFAULT_PARENT_MATTER

    # Phase 2 — matter override. When the upstream signal already had
    # target_kind="matter" with a resolved target_path, that matter IS
    # the parent. The LLM-picked value above is a hint only and gets
    # overridden so the resulting task always lives under the matter
    # the extractor identified.
    signal_target_kind = str(signal.get("target_kind") or "").strip().lower()
    signal_target_path = str(signal.get("target_path") or "").strip()
    if (
        signal_target_kind == "matter"
        and signal_target_path.startswith("matter/")
        and signal_target_path.endswith(".md")
    ):
        if parent_matter != signal_target_path:
            logger.info(
                "task_creation: parent_matter override source_event=%s "
                "llm_chose=%s using=%s (signal target_kind=matter)",
                source_event_path, parent_matter, signal_target_path,
            )
            parent_matter = signal_target_path

    due_at_raw = llm_response.get("due_at")
    due_at: str | None = None
    if isinstance(due_at_raw, str) and due_at_raw.strip():
        # Trust the LLM's ISO output verbatim — Steward + the dashboard
        # both tolerate near-ISO strings; full validation is overkill.
        due_at = due_at_raw.strip()

    # --- Step 6.5: synthesize closure-evidence predicates ---
    # Auto-tasks are dead-on-arrival from a closure perspective unless
    # Steward has predicates to query against. Ask the LLM to translate
    # the signal context into a small set of deterministic predicates
    # ("if a Sure transaction matching X arrives, this task is done").
    # Best-effort: a failure here doesn't block task creation.
    closure_predicates: list[str] = []
    try:
        closure_predicates = await _synthesize_closure_predicates(
            signal=signal,
            title=title,
            description=description,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "task_creation: predicate synthesis failed source_event=%s err=%s",
            source_event_path, exc,
        )

    # --- Step 7: slug ---
    base_slug = _slug_from_title(title)
    if not base_slug:
        # Degenerate case (title was all-symbols) — fall back to a hash.
        base_slug = "auto-task-" + hashlib.sha256(
            source_event_path.encode("utf-8")
        ).hexdigest()[:8]

    # Disambiguate via timestamp suffix if a record with this slug
    # already exists. We don't query the vault to detect collisions
    # (it'd be one HTTP roundtrip per creation, in addition to the LLM
    # call); instead we always append an 8-char hash of the
    # source_event_path which is deterministic per event and guarantees
    # uniqueness across signals from different events.
    short_hash = hashlib.sha256(
        source_event_path.encode("utf-8")
    ).hexdigest()[:8]
    slug = f"{short_hash}-{base_slug}"
    # Re-trim if the hash + slug exceeded the budget.
    if len(slug) > SLUG_MAX_CHARS:
        slug = slug[:SLUG_MAX_CHARS].rstrip("-")

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat(timespec="seconds")

    # --- Step 8: render content ---
    content = _render_task_content(
        title=title,
        description=description,
        slug=slug,
        parent_matter=parent_matter,
        due_at=due_at,
        signal=signal,
        created_iso=now_iso,
        closure_predicates=closure_predicates,
    )

    # --- Step 9: write the task ---
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        try:
            task_path = await client.write_record(
                record_type="task",
                name=slug,
                content=content,
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "task_creation: vault write failed source_event=%s slug=%s err=%s",
                source_event_path, slug, exc,
            )
            return None

        # --- Step 10: update cache ---
        try:
            await _record_cached_task(source_event_path, task_path)
        except Exception as exc:  # noqa: BLE001
            # Cache failure shouldn't block — the task is already
            # written and a future tick that re-extracts the same event
            # would just produce an idempotent overwrite (write_record
            # is upsert-shaped on ctrl-api). Log so we notice if this
            # becomes a pattern.
            logger.warning(
                "task_creation: cache update failed source_event=%s task=%s err=%s",
                source_event_path, task_path, exc,
            )

        # --- Step 11: emit audit record ---
        try:
            await _emit_audit_record(
                client=client,
                signal=signal,
                task_path=task_path,
                title=title,
                description=description,
                prompt=prompt,
                llm_response=llm_response,
                created_iso=now_iso,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "task_creation: audit emit failed task=%s err=%s",
                task_path, exc,
            )

        logger.info(
            "task_creation: created source_event=%s -> task=%s title=%r",
            source_event_path, task_path, title[:60],
        )
        return task_path
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Idempotency cache helpers
# ---------------------------------------------------------------------------

async def _get_cached_task_for_event(
    source_event_path: str,
) -> str | None:
    """Return the cached task path for ``source_event_path``, or None.

    Lazy-creates the cache file (with ``{}`` content) on first read so
    a fresh tenant doesn't fail with ``FileNotFoundError`` on the first
    auto-creation attempt. Returns ``None`` for cache miss, malformed
    cache, or any I/O error — auto-creation should never break because
    bookkeeping failed.
    """
    import json
    import os

    if not source_event_path:
        return None

    try:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    except OSError as exc:
        logger.warning(
            "task_creation._get_cached_task_for_event: mkdir failed err=%s", exc
        )
        return None

    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        # Lazy-create empty cache so subsequent reads stay clean.
        try:
            with open(CACHE_PATH, "w", encoding="utf-8") as f:
                json.dump({}, f)
        except OSError as exc:
            logger.warning(
                "task_creation._get_cached_task_for_event: lazy-create failed err=%s",
                exc,
            )
        return None
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "task_creation._get_cached_task_for_event: read failed path=%s err=%s",
            CACHE_PATH, exc,
        )
        return None

    if not isinstance(data, dict):
        return None

    entry = data.get(source_event_path)
    if isinstance(entry, str) and entry.strip():
        return entry.strip()
    if isinstance(entry, dict):
        # Forward-compat shape — we don't write this today but a future
        # cache version might store {"task_path": ..., "created_at": ...}.
        path = entry.get("task_path")
        if isinstance(path, str) and path.strip():
            return path.strip()
    return None


async def _record_cached_task(
    source_event_path: str,
    task_path: str,
) -> None:
    """Record a ``source_event_path -> task_path`` mapping in the cache.

    Read-modify-write with atomic rename. The cache is small (a few
    hundred entries on a saturated tenant) so a full file rewrite is
    fine; we cap retained entries at ``CACHE_MAX_ENTRIES`` to bound
    growth on a pathological tenant.

    Concurrency note: two activity workers can race here. Last-writer-
    wins under os.replace, which means the worst case is one cache
    miss on a second-tick re-extraction of the SAME source_event. The
    activity that retries finds the task already exists in the vault
    (its slug derives from the event path's hash) and the write_record
    call will overwrite-with-same-content. Acceptable.
    """
    import json
    import os
    from datetime import datetime, timezone

    if not source_event_path or not task_path:
        return

    try:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    except OSError as exc:
        logger.warning(
            "task_creation._record_cached_task: mkdir failed err=%s", exc
        )
        return

    # Read existing cache.
    data: dict[str, Any] = {}
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            data = loaded
    except FileNotFoundError:
        data = {}
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "task_creation._record_cached_task: read failed err=%s — overwriting",
            exc,
        )
        data = {}

    # Insert / update. Store as a small dict so future fields (LLM
    # response excerpt, audit path, etc.) can be added without breaking
    # the read path's string-or-dict tolerance.
    data[source_event_path] = {
        "task_path": task_path,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    # Trim if oversized — keep the most recent entries by created_at.
    if len(data) > CACHE_MAX_ENTRIES:
        try:
            sorted_items = sorted(
                data.items(),
                key=lambda kv: (
                    kv[1].get("created_at", "")
                    if isinstance(kv[1], dict)
                    else ""
                ),
                reverse=True,
            )
            data = dict(sorted_items[:CACHE_MAX_ENTRIES])
        except Exception:  # noqa: BLE001
            # Trim is best-effort; if it fails just leave the cache as-is.
            pass

    # Atomic write.
    tmp = CACHE_PATH + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True, default=str)
        os.replace(tmp, CACHE_PATH)
    except OSError as exc:
        logger.warning(
            "task_creation._record_cached_task: write failed err=%s", exc
        )


# ---------------------------------------------------------------------------
# Slug builder
# ---------------------------------------------------------------------------

def _slug_from_title(title: str) -> str:
    """Convert a free-text title into a kebab-case filename-safe slug.

    Rules: lowercase, replace any non-alnum with ``-``, collapse runs
    of ``-`` into a single ``-``, strip leading/trailing ``-``, trim
    to ``SLUG_MAX_CHARS``. Returns ``""`` for empty / all-symbol input
    (caller falls back to a hash-based slug).
    """
    import re

    if not title:
        return ""
    # Lowercase + scrub.
    s = title.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    if not s:
        return ""
    if len(s) > SLUG_MAX_CHARS:
        s = s[:SLUG_MAX_CHARS].rstrip("-")
    return s


# ---------------------------------------------------------------------------
# LLM prompt builder
# ---------------------------------------------------------------------------

async def _synthesize_closure_predicates(
    *,
    signal: dict[str, Any],
    title: str,
    description: str,
) -> list[str]:
    """LLM-synthesize Steward closure-evidence predicates for a new task.

    The signal layer creates tasks reactively from inbound stream events
    (e.g. "Pick up Magyar Posta package"). Without explicit signal_sources
    predicates, Steward's per-task evaluation has nothing deterministic
    to poll for evidence of completion — the task can only close if a
    NEW stream event happens to extract another signal targeting the same
    task. That misses the common case where Sir does the thing
    out-of-band (bank transfer, in person, etc.) and the only trace is
    a Sure transaction or vault edit.

    This helper makes one cheap clerk call asking the LLM:
    "Given this task, what deterministic evidence would prove it's done?"

    Returns a list of predicate strings (≤5) in the wire format Steward's
    legacy gather_signals_* activities consume:
      - ``sure:transaction:match:<term>``
      - ``sure:transaction:tag:<id>``
      - ``sure:account:<id>``
      - ``gmail:from:<email-or-domain>``
      - ``gmail:subject_contains:<term>``

    Returns ``[]`` on any failure or when the task has no obvious
    deterministic closure path. Caller logs and continues.
    """
    import json

    from src.activities.clerk import _call_clerk

    raw_quote = str(signal.get("raw_quote") or "").strip()
    reasoning = str(signal.get("reasoning") or "").strip()
    proposal = signal.get("action_proposal") or signal.get("mutation_proposal") or {}
    if not isinstance(proposal, dict):
        proposal = {}

    prompt = f"""You are Alfred's evidence-predicate synthesizer. A new auto-task was just created from a signal. Your job: return up to 5 deterministic predicates that Steward can poll to detect when this task is done.

## Task just created

Title: {title!r}
Description: {description!r}

## Originating signal context

raw_quote: {raw_quote!r}
reasoning: {reasoning!r}
proposal: {json.dumps(proposal, ensure_ascii=False, default=str)!r}

## Predicate vocabulary (use ONLY these forms)

- `sure:transaction:match:<term>` — match Sure (banking) transactions whose name/merchant/category contains <term>. Use for "pay X" / "renew Y" tasks where a financial transaction would prove completion.
- `sure:transaction:tag:<tag-id>` — match a specific Sure tag id (rare; only if the signal mentions a known tag).
- `sure:account:<account-id>` — all transactions on a Sure account (rare; only when the task is account-scoped).
- `gmail:from:<email-or-domain>` — match gmail events whose sender matches. Use for "respond to X" / "review Y from Z" tasks where a follow-up email would prove completion.
- `gmail:subject_contains:<term>` — match gmail events whose subject contains <term>.

## Output shape

Return STRICT JSON — a list of strings, no other text. Examples:

For "Resolve Mailgun account disablement":
```json
["sure:transaction:match:Mailgun", "gmail:from:mailgun.com", "gmail:subject_contains:Mailgun"]
```

For "Pick up Magyar Posta package":
```json
["gmail:from:posta.hu", "gmail:subject_contains:kézbesít"]
```

For "Reply to Boardy about TBPN opportunity":
```json
["gmail:from:boardy", "gmail:subject_contains:TBPN"]
```

For tasks without an obvious deterministic close (e.g. "Think about pricing strategy"):
```json
[]
```

## Rules

- Maximum 5 predicates. Most tasks need 1-3.
- Use specific terms — "Mailgun" not "billing", "DigitalOcean" not "cloud".
- Prefer `sure:transaction:match:` for any payment / subscription / renewal task.
- Prefer `gmail:from:<domain>` over `gmail:from:<full-email>` when the domain is well-known (mailgun.com, dpd.hu).
- If the task can ONLY be confirmed by Sir's manual closure (e.g. "Think about X", "Plan Y"), return `[]`.
- Output ONLY the JSON array. No prose, no markdown, no preamble."""

    try:
        response = await _call_clerk(prompt, raw=False)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "task_creation._synthesize_closure_predicates: clerk failed err=%s",
            exc,
        )
        return []

    # _call_clerk attempts to JSON-parse the response. We expect a list.
    if isinstance(response, list):
        items = response
    elif isinstance(response, dict):
        # Some models wrap in {"predicates": [...]} despite the prompt
        for key in ("predicates", "signal_sources", "list", "result"):
            if isinstance(response.get(key), list):
                items = response[key]
                break
        else:
            return []
    else:
        return []

    valid_prefixes = (
        "sure:transaction:match:",
        "sure:transaction:tag:",
        "sure:transaction:category:",
        "sure:account:",
        "gmail:from:",
        "gmail:subject_contains:",
        "gmail:to:",
    )
    cleaned: list[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        s = item.strip()
        if not s:
            continue
        if not any(s.startswith(p) for p in valid_prefixes):
            logger.info(
                "task_creation._synthesize_closure_predicates: dropped "
                "out-of-vocab predicate=%r",
                s,
            )
            continue
        if len(s) > 200:
            continue
        cleaned.append(s)
        if len(cleaned) >= 5:
            break

    return cleaned


def _build_creation_prompt(signal: dict[str, Any]) -> str:
    """Build the clerk prompt asking for {title, description, due_at, …}.

    The prompt encodes:
      * The target signal's raw_quote, reasoning, and proposal — the
        only context the LLM has to decide whether/how to materialize a
        task.
      * The strict JSON shape signals_router downstream consumers
        expect: ``{title (≤60 chars), description (1-3 sentences),
        due_at (ISO or null), parent_matter (default
        "matter/inbox.md"), should_create (bool), reasoning (string)}``.
      * The conservatism rule: ``should_create=false`` UNLESS the
        signal clearly implies Sir wants this tracked. Better to drop
        a borderline signal than flood Sir's task list.

    The prompt deliberately does NOT include few-shot examples — the
    creation surface is narrow (one signal → one task) and the
    extraction prompt the signal already went through provides plenty
    of signal-shape priming. Adding 8 few-shot pairs would just burn
    tokens.
    """
    import json

    raw_quote = str(signal.get("raw_quote") or "").strip()
    reasoning = str(signal.get("reasoning") or "").strip()
    source_event_path = str(signal.get("source_event_path") or "").strip()
    source_type = str(signal.get("source_type") or "unknown").strip()
    effect = str(signal.get("effect") or "").strip()
    action_proposal = signal.get("action_proposal")
    mutation_proposal = signal.get("mutation_proposal")

    proposal_block: str
    if isinstance(action_proposal, dict) and action_proposal:
        proposal_block = (
            "Action proposal (from extraction):\n```json\n"
            + json.dumps(action_proposal, indent=2, ensure_ascii=False, default=str)
            + "\n```"
        )
    elif isinstance(mutation_proposal, dict) and mutation_proposal:
        proposal_block = (
            "Mutation proposal (from extraction):\n```json\n"
            + json.dumps(mutation_proposal, indent=2, ensure_ascii=False, default=str)
            + "\n```"
        )
    else:
        proposal_block = "(no proposal in signal)"

    return f"""You are Alfred's task-creation clerk. Your job: read ONE signal that has no resolvable existing target task or matter, and decide whether to materialize a NEW task record for Sir to track — and if so, what its title and description should be.

You produce STRICT JSON output. The downstream Python module parses your response. Malformed JSON, missing fields, or values outside the declared types break the pipeline silently.

## 1. The signal you must consider

source_event_path: `{source_event_path}`
source_type: `{source_type}`
effect: `{effect}`

raw_quote (≤200 chars from the source event):
```
{raw_quote}
```

extraction reasoning:
```
{reasoning}
```

{proposal_block}

## 2. The bar for creating a task (CRITICAL)

`should_create` MUST be `true` ONLY if:
- The signal clearly implies Sir wants this tracked as discrete work, AND
- The required action is concrete (replyable, schedulable, payable, decidable), AND
- A reasonable assistant would expect Sir to ask "what's the status of X?" later.

`should_create` MUST be `false` when:
- The signal is informational / a status update / a receipt,
- The signal is a question Sir asked (questions are answered in-session, not tracked),
- The signal is ambient narration / OMI thinking-out-loud,
- The work is too small to merit a tracked task (one-line replies, one-click confirms),
- The signal is a duplicate of a task you suspect already exists (you can't see the vault — but if the description sounds like routine inbox triage, lean false).

When in doubt, return `should_create=false`. Sir would rather lose one borderline signal than drown in auto-tasks.

## 3. The output JSON schema (strict)

```json
{{
  "should_create": true | false,
  "title": "<≤60-character imperative title; required when should_create=true>",
  "description": "<1-3 sentence description, required when should_create=true>",
  "due_at": "<ISO8601 datetime string or null>",
  "parent_matter": "<vault path like matter/<slug>.md, defaulting to matter/inbox.md>",
  "reasoning": "<1-2 sentences explaining your decision either way>"
}}
```

Schema rules:
- `should_create`: boolean. Required.
- `title`: imperative form ("Pay X invoice", "Verify Y device login", "Reply to Z about W"). Max 60 chars. Required when should_create=true; can be empty string when should_create=false.
- `description`: 1-3 sentences explaining what the task is about and what Sir needs to do. Plain text, no markdown. Required when should_create=true; can be empty string when should_create=false.
- `due_at`: ISO8601 datetime in UTC if the signal mentions a deadline, otherwise `null`. Don't invent deadlines.
- `parent_matter`: path to a vault matter record. You can't see the matter list, so default to `matter/inbox.md` unless the signal explicitly names a project (e.g. "Berlin trip planning" → `matter/berlin-trip-planning.md`). When in doubt, use `matter/inbox.md` — Sir's Steward home for orphan tasks.
- `reasoning`: 1-2 sentences explaining why you decided should_create=true or false. Required.

## 4. Output

Output ONLY the JSON object, no other text. No markdown code fences. No commentary before or after. The first character of your response must be `{{` and the last must be `}}`.
"""


# ---------------------------------------------------------------------------
# Task content rendering
# ---------------------------------------------------------------------------

def _render_task_content(
    *,
    title: str,
    description: str,
    slug: str,
    parent_matter: str,
    due_at: str | None,
    signal: dict[str, Any],
    created_iso: str,
    closure_predicates: list[str] | None = None,
) -> str:
    """Render the full ``---\\n<frontmatter>\\n---\\n<body>`` task record.

    Mirrors the schema of david's existing enrichment-created tasks
    (see header docstring). The fields are alphabetized as YAML emits
    them via PyYAML's default safe-dump on the ctrl-api side, EXCEPT
    we keep the field order semantically grouped because the file is
    human-readable too — Sir / contributors browse vault records.
    """
    # Source signal metadata. The signal record itself (signal/<slug>.md)
    # is written by signals.write_signal_record AFTER this activity
    # returns, so we can't include the signal_path here. Steward will
    # backfill that link on its first tick if needed; the source_event
    # link is the durable handle.
    source_event_path = str(signal.get("source_event_path") or "").strip()
    source_type = str(signal.get("source_type") or "").strip()

    # signal_sources: list-of-dicts mirroring how steward.py records
    # signal provenance. ``source_signal_path`` is null at creation
    # time — the signal record hasn't been written yet. This shape is
    # documented in the header. Closure predicates (synthesized by the
    # LLM at creation time) are appended as additional entries with a
    # ``name`` field — Steward's gather_signals_sure / gather_signals_gmail
    # activities consume these to actively poll for closure evidence.
    pred_lines = ""
    for pred in (closure_predicates or []):
        pred = (pred or "").strip()
        if pred:
            pred_lines += f"  - name: {_yaml_inline_str(pred)}\n"
    signal_sources_yaml = (
        f"signal_sources:\n"
        f"  - source_event_path: {_yaml_inline_str(source_event_path)}\n"
        f"    source_signal_path: null\n"
        f"    source_type: {_yaml_inline_str(source_type)}\n"
        f"{pred_lines}".rstrip()
    )

    # Frontmatter — mirroring the enrichment-created task shape
    # observed on david. Keys we set to empty/null/zero match Steward's
    # initial-state expectations exactly.
    lines: list[str] = ["---"]
    lines.append("blocked_on: ''")
    lines.append(f"created: {_yaml_inline_str(created_iso)}")
    lines.append(f"description: {_yaml_inline_str(description)}")
    if due_at:
        lines.append(f"due_at: {_yaml_inline_str(due_at)}")
    lines.append("enrichment_status: pending")
    lines.append("janitor_note: ''")
    lines.append("last_steward_check_at: ''")
    lines.append("last_steward_outcome: null")
    lines.append(f"name: {_yaml_inline_str(title)}")
    # next_check_after = created so the next Steward tick picks up the
    # new task. Steward's load_matter_tasks filter accepts any task
    # whose next_check_after is <= now.
    lines.append(f"next_check_after: {_yaml_inline_str(created_iso)}")
    lines.append(f"parent_matter: {_yaml_inline_str(parent_matter)}")
    lines.append("pending_confirmation: false")
    lines.append("related_matters: []")
    lines.append("related_orgs: []")
    lines.append("related_persons: []")
    lines.append(signal_sources_yaml)
    if source_event_path:
        lines.append(f"source_event: {_yaml_inline_str(source_event_path)}")
    lines.append("staleness_score: 0")
    lines.append("state: open")
    lines.append("status: todo")
    lines.append("surface_class: normal")
    lines.append("tags:")
    lines.append("  - auto-from-signal")
    lines.append("type: task")
    lines.append("---")
    lines.append("")
    # Body — short and scannable. Repeats the description for the
    # vault file browser, then cites the source event.
    lines.append(f"# {title}")
    lines.append("")
    lines.append(description)
    lines.append("")
    if source_event_path:
        # Strip ``.md`` suffix for the wikilink form per vault convention.
        wiki_target = source_event_path
        if wiki_target.endswith(".md"):
            wiki_target = wiki_target[:-3]
        lines.append(f"Auto-created from signal: [[{wiki_target}]].")
        lines.append("")
    return "\n".join(lines)


def _yaml_inline_str(value: str) -> str:
    """Render ``value`` as a YAML single-quoted scalar.

    Mirrors signals.py's ``_yaml_inline_str`` so the two writers emit
    identical YAML for the same logical input. Single-quoting is the
    safest inline form: only ``'`` itself needs escaping (doubled),
    everything else passes through verbatim.
    """
    if value is None:
        return "''"
    s = str(value)
    escaped = s.replace("'", "''")
    return f"'{escaped}'"


# ---------------------------------------------------------------------------
# Audit emitter
# ---------------------------------------------------------------------------

async def _emit_audit_record(
    *,
    client: Any,
    signal: dict[str, Any],
    task_path: str,
    title: str,
    description: str,
    prompt: str,
    llm_response: dict[str, Any],
    created_iso: str,
) -> str | None:
    """Write one ``event/auto-task-created-<ts>-<slug>.md`` audit record.

    The audit cites:
      * the source signal's source_event_path,
      * the resulting task path,
      * the LLM prompt (full — Phase 6.7 calibration replays these),
      * the LLM response (the raw JSON),
      * the LLM-decided title + description (mirrored from the task
        for at-a-glance review).

    Returns the written audit path on success, ``None`` on failure
    (logged + swallowed; the task is already written so a missing
    audit doesn't block downstream).
    """
    import hashlib
    import json

    import httpx

    source_event_path = str(signal.get("source_event_path") or "")

    # Audit slug — share the timestamp suffix shape used by the existing
    # event/steward-* audit records on david so the dashboard's recent-
    # events query can group them naturally.
    ts_filename = (
        created_iso.replace("+00:00", "Z").replace(":", "-")
    )
    slug_suffix = hashlib.sha256(
        source_event_path.encode("utf-8")
    ).hexdigest()[:8]
    audit_name = f"auto-task-created-{ts_filename}-{slug_suffix}"

    # Render the LLM response as compact JSON for the audit. The full
    # prompt + response goes in the body; only key scalars go in
    # frontmatter so the dashboard can index them.
    response_json = json.dumps(
        llm_response, ensure_ascii=False, indent=2, default=str,
    )

    fm_lines: list[str] = ["---"]
    fm_lines.append("type: auto-task-created")
    fm_lines.append(f"timestamp: {_yaml_inline_str(created_iso)}")
    fm_lines.append(f"target: {_yaml_inline_str(task_path)}")
    fm_lines.append(
        f"source_event_path: {_yaml_inline_str(source_event_path)}"
    )
    fm_lines.append(
        f"source_signal_path: {_yaml_inline_str('')}"
    )  # not yet written
    fm_lines.append(f"title: {_yaml_inline_str(title)}")
    fm_lines.append("---")
    fm_lines.append("")
    body_lines: list[str] = [
        f"# Auto-task created: {title}",
        "",
        description,
        "",
        f"- Target task: `{task_path}`",
        f"- Source signal event: `{source_event_path}`",
        "",
        "## LLM prompt",
        "",
        "```",
        prompt,
        "```",
        "",
        "## LLM response",
        "",
        "```json",
        response_json,
        "```",
        "",
    ]
    content = "\n".join(fm_lines + body_lines)

    # STORE-P6-1f-D: legacy /vault/event/ markdown write (auto-task-created audit) removed; SQL is now authoritative (via write_audit_safe).
    # The previous shadow audit-row emit (STORE-P2-2) is the only
    # persistence path. Replay-safe — inside an @activity.defn body
    # (``create_task_from_signal``), so no ``workflow.patched()`` gate
    # is required per packages/learn/CLAUDE.md.
    try:
        from src.activities.audit_writer import (
            current_enforcement_mode,
            write_audit_safe,
        )

        sql_resp = await write_audit_safe(
            actor="task_creation",
            action_type="auto_task_created",
            target_type="task",
            target_id=task_path,
            payload={
                "type": "auto-task-created",
                "timestamp": created_iso,
                "target": task_path,
                "source_event_path": source_event_path,
                "title": title,
                "description": description,
                "prompt": prompt,
                "llm_response": llm_response,
                "audit_name": audit_name,
                "body": content,
            },
            decision_origin=source_event_path or None,
            reasoning=None,
            reversible=False,
        )
        _ = current_enforcement_mode()  # plumbed for future warn/reject
    except Exception as exc:  # noqa: BLE001
        # Programming error in the kwargs above. Audit emit is now load-
        # bearing (no markdown twin), so surface to the caller rather
        # than starve silently.
        logger.warning(
            "task_creation: audit-row emit failed task=%s err=%r",
            task_path, exc,
        )
        return None

    if not sql_resp:
        # write_audit_safe swallowed an error and returned None.
        logger.warning(
            "task_creation: audit SQL emit returned None task=%s "
            "— audit row NOT persisted",
            task_path,
        )
        return None

    row_id = (
        str(sql_resp.get("id") or "") if isinstance(sql_resp, dict) else ""
    )
    path = f"audit/{row_id}" if row_id else ""
    logger.info(
        "task_creation: audit emitted source_event=%s task=%s -> SQL id=%s",
        source_event_path, task_path, row_id,
    )
    return path
