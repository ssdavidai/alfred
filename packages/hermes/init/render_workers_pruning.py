"""render_workers_pruning.py — backfill disk-bloat GC cron onto background profiles.

`render_hermes.py` seeds the per-profile config.yaml ONCE; on subsequent boots
the file is operator-owned and never re-rendered (see render_mcp_servers.py
docstring for the full rationale). That means the `cron:` GC block added to
hermes-config.yaml.njk for the background profiles (workers / heavy) is
invisible to any tenant whose config.yaml predates the change — exactly the
fleet that is already bloated.

This is an idempotent ADD-only mutator, the same shape as render_mcp_servers.py
and render_sms_gateway.py. It ensures the two GC jobs exist in
`cron.jobs` for the workers + heavy profiles:

  * prune-old-sessions — delete sessions/session_*.json and
    sessions/request_dump_*.json older than 7 days.
  * vacuum-state-db    — VACUUM the profile's state.db (SQLite does not shrink
                          the file on DELETE; VACUUM rewrites it compactly).

It is ADD-only: if a job with the same `name` already exists (operator may have
tuned the schedule or command), it is preserved verbatim. Any OTHER operator
cron job is preserved. `cron.wrap_response` is set to false only if the key is
absent (these profiles have no channel consumer).

Motivating regression (2026-06-19): a client tenant workers state.db = 111 G
and sessions/ = 140 G across 312,875 files filled the host disk to 100% and
took the whole tenant down. The bloat is fleet-wide (joe state.db 52 G, rj
59 G, rami sessions 37 G/92 k files, home 19 G/54 k files); nothing prunes
either store. See the GC block in hermes-config.yaml.njk.

main / codex-builder are skipped:
  * main already renders its own `cron:` block (wrap_response + reminders);
    its sessions are the live chat surface and reset on a daily boundary.
  * codex-builder is a sealed runtime with its own `cleanup-old-runs` GC of
    /work/runs — its sessions live elsewhere.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Profiles that get the GC cron. Mirrors the `{%- else %}` background branch in
# hermes-config.yaml.njk (everything that is not main / codex-builder).
_BACKGROUND_PROFILES = {"workers", "heavy"}

# Retention window for session / request_dump files, in days. Worker sessions
# are one-shot (session_reset idle 30m) so a file older than a day is already
# dead; 7 keeps a forensic window. Keep in sync with the .njk template.
_SESSION_RETENTION_DAYS = 7


def _gc_jobs(runtime_profile_dir: str) -> list[dict]:
    """The two GC jobs, rendered for a given runtime profile dir.

    Schedules + commands MUST stay in sync with the `cron.jobs` block the
    .njk template renders for the background profiles.
    """
    sessions = f"{runtime_profile_dir}/sessions"
    state_db = f"{runtime_profile_dir}/state.db"
    return [
        {
            "name": "prune-old-sessions",
            "schedule": "23 3 * * *",
            "command": (
                f"find {sessions} -maxdepth 1 -type f "
                f"\\( -name 'session_*.json' -o -name 'request_dump_*.json' \\) "
                f"-mtime +{_SESSION_RETENTION_DAYS} -delete"
            ),
        },
        {
            "name": "vacuum-state-db",
            "schedule": "43 3 * * *",
            "command": (
                "python3 -c \"import sqlite3,os; "
                f"p='{state_db}'; "
                "(sqlite3.connect(p).execute('VACUUM').connection.close()) "
                "if os.path.exists(p) else None\""
            ),
        },
    ]


def ensure_workers_pruning(
    config_path: Path,
    *,
    profile: str,
    runtime_profile_dir: str,
) -> str:
    """Ensure the GC cron jobs exist on a background profile's config.yaml.

    Returns one of: "skipped" (not a background profile / no config),
    "present" (both jobs already there), "added" (one or both backfilled).
    """
    if profile not in _BACKGROUND_PROFILES:
        return "skipped"
    if not config_path.exists():
        return "skipped"

    # ruamel.yaml round-trip — preserves the operator's comments / quoting /
    # ordering; only the grafted cron sub-block changes. Same editor the
    # sibling ADD-only mutators (render_mcp_servers, render_sms_gateway) use.
    from ruamel.yaml import YAML

    yaml = YAML()
    yaml.preserve_quotes = True

    data = yaml.load(config_path.read_text(encoding="utf-8"))
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return "skipped"

    cron = data.get("cron")
    if not isinstance(cron, dict):
        cron = {}
        data["cron"] = cron

    # Silent background runs — only set if the operator hasn't.
    if "wrap_response" not in cron:
        cron["wrap_response"] = False

    jobs = cron.get("jobs")
    if not isinstance(jobs, list):
        jobs = []
        cron["jobs"] = jobs

    existing_names = {
        j.get("name") for j in jobs if isinstance(j, dict) and j.get("name")
    }

    added_any = False
    for job in _gc_jobs(runtime_profile_dir):
        if job["name"] in existing_names:
            continue  # ADD-only — preserve an operator-tuned job verbatim.
        jobs.append(job)
        added_any = True

    if not added_any:
        return "present"

    with config_path.open("w", encoding="utf-8") as f:
        yaml.dump(data, f)
    return "added"


if __name__ == "__main__":
    profile = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
    if not profile:
        print(
            "usage: render_workers_pruning.py <profile>\n"
            "  env: PROFILE_DIR, HERMES_RUNTIME_PROFILE_DIR",
            file=sys.stderr,
        )
        sys.exit(2)

    profile_dir = Path(
        os.environ.get("PROFILE_DIR", f"/hermes-state/profiles/{profile}")
    )
    config = profile_dir / "config.yaml"

    # The runtime view of the profile dir (what the gateway process sees) — the
    # cron commands run inside the hermes runtime container, not the init
    # container. Same resolution as render_mcp_servers.py.
    runtime_override = os.environ.get("HERMES_RUNTIME_PROFILE_DIR", "").strip()
    runtime_home = os.environ.get("HERMES_RUNTIME_HOME", "").strip()
    if runtime_override:
        runtime_profile_dir = runtime_override
    elif runtime_home:
        runtime_profile_dir = str(Path(runtime_home) / "profiles" / profile)
    else:
        runtime_profile_dir = str(profile_dir)

    try:
        outcome = ensure_workers_pruning(
            config,
            profile=profile,
            runtime_profile_dir=runtime_profile_dir,
        )
    except Exception as exc:
        # Best-effort step; never abort init on a render hiccup.
        print(f"[render-workers-pruning] WARN {config}: {exc}", file=sys.stderr)
        sys.exit(0)
    print(f"[render-workers-pruning] {config} ({profile}): {outcome}")
