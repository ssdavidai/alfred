"""Backfill — mark pre-Phase-6 onboarding records as processed.

The 135 generic-prefixed stream_events with human-readable filenames
(no system source field) are onboarding-era reference cards from the
2026-04-08 vault bootstrap, not real stream events. They got the
``generic-`` prefix during the T6.6.1 migration but they predate the
stream-events architecture entirely.

Treatment: stamp ``source_type: onboarding`` and
``signal_extracted_at: <ts>`` so the SignalExtractWorkflow's
unprocessed-events query skips them. We do NOT move them out of
stream_event/ in this script — that would require a second round of
wikilink rewriting and we want to keep the soak-window blast radius
minimal. Defer relocating them to note/ or inbox/ until post-soak.
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

FRONTMATTER_SPLIT = re.compile(r"^---\n([\s\S]*?)\n---(\n[\s\S]*)?$")
SOURCE_FIELD_RE = re.compile(r'^source:', re.MULTILINE)
SOURCE_TYPE_FIELD_RE = re.compile(
    r'^source_type:\s*"?([^"\n]+)"?\s*$', re.MULTILINE
)
SIGNAL_EXTRACTED_AT_RE = re.compile(
    r'^signal_extracted_at:\s*(\S.*)?$', re.MULTILINE
)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--vault", required=True)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    stream_dir = Path(args.vault) / "stream_event"
    if not stream_dir.is_dir():
        print(f"FATAL: {stream_dir} not found", file=sys.stderr)
        return 1

    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    stamp_iso = now_iso  # arbitrary marker; downstream queries skip non-null

    stamped = 0
    not_eligible = 0
    errors = 0
    files = sorted(stream_dir.glob("generic-*.md"))

    for f in files:
        try:
            raw = f.read_text(encoding="utf-8")
        except Exception:
            errors += 1
            continue

        m = FRONTMATTER_SPLIT.match(raw)
        if not m:
            errors += 1
            continue
        fm = m.group(1)
        body = m.group(2) or ""

        # Eligibility: no source field (onboarding shape)
        if SOURCE_FIELD_RE.search(fm):
            not_eligible += 1
            continue

        new_fm = fm
        # Stamp source_type: onboarding (replace if missing/different)
        if SOURCE_TYPE_FIELD_RE.search(new_fm):
            new_fm = SOURCE_TYPE_FIELD_RE.sub(
                'source_type: "onboarding"', new_fm, count=1
            )
        else:
            new_fm = new_fm + '\nsource_type: "onboarding"'

        # Stamp signal_extracted_at so the SignalExtractWorkflow skips
        if SIGNAL_EXTRACTED_AT_RE.search(new_fm):
            new_fm = SIGNAL_EXTRACTED_AT_RE.sub(
                f'signal_extracted_at: "{stamp_iso}"', new_fm, count=1
            )
        else:
            new_fm = new_fm + f'\nsignal_extracted_at: "{stamp_iso}"'

        if not args.dry_run:
            f.write_text(f"---\n{new_fm}\n---{body}", encoding="utf-8")
        stamped += 1
        if args.verbose:
            print(f"  {f.name}")

    print(f"Stamped: {stamped}")
    print(f"Not eligible (had source field): {not_eligible}")
    print(f"Errors: {errors}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
