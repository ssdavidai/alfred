"""Tests for render_registry.py — the #120 Lane II profile enumerator.

Pins the contract every layer above depends on:

  1. With a fully-seeded state.db (post-0017 migration), render_registry
     emits all four reserved profiles + any user-facing rows, ordered
     reserved-first then by api_server_port.
  2. With a missing state.db, the fallback emits the four reserved
     profiles with their canonical ports — so a fresh tenant (init
     boots before ctrl-api has applied the migration) still gets a
     valid layout.
  3. The atomic JSON write writes through a `.tmp` rename — never a
     half-written file.
  4. The stdout line format is `slug:port:model` — colon-separated,
     parseable by the entrypoint.sh loop.
  5. Archived profiles are excluded.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest


HERMES = Path(__file__).resolve().parent.parent
SCRIPT = HERMES / "init" / "render_registry.py"


def _seed_state_db(path: Path, *, include_user: bool = False, archive_user: bool = False) -> None:
    """Create a minimal state.db that mimics the post-0017-migration shape."""
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE agent_profile (
          slug              TEXT PRIMARY KEY,
          label             TEXT NOT NULL,
          description       TEXT,
          model             TEXT NOT NULL,
          deployment_shape  TEXT NOT NULL DEFAULT 'supervised',
          api_server_port   INTEGER NOT NULL,
          persona_template  TEXT,
          status            TEXT NOT NULL DEFAULT 'pending',
          is_user_facing    INTEGER NOT NULL DEFAULT 1,
          is_reserved       INTEGER NOT NULL DEFAULT 0,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL,
          archived_at       INTEGER
        );
        INSERT INTO agent_profile (slug, label, model, api_server_port, status, is_user_facing, is_reserved, created_at, updated_at) VALUES
          ('main',          'Alfred',        'x-ai/grok-4.3',             18789, 'running', 1, 1, 0, 0),
          ('workers',       'Workers',       'openai/gpt-4.1-nano',       18790, 'running', 0, 1, 0, 0),
          ('heavy',         'Heavy',         'anthropic/claude-opus-4-6', 18791, 'running', 0, 1, 0, 0),
          ('codex-builder', 'Codex builder', 'gpt-5-codex',               18793, 'stopped', 0, 1, 0, 0);
        """
    )
    if include_user:
        archived_at = "100" if archive_user else "NULL"
        status = "'archived'" if archive_user else "'pending'"
        conn.execute(
            f"INSERT INTO agent_profile (slug, label, model, api_server_port, status, is_user_facing, is_reserved, created_at, updated_at, archived_at) VALUES "
            f"('cratchit', 'Cratchit', 'x-ai/grok-4.3', 18794, {status}, 1, 0, 0, 0, {archived_at})"
        )
    conn.commit()
    conn.close()


def _run_script(state_db: Path | None, hermes_data_dir: Path | None, args: list[str] | None = None):
    """Run render_registry.py as a subprocess. Returns (stdout, stderr, rc)."""
    env = dict(os.environ)
    env["STATE_DB_PATH"] = str(state_db) if state_db else "/nonexistent.db"
    if hermes_data_dir:
        env["HERMES_DATA_DIR"] = str(hermes_data_dir)
    cmd = [sys.executable, str(SCRIPT)]
    if args:
        cmd.extend(args)
    result = subprocess.run(cmd, env=env, capture_output=True, text=True)
    return result.stdout, result.stderr, result.returncode


def test_emits_four_reserved_profiles_from_seeded_db(tmp_path: Path):
    state_db = tmp_path / "state.db"
    hermes_data = tmp_path / "hermes-data"
    hermes_data.mkdir()
    _seed_state_db(state_db)

    stdout, stderr, rc = _run_script(state_db, hermes_data)
    assert rc == 0, stderr
    lines = [l for l in stdout.strip().splitlines() if l]
    # 4 reserved profiles, ordered by api_server_port (main:18789 → ... → codex:18793).
    assert len(lines) == 4
    slugs = [line.split(":", 1)[0] for line in lines]
    assert slugs == ["main", "workers", "heavy", "codex-builder"]


def test_includes_user_facing_profile(tmp_path: Path):
    state_db = tmp_path / "state.db"
    hermes_data = tmp_path / "hermes-data"
    hermes_data.mkdir()
    _seed_state_db(state_db, include_user=True)

    stdout, stderr, rc = _run_script(state_db, hermes_data)
    assert rc == 0, stderr
    lines = [l for l in stdout.strip().splitlines() if l]
    assert len(lines) == 5
    # cratchit allocated on 18794 — last in port-ordered output (reserved
    # are sorted before user-facing because of is_reserved DESC).
    assert any("cratchit:18794:" in line for line in lines)


def test_archived_user_facing_profile_excluded(tmp_path: Path):
    state_db = tmp_path / "state.db"
    hermes_data = tmp_path / "hermes-data"
    hermes_data.mkdir()
    _seed_state_db(state_db, include_user=True, archive_user=True)

    stdout, stderr, rc = _run_script(state_db, hermes_data)
    assert rc == 0, stderr
    lines = [l for l in stdout.strip().splitlines() if l]
    assert len(lines) == 4  # archived profile excluded
    assert not any("cratchit" in line for line in lines)


def test_fallback_to_reserved_set_when_state_db_missing(tmp_path: Path):
    hermes_data = tmp_path / "hermes-data"
    hermes_data.mkdir()

    stdout, stderr, rc = _run_script(state_db=None, hermes_data_dir=hermes_data)
    assert rc == 0, stderr
    lines = [l for l in stdout.strip().splitlines() if l]
    assert len(lines) == 4
    slugs = [line.split(":", 1)[0] for line in lines]
    assert set(slugs) == {"main", "workers", "heavy", "codex-builder"}


def test_writes_atomic_registry_json(tmp_path: Path):
    state_db = tmp_path / "state.db"
    hermes_data = tmp_path / "hermes-data"
    hermes_data.mkdir()
    _seed_state_db(state_db, include_user=True)

    stdout, stderr, rc = _run_script(state_db, hermes_data)
    assert rc == 0, stderr

    out = hermes_data / "profiles" / "_registry.json"
    assert out.exists(), f"expected {out} to exist"
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert "profiles" in payload
    assert "generated_at" in payload
    assert "source" in payload
    slugs = {p["slug"] for p in payload["profiles"]}
    assert {"main", "workers", "heavy", "codex-builder", "cratchit"} <= slugs
    # The atomic write path uses a .tmp sibling and renames — that .tmp
    # must NOT survive a clean run.
    assert not (out.parent / "_registry.json.tmp").exists()


def test_print_only_does_not_write_registry(tmp_path: Path):
    state_db = tmp_path / "state.db"
    hermes_data = tmp_path / "hermes-data"
    hermes_data.mkdir()
    _seed_state_db(state_db)

    stdout, stderr, rc = _run_script(state_db, hermes_data, args=["--print-only"])
    assert rc == 0, stderr
    # stdout still has the tuples.
    assert "main:18789:" in stdout
    # but no registry file written.
    assert not (hermes_data / "profiles" / "_registry.json").exists()


def test_line_format_is_slug_port_model(tmp_path: Path):
    state_db = tmp_path / "state.db"
    hermes_data = tmp_path / "hermes-data"
    hermes_data.mkdir()
    _seed_state_db(state_db)

    stdout, _, rc = _run_script(state_db, hermes_data)
    assert rc == 0
    for line in stdout.strip().splitlines():
        if not line:
            continue
        # split on first two colons — model can contain slashes (OpenRouter
        # vendor/model convention) but never colons.
        slug, rest = line.split(":", 1)
        port, model = rest.split(":", 1)
        assert slug and port.isdigit() and model
