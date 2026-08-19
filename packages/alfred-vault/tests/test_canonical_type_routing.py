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


# --- 3. the same guarantee on the edit path ------------------------------

def test_edit_http_rejection_is_translated_to_vaulterror(monkeypatch, tmp_path):
    """The janitor annotates existing records with vault_edit, and the vault is
    full of pre-cutover ones (assumption/, synthesis/, constraint/, event/).
    ctrl answers 422 for every such path. An escaping HTTPStatusError killed the
    whole janitor sweep; the janitor already catches VaultError in a dozen
    places, so translation is all that is needed."""
    import alfred.ctrl_client as cc

    def _boom(rel_path, set_fields=None, body_append=None):
        raise httpx.HTTPStatusError(
            "422", request=httpx.Request("PATCH", "http://ctrl/x"),
            response=httpx.Response(
                422,
                json={"error": {"message": 'Path "assumption/x.md" is not canonical.'}},
            ),
        )

    monkeypatch.setattr(cc, "ctrl_edit", _boom)
    monkeypatch.setattr(cc, "via_ctrl_enabled", lambda: True)

    from alfred.vault.ops import vault_edit
    with pytest.raises(VaultError) as exc:
        vault_edit(tmp_path, "assumption/x.md", set_fields={"janitor_note": "n"})
    assert "422" in str(exc.value)


# --- 4. don't attempt writes ctrl will refuse -----------------------------

def test_writable_path_predicate_matches_ctrl_exemptions():
    """Seam test, same shape as the type one: ctrl exempts _templates/,
    needs_attention/, SOUL.md and RULES.md from the promotion contract. If this
    daemon's idea of writable drifts, the janitor either skips records it could
    have fixed or hammers ones it never can."""
    from alfred.vault.schema import (
        CANONICAL_NON_RECORD_DIRS,
        CANONICAL_TOP_LEVEL_FILES,
    )
    if not CTRL_CONTRACT.exists():
        pytest.skip("ctrl package not present")
    src = CTRL_CONTRACT.read_text()
    dirs = set(re.findall(r'"([a-z_]+)"', re.search(
        r"CANONICAL_NON_RECORD_DIRS = new Set<string>\(\[(.*?)\]", src, re.S).group(1)))
    files = set(re.findall(r'"([A-Za-z.]+\.md)"', re.search(
        r"CANONICAL_TOP_LEVEL_FILES = new Set<string>\(\[(.*?)\]", src, re.S).group(1)))
    assert dirs == CANONICAL_NON_RECORD_DIRS, (dirs, CANONICAL_NON_RECORD_DIRS)
    assert files == CANONICAL_TOP_LEVEL_FILES, (files, CANONICAL_TOP_LEVEL_FILES)


def test_pre_cutover_directories_are_not_writable():
    """These are what the janitor was hammering — 2,866 rejected writes per
    sweep against event/ alone."""
    from alfred.vault.schema import is_writable_vault_path
    for demoted in ("event", "assumption", "constraint", "synthesis",
                    "contradiction", "project", "session", "account"):
        assert not is_writable_vault_path(f"{demoted}/x.md"), demoted


def test_canonical_and_exempt_paths_stay_writable():
    from alfred.vault.schema import is_writable_vault_path
    for ok in ("matter/x.md", "task/x.md", "note/x.md", "person/x.md",
               "needs_attention/card.md", "_templates/t.md", "SOUL.md", "RULES.md"):
        assert is_writable_vault_path(ok), ok


def test_janitor_skips_unwritable_records_without_attempting_a_write(monkeypatch):
    """The behaviour, not just the predicate: autofix must not call through to
    vault_edit for a record ctrl will refuse."""
    import alfred.janitor.autofix as af

    def _must_not_run(*a, **k):  # pragma: no cover
        raise AssertionError("attempted a write to an unwritable record")

    monkeypatch.setattr(af, "_apply_fix", _must_not_run)

    class _Issue:
        file = "event/some-old-record.md"
        code = type("C", (), {"value": "FM002"})()
        message = "stale"

    af.autofix_issues([_Issue()], Path("/vault"), "session/x.md")
