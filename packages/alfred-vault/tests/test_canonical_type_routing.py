"""The curator died for six days on a type ctrl-api will never accept.

`_resolve_entities` extracted an entity of type `project`, `vault_create`
POSTed it, ctrl-api answered 422 PROMOTION_CONTRACT_VIOLATION, and httpx raised
`HTTPStatusError`. The caller catches `VaultError`, so the HTTP exception blew
straight past the skip-and-continue handler and killed the whole pipeline run —
after the file had already been moved into inbox/processed/, so it was never
retried and the failure was invisible.

Two independent defects, one per class of test below:
  1. the daemon's vocabulary disagreed with ctrl's (project/location vs
     matter/place), and had no name for `matter` at all;
  2. a permanent, non-retryable rejection escaped the vault layer as an HTTP
     exception instead of a VaultError.
"""
from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest

from alfred.vault.ops import VaultError, vault_create
from alfred.vault.schema import (
    CANONICAL_VAULT_TYPES,
    KNOWN_TYPES,
    TYPE_ALIASES,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CTRL_CONTRACT = REPO_ROOT / "packages/ctrl/src/db/promotionContract.ts"


# --- 1. the two vocabularies must agree -----------------------------------

def test_canonical_set_matches_ctrl_api_exactly():
    """The seam that broke. ctrl-api is the enforcing side; if this daemon's
    idea of canonical drifts from ctrl's, every write of the drifted type
    fails at the network boundary rather than locally."""
    if not CTRL_CONTRACT.exists():
        pytest.skip("ctrl package not present (alfred-vault installed standalone)")
    src = CTRL_CONTRACT.read_text()
    block = re.search(
        r"export const CANONICAL_RECORD_TYPES = \[(.*?)\]", src, re.S
    )
    assert block, "could not find CANONICAL_RECORD_TYPES in ctrl's promotionContract.ts"
    ctrl_types = set(re.findall(r'"([a-z_]+)"', block.group(1)))
    assert ctrl_types == CANONICAL_VAULT_TYPES, (
        "alfred-vault and ctrl-api disagree about the canonical vault types.\n"
        f"  only in ctrl:         {sorted(ctrl_types - CANONICAL_VAULT_TYPES)}\n"
        f"  only in alfred-vault: {sorted(CANONICAL_VAULT_TYPES - ctrl_types)}"
    )


def test_every_canonical_type_is_nameable_by_this_daemon():
    """`matter` was absent from KNOWN_TYPES, so the daemon could not author the
    vault's central record type at all."""
    assert CANONICAL_VAULT_TYPES <= KNOWN_TYPES, (
        f"canonical types this daemon cannot name: "
        f"{sorted(CANONICAL_VAULT_TYPES - KNOWN_TYPES)}"
    )


def test_aliases_map_pre_cutover_names_onto_canonical_ones():
    assert TYPE_ALIASES["project"] == "matter"
    assert TYPE_ALIASES["location"] == "place"
    for old, new in TYPE_ALIASES.items():
        assert new in CANONICAL_VAULT_TYPES, f"{old} aliases to non-canonical {new}"
        assert old not in CANONICAL_VAULT_TYPES, f"{old} is canonical; do not alias it"


# --- 2. a permanent rejection must not escape as an HTTP exception --------

class _FakeResponse:
    status_code = 422

    @staticmethod
    def json():
        return {"error": {"message": 'Record type "project" is not a canonical vault type.'}}

    text = "422"


def test_http_rejection_is_translated_to_vaulterror(monkeypatch, tmp_path):
    """An HTTPStatusError escaping vault_create is what killed the pipeline:
    callers catch VaultError, so the raw httpx error bypassed their handler."""
    import alfred.ctrl_client as cc

    def _boom(record_type, name, content):
        raise httpx.HTTPStatusError(
            "422", request=httpx.Request("POST", "http://ctrl/x"),
            response=httpx.Response(422, json=_FakeResponse.json()),
        )

    monkeypatch.setattr(cc, "ctrl_create", _boom)
    monkeypatch.setattr(cc, "via_ctrl_enabled", lambda: True)

    with pytest.raises(VaultError) as exc:
        vault_create(tmp_path, "matter", "Some Matter")
    assert "422" in str(exc.value)


def test_non_canonical_type_raises_vaulterror_not_http(monkeypatch, tmp_path):
    """A demoted type is a permanent rejection. It must surface as VaultError so
    the curator drops that one entity and keeps processing the file."""
    import alfred.ctrl_client as cc

    def _must_not_be_called(*a, **k):  # pragma: no cover
        raise AssertionError("non-canonical type should never reach the network")

    monkeypatch.setattr(cc, "ctrl_create", _must_not_be_called)
    monkeypatch.setattr(cc, "via_ctrl_enabled", lambda: True)

    with pytest.raises(VaultError) as exc:
        vault_create(tmp_path, "assumption", "Some Assumption")
    assert "not a canonical vault type" in str(exc.value)


def test_project_is_routed_to_matter(monkeypatch, tmp_path):
    """The exact failure: an extracted `project` entity now lands as a matter."""
    import alfred.ctrl_client as cc
    seen: dict = {}

    def _capture(record_type, name, content):
        seen["type"] = record_type
        return {"path": f"{record_type}/{name}.md"}

    monkeypatch.setattr(cc, "ctrl_create", _capture)
    monkeypatch.setattr(cc, "via_ctrl_enabled", lambda: True)

    out = vault_create(tmp_path, "project", "MOSZ Discovery", set_fields={"status": "active"})
    assert seen["type"] == "matter", "project must be written as a matter"
    assert out["path"].startswith("matter/")
