"""raise_if_permanent adoption at three call sites (#539).

A permanent HTTP error (422/400) must become a non-retryable ApplicationError;
a transient error (503) must still propagate so Temporal retries it.

Live evidence: write_fleet_audit_observation reached attempt 2+3 on 422
(FleetAuditWorkflow 2026-08-11T02:00:00Z — vault rejects ``observation`` as
a demoted type). read_target and adjust_matter_surface_class_v2 share the
same bare-re-raise pattern that caused create_session to run to attempt 7208.
"""
from __future__ import annotations

import httpx
import pytest
from temporalio.exceptions import ApplicationError


# ---------------------------------------------------------------------------
# Shared helper — build a minimal HTTPStatusError
# ---------------------------------------------------------------------------

def _http_error(status: int) -> httpx.HTTPStatusError:
    req = httpx.Request("POST", "http://ctrl-api/api/v1/vault/records")
    resp = httpx.Response(status, request=req)
    return httpx.HTTPStatusError(str(status), request=req, response=resp)


# ---------------------------------------------------------------------------
# write_fleet_audit_observation — fleet_audit.py
# ---------------------------------------------------------------------------

_MINIMAL_REPORT = {
    "status": "green",
    "owner_email": "owner@example.com",
    "files_scanned": 1,
    "total_mismatches": 0,
}


class TestFleetAuditObservationRetry:
    """write_fleet_audit_observation now routes to StateClient (state.db), not
    the vault.  The old 422-permanent / 503-propagate contract applied to the
    vault path; the new contract is: any StateClient error is caught and an
    empty string is returned (soft error), because the full audit report is
    already in Temporal history and a write failure should not abort the run.
    """

    async def test_state_client_error_returns_empty_string(self, monkeypatch):
        """Any StateClient failure must be caught and return ''."""
        from src.activities.fleet_audit import write_fleet_audit_observation

        class _BoomStateClient:
            def __init__(self, *a, **kw): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def create_observation(self, **kw):
                raise _http_error(422)

        monkeypatch.setattr("src.utils.signal_state.StateClient", _BoomStateClient)

        result = await write_fleet_audit_observation(_MINIMAL_REPORT)
        assert result == ""

    async def test_vault_never_reached(self, monkeypatch):
        """VaultClient.write_record must never be called by this activity."""
        from src.activities.fleet_audit import write_fleet_audit_observation
        from src.utils.vault_client import VaultClient

        vault_calls: list = []

        async def _spy_write(self, *a, **kw):  # noqa: ANN001
            vault_calls.append(a)
            return "vault/observation/should-not-happen.md"

        monkeypatch.setattr(VaultClient, "write_record", _spy_write)

        class _OkStateClient:
            def __init__(self, *a, **kw): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def create_observation(self, **kw): return "01ULID"

        monkeypatch.setattr("src.utils.signal_state.StateClient", _OkStateClient)

        await write_fleet_audit_observation(_MINIMAL_REPORT)
        assert vault_calls == [], "vault must not be written"


# ---------------------------------------------------------------------------
# read_target — state_mutator.py
# ---------------------------------------------------------------------------

class TestReadTargetRetry:
    async def test_404_returns_sentinel(self, monkeypatch):
        from src.activities.state_mutator import read_target
        from src.utils.vault_client import VaultClient

        async def _not_found(self, path):  # noqa: ANN001
            raise _http_error(404)

        monkeypatch.setattr(VaultClient, "read_record", _not_found)

        result = await read_target("matter/missing.md")
        assert result == {"frontmatter": {}, "body": "", "as_of": None}

    async def test_422_becomes_non_retryable(self, monkeypatch):
        from src.activities.state_mutator import read_target
        from src.utils.vault_client import VaultClient

        async def _bad_read(self, path):  # noqa: ANN001
            raise _http_error(422)

        monkeypatch.setattr(VaultClient, "read_record", _bad_read)

        with pytest.raises(ApplicationError) as exc_info:
            await read_target("matter/something.md")

        err = exc_info.value
        assert err.non_retryable is True
        assert "read_target" in str(err)

    async def test_503_still_retries(self, monkeypatch):
        from src.activities.state_mutator import read_target
        from src.utils.vault_client import VaultClient

        async def _bad_read(self, path):  # noqa: ANN001
            raise _http_error(503)

        monkeypatch.setattr(VaultClient, "read_record", _bad_read)

        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await read_target("matter/something.md")

        assert exc_info.value.response.status_code == 503


# ---------------------------------------------------------------------------
# adjust_matter_surface_class_v2 — decay_watcher.py
# ---------------------------------------------------------------------------

class TestAdjustMatterSurfaceClassV2Retry:
    async def test_404_returns_no_change(self, monkeypatch):
        from src.activities.decay_watcher import adjust_matter_surface_class_v2
        from src.utils.vault_client import VaultClient

        async def _not_found(self, path):  # noqa: ANN001
            raise _http_error(404)

        monkeypatch.setattr(VaultClient, "read_record", _not_found)

        result = await adjust_matter_surface_class_v2(
            "matter/gone.md", "2026-08-11T02:00:00Z"
        )
        assert result["status"] == "no_change"

    async def test_422_becomes_non_retryable(self, monkeypatch):
        from src.activities.decay_watcher import adjust_matter_surface_class_v2
        from src.utils.vault_client import VaultClient

        async def _bad_read(self, path):  # noqa: ANN001
            raise _http_error(422)

        monkeypatch.setattr(VaultClient, "read_record", _bad_read)

        with pytest.raises(ApplicationError) as exc_info:
            await adjust_matter_surface_class_v2(
                "matter/something.md", "2026-08-11T02:00:00Z"
            )

        err = exc_info.value
        assert err.non_retryable is True
        assert "adjust_matter_surface_class_v2" in str(err)

    async def test_503_still_retries(self, monkeypatch):
        from src.activities.decay_watcher import adjust_matter_surface_class_v2
        from src.utils.vault_client import VaultClient

        async def _bad_read(self, path):  # noqa: ANN001
            raise _http_error(503)

        monkeypatch.setattr(VaultClient, "read_record", _bad_read)

        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await adjust_matter_surface_class_v2(
                "matter/something.md", "2026-08-11T02:00:00Z"
            )

        assert exc_info.value.response.status_code == 503
