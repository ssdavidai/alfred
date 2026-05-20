"""Locate bundled data files (skills, scaffold, examples).

Uses importlib.resources so paths resolve correctly whether Alfred is
installed from a local checkout or from a wheel on PyPI.
"""

from __future__ import annotations

from importlib.resources import files
from pathlib import Path


def get_bundled_dir() -> Path:
    return Path(str(files("alfred._bundled")))


def get_skills_dir() -> Path:
    return get_bundled_dir() / "skills"


def get_scaffold_dir() -> Path:
    return get_bundled_dir() / "scaffold"


def get_example_config() -> Path:
    return get_bundled_dir() / "config.yaml.example"


def get_example_env() -> Path:
    return get_bundled_dir() / ".env.example"


def get_tui_js_path() -> Path:
    return get_bundled_dir() / "tui_js" / "index.js"
