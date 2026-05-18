"""Backfill — fix source_type on generic-prefixed stream_events.

The migrator (T6.6.1) mapped legacy event/ + conversation/ records to
stream_event/<source_type>-<slug>.md, but ~2548 records lacked a
recognizable stream_type/source field at the time and got the
"generic" fallback. They actually carry an unambiguous `source:`
field — composio-gmail-*, composio-slack-*, etc. — that pins down
the real source.

This script reads each generic-* file, infers the correct source_type
from the `source:` field, and rewrites the frontmatter `source_type`
in place. Filenames stay as-is so wikilinks don't break — the per-
source confidence priors (T6.7.4) fire on frontmatter source_type,
not filename.

Run from inside the alfred container (write access to /vault):
  docker exec compose-alfred-1 python3 \\
    /opt/alfred/dev/alfred-platform/packages/learn/scripts/reclassify_generic_source_type.py \\
    --vault /mnt/encrypted/vault [--dry-run] [--verbose]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


SOURCE_PATTERN_TO_TYPE = [
    (re.compile(r"^composio-gmail-"), "gmail"),
    (re.compile(r"^composio-slack-"), "slack"),
    (re.compile(r"^composio-googlecalendar-"), "gcal"),
    (re.compile(r"^composio-github-"), "github"),
    (re.compile(r"^composio-notion-"), "notion"),
    (re.compile(r"^system-openclaw-sessions"), "openclaw-chat"),
    (re.compile(r"^sms-"), "sms"),
]

# UUID-only sources (the migrator wrote source: <uuid>) come from
# pre-Phase-6 ingestion that lost the stream_type metadata. Leave
# those as "generic" — we don't have enough signal to classify.

FRONTMATTER_SPLIT = re.compile(r"^---\n([\s\S]*?)\n---(\n[\s\S]*)?$")
SOURCE_FIELD_RE = re.compile(r'^source:\s*"?([^"\n]+)"?\s*$', re.MULTILINE)
SOURCE_TYPE_FIELD_RE = re.compile(r'^source_type:\s*"?([^"\n]+)"?\s*$', re.MULTILINE)


def infer_source_type(source_value: str) -> str | None:
    s = source_value.strip().strip('"').strip("'")
    if not s:
        return None
    for pattern, type_ in SOURCE_PATTERN_TO_TYPE:
        if pattern.search(s):
            return type_
    return None


def process_file(path: Path, dry_run: bool, verbose: bool) -> str:
    """Returns one of: 'updated', 'no_change', 'no_source_field',
    'no_inference', 'error'."""
    try:
        raw = path.read_text(encoding="utf-8")
    except Exception as e:
        if verbose:
            print(f"  ERROR reading {path}: {e}", file=sys.stderr)
        return "error"

    m = FRONTMATTER_SPLIT.match(raw)
    if not m:
        if verbose:
            print(f"  SKIP {path.name} (no frontmatter)")
        return "error"

    fm_text = m.group(1)
    body = m.group(2) or ""

    src_match = SOURCE_FIELD_RE.search(fm_text)
    if not src_match:
        return "no_source_field"
    src_value = src_match.group(1)

    inferred = infer_source_type(src_value)
    if not inferred:
        return "no_inference"

    st_match = SOURCE_TYPE_FIELD_RE.search(fm_text)
    if st_match:
        current = st_match.group(1).strip()
        if current == inferred:
            return "no_change"
        new_fm = SOURCE_TYPE_FIELD_RE.sub(
            f'source_type: "{inferred}"', fm_text, count=1
        )
    else:
        new_fm = fm_text + f'\nsource_type: "{inferred}"'

    if not dry_run:
        new_raw = f"---\n{new_fm}\n---{body}"
        path.write_text(new_raw, encoding="utf-8")

    if verbose:
        old = st_match.group(1) if st_match else "<missing>"
        print(f"  {path.name}: source_type {old!r} -> {inferred!r}")
    return "updated"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--vault", required=True, help="vault root directory")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    stream_dir = Path(args.vault) / "stream_event"
    if not stream_dir.is_dir():
        print(f"FATAL: {stream_dir} not found", file=sys.stderr)
        return 1

    counters: dict[str, int] = {
        "updated": 0,
        "no_change": 0,
        "no_source_field": 0,
        "no_inference": 0,
        "error": 0,
    }
    by_inferred: dict[str, int] = {}

    files = sorted(stream_dir.glob("generic-*.md"))
    print(f"Scanning {len(files)} generic-* records under {stream_dir}")
    if args.dry_run:
        print("(dry-run)")

    for f in files:
        result = process_file(f, args.dry_run, args.verbose)
        counters[result] = counters.get(result, 0) + 1
        if result == "updated" and not args.verbose:
            try:
                fm_text = FRONTMATTER_SPLIT.match(
                    f.read_text(encoding="utf-8")
                ).group(1)
                st = SOURCE_TYPE_FIELD_RE.search(fm_text)
                if st:
                    inferred = st.group(1).strip()
                    by_inferred[inferred] = by_inferred.get(inferred, 0) + 1
            except Exception:
                pass

    print()
    print("Summary:")
    for k, v in counters.items():
        print(f"  {k}: {v}")
    if by_inferred:
        print("By inferred source_type:")
        for k, v in sorted(by_inferred.items(), key=lambda x: -x[1]):
            print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
