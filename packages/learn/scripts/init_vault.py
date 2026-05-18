"""Initialize vault folders and initial files for alfred-learn.

Run on first boot:
    python -m scripts.init_vault
"""

from __future__ import annotations

import asyncio
import logging
import os

from src.config import load_config
from src.utils.vault_client import VaultClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("init-vault")

INTUITION_INDEX_CONTENT = """---
type: index
name: Intuition Index
---

# Intuition Index

Alfred's accumulated intuition about how the household runs.

No instincts developed yet. As observations accumulate and nightly reflection
runs, instincts will appear here automatically.
"""


async def init_vault() -> None:
    config = load_config()
    client = VaultClient(config)

    # Ensure all required vault directories exist on the mounted volume
    required_dirs = [
        config.vault_observation_dir,
        config.vault_intuition_dir,
        config.vault_instincts_dir,
        config.vault_reflection_dir,
        os.path.join(config.vault_path, "session"),
        config.vault_quarantine_dir,
    ]
    for directory in required_dirs:
        os.makedirs(directory, exist_ok=True)
        logger.info("Ensured directory exists: %s", directory)

    try:
        # Create the intuition index
        try:
            await client.write_record("index", "intuition-index", INTUITION_INDEX_CONTENT)
            logger.info("Created intuition/index.md")
        except Exception as e:
            if "already exists" in str(e).lower() or "409" in str(e):
                logger.info("intuition/index.md already exists")
            else:
                logger.warning("Could not create intuition index: %s", e)

        logger.info("Vault initialization complete.")
    finally:
        await client.close()


def main() -> None:
    asyncio.run(init_vault())


if __name__ == "__main__":
    main()
