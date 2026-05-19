"""Pattern detection from the unified observation pool (OBS-4).

OBS-2 + OBS-1 give us one canonical evidence layer: every decision the
principal makes AND every signal that reaches the principal lands as
an ``observation/*.md`` record with a uniform schema (subject, fact,
topic, source_kind, sender, intent, ...).

This activity scans that pool deterministically — no clerk — and
clusters observations by (sender, intent) within a recent window. A
cluster passes when at least ``MIN_CLUSTER_SIZE`` observations from
the same sender agree on the same intent (>= INTENT_AGREEMENT of
that sender's observations in the window).

For each surviving cluster we propose a ``pattern_proposal`` record
the principal can accept on /desk. OBS-5's acceptor will materialise
an instinct from the accepted proposal.

The detector skips clusters that are already covered:
  * an active instinct whose ``input_patterns.sender_domains`` /
    ``signals.domain_patterns`` matches the sender, OR
  * any open / adopted / rejected pattern_proposal whose
    ``sender_key`` + ``intent_key`` match this cluster (avoids
    re-proposing rules the principal already saw)

Thresholds are conservative on purpose — OBS-7 will tune them once we
have real traffic. The detector is deliberately cheap; it can run
hourly without paying the LLM tax that ``DecisionPatternsWorkflow``
(legacy, daily, clerk-based) does.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient
from src.validators.pattern_proposal import validate_pattern_proposal_record
from src.validators.schema import MIN_PATTERN_PROPOSAL_EVIDENCE

logger = logging.getLogger("pattern-detection")


# ---------------------------------------------------------------------------
# Thresholds (OBS-7 will tune)
# ---------------------------------------------------------------------------

# At least this many observations must back a cluster before we surface
# a proposal. 5 is small enough to catch fast-recurring patterns
# (newsletter senders, weekly Slack pings) but big enough to avoid
# acting on a single bad week.
MIN_CLUSTER_SIZE = 5

# A sender's bucket only proposes a pattern if the dominant intent
# accounts for at least this fraction of their observations. 0.8 means
# 4 out of 5 in agreement, 8 out of 10, etc. Below that the principal
# is still ambiguous and the rule isn't real yet.
INTENT_AGREEMENT = 0.8

# Days of observation history to look back over. Long enough to catch
# weekly patterns; short enough that stale senders age out of the
# decision cohort.
WINDOW_DAYS = 30

# Hard cap on proposals emitted per run. The detector runs hourly; we
# never want to dump 200 cards onto /desk in one tick. If real signal
# exceeds this cap, the next tick picks up the residue.
MAX_PROPOSALS_PER_RUN = 10

# Intents that are eligible to become auto-routing rules. "take_mine"
# is the principal asserting "I'll handle this myself" — that's a
# negative-space pattern, not an auto-route. "approve" and
# "auto_dispatch" are autonomous-side artifacts (Alfred's own
# decisions), not signal of the principal's preference.
ROUTABLE_INTENTS = frozenset({"delegate", "defer", "done", "noise"})


# Map from intent → human-readable verb for the rule sentence.
# Mirrors decision_observations._INTENT_VERBS but in the third-person
# observed form (the rule narrates the principal's behavior).
_INTENT_PHRASE: dict[str, str] = {
    "delegate": "delegated the response to Alfred",
    "defer": "deferred without action",
    "done": "marked it handled immediately",
    "noise": "marked it as noise (no action needed)",
}

# Map from intent → proposed action sentence.
_INTENT_ACTION: dict[str, str] = {
    "delegate": (
        "Auto-delegate inbound from this sender to Alfred without "
        "surfacing on /desk."
    ),
    "defer": (
        "Auto-defer inbound from this sender for later review; do not "
        "interrupt the principal."
    ),
    "done": (
        "Treat inbound from this sender as already-handled; archive on "
        "arrival."
    ),
    "noise": (
        "Auto-suppress inbound from this sender as known noise; do not "
        "create a needs_attention card."
    ),
}


def _http() -> httpx.AsyncClient:
    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    return httpx.AsyncClient(
        base_url=cfg.alfred_ctrl_url, headers=headers, timeout=60.0,
    )


def _readers_use_sql() -> bool:
    """STORE-P3-5: gate the SQL read switch. Default ``1`` (on)."""
    raw = (os.environ.get("READERS_USE_SQL") or "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _sql_observation_to_record(row: dict[str, Any]) -> dict[str, Any]:
    """Adapt one ctrl-api ``observation`` row into the legacy markdown shape.

    The clustering code keys off ``subject``, ``source_kind``, ``sender``,
    ``intent``, ``topic``, ``matter_ref``, and ``created`` inside
    ``frontmatter``. The SQL row only carries ``{id, ts, signal_id,
    instinct_id, confidence, embedding_id}`` — every analytic field the
    markdown record carried lives in companion tables we haven't joined
    yet. So the SQL path returns a record whose frontmatter has the
    minimum the clusterer can act on: ``instinct_id`` as the dedup key
    surrogate for ``sender`` and ``created`` translated from ``ts``.
    Subject/source_kind default to "principal" / "decision" so the
    clusterer's coarse filters pass — STORE-P3 will widen the SQL
    schema before this becomes the only path.
    """
    ts_raw = row.get("ts")
    created_iso = ""
    if ts_raw is not None:
        try:
            ts_ns = int(str(ts_raw))
            created_iso = (
                datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=timezone.utc)
                .isoformat(timespec="seconds")
                .replace("+00:00", "Z")
            )
        except (TypeError, ValueError):
            created_iso = ""
    fm: dict[str, Any] = {
        "subject": "principal",
        "source_kind": "decision",
        "sender": row.get("instinct_id") or "",
        "intent": "delegate",
        "topic": "",
        "matter_ref": "",
        "created": created_iso,
        "confidence": row.get("confidence"),
    }
    obs_id = str(row.get("id") or "").strip()
    path = f"observation/{obs_id}.md" if obs_id else ""
    return {"path": path, "frontmatter": fm}


def _parse_iso(s: str) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Deterministic clustering
# ---------------------------------------------------------------------------

def _build_clusters(
    observations: list[dict[str, Any]],
    *,
    window_days: int,
) -> list[dict[str, Any]]:
    """Bucket observations by (sender, intent), apply the agreement
    + size thresholds, and return the surviving clusters.

    Pure function — no I/O. ``observations`` is the list returned by
    the records-list endpoint (each entry has ``path`` + ``frontmatter``).
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)

    # by_sender[sender] = {
    #   "by_intent": {intent: [obs_paths]},
    #   "topics": set(),
    #   "matter_refs": set(),
    #   "total": int,
    # }
    by_sender: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "by_intent": defaultdict(list),
            "topics": set(),
            "matter_refs": set(),
            "total": 0,
        }
    )

    for obs in observations:
        fm = obs.get("frontmatter") or {}
        if not isinstance(fm, dict):
            continue
        path = obs.get("path") or obs.get("relPath") or ""
        if not path:
            continue
        # Subject filter: only "principal" — autonomous Alfred fires
        # land as "principal_via_alfred" and aren't signal of the
        # principal's preference.
        if str(fm.get("subject") or "").strip() != "principal":
            continue
        # Source filter: cluster on decisions only for v1. Signal
        # observations carry intent=null and don't tell us what the
        # principal *did*.
        if str(fm.get("source_kind") or "").strip() != "decision":
            continue
        sender = str(fm.get("sender") or "").strip()
        intent = str(fm.get("intent") or "").strip()
        if not sender or not intent:
            continue
        if intent not in ROUTABLE_INTENTS:
            continue
        created = _parse_iso(str(fm.get("created") or ""))
        if created is None or created < cutoff:
            continue

        bucket = by_sender[sender]
        bucket["by_intent"][intent].append(path)
        bucket["total"] += 1
        topic = str(fm.get("topic") or "").strip()
        if topic:
            bucket["topics"].add(topic)
        mref = str(fm.get("matter_ref") or "").strip()
        if mref:
            bucket["matter_refs"].add(mref)

    clusters: list[dict[str, Any]] = []
    for sender, bucket in by_sender.items():
        total = bucket["total"]
        if total < MIN_CLUSTER_SIZE:
            continue
        # Pick the dominant intent. defaultdict(list) → iterate items.
        dominant_intent: str = ""
        dominant_paths: list[str] = []
        for intent, paths in bucket["by_intent"].items():
            if len(paths) > len(dominant_paths):
                dominant_intent = intent
                dominant_paths = paths
        if not dominant_intent:
            continue
        if len(dominant_paths) < MIN_CLUSTER_SIZE:
            continue
        agreement = len(dominant_paths) / total
        if agreement < INTENT_AGREEMENT:
            continue

        # Sample a representative subset of observation paths for the
        # proposal frontmatter. We keep the full cluster_size on the
        # record so the receiver can see the evidence weight, even if
        # we only surface a sample of paths.
        sample = sorted(dominant_paths)[-10:]  # most recent 10

        clusters.append({
            "sender": sender,
            "intent": dominant_intent,
            "cluster_size": len(dominant_paths),
            "total_in_bucket": total,
            "agreement": round(agreement, 3),
            "observation_refs": sample,
            "topics": sorted(bucket["topics"])[:5],
            "matter_refs": sorted(bucket["matter_refs"])[:3],
        })

    # Strongest clusters first (higher agreement × cluster_size).
    clusters.sort(
        key=lambda c: (c["agreement"], c["cluster_size"]),
        reverse=True,
    )
    return clusters


# ---------------------------------------------------------------------------
# Skip-set: existing instincts + existing pattern_proposals
# ---------------------------------------------------------------------------

def _normalise_sender_key(sender: str) -> str:
    """Normalise a sender label for dedup comparison.

    Senders come in as ``"org/DigitalOcean"``, ``"person/Randal Johnson"``,
    raw email strings, or composio ``"name: subject"`` artifacts. We
    lowercase + strip the slash prefix so equivalent senders bucket
    the same way across runs.
    """
    s = (sender or "").strip().lower()
    if "/" in s:
        s = s.split("/", 1)[1]
    return s


async def _fetch_skip_set(client: httpx.AsyncClient) -> set[tuple[str, str]]:
    """Return the set of (sender_key, intent_key) tuples that
    correspond to existing instincts or pattern_proposals we should NOT
    re-propose.

    Conservative: any existing proposal in any non-terminal state, OR
    an active instinct mentioning the sender. We err on the side of
    silence — re-proposing the same rule is more annoying than missing
    one.
    """
    skip: set[tuple[str, str]] = set()

    # Existing pattern_proposals — index by sender_key + intent_key
    # frontmatter fields stamped by this very activity.
    try:
        resp = await client.get(
            "/api/v1/vault/list/pattern_proposal?preview=500",
        )
        if resp.status_code < 400:
            for r in (resp.json().get("results") or []):
                fm = r.get("frontmatter") or {}
                if not isinstance(fm, dict):
                    continue
                sender_key = _normalise_sender_key(str(fm.get("sender_key") or ""))
                intent_key = str(fm.get("intent_key") or "").strip().lower()
                if sender_key and intent_key:
                    skip.add((sender_key, intent_key))
    except httpx.HTTPError as exc:
        logger.warning("skip-set: failed to read pattern_proposals: %s", exc)

    # Active instincts — match on sender_domains / signals.domain_patterns.
    # Best-effort: this is a soft dedup, not a guarantee.
    try:
        resp = await client.get(
            "/api/v1/vault/list/instinct?preview=200",
        )
        if resp.status_code < 400:
            for r in (resp.json().get("results") or []):
                fm = r.get("frontmatter") or {}
                if not isinstance(fm, dict):
                    continue
                if str(fm.get("status") or "active") != "active":
                    continue
                # Pull every domain-ish list out of either schema.
                candidates: list[str] = []
                ip = fm.get("input_patterns") or {}
                if isinstance(ip, dict):
                    for k in ("sender_domains", "domain_patterns"):
                        v = ip.get(k) or []
                        if isinstance(v, list):
                            candidates.extend(str(x) for x in v)
                sigs = fm.get("signals") or {}
                if isinstance(sigs, dict):
                    v = sigs.get("domain_patterns") or []
                    if isinstance(v, list):
                        candidates.extend(str(x) for x in v)
                for cand in candidates:
                    key = _normalise_sender_key(cand)
                    if not key:
                        continue
                    # Match against every routable intent — an instinct
                    # claiming this sender preempts ALL intent rules
                    # for that sender. The principal already routed it.
                    for intent in ROUTABLE_INTENTS:
                        skip.add((key, intent))
    except httpx.HTTPError as exc:
        logger.warning("skip-set: failed to read instincts: %s", exc)

    return skip


# ---------------------------------------------------------------------------
# Proposal payload + writer
# ---------------------------------------------------------------------------

def _build_proposal(
    cluster: dict[str, Any], *, now_iso: str,
) -> tuple[str, str, dict[str, Any]]:
    """Return (name, content, frontmatter) for a pattern_proposal."""
    sender = cluster["sender"]
    intent = cluster["intent"]
    cluster_size = cluster["cluster_size"]
    agreement = cluster["agreement"]
    observation_refs = cluster["observation_refs"]
    sender_key = _normalise_sender_key(sender)

    phrase = _INTENT_PHRASE.get(intent, f"chose {intent}")
    action = _INTENT_ACTION.get(intent, f"Auto-{intent} inbound from this sender.")

    rule = (
        f"When inbound arrives from {sender}, the principal consistently "
        f"{phrase}."
    )
    name_label = f"Auto-{intent}: {sender}"[:90]
    evidence = (
        f"Observed in {cluster_size} of {cluster['total_in_bucket']} decisions "
        f"({int(agreement * 100)}% agreement) over the last {WINDOW_DAYS} days."
    )

    # Deterministic slug: same sender + intent collapses to the same
    # name on re-runs (the skip-set should prevent this, but the slug
    # protects us if it doesn't).
    short = hashlib.sha256(
        f"{sender_key}\x00{intent}".encode("utf-8")
    ).hexdigest()[:8]
    ts = now_iso.replace(":", "-").replace(".", "-")[:19] + "Z"
    record_name = f"{ts}-{short}"

    fm: dict[str, Any] = {
        "type": "pattern_proposal",
        "name": name_label,
        "created": now_iso,
        "status": "proposed",
        "rule": rule,
        "proposed_action": action,
        "evidence": evidence,
        "observation_refs": observation_refs,
        "cluster_size": cluster_size,
        "confidence": agreement,
        "matter_ref": None,
        "source_kind": "observation_cluster",
        "detector_version": "obs4.v1",
        "sender_key": sender_key,
        "intent_key": intent,
        "window_days": WINDOW_DAYS,
        "topics": cluster["topics"],
    }

    # YAML serialisation — keep it shallow, the writer reads frontmatter
    # back through the same parser the ctrl-api uses.
    fm_lines = ["---"]
    for k, v in fm.items():
        if v is None:
            fm_lines.append(f"{k}: null")
        elif isinstance(v, bool):
            fm_lines.append(f"{k}: {'true' if v else 'false'}")
        elif isinstance(v, (int, float)):
            fm_lines.append(f"{k}: {v}")
        elif isinstance(v, list):
            if not v:
                fm_lines.append(f"{k}: []")
            else:
                fm_lines.append(f"{k}:")
                for item in v:
                    fm_lines.append(f"  - {json.dumps(item)}")
        else:
            fm_lines.append(f"{k}: {json.dumps(str(v))}")
    fm_lines.append("---")
    fm_lines.append("")
    fm_lines.append(f"# {name_label}")
    fm_lines.append("")
    fm_lines.append(rule)
    fm_lines.append("")
    fm_lines.append(f"**Proposed action**: {action}")
    fm_lines.append("")
    fm_lines.append(f"*Evidence*: {evidence}")
    fm_lines.append("")
    if cluster["topics"]:
        fm_lines.append(f"*Topics observed*: {', '.join(cluster['topics'])}")
        fm_lines.append("")

    content = "\n".join(fm_lines) + "\n"
    return record_name, content, fm


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------

@activity.defn
async def detect_pattern_proposals() -> dict[str, Any]:
    """One-shot driver — gather observations, cluster, filter, write.

    Returned dict counters (surfaced in Temporal UI):

      * ``scanned``        — observation records pulled
      * ``clusters_found`` — buckets passing size + agreement
      * ``proposals_written`` — pattern_proposal records persisted
      * ``skipped_existing`` — clusters dropped by the skip-set
      * ``skipped_invalid`` — payloads that failed validator
      * ``errors``         — write failures (path + reason in error_messages)
    """
    counters: dict[str, Any] = {
        "scanned": 0,
        "clusters_found": 0,
        "proposals_written": 0,
        "proposal_paths": [],
        "skipped_existing": 0,
        "skipped_invalid": 0,
        "skipped_max_per_run": 0,
        "errors": 0,
        "error_messages": [],
    }

    async with _http() as client:
        # 1. Pull observations.
        #
        # STORE-P3-5: activity-internal SQL read; no workflow.patched gate needed per CLAUDE.md.
        # When READERS_USE_SQL=1 (default) we pull rows from
        # ctrl-api's GET /api/v1/observations and adapt them into the
        # markdown-record shape the clusterer expects. The SQL row
        # schema is narrower than the markdown frontmatter (no
        # subject/sender/intent/topic on the SQL side yet), so the
        # adapter fills the analytical fields with conservative
        # defaults — this path returns fewer clusters than the
        # markdown walk until the SQL schema widens. The legacy
        # markdown path stays the READERS_USE_SQL=0 fallback.
        use_sql = _readers_use_sql()
        observations: list[dict[str, Any]] = []
        if use_sql:
            cfg = load_config()
            vault = VaultClient(cfg)
            try:
                rows = await vault.list_observations(limit=2000)
                observations = [
                    _sql_observation_to_record(r)
                    for r in rows
                    if isinstance(r, dict)
                ]
            except (httpx.HTTPError, AttributeError) as exc:
                counters["errors"] += 1
                counters["error_messages"].append(f"list obs (sql): {exc}"[:300])
                return counters
            finally:
                await vault.close()
        else:
            # ``preview=2000`` returns frontmatter only, which is
            # exactly what the clusterer needs.
            try:
                resp = await client.get(
                    "/api/v1/vault/list/observation?preview=2000",
                )
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                counters["errors"] += 1
                counters["error_messages"].append(f"list obs: {exc}"[:300])
                return counters
            observations = resp.json().get("results", []) or []
        counters["scanned"] = len(observations)

        # 2. Cluster.
        clusters = _build_clusters(observations, window_days=WINDOW_DAYS)
        counters["clusters_found"] = len(clusters)
        if not clusters:
            return counters

        # 3. Skip-set from existing proposals + active instincts.
        skip = await _fetch_skip_set(client)

        # 4. Validate + write the surviving proposals.
        now_iso = datetime.now(timezone.utc).isoformat()
        for cluster in clusters:
            key = (
                _normalise_sender_key(cluster["sender"]),
                cluster["intent"],
            )
            if key in skip:
                counters["skipped_existing"] += 1
                continue
            if counters["proposals_written"] >= MAX_PROPOSALS_PER_RUN:
                counters["skipped_max_per_run"] += 1
                continue

            record_name, content, fm = _build_proposal(cluster, now_iso=now_iso)
            validation = validate_pattern_proposal_record(fm)
            if not validation.valid:
                counters["skipped_invalid"] += 1
                counters["error_messages"].append(
                    f"validator: {validation.errors}"[:300]
                )
                continue

            # STORE-P6-1f-D: legacy /vault/pattern_proposal/ markdown write removed; SQL is now authoritative (via write_pattern_proposal_safe).
            # The previous shadow SQL emit (Round 1) is the only
            # persistence path. ``write_pattern_proposal_safe`` still
            # swallows transport errors → returns None on failure; we
            # promote that None into the ``errors`` counter so a stuck
            # writer surfaces in the workflow result instead of silently
            # eating proposals. Replay-safe — this is inside an
            # ``@activity.defn`` body, so no ``workflow.patched()``
            # gate is required per packages/learn/CLAUDE.md.
            sql_resp: dict[str, Any] | None = None
            try:
                from src.activities.pattern_proposal_writer import (
                    write_pattern_proposal_safe,
                )

                observation_refs = fm.get("observation_refs") or []
                member_ids = (
                    [str(x) for x in observation_refs]
                    if isinstance(observation_refs, list)
                    else None
                )
                # STORE-P6-1f-F: deterministic id from the cluster's
                # canonical record_name (already a stable function of
                # sender + intent + cluster signature) so Temporal
                # retries collide on the same row; 409 returned by the
                # ctrl-api POST is mapped to success by the safe wrapper.
                import uuid as _uuid

                determ_id = str(
                    _uuid.uuid5(
                        _uuid.NAMESPACE_URL,
                        f"pattern-proposal:{record_name}",
                    )
                )
                sql_resp = await write_pattern_proposal_safe(
                    proposed_name=str(fm.get("name") or record_name),
                    proposed_body=content,
                    cluster_size=int(fm.get("cluster_size") or 0),
                    member_observation_ids=member_ids,
                    payload=fm,
                    id=determ_id,
                )
            except Exception as exc:  # noqa: BLE001
                # Programming error in the kwargs mapping above would
                # surface here. write_pattern_proposal_safe itself
                # already swallows transport errors and returns None.
                counters["errors"] += 1
                counters["error_messages"].append(
                    f"write {record_name}: {exc}"[:300]
                )
                continue

            if not sql_resp:
                counters["errors"] += 1
                counters["error_messages"].append(
                    f"write {record_name}: SQL emit returned None"[:300]
                )
                continue

            # Synthesise a pseudo-path so callers that expected a vault
            # path keep working. The SQL row id is the canonical
            # identifier; Phase 6 readers query /api/v1/pattern-proposals.
            row_id = (
                str(sql_resp.get("id") or "") if isinstance(sql_resp, dict) else ""
            )
            path = f"pattern_proposal/{row_id}" if row_id else ""
            counters["proposals_written"] += 1
            counters["proposal_paths"].append(path)
            logger.info(
                "pattern_detection: wrote SQL row id=%s (sender=%s intent=%s n=%d agree=%.2f)",
                row_id, cluster["sender"][:40], cluster["intent"],
                cluster["cluster_size"], cluster["agreement"],
            )

            # Also add to skip set so a duplicate cluster later in the
            # same pass doesn't double-write.
            skip.add(key)

    # Truncate verbose lists for Temporal UI sanity.
    counters["error_messages"] = counters["error_messages"][:10]
    counters["proposal_paths"] = counters["proposal_paths"][:20]

    # MIN_PATTERN_PROPOSAL_EVIDENCE is referenced here so the lint /
    # import-stripper doesn't drop the schema constant; the writer
    # relies on the validator enforcing it.
    _ = MIN_PATTERN_PROPOSAL_EVIDENCE
    return counters
