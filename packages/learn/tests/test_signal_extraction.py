"""Phase 6.7 (T6.7.2) regression test for the signal extractor.

Replays each fixture in ``tests/fixtures/signal_examples.yaml`` through
``src.activities.signals.extract_signal_from_event`` and asserts the
output matches the fixture's ``expected`` block. The LLM call goes
through the **real** clerk dispatch (no mocks) so this is a true
regression gate against prompt + few-shot changes — exactly what
T6.7.3 needs to iterate prompt-quality numbers.

Why this test is opt-in (``-m slow``):

* Each fixture is one round-trip through the OpenClaw clerk gateway
  (typically 1-3s LLM latency). 100 fixtures sequentially is 2-5
  minutes wall-clock. That's intolerable on the unit-test path that
  runs on every push, but acceptable for a calibration gate run on
  prompt edits or before deploys.
* Pytest's ``-m "not slow"`` selector keeps CI fast. The CI workflow
  for prompt changes specifically opts in via ``-m slow``.
* No network → automatically skipped. We surface a one-line skip
  reason so a confused contributor immediately sees why.

Why we monkey-patch ``read_record`` and ``_resolve_target`` (Option B
from the spec):

* Option A (write fixtures into a temp vault, point ctrl-api at it)
  needs ctrl-api running and adds a moving part that doesn't help
  test the LLM prompt — which is what we actually want to gate on.
* Option B isolates the *unit under test* to ``build_signal_extraction_prompt``
  + ``_call_clerk`` + ``_validate_llm_classification``. We stub
  ``read_record`` to feed the fixture content into the activity, and
  stub ``_resolve_target`` so an effect=action/mutation classification
  doesn't try to enumerate task/matter records over a non-existent
  ctrl-api connection.
* The activity's auto-create branch (T6.5.2) is gated by the env var
  ``STEWARD_SIGNAL_AUTOCREATE_TASKS``. We unset it for these tests
  so a positive classification never tries to call ``create_task_from_signal``
  — which would also need ctrl-api.
"""
from __future__ import annotations

import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
import yaml

# ---------------------------------------------------------------------------
# Fixture loader
# ---------------------------------------------------------------------------

_FIXTURE_PATH = (
    Path(__file__).parent / "fixtures" / "signal_examples.yaml"
)


def _load_fixtures() -> list[dict[str, Any]]:
    """Load + validate the YAML fixture list.

    Loaded once per pytest collection. We keep the validation strict so
    a typo in the fixture (missing key, wrong enum) blows up at
    collection time with a useful error rather than silently producing
    a non-test.
    """
    if not _FIXTURE_PATH.exists():
        raise FileNotFoundError(
            f"Signal fixture missing: {_FIXTURE_PATH}. "
            f"This is the T6.7.1 fixture and the test cannot run "
            f"without it."
        )
    with _FIXTURE_PATH.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, list):
        raise ValueError(
            f"Fixture root must be a list of examples, got "
            f"{type(data).__name__}"
        )
    if len(data) != 100:
        raise ValueError(
            f"Fixture must contain exactly 100 examples, got {len(data)}"
        )
    pos = sum(
        1 for e in data
        if (e.get("expected") or {}).get("should_produce_signal")
    )
    if pos != 60:
        raise ValueError(
            f"Fixture must contain exactly 60 positive examples, got {pos}"
        )

    seen_ids: set[str] = set()
    for entry in data:
        for key in (
            "id",
            "description",
            "stream_event_frontmatter",
            "stream_event_body",
            "expected",
        ):
            if key not in entry:
                raise ValueError(
                    f"Fixture entry missing required key {key!r}: "
                    f"{entry.get('id', '<no-id>')}"
                )
        if entry["id"] in seen_ids:
            raise ValueError(f"Duplicate fixture id: {entry['id']}")
        seen_ids.add(entry["id"])
        exp = entry["expected"]
        for ekey in (
            "should_produce_signal",
            "effect",
            "target_kind",
            "target_path_contains",
            "mutation_decision",
            "target_confidence_min",
            "effect_confidence_min",
            "notes",
        ):
            if ekey not in exp:
                raise ValueError(
                    f"Fixture {entry['id']!r} missing expected.{ekey}"
                )
        if exp["effect"] not in ("mutation", "action", "none"):
            raise ValueError(
                f"Fixture {entry['id']!r}: effect must be one of "
                f"mutation/action/none, got {exp['effect']!r}"
            )

    return data


_FIXTURES: list[dict[str, Any]] = _load_fixtures()


# ---------------------------------------------------------------------------
# Network-availability gate — auto-skip when openclaw isn't reachable.
# ---------------------------------------------------------------------------

def _openclaw_reachable() -> bool:
    """Quick probe — if the gateway env var is missing or the host
    isn't reachable, we skip rather than fail."""
    if not os.environ.get("OPENCLAW_GATEWAY_URL"):
        return False
    # We only verify env presence; a deeper TCP probe would slow
    # collection and the real ``_call_clerk`` will surface a clean
    # error if the gateway is down — pytest reports those as test
    # failures, which is what we want when the env *is* configured.
    return True


# ---------------------------------------------------------------------------
# Vault stub — Option B from the spec.
# ---------------------------------------------------------------------------

class _StubVaultClient:
    """Minimal in-memory VaultClient stand-in.

    Only implements the methods ``extract_signal_from_event`` calls:

      * ``read_record(path)`` — return the fixture frontmatter+body.
      * ``list_records(kind, limit=...)`` — return ``[]`` (we stub
        ``_resolve_target`` separately so this is belt-and-braces).
      * ``close()`` — no-op.

    Construction takes the fixture entry. Each test instantiates one.
    """

    def __init__(self, fixture: dict[str, Any]) -> None:
        self._fixture = fixture
        self.read_calls: list[str] = []

    async def close(self) -> None:
        return None

    async def read_record(self, path: str) -> dict[str, Any]:
        self.read_calls.append(path)
        # Mimic the ctrl-api shape — frontmatter + content.
        return {
            "path": path,
            "frontmatter": dict(self._fixture["stream_event_frontmatter"]),
            "content": self._fixture["stream_event_body"],
        }

    async def list_records(
        self, kind: str, limit: int | None = None
    ) -> list[dict[str, Any]]:
        return []


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------

# Aggregate counters used by the ``test_aggregate_pass_rate`` summary.
# We persist results to a JSONL file so the aggregate test works under
# pytest-xdist (parallel workers each write to the same file in
# append-line mode; on a local POSIX FS that's atomic for short writes).
import json as _json
_RESULTS: list[dict[str, Any]] = []
_RESULTS_PATH = Path(
    os.environ.get("SIGNAL_EXTRACTION_RESULTS_PATH")
    or "/tmp/signal_extraction_results.jsonl"
)


def _record_result(payload: dict[str, Any]) -> None:
    _RESULTS.append(payload)
    try:
        with _RESULTS_PATH.open("a", encoding="utf-8") as f:
            f.write(_json.dumps(payload, ensure_ascii=False) + "\n")
    except OSError:
        # Aggregate fallback to in-memory only — never block the test
        # on a results-side error.
        pass


def _check_signal_against_expected(
    fixture: dict[str, Any], signal: dict[str, Any] | None
) -> tuple[bool, str]:
    """Return (passed, reason). reason is non-empty on failure."""
    expected = fixture["expected"]
    should_produce = expected["should_produce_signal"]
    expected_effect = expected["effect"]

    # Null signal means "extractor decided no" (effect=none, pre-filter, or LLM error).
    if signal is None:
        if should_produce:
            return False, (
                f"unexpected_drop: expected effect={expected_effect!r}, "
                f"got None (extractor returned no signal)"
            )
        return True, ""

    # Non-null signal → extractor produced something.
    actual_effect = str(signal.get("effect") or "").lower()
    if not should_produce:
        return False, (
            f"unexpected_signal: expected effect=none, got "
            f"effect={actual_effect!r}"
        )

    if actual_effect != expected_effect:
        return False, (
            f"effect_mismatch: expected {expected_effect!r}, "
            f"got {actual_effect!r}"
        )

    expected_kind = expected["target_kind"]
    actual_kind = signal.get("target_kind")
    # target_kind: only assert when expected is non-null. When the
    # fixture sets target_kind=null we accept any actual_kind because
    # the extractor's target resolution runs against an empty vault
    # under the stub — the fixture's null-kind cases are about effect,
    # not kind.
    if expected_kind is not None and actual_kind != expected_kind:
        return False, (
            f"target_kind_mismatch: expected {expected_kind!r}, "
            f"got {actual_kind!r}"
        )

    # target_path_contains hints — only assert if the fixture provides
    # a non-empty list AND the extractor produced a target_path.
    expected_substrings = expected["target_path_contains"] or []
    actual_target_path = signal.get("target_path") or ""
    if expected_substrings and actual_target_path:
        path_lower = str(actual_target_path).lower()
        if not any(s.lower() in path_lower for s in expected_substrings):
            return False, (
                f"target_path_substring_miss: expected one of "
                f"{expected_substrings!r} in target_path "
                f"{actual_target_path!r}"
            )

    # mutation_decision substring hint.
    expected_decision = expected["mutation_decision"]
    if expected_effect == "mutation" and expected_decision:
        proposal = signal.get("mutation_proposal") or {}
        actual_decision = str(proposal.get("decision") or "").lower()
        if expected_decision.lower() not in actual_decision:
            return False, (
                f"mutation_decision_miss: expected substring "
                f"{expected_decision!r} in {actual_decision!r}"
            )

    # Confidence floors — soft assertion (warn-only is too lenient;
    # treat as failure to keep the gate honest).
    actual_effect_conf = float(signal.get("effect_confidence") or 0.0)
    if actual_effect_conf < float(expected["effect_confidence_min"]):
        return False, (
            f"effect_confidence_low: expected >= "
            f"{expected['effect_confidence_min']:.2f}, got "
            f"{actual_effect_conf:.2f}"
        )

    return True, ""


@pytest.mark.slow
@pytest.mark.parametrize(
    "fixture",
    _FIXTURES,
    ids=[f["id"] for f in _FIXTURES],
)
async def test_signal_extraction_per_fixture(
    fixture: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """One regression case per fixture entry.

    Each test:
      1. Monkey-patches ``VaultClient`` (used inside the activity) to
         the stub so ``read_record`` returns the fixture content.
      2. Monkey-patches ``_resolve_target`` to a no-op resolver — the
         signal extractor's prompt + LLM stage is what we test, not
         the difflib-based target ranking.
      3. Disables auto-task-creation via env so an effect=action
         classification doesn't try to dispatch a real task creation.
      4. Calls ``extract_signal_from_event`` with a synthetic path.
      5. Records pass/fail in the module-level _RESULTS for the
         aggregate summary test.
    """
    if not _openclaw_reachable():
        pytest.skip(
            "OPENCLAW_GATEWAY_URL unset — skipping LLM-backed regression test"
        )

    # Lazy imports so that even without the env, fixture collection runs.
    from src.activities import signals as signals_module

    # 1+2. Stub VaultClient + _resolve_target.
    stub = _StubVaultClient(fixture)

    def _stub_vault_client(_cfg: Any) -> _StubVaultClient:
        return stub

    monkeypatch.setattr(signals_module, "VaultClient", _stub_vault_client)

    async def _stub_resolve_target(
        target_hint: str,
        target_kind_hint: str,
        *,
        client: Any,
    ) -> dict[str, Any]:
        # Echo a target-kind hint back so the extractor stamps it on
        # the signal record without touching ctrl-api.
        kind_hint = (target_kind_hint or "").strip().lower()
        kind = kind_hint if kind_hint in ("task", "matter") else None
        return {
            "target_path": None,
            "target_kind": kind,
            "target_confidence": 0.0,
            "candidates": [],
            "ambiguous": False,
        }

    monkeypatch.setattr(
        signals_module, "_resolve_target", _stub_resolve_target
    )

    # 3. Auto-create off — keep the test pure.
    monkeypatch.delenv("STEWARD_SIGNAL_AUTOCREATE_TASKS", raising=False)

    # 4. Run the activity. Synthetic path is fine; the stub doesn't
    # parse it.
    fake_path = f"stream_event/{fixture['id']}.md"
    try:
        signal = await signals_module.extract_signal_from_event(fake_path)
    except Exception as exc:  # noqa: BLE001
        pytest.fail(
            f"extract_signal_from_event raised on {fixture['id']!r}: "
            f"{type(exc).__name__}: {exc}"
        )
        return

    passed, reason = _check_signal_against_expected(fixture, signal)
    src = fixture["stream_event_frontmatter"].get("source_type", "?")
    _record_result({
        "id": fixture["id"],
        "source_type": src,
        "passed": passed,
        "reason": reason,
    })
    if not passed:
        pytest.fail(f"{fixture['id']}: {reason}")


# ---------------------------------------------------------------------------
# Summary test — runs LAST (alphabetical sort + zzz prefix). Reports
# aggregate stats. We deliberately mark it as ``slow`` and ``last`` so
# pytest with ``-m slow`` picks it up after the parametrized tests.
# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_zzz_aggregate_pass_rate() -> None:
    """Summarize pass/fail counts — informational, not blocking.

    The ≥95/100 target lives in the prompt-iteration workflow
    (T6.7.3), not in the test itself. We surface the numbers so a
    developer running this suite sees them at a glance, but we don't
    flunk this aggregate when individual cases fail (that's already
    flunked by ``test_signal_extraction_per_fixture``).
    """
    # Prefer the file (works under xdist); fall back to in-memory list
    # for serial runs that didn't touch the file.
    rows: list[dict[str, Any]] = []
    if _RESULTS_PATH.exists():
        with _RESULTS_PATH.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(_json.loads(line))
                except (ValueError, _json.JSONDecodeError):
                    continue
    if not rows:
        rows = list(_RESULTS)
    if not rows:
        pytest.skip("no per-fixture results recorded — main suite skipped?")

    # Deduplicate on id (keep last write — xdist retries can append twice).
    by_id: dict[str, dict[str, Any]] = {}
    for r in rows:
        by_id[r.get("id") or ""] = r
    rows = list(by_id.values())

    total = len(rows)
    passed = sum(1 for r in rows if r["passed"])
    fail_by_src: Counter[str] = Counter()
    pass_by_src: Counter[str] = Counter()
    fail_by_reason: Counter[str] = Counter()
    for r in rows:
        if r["passed"]:
            pass_by_src[r["source_type"]] += 1
        else:
            fail_by_src[r["source_type"]] += 1
            # First word of reason = failure-mode tag.
            tag = (r["reason"].split(":", 1)[0] or "unknown").strip()
            fail_by_reason[tag] += 1

    # Print to stdout — pytest captures and prints with -s.
    print(file=sys.stderr)
    print(f"=== Signal extraction regression: PASS {passed}/{total} "
          f"(target: 95/100) ===", file=sys.stderr)
    print("PASS by source_type:", file=sys.stderr)
    for src in sorted(pass_by_src):
        print(f"  {src}: {pass_by_src[src]}", file=sys.stderr)
    if fail_by_src:
        print("FAIL by source_type:", file=sys.stderr)
        for src in sorted(fail_by_src):
            print(f"  {src}: {fail_by_src[src]}", file=sys.stderr)
    if fail_by_reason:
        print("FAIL by failure mode:", file=sys.stderr)
        for tag in sorted(fail_by_reason):
            print(f"  {tag}: {fail_by_reason[tag]}", file=sys.stderr)
    print(f"=== Final: {passed}/{total} ===", file=sys.stderr)
