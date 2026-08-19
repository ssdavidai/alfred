"""The LLM writes in a different container than the one that reads.

alfred-black_alfred_data is mounted at /alfred-data in hermes (where the LLM
runs) and /app/data here. A path handed to the LLM is therefore NOT a path this
process can open.

The distiller used /tmp, which is a separate tmpfs per container. Its primary
read could not succeed even in principle — every run silently depended on
scraping stdout, and a well-behaved model that wrote the file and printed a
short acknowledgement produced nothing to scrape.
"""
from __future__ import annotations

import re
from pathlib import Path

from alfred.shared_paths import (
    LLM_SHARED_DIR,
    LOCAL_SHARED_DIR,
    manifest_paths,
    to_local,
)

SRC = Path(__file__).resolve().parents[1] / "src" / "alfred"


def test_llm_path_and_local_path_are_the_same_file_seen_differently():
    llm, local = manifest_paths("distiller")
    assert llm.startswith(LLM_SHARED_DIR + "/")
    assert str(local).startswith(LOCAL_SHARED_DIR + "/")
    assert Path(llm).name == local.name


def test_the_two_paths_are_different_types_so_they_cannot_be_swapped():
    """The prompt wants a str, the reader wants a Path. Mixing them up is the
    original bug, so make it a type error rather than a silent miss."""
    llm, local = manifest_paths("curator")
    assert isinstance(llm, str)
    assert isinstance(local, Path)


def test_to_local_is_a_no_op_for_paths_already_local():
    assert to_local("/app/data/x.json") == Path("/app/data/x.json")
    assert to_local("/vault/x.md") == Path("/vault/x.md")


def test_no_pipeline_asks_the_llm_to_write_to_tmp():
    """/tmp is per-container. A manifest written there by the LLM is
    unreachable from here — which is exactly how the distiller's primary path
    came to be dead for its whole life."""
    offenders = []
    for f in SRC.rglob("pipeline.py"):
        for i, line in enumerate(f.read_text().splitlines(), 1):
            if re.search(r'["\']/tmp/[^"\']*manifest', line):
                offenders.append(f"{f.relative_to(SRC)}:{i}: {line.strip()}")
    assert not offenders, (
        "manifest files must live on the shared volume, not /tmp:\n  "
        + "\n  ".join(offenders)
    )
