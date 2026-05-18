"""Fleet audit activities — detect wrong-tenant data in streams.

Background
----------

In April 2026 we discovered that ~8 days of tenant-a's Gmail/Calendar events
had been ingested under Sir's tenant due to a misconfigured Composio
user_id. The leak went unnoticed because the streams look like ordinary
Google events — there's no surface-level difference between "Sir's own
calendar event" and "an event from tenant-a's account that happened to land
on Sir's stream JSONL".

This module is the after-the-fact tripwire. Once a day every tenant runs
``audit_streams_for_owner_mismatch`` against its own ``composio-*.jsonl``
files. For every Google-origin event we extract the ``self: true``
attendee (which Google fills in with the authenticated account's email)
and compare it against the tenant's canonical owner email. A mismatch
means the stream contains events for someone else's Google account —
the exact signature of the tenant-a-vs-Sir leak.

Scope
-----

* Read-only. Never delete or modify streams.
* No LLM calls — pure string comparison.
* No cross-tenant reads — each tenant audits only its own
  ``/alfred-data/streams/composio-*.jsonl``.
* Malformed JSONL lines are logged and skipped so one bad line never
  stops the audit.
"""
from __future__ import annotations

import glob
import json
import logging
import os
from typing import Any

from temporalio import activity

logger = logging.getLogger("alfred-learn")


STREAMS_GLOB = "composio-*.jsonl"


@activity.defn
async def fleet_audit_is_enabled() -> bool:
    """Feature flag — defaults to true.

    Separate activity so the workflow's flag check is deterministic from
    Temporal's perspective (env reads happen inside an activity, not the
    workflow body). Mirrors the Plane sync pattern.
    """
    return os.environ.get(
        "FLEET_AUDIT_ENABLED", "true",
    ).strip().lower() == "true"


def _resolve_owner_email() -> tuple[str, str]:
    """Resolve the tenant owner's canonical email.

    Priority:
      1. ``OWNER_EMAIL`` env var (set by the provisioner, see
         ``packages/ctrl/src/infra/provisioner.ts``).
      2. ``/alfred-data/onboard.json`` — check ``owner_email`` /
         ``user_email`` / ``user.email`` shapes that some legacy
         onboard files carry.

    Returns ``(email, source)``. ``email`` is empty if nothing resolves.
    ``source`` is one of ``"env"``, ``"onboard_json"``, or ``""``.
    """
    email = (os.environ.get("OWNER_EMAIL") or "").strip().lower()
    if email:
        return email, "env"

    onboard_path = os.environ.get(
        "ONBOARD_JSON_PATH", "/alfred-data/onboard.json"
    )
    try:
        with open(onboard_path) as f:
            onboard = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return "", ""

    # Shapes we've seen across the fleet.
    candidates: list[Any] = [
        onboard.get("owner_email"),
        onboard.get("user_email"),
    ]
    user_blob = onboard.get("user")
    if isinstance(user_blob, dict):
        candidates.append(user_blob.get("email"))
    for cand in candidates:
        if isinstance(cand, str) and "@" in cand:
            return cand.strip().lower(), "onboard_json"
    return "", ""


def _iter_stream_files(streams_dir: str) -> list[str]:
    """Return absolute paths to ``composio-*.jsonl`` in ``streams_dir``.

    Returned in sorted order so the report is deterministic across runs.
    """
    pattern = os.path.join(streams_dir, STREAMS_GLOB)
    return sorted(glob.glob(pattern))


def _extract_self_attendee_email(raw: Any) -> str | None:
    """Pull the ``self: true`` attendee email out of a Google event payload.

    Google Calendar populates ``self: true`` on the attendee entry that
    represents the authenticated account. If the owner saw this event in
    their own calendar, that email matches ``OWNER_EMAIL``. If it came
    from another tenant's account, it'll be that other tenant's address.

    Returns a lowercased email string, or ``None`` if no self attendee
    exists in this payload.
    """
    if not isinstance(raw, dict):
        return None
    attendees = raw.get("attendees")
    if not isinstance(attendees, list):
        return None
    for a in attendees:
        if not isinstance(a, dict):
            continue
        if a.get("self") is True:
            email = a.get("email")
            if isinstance(email, str) and "@" in email:
                return email.strip().lower()
    return None


def _scan_jsonl_file(path: str, owner_email: str) -> list[dict[str, Any]]:
    """Scan one JSONL stream file for owner-mismatched events.

    Each mismatch is reported as a dict with event_id, date, self_email,
    expected_email, and the line number for cross-referencing.
    """
    mismatches: list[dict[str, Any]] = []
    try:
        fh = open(path, encoding="utf-8")
    except OSError as exc:
        logger.warning("fleet_audit: cannot open %s: %s", path, exc)
        return mismatches

    with fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError as exc:
                logger.warning(
                    "fleet_audit: malformed JSON at %s:%d — %s",
                    path, lineno, exc,
                )
                continue

            raw = event.get("raw") if isinstance(event, dict) else None
            self_email = _extract_self_attendee_email(raw)
            if not self_email:
                continue
            if self_email == owner_email:
                continue

            event_id = (
                (event.get("source_ref") or event.get("id") or "")
                if isinstance(event, dict) else ""
            )
            # Try a few date-ish shapes — calendar uses start.dateTime;
            # email-ish events use received_at.
            event_date = ""
            if isinstance(event, dict):
                for key in ("received_at", "created_at"):
                    val = event.get(key)
                    if isinstance(val, str) and val:
                        event_date = val
                        break
            if not event_date and isinstance(raw, dict):
                start = raw.get("start")
                if isinstance(start, dict):
                    event_date = str(
                        start.get("dateTime") or start.get("date") or ""
                    )

            mismatches.append({
                "event_id": event_id,
                "date": event_date,
                "self_email": self_email,
                "expected_email": owner_email,
                "line": lineno,
            })

    return mismatches


@activity.defn
async def audit_streams_for_owner_mismatch(
    streams_dir: str | None = None,
) -> dict[str, Any]:
    """Scan composio stream JSONL files for ``self:true`` attendees whose
    email doesn't match the tenant owner.

    Returns a structured report:

    ``{
        "status": "ok" | "no_owner_email_configured" | "no_streams_dir",
        "owner_email": str,
        "owner_source": str,
        "streams_dir": str,
        "files_scanned": int,
        "events_scanned": int,  # not exact — counts only candidate events
        "total_mismatches": int,
        "mismatches_by_file": {file_basename: [mismatched_event, ...]},
    }``

    Hard rule: if ``OWNER_EMAIL`` is unset and onboard.json doesn't
    carry the owner, return ``status="no_owner_email_configured"``
    immediately. Never false-alarm.
    """
    owner_email, owner_source = _resolve_owner_email()
    if not owner_email:
        logger.info(
            "fleet_audit: no owner email resolved — skipping audit"
        )
        return {
            "status": "no_owner_email_configured",
            "owner_email": "",
            "owner_source": "",
            "streams_dir": streams_dir or "",
            "files_scanned": 0,
            "events_scanned": 0,
            "total_mismatches": 0,
            "mismatches_by_file": {},
        }

    resolved_dir = streams_dir or os.environ.get(
        "ALFRED_DATA_DIR", "/alfred-data"
    ).rstrip("/") + "/streams"

    if not os.path.isdir(resolved_dir):
        logger.info(
            "fleet_audit: streams dir %s does not exist — nothing to audit",
            resolved_dir,
        )
        return {
            "status": "no_streams_dir",
            "owner_email": owner_email,
            "owner_source": owner_source,
            "streams_dir": resolved_dir,
            "files_scanned": 0,
            "events_scanned": 0,
            "total_mismatches": 0,
            "mismatches_by_file": {},
        }

    files = _iter_stream_files(resolved_dir)
    logger.info(
        "fleet_audit: owner=%s (source=%s) scanning %d composio-*.jsonl "
        "files under %s",
        owner_email, owner_source, len(files), resolved_dir,
    )

    mismatches_by_file: dict[str, list[dict[str, Any]]] = {}
    events_scanned = 0
    for fpath in files:
        file_mismatches = _scan_jsonl_file(fpath, owner_email)
        events_scanned += len(file_mismatches)  # only counts candidates
        if file_mismatches:
            mismatches_by_file[os.path.basename(fpath)] = file_mismatches

    total = sum(len(v) for v in mismatches_by_file.values())
    logger.info(
        "fleet_audit: done. files=%d mismatches=%d",
        len(files), total,
    )

    return {
        "status": "ok",
        "owner_email": owner_email,
        "owner_source": owner_source,
        "streams_dir": resolved_dir,
        "files_scanned": len(files),
        "events_scanned": events_scanned,
        "total_mismatches": total,
        "mismatches_by_file": mismatches_by_file,
    }


@activity.defn
async def write_fleet_audit_observation(report: dict[str, Any]) -> str:
    """Persist the audit report as an observation in the vault.

    Writes a single observation record per run (green or red) under
    ``observation/fleet-audit-<date>.md``. The reflection pipeline
    picks these up and Alfred surfaces any red entries in the next
    morning briefing.

    Returns the vault path written, or empty string if nothing was
    written (e.g. no-owner-email case — we still want a breadcrumb).
    """
    # Late-bound imports so the Temporal sandbox never sees httpx at
    # workflow-import time. (Matches the pattern in other activities.)
    from datetime import datetime, timezone

    from src.activities.vault import vault_record_path
    from src.config import load_config
    from src.utils.vault_client import VaultClient

    config = load_config()
    client = VaultClient(config)
    try:
        now = datetime.now(timezone.utc)
        date_str = now.strftime("%Y-%m-%d")
        status = report.get("status", "unknown")
        owner_email = report.get("owner_email", "")
        total = int(report.get("total_mismatches", 0) or 0)
        files_scanned = int(report.get("files_scanned", 0) or 0)

        if status == "no_owner_email_configured":
            severity = "not_audited"
            title = f"Fleet audit {date_str}: not audited (no owner email)"
            summary = (
                "OWNER_EMAIL env is unset and onboard.json has no usable "
                "email — audit skipped. Set OWNER_EMAIL on the tenant to "
                "enable wrong-tenant stream detection."
            )
        elif total == 0:
            severity = "green"
            title = f"Fleet audit {date_str}: green ({files_scanned} files)"
            summary = (
                f"Scanned {files_scanned} composio stream file(s) against "
                f"owner {owner_email}. No wrong-tenant events detected."
            )
        else:
            severity = "incident"
            title = (
                f"Fleet audit {date_str}: {total} WRONG-TENANT events "
                f"across {len(report.get('mismatches_by_file', {}))} files"
            )
            summary = (
                f"Stream contamination detected: {total} events have a "
                f"self:true attendee whose email does not match the tenant "
                f"owner ({owner_email}). This is the signature of a "
                f"cross-tenant Composio account leak. Review the files "
                f"listed below and the Composio user_id configuration."
            )

        # Build a readable body with the file-by-file breakdown.
        body_parts: list[str] = [f"# {title}", "", summary, ""]
        body_parts.append(f"- **Severity**: {severity}")
        body_parts.append(f"- **Owner email**: {owner_email or '(unresolved)'}")
        body_parts.append(
            f"- **Owner source**: {report.get('owner_source', '') or '(n/a)'}"
        )
        body_parts.append(
            f"- **Streams dir**: {report.get('streams_dir', '') or '(n/a)'}"
        )
        body_parts.append(f"- **Files scanned**: {files_scanned}")
        body_parts.append(f"- **Total mismatches**: {total}")
        body_parts.append("")

        mismatches_by_file = report.get("mismatches_by_file") or {}
        if mismatches_by_file:
            body_parts.append("## Mismatches by file")
            body_parts.append("")
            for fname, entries in sorted(mismatches_by_file.items()):
                body_parts.append(f"### `{fname}` — {len(entries)} events")
                body_parts.append("")
                # Cap per-file detail to keep the observation readable;
                # the full report still lives in Temporal history.
                for entry in entries[:25]:
                    body_parts.append(
                        f"- line {entry.get('line', '?')} · "
                        f"{entry.get('date', '?')} · "
                        f"self=`{entry.get('self_email', '')}` "
                        f"(expected `{entry.get('expected_email', '')}`) · "
                        f"event_id=`{entry.get('event_id', '')}`"
                    )
                if len(entries) > 25:
                    body_parts.append(
                        f"- ...and {len(entries) - 25} more. "
                        f"See Temporal history for the full list."
                    )
                body_parts.append("")

        frontmatter_tags = ["fleet-audit", severity]
        if severity == "incident":
            frontmatter_tags.append("wrong-tenant")

        content = f"""---
type: observation
created: {now.isoformat()}
status: unprocessed
input_type: system
input_source: fleet_audit
confidence: high
routed_by: fleet_audit
source: fleet_audit
severity: {severity}
tags: {frontmatter_tags}
fleet_audit:
  status: "{status}"
  owner_email: "{owner_email}"
  files_scanned: {files_scanned}
  total_mismatches: {total}
---

""" + "\n".join(body_parts)

        raw_name = f"fleet-audit-{severity}-{date_str}"
        name = vault_record_path("observation", raw_name, created=now)
        path = await client.write_record("observation", name, content)
        logger.info(
            "fleet_audit: wrote observation %s (severity=%s)",
            path, severity,
        )
        return path
    finally:
        await client.close()
