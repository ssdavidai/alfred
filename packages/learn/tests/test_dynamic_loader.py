"""Tests for the dynamic chore template loader (Step 4, S4-1).

Covers the Layer 2 static validator (`validate_template_source`) and the
loader's filesystem behavior. The validator is the security boundary for
generated code — exhaustive coverage matters here.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from src.workflows.chores._dynamic_loader import (
    ALLOWED_IMPORTS,
    ValidationResult,
    load_user_chore_templates,
    validate_template_source,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _good_template_source(class_name: str = "TestWorkflow") -> str:
    """Return a minimal valid generated chore template source.

    Mirrors the structure of subscription_watcher.py but with a single
    no-op activity call so the structural checks pass.
    """
    return f'''"""Test template generated for unit tests."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.workflows.chores._base import load_chore_context, record_chore_run
    from src.activities.chore_actions import fetch_financial_events


@dataclass
class TestInput:
    chore_slug: str


@dataclass
class TestResult:
    notes: str = ""


@workflow.defn(name="{class_name}")
class {class_name}:
    @workflow.run
    async def run(self, input: TestInput) -> TestResult:
        await workflow.execute_activity(
            load_chore_context,
            args=[input.chore_slug],
            start_to_close_timeout=timedelta(seconds=15),
        )
        events = await workflow.execute_activity(
            fetch_financial_events,
            args=[["test.com"], 7],
            start_to_close_timeout=timedelta(seconds=60),
        )
        return TestResult(notes=f"got {{len(events)}} events")
'''


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

class TestValidationHappyPath:
    def test_minimal_valid_template_passes(self):
        result = validate_template_source(_good_template_source())
        assert result.ok, f"validation failed: {result.violations}"
        assert result.violations == []

    def test_existing_subscription_watcher_passes(self):
        # Regression: every standard-library template must always validate
        path = Path("src/workflows/chores/subscription_watcher.py")
        if not path.exists():
            pytest.skip("running outside the learn package directory")
        source = path.read_text()
        result = validate_template_source(source)
        assert result.ok, f"subscription_watcher.py failed validation: {result.violations}"

    def test_existing_weekly_matter_digest_passes(self):
        path = Path("src/workflows/chores/weekly_matter_digest.py")
        if not path.exists():
            pytest.skip("running outside the learn package directory")
        source = path.read_text()
        result = validate_template_source(source)
        assert result.ok, f"weekly_matter_digest.py failed validation: {result.violations}"


# ---------------------------------------------------------------------------
# Size limit
# ---------------------------------------------------------------------------

class TestValidationSizeLimit:
    def test_too_large_rejected(self):
        # 100KB cap — make a string just over
        oversized = "x" * 100_001
        result = validate_template_source(oversized)
        assert not result.ok
        assert any("too large" in v for v in result.violations)


# ---------------------------------------------------------------------------
# Syntax
# ---------------------------------------------------------------------------

class TestValidationSyntax:
    def test_syntax_error_rejected(self):
        result = validate_template_source("def broken(:")
        assert not result.ok
        assert any("syntax error" in v for v in result.violations)


# ---------------------------------------------------------------------------
# Top-level structure
# ---------------------------------------------------------------------------

def _inject_top_level(source: str, extra: str) -> str:
    """Insert `extra` after the module docstring of a template source.

    The `_good_template_source()` helper produces a module starting with
    a docstring. Prepending constants would displace the docstring from
    tree.body[0] and cause false failures unrelated to the check under
    test. This helper keeps the docstring at index 0.
    """
    lines = source.split("\n")
    # Docstring is the first triple-quoted string — typically line 0.
    # Find the end of the docstring (line with closing """).
    if lines and lines[0].startswith('"""'):
        # Single-line docstring like `"""foo"""`
        if lines[0].count('"""') >= 2:
            end_idx = 0
        else:
            end_idx = 0
            for i in range(1, len(lines)):
                if '"""' in lines[i]:
                    end_idx = i
                    break
        return "\n".join(lines[: end_idx + 1]) + "\n" + extra + "\n" + "\n".join(lines[end_idx + 1 :])
    return extra + "\n" + source


class TestValidationTopLevelStructure:
    def test_top_level_literal_constant_allowed(self):
        """Literal module-level constants are allowed — Opus writes them
        naturally and they're deterministic/replay-safe."""
        source = _inject_top_level(
            _good_template_source(),
            "_POLL_HOURS = 9\n_MAX_ITEMS = 20",
        )
        result = validate_template_source(source)
        assert result.ok, f"literal constant rejected: {result.violations}"

    def test_top_level_annotated_constant_allowed(self):
        source = _inject_top_level(
            _good_template_source(),
            'THRESHOLD: float = 0.85\n_TAGS: list[str] = ["a", "b"]',
        )
        result = validate_template_source(source)
        assert result.ok, f"annotated constant rejected: {result.violations}"

    def test_top_level_dict_literal_allowed(self):
        source = _inject_top_level(
            _good_template_source(),
            'CONFIG = {"timeout": 30, "retries": 3}',
        )
        result = validate_template_source(source)
        assert result.ok, f"dict literal rejected: {result.violations}"

    def test_top_level_function_call_rejected(self):
        """Non-literal RHS at module scope IS rejected — it would run
        at import time which is a side effect."""
        source = _inject_top_level(_good_template_source(), "logger = make_logger()")
        result = validate_template_source(source)
        assert not result.ok
        assert any("top-level statement not allowed" in v for v in result.violations)

    def test_top_level_expression_statement_rejected(self):
        source = _inject_top_level(_good_template_source(), "print('hello')")
        result = validate_template_source(source)
        assert not result.ok
        assert any("top-level statement not allowed" in v for v in result.violations)

    def test_top_level_tuple_unpacking_rejected(self):
        """Tuple targets aren't literal-simple enough."""
        source = _inject_top_level(_good_template_source(), "a, b = 1, 2")
        result = validate_template_source(source)
        assert not result.ok

    def test_top_level_name_reference_rejected(self):
        """FOO = BAR would let Opus chain constants into a non-literal RHS."""
        source = _inject_top_level(_good_template_source(), "BAR = 5\nFOO = BAR")
        result = validate_template_source(source)
        assert not result.ok


# ---------------------------------------------------------------------------
# Import whitelist
# ---------------------------------------------------------------------------

class TestValidationImports:
    def test_forbidden_import_os_rejected(self):
        source = _good_template_source()
        source = "import os\n" + source
        result = validate_template_source(source)
        assert not result.ok
        assert any("forbidden import: os" in v for v in result.violations)

    def test_forbidden_from_subprocess_rejected(self):
        source = _good_template_source()
        source = "from subprocess import run\n" + source
        result = validate_template_source(source)
        assert not result.ok
        assert any("forbidden import" in v and "subprocess" in v for v in result.violations)

    def test_unknown_module_rejected(self):
        source = _good_template_source()
        source = "import requests\n" + source
        result = validate_template_source(source)
        assert not result.ok
        # requests is in FORBIDDEN_IMPORTS so it triggers the forbidden check
        assert any("forbidden import" in v for v in result.violations)

    def test_random_import_rejected(self):
        # random is not forbidden but also not whitelisted → rejected
        source = _good_template_source()
        source = "import random\n" + source
        result = validate_template_source(source)
        assert not result.ok

    def test_unknown_activity_import_rejected(self):
        source = _good_template_source()
        source = source.replace(
            "from src.activities.chore_actions import fetch_financial_events",
            "from src.activities.chore_actions import nonexistent_activity",
        )
        result = validate_template_source(source)
        assert not result.ok
        assert any("unknown activity import" in v for v in result.violations)

    def test_activity_from_other_module_rejected(self):
        """An activity that exists in the global manifest but comes from a
        different module (e.g. session.py, vault.py) must still be
        rejected when imported from src.activities.chore_actions.

        Regression: on david's first real generation run, Opus hallucinated
        `from src.activities.chore_actions import fetch_recent_records`.
        fetch_recent_records exists in src.activities.session — the global
        manifest has it — but it is NOT exported from chore_actions, so
        the runtime import crashes. The validator must catch this.
        """
        source = _good_template_source()
        # fetch_recent_records is a real activity but it lives in
        # src.activities.session, not src.activities.chore_actions.
        source = source.replace(
            "from src.activities.chore_actions import fetch_financial_events",
            "from src.activities.chore_actions import fetch_recent_records",
        )
        result = validate_template_source(source)
        assert not result.ok
        # Either "not exported from chore_actions" (if manifest built
        # successfully) or "unknown activity import" (if fetch_recent_records
        # isn't in the manifest in the test env). Both are acceptable
        # rejections — the point is the validator refuses the import.
        assert any(
            "not exported from chore_actions" in v or "unknown activity import" in v
            for v in result.violations
        ), f"expected rejection, got: {result.violations}"


# ---------------------------------------------------------------------------
# Workflow class structure
# ---------------------------------------------------------------------------

class TestValidationWorkflowStructure:
    def test_no_workflow_defn_rejected(self):
        source = _good_template_source()
        source = source.replace("@workflow.defn(name=\"TestWorkflow\")", "")
        result = validate_template_source(source)
        assert not result.ok
        assert any("no class with @workflow.defn" in v for v in result.violations)

    def test_two_workflow_defn_rejected(self):
        # Append a second workflow class
        first = _good_template_source("WorkflowA")
        second = _good_template_source("WorkflowB")
        # Strip the imports/from-future from the second
        second_lines = second.split("\n")
        second_body_start = next(
            i for i, l in enumerate(second_lines) if l.startswith("@workflow.defn")
        )
        second_body = "\n".join(second_lines[second_body_start:])
        combined = first + "\n\n" + second_body
        result = validate_template_source(combined)
        assert not result.ok
        assert any("exactly one @workflow.defn" in v for v in result.violations)


# ---------------------------------------------------------------------------
# Forbidden names
# ---------------------------------------------------------------------------

class TestValidationForbiddenNames:
    def test_eval_rejected(self):
        source = _good_template_source()
        source = source.replace(
            "return TestResult(notes=f\"got {len(events)} events\")",
            "eval('1+1')\n        return TestResult(notes=\"x\")",
        )
        result = validate_template_source(source)
        assert not result.ok
        assert any("forbidden name reference: eval" in v for v in result.violations)

    def test_open_rejected(self):
        source = _good_template_source()
        source = source.replace(
            "return TestResult(notes=f\"got {len(events)} events\")",
            "open('/tmp/x')\n        return TestResult(notes=\"x\")",
        )
        result = validate_template_source(source)
        assert not result.ok
        assert any("forbidden name reference: open" in v for v in result.violations)

    def test_os_attribute_rejected(self):
        # If os were importable, os.system would be a forbidden attribute. We
        # already block the import; verify the attribute scan also catches it
        # by injecting after a fake "ok" import.
        source = "import os\n" + _good_template_source()
        source = source.replace(
            "return TestResult(notes=f\"got {len(events)} events\")",
            "os.system('rm -rf /')\n        return TestResult(notes=\"x\")",
        )
        result = validate_template_source(source)
        assert not result.ok
        # Both the import AND the attribute access should be flagged
        assert any("forbidden import: os" in v for v in result.violations)
        assert any("forbidden attribute access" in v and "os.system" in v for v in result.violations)


# ---------------------------------------------------------------------------
# Activity call validation
# ---------------------------------------------------------------------------

class TestValidationActivityCalls:
    def test_unknown_activity_call_rejected(self):
        # Import a known activity but call a different one (typo or hallucination)
        source = _good_template_source()
        source = source.replace(
            "fetch_financial_events,",
            "fetch_financial_events_typo,",
            1,  # only the workflow.execute_activity call site
        )
        result = validate_template_source(source)
        assert not result.ok

    def test_string_activity_arg_rejected(self):
        # Strings bypass the import-whitelist guarantee. Construct a source
        # that calls workflow.execute_activity with a string literal directly
        # so we know exactly which call site we're testing.
        source = '''"""Test."""
from __future__ import annotations
from dataclasses import dataclass
from datetime import timedelta
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from src.workflows.chores._base import load_chore_context

@dataclass
class TestInput:
    chore_slug: str

@dataclass
class TestResult:
    notes: str = ""

@workflow.defn(name="StringArgWorkflow")
class StringArgWorkflow:
    @workflow.run
    async def run(self, input: TestInput) -> TestResult:
        await workflow.execute_activity(
            "load_chore_context",
            args=[input.chore_slug],
            start_to_close_timeout=timedelta(seconds=15),
        )
        return TestResult(notes="x")
'''
        result = validate_template_source(source)
        assert not result.ok
        assert any("direct name reference" in v for v in result.violations)


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------

class TestValidationDeterminism:
    def test_datetime_now_at_workflow_scope_rejected(self):
        # We don't import datetime as a class but the AST attribute check
        # catches datetime.now() anywhere
        source = _good_template_source()
        source = source.replace(
            "return TestResult(notes=f\"got {len(events)} events\")",
            "now = datetime.now()\n        return TestResult(notes=str(now))",
        )
        result = validate_template_source(source)
        # Should flag the non-deterministic call
        assert not result.ok
        assert any("non-deterministic" in v and "datetime.now" in v for v in result.violations)


# ---------------------------------------------------------------------------
# Filesystem loader
# ---------------------------------------------------------------------------

class TestStagedPackageDir:
    def test_ensure_staged_package_dir_creates_init(self, tmp_path):
        # Patch the staging dir to a temp location and verify it gets created
        from unittest.mock import patch
        from src.workflows.chores import _dynamic_loader

        fake_dir = tmp_path / "staged"
        with patch.object(_dynamic_loader, "_STAGED_PACKAGE_DIR", fake_dir):
            _dynamic_loader._ensure_staged_package_dir()
            assert fake_dir.exists()
            init = fake_dir / "__init__.py"
            assert init.exists()
            assert "Auto-staged" in init.read_text()


class TestLoadUserChoreTemplates:
    """Loader filesystem tests. Each test patches both USER_CHORES_DIR (the
    source) and _STAGED_PACKAGE_DIR (the staging copy under /app, which
    doesn't exist outside the container) to temp directories."""

    def _patch_dirs(self, source: str, staged: Path):
        """Convenience: return a context manager patching both directories."""
        return _patch_loader_dirs(source, staged)

    def test_missing_directory_returns_empty_list(self, tmp_path):
        with self._patch_dirs("/nonexistent/path/xyz", tmp_path / "staged"):
            result = load_user_chore_templates()
            assert result == []

    def test_empty_directory_returns_empty_list(self, tmp_path):
        source = tmp_path / "source"
        source.mkdir()
        with self._patch_dirs(str(source), tmp_path / "staged"):
            result = load_user_chore_templates()
            assert result == []

    def test_invalid_file_skipped(self, tmp_path):
        source = tmp_path / "source"
        source.mkdir()
        bad_file = source / "bad.py"
        bad_file.write_text("import os\n@workflow.defn\nclass X: pass\n")
        with self._patch_dirs(str(source), tmp_path / "staged"):
            result = load_user_chore_templates()
            assert result == []  # rejected by validator

    def test_underscore_files_skipped(self, tmp_path):
        source = tmp_path / "source"
        source.mkdir()
        init_file = source / "_helpers.py"
        init_file.write_text("import os\n")  # would fail validation if scanned
        with self._patch_dirs(str(source), tmp_path / "staged"):
            result = load_user_chore_templates()
            assert result == []


def _patch_loader_dirs(source: str, staged: Path):
    """Patch BOTH USER_CHORES_DIR and _STAGED_PACKAGE_DIR for unit tests.

    Outside the alfred-learn container `/app` doesn't exist and is read-only,
    so the staging directory must be redirected to a writable temp path.
    """
    from contextlib import ExitStack
    from src.workflows.chores import _dynamic_loader

    stack = ExitStack()
    stack.enter_context(patch.object(_dynamic_loader, "USER_CHORES_DIR", source))
    stack.enter_context(patch.object(_dynamic_loader, "_STAGED_PACKAGE_DIR", staged))
    return stack
