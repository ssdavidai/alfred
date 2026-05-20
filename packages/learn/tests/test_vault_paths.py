"""Tests for date-based vault paths and slugify helper."""

from datetime import datetime
from unittest.mock import patch

import pytest

from src.activities.vault import slugify, vault_record_path


class TestSlugify:
    def test_basic(self):
        assert slugify("Call tenant-a About Invoice") == "call-tenant-a-about-invoice"

    def test_underscores(self):
        assert slugify("my_task_name") == "my-task-name"

    def test_special_chars(self):
        assert slugify("Invoice #1234 (urgent!)") == "invoice-1234-urgent"

    def test_extra_hyphens(self):
        assert slugify("hello---world") == "hello-world"

    def test_leading_trailing(self):
        assert slugify("  hello  ") == "hello"

    def test_mixed_case(self):
        assert slugify("Daily Digest — 2026-03-02") == "daily-digest-2026-03-02"

    def test_empty(self):
        assert slugify("") == ""


class TestVaultRecordPath:
    @patch("src.activities.vault.load_config")
    def test_date_path_with_explicit_date(self, mock_config):
        mock_config.return_value.use_date_paths = True
        dt = datetime(2026, 3, 2, 14, 30)
        result = vault_record_path("task", "Call tenant-a About Invoice", created=dt)
        assert result == "task/2026/03/02/call-tenant-a-about-invoice.md"

    @patch("src.activities.vault.load_config")
    def test_date_path_defaults_to_now(self, mock_config):
        mock_config.return_value.use_date_paths = True
        result = vault_record_path("note", "Some Note")
        # Should contain YYYY/MM/DD structure
        parts = result.split("/")
        assert parts[0] == "note"
        assert len(parts) == 5  # type/YYYY/MM/DD/slug.md
        assert parts[-1] == "some-note.md"

    @patch("src.activities.vault.load_config")
    def test_flat_path_when_disabled(self, mock_config):
        mock_config.return_value.use_date_paths = False
        dt = datetime(2026, 3, 2)
        result = vault_record_path("task", "My Task", created=dt)
        assert result == "task/my-task.md"

    @patch("src.activities.vault.load_config")
    def test_observation_path(self, mock_config):
        mock_config.return_value.use_date_paths = True
        dt = datetime(2026, 1, 15)
        result = vault_record_path("observation", "observation-2026-01-15-email", created=dt)
        assert result == "observation/2026/01/15/observation-2026-01-15-email.md"

    @patch("src.activities.vault.load_config")
    def test_session_path(self, mock_config):
        mock_config.return_value.use_date_paths = True
        dt = datetime(2026, 7, 4)
        result = vault_record_path("session", "session-2026-07-04", created=dt)
        assert result == "session/2026/07/04/session-2026-07-04.md"

    @patch("src.activities.vault.load_config")
    def test_event_digest_path(self, mock_config):
        mock_config.return_value.use_date_paths = True
        dt = datetime(2026, 12, 25)
        result = vault_record_path("event", "Daily Digest", created=dt)
        assert result == "event/2026/12/25/daily-digest.md"
