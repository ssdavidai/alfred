#!/usr/bin/env python3
"""render_telegram_gateway.py — idempotently ensure the main-profile
config.yaml has a `gateway.platforms.telegram` block.

Hermes' built-in Telegram platform (`gateway/platforms/telegram.py`) is
enabled iff config.yaml has this block, and the bot token is then picked
up natively from `TELEGRAM_BOT_TOKEN` (see `gateway/config.py:1194,1243`).
`render_hermes.py` only SEEDS config.yaml when absent (operator-owned),
so a new template key never reaches an already-deployed tenant. This
script backfills the block on every init boot.

ruamel.yaml round-trip mode preserves comments + key ordering; PyYAML's
safe_load → safe_dump would strip every comment in the file.

Usage:
    render_telegram_gateway.py <profile_dir>
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


def ensure_telegram_gateway_block(config_path: Path) -> str:
    """Ensure `gateway.platforms.telegram` exists in `config_path`.

    Returns "added" / "present" / "no-config". Idempotent. Preserves all
    other keys; preserves operator-set values inside an existing
    telegram block (the function is ADD-only, never an enforce-on-true
    overwrite).
    """
    if not config_path.exists():
        return "no-config"

    from ruamel.yaml import YAML
    from ruamel.yaml.comments import CommentedMap

    yaml = YAML()
    yaml.preserve_quotes = True
    # Match the template's 2-space indent / 4-space mapping offset.
    yaml.indent(mapping=2, sequence=4, offset=2)

    with config_path.open("r", encoding="utf-8") as fh:
        data: Any = yaml.load(fh)
    if data is None:
        data = CommentedMap()

    if "gateway" not in data:
        data["gateway"] = CommentedMap()
    gateway = data["gateway"]
    if not isinstance(gateway, dict):
        raise RuntimeError(
            f"`gateway:` in {config_path} is not a mapping; refusing to overwrite."
        )

    if "platforms" not in gateway:
        gateway["platforms"] = CommentedMap()
    platforms = gateway["platforms"]
    if not isinstance(platforms, dict):
        raise RuntimeError(
            f"`gateway.platforms:` in {config_path} is not a mapping; "
            "refusing to overwrite."
        )

    if "telegram" in platforms:
        return "present"

    telegram = CommentedMap()
    telegram["enabled"] = True
    telegram["token_env"] = "TELEGRAM_BOT_TOKEN"
    platforms["telegram"] = telegram

    with config_path.open("w", encoding="utf-8") as fh:
        yaml.dump(data, fh)

    return "added"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: render_telegram_gateway.py <profile_dir>", file=sys.stderr)
        return 2
    config_path = Path(argv[1]) / "config.yaml"
    result = ensure_telegram_gateway_block(config_path)
    if result == "added":
        print("[init] Added gateway.platforms.telegram to main profile config.yaml")
    elif result == "present":
        print("[init] gateway.platforms.telegram already present, preserving")
    else:  # no-config
        print(
            f"[init] config.yaml not at {config_path} — skipping "
            "telegram-gateway step"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
