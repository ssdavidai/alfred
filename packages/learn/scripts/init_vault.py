"""Initialize vault folders for alfred-learn.

Run on first boot:
    python -m scripts.init_vault

Storage cutover (#26/#27, PLAN.md Part I): the vault holds only the ~12
canonical, principal-facing record types. The "intuition index" is
*machine state* — Alfred's accumulated instincts/observations are
tracked in ``state.db`` (Store 2), not as a markdown record. ctrl-api's
promotion contract rejects writes to non-canonical vault paths, so the
old ``client.write_record("index", "intuition-index", ...)`` call
returned HTTP 422. That write is removed: there is no ``intuition/``
directory and no index record. The /instincts dashboard page reads
instincts directly (canonical ``instinct/`` vault type) and observation
state from ``state.db`` — no index file is needed.
"""

from __future__ import annotations

import asyncio
import logging
import os

from src.config import load_config

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("init-vault")


async def init_vault() -> None:
    config = load_config()

    # Ensure the canonical on-disk vault directories exist on the
    # mounted volume. ``intuition/`` is deliberately NOT created — the
    # intuition index is machine state in state.db, not a vault record
    # (promotion contract, PLAN.md Part I). ``observation/`` likewise no
    # longer receives markdown (observations are state.db rows), but the
    # directory is harmless to pre-create for any legacy reader; we drop
    # it from the required set to stay strictly aligned with the 12
    # canonical types.
    required_dirs = [
        config.vault_instincts_dir,
        config.vault_reflection_dir,
        os.path.join(config.vault_path, "session"),
        config.vault_quarantine_dir,
    ]
    for directory in required_dirs:
        os.makedirs(directory, exist_ok=True)
        logger.info("Ensured directory exists: %s", directory)

    # No intuition-index markdown record is written. Instincts surface
    # from the canonical ``instinct/`` vault type; the machine's
    # accumulated intuition (observations, patterns) lives in state.db.
    logger.info(
        "Vault initialization complete "
        "(intuition index is state.db machine state — no vault record)."
    )


def main() -> None:
    asyncio.run(init_vault())


if __name__ == "__main__":
    main()
