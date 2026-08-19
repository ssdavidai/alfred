"""Paths on the volume shared between this daemon and the LLM's container.

The LLM does not run here. It runs in the hermes container, and the two
containers mount the SAME docker volume at DIFFERENT places:

    alfred-black_alfred_data  ->  /alfred-data   (hermes: where the LLM writes)
                              ->  /app/data      (this daemon: where we read)

So a path handed to the LLM in a prompt is not a path this process can open,
and vice versa. Getting that wrong is silent: the write succeeds, the read
raises FileNotFoundError, and the pipeline falls back to scraping stdout.

The distiller got it wrong in a way no fallback could rescue — it used /tmp,
which is a separate tmpfs per container, so the file the LLM wrote was never
reachable from here at all. Its "primary" read path could not succeed even in
principle; every run depended on the stdout fallback, and a well-behaved model
that wrote the file and printed a short acknowledgement produced nothing to
scrape. The better the model behaved, the worse the outcome.

Use manifest_paths() rather than composing either path by hand.
"""

from __future__ import annotations

import uuid
from pathlib import Path

# How the LLM's container sees the shared volume.
LLM_SHARED_DIR = "/alfred-data"
# How this container sees the same volume.
LOCAL_SHARED_DIR = "/app/data"


def to_local(llm_path: str) -> Path:
    """Translate a path as the LLM sees it into one this process can open."""
    if llm_path.startswith(LLM_SHARED_DIR + "/"):
        return Path(llm_path.replace(LLM_SHARED_DIR, LOCAL_SHARED_DIR, 1))
    return Path(llm_path)


def manifest_paths(prefix: str) -> tuple[str, Path]:
    """Allocate a manifest file on the shared volume.

    Returns (llm_path, local_path):
      * llm_path   — put THIS in the prompt; it is what the LLM can write to.
      * local_path — read THIS here; it is the same file, seen from this
                     container.

    They are deliberately different types so the two cannot be swapped by
    accident: the prompt wants a str, the reader wants a Path.
    """
    llm_path = f"{LLM_SHARED_DIR}/alfred-{prefix}-{uuid.uuid4().hex[:12]}-manifest.json"
    return llm_path, to_local(llm_path)
