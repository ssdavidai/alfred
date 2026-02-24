"""Tests for Bat CLI handlers."""

from types import SimpleNamespace

from alfred.bat.cli import bat_status, bat_verify_ledger
from alfred.bat.ledger import GovernanceLedger


def test_bat_status_runs_without_import_error(tmp_path, capsys):
    ledger_path = tmp_path / "bat-ledger.jsonl"
    ledger = GovernanceLedger(ledger_path, b"test-key")
    # Write one entry so status path is exercised.
    from alfred.bat.proposal import OperationProposal
    from alfred.bat.enforcement import EnforcementDecision, Action
    from alfred.bat.risk import RiskClassification, RiskLevel
    from datetime import datetime, timezone

    proposal = OperationProposal(agent_id="test", operation_type="read_file", target="x")
    decision = EnforcementDecision(
        proposal_id=proposal.proposal_id,
        action=Action.ALLOW,
        policy_version="1.0",
        classification=RiskClassification(level=RiskLevel.L1, rule_id="r", rationale="ok"),
        timestamp=datetime.now(timezone.utc),
    )
    ledger.append(decision, proposal)

    rc = bat_status(SimpleNamespace(config=None, ledger_path=str(ledger_path), signing_key=None))
    out = capsys.readouterr().out
    assert rc == 0
    assert "Ledger Integrity: skipped" in out


def test_bat_verify_ledger_requires_signing_key(tmp_path):
    ledger_path = tmp_path / "bat-ledger.jsonl"
    ledger_path.write_text("", encoding="utf-8")
    rc = bat_verify_ledger(SimpleNamespace(ledger_path=str(ledger_path), signing_key=None))
    assert rc == 1


def test_bat_verify_ledger_invalid_signing_key_hex(tmp_path):
    ledger_path = tmp_path / "bat-ledger.jsonl"
    ledger_path.write_text("", encoding="utf-8")
    rc = bat_verify_ledger(SimpleNamespace(ledger_path=str(ledger_path), signing_key="zz-not-hex"))
    assert rc == 1


def test_bat_verify_ledger_valid_signing_key_hex(tmp_path):
    ledger_path = tmp_path / "bat-ledger.jsonl"
    key = b"\x01\x02test-key"
    ledger = GovernanceLedger(ledger_path, key)

    from alfred.bat.proposal import OperationProposal
    from alfred.bat.enforcement import EnforcementDecision, Action
    from alfred.bat.risk import RiskClassification, RiskLevel
    from datetime import datetime, timezone

    proposal = OperationProposal(agent_id="test", operation_type="read_file", target="x")
    decision = EnforcementDecision(
        proposal_id=proposal.proposal_id,
        action=Action.ALLOW,
        policy_version="1.0",
        classification=RiskClassification(level=RiskLevel.L1, rule_id="r", rationale="ok"),
        timestamp=datetime.now(timezone.utc),
    )
    ledger.append(decision, proposal)

    rc = bat_verify_ledger(
        SimpleNamespace(ledger_path=str(ledger_path), signing_key=key.hex())
    )
    assert rc == 0
