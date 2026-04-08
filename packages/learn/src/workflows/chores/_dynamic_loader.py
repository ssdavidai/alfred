"""Dynamic loader for generated chore template workflows.

Scans /alfred-data/user-chores/ at worker startup, runs Layer 2 static
validation on each .py file (AST parse + import whitelist + structural
checks + forbidden-name scan + activity-call validation), and dynamically
imports valid templates so they can be appended to ALL_WORKFLOWS before
the Worker is constructed.

Files that fail validation are skipped with an ERROR log containing the
specific violation. The worker still starts cleanly even if every file
in user-chores is broken — the dynamic loader is opportunistic, not
required for normal operation.

This is the first half of the Step 4 safety model. The second half (the
actual smoke test of generated source against synthetic data) lives in
chore_smoke/harness.py and is invoked by S4-6's smoke_test_generated_template
activity. They share the same `validate_template_source` helper exported
from this module so generation and runtime loading apply identical checks.
"""
from __future__ import annotations

import ast
import importlib.util
import logging
import sys
import types
from dataclasses import dataclass
from pathlib import Path

from temporalio import workflow

from src.chore_manifest import (
    FORBIDDEN_IMPORTS,
    USER_CHORES_DIR,
    get_manifest,
)

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Package stub registration
#
# Temporal's workflow validator re-imports the workflow's defining module
# by its qualified name to verify sandbox safety. We use the synthetic
# prefix `alfred_learn_dynamic.<stem>` for dynamically loaded templates,
# but `alfred_learn_dynamic` isn't a real package on disk — Temporal would
# fail with ModuleNotFoundError. We fix this by registering an empty
# package stub in sys.modules at module-import time. The stub has the
# correct __path__ attribute so importlib treats it as a real namespace
# package.
# ---------------------------------------------------------------------------

_DYNAMIC_PACKAGE_NAME = "alfred_learn_dynamic"


def _ensure_dynamic_package_stub() -> None:
    """Register an empty alfred_learn_dynamic namespace package in sys.modules.

    Idempotent — safe to call multiple times. Required so Temporal's
    workflow validator can re-import dynamically loaded templates without
    raising ModuleNotFoundError.
    """
    if _DYNAMIC_PACKAGE_NAME in sys.modules:
        return
    pkg = types.ModuleType(_DYNAMIC_PACKAGE_NAME)
    # Mark as a package by setting __path__ to an empty list (PEP 420
    # namespace package). importlib will use this to treat
    # alfred_learn_dynamic.<x> as a submodule lookup.
    pkg.__path__ = []  # type: ignore[attr-defined]
    pkg.__doc__ = (
        "Synthetic namespace package for dynamically loaded chore templates. "
        "See src.workflows.chores._dynamic_loader for the loader."
    )
    sys.modules[_DYNAMIC_PACKAGE_NAME] = pkg


# Register the stub eagerly so it's available before any dynamic load happens.
_ensure_dynamic_package_stub()


# ---------------------------------------------------------------------------
# Constants — the safety boundary
# ---------------------------------------------------------------------------

# Maximum size of a generated template file. Anything larger is rejected.
_MAX_TEMPLATE_FILE_BYTES = 100_000  # 100 KB — far larger than any realistic template

# Modules a generated template is ALLOWED to import. Anything else is rejected.
ALLOWED_IMPORTS: frozenset[str] = frozenset({
    "__future__",
    "dataclasses",
    "datetime",
    "typing",
    "json",
    "temporalio.workflow",
    "temporalio.common",
    "temporalio",
    "src.workflows.chores._base",
    "src.activities.chore_actions",
})

# Allowed `from X import Y` source modules. Each entry is the module path; we
# additionally check that the imported NAMES are activity manifest entries.
_ALLOWED_FROM_IMPORTS: frozenset[str] = frozenset({
    "__future__",
    "dataclasses",
    "datetime",
    "typing",
    "temporalio",
    "temporalio.common",
    "src.workflows.chores._base",
    "src.activities.chore_actions",
})

# Functions/attributes that must NEVER appear in generated code (security boundary).
# Note: `input` is intentionally NOT in this list — it's commonly used as a
# parameter name in Temporal workflow run methods (e.g. `def run(self, input: SubInput)`).
# The dangerous form `input()` (interactive prompt) is irrelevant in background
# workers anyway. We block `open` because it bypasses the activity boundary
# for filesystem reads.
_FORBIDDEN_NAMES: frozenset[str] = frozenset({
    "eval", "exec", "compile", "__import__", "globals", "locals",
    "open", "breakpoint",
    "getattr", "setattr", "delattr",  # reflection — disallow until proven needed
    "vars", "dir",
})

# Calls disallowed at workflow scope (non-deterministic — Temporal would break).
# These are OK inside activities, just not in workflow code.
_NONDETERMINISTIC_CALLS: frozenset[str] = frozenset({
    "datetime.now",
    "datetime.utcnow",
    "random.random",
    "random.randint",
    "random.choice",
    "uuid.uuid4",
    "uuid.uuid1",
    "time.time",
    "time.monotonic",
})


# ---------------------------------------------------------------------------
# Validation result + violation types
# ---------------------------------------------------------------------------

@dataclass
class ValidationResult:
    """Outcome of running Layer 2 static checks on a generated template source."""
    ok: bool
    violations: list[str]

    def first_violation(self) -> str:
        return self.violations[0] if self.violations else ""


# ---------------------------------------------------------------------------
# Public validation API
# ---------------------------------------------------------------------------

def validate_template_source(source: str) -> ValidationResult:
    """Run all Layer 2 safety checks on a chore template's Python source.

    Returns a ValidationResult with `ok` and a list of `violations` (empty
    on success). Does NOT raise — every check returns a structured violation
    so the caller (loader OR smoke test OR generation retry loop) can decide
    what to do.

    Checks (in order):
      1. Source size (must be < 100KB)
      2. Syntax (ast.parse)
      3. Top-level structure: only Import / ImportFrom / ClassDef / FunctionDef
         allowed at module scope (no loose statements, no module-level side effects)
      4. Import whitelist: every Import / ImportFrom must reference an allowed module
         (and ImportFrom names from src.activities.chore_actions must be in the manifest)
      5. Workflow class structure: exactly one @workflow.defn class with one @workflow.run
      6. Forbidden name scan: no eval, exec, os.*, sys.*, etc. anywhere in the AST
      7. Activity call manifest check: every workflow.execute_activity(name, ...)
         must reference a name in the activity manifest (or imported _base helpers)
      8. Determinism: no datetime.now() / random.* / uuid.* at workflow scope
    """
    violations: list[str] = []

    # 1. Size
    if len(source) > _MAX_TEMPLATE_FILE_BYTES:
        violations.append(
            f"source too large: {len(source)} bytes > max {_MAX_TEMPLATE_FILE_BYTES}"
        )
        return ValidationResult(ok=False, violations=violations)

    # 2. Syntax
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        violations.append(f"syntax error: {exc.msg} at line {exc.lineno}")
        return ValidationResult(ok=False, violations=violations)

    # 3. Top-level structure
    # Allowed at module scope:
    #   - Import / ImportFrom
    #   - ClassDef / FunctionDef / AsyncFunctionDef
    #   - Module docstring (Expr wrapping a string Constant) — only as the first stmt
    #   - `with workflow.unsafe.imports_passed_through():` (Temporal's official
    #     import-deferral pattern — used by every existing chore template)
    for idx, node in enumerate(tree.body):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        # Module docstring: an Expr at index 0 wrapping a string Constant
        if (
            idx == 0
            and isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            continue
        # Temporal import-deferral pattern
        if isinstance(node, ast.With) and _is_temporal_imports_passed_through(node):
            # Validate imports INSIDE the with body via the same import-whitelist
            # walk we do at module scope (handled by the ast.walk pass below).
            continue
        violations.append(
            f"top-level statement not allowed: {type(node).__name__} at line {node.lineno}"
        )

    # 4. Import whitelist (collect names while we're at it for the activity check)
    imported_activity_names: set[str] = set()
    imported_base_names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in FORBIDDEN_IMPORTS:
                    violations.append(f"forbidden import: {alias.name} (line {node.lineno})")
                elif alias.name not in ALLOWED_IMPORTS:
                    violations.append(
                        f"import not in whitelist: {alias.name} (line {node.lineno})"
                    )
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module.split(".")[0] in FORBIDDEN_IMPORTS:
                violations.append(f"forbidden import: from {module} (line {node.lineno})")
                continue
            if module not in _ALLOWED_FROM_IMPORTS:
                violations.append(
                    f"from-import source not in whitelist: {module} (line {node.lineno})"
                )
                continue
            # If importing from chore_actions, verify each name is in the manifest
            if module == "src.activities.chore_actions":
                manifest = get_manifest()
                for alias in node.names:
                    if alias.name not in manifest:
                        violations.append(
                            f"unknown activity import: {alias.name} from {module} "
                            f"(line {node.lineno})"
                        )
                    else:
                        imported_activity_names.add(alias.name)
            elif module == "src.workflows.chores._base":
                for alias in node.names:
                    imported_base_names.add(alias.name)

    # 5. Workflow class structure
    workflow_classes: list[ast.ClassDef] = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and _has_workflow_defn_decorator(node):
            workflow_classes.append(node)

    if len(workflow_classes) == 0:
        violations.append("no class with @workflow.defn decorator found")
    elif len(workflow_classes) > 1:
        violations.append(
            f"exactly one @workflow.defn class allowed, found {len(workflow_classes)}"
        )
    else:
        wf = workflow_classes[0]
        run_methods = [
            n for n in wf.body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            and _has_workflow_run_decorator(n)
        ]
        if len(run_methods) != 1:
            violations.append(
                f"workflow class must have exactly one @workflow.run method, "
                f"found {len(run_methods)}"
            )

    # 6. Forbidden name scan
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in _FORBIDDEN_NAMES:
            violations.append(
                f"forbidden name reference: {node.id} (line {node.lineno})"
            )
        elif isinstance(node, ast.Attribute):
            # Catch os.path, sys.modules, subprocess.run, etc.
            full = _attribute_chain(node)
            if full:
                root = full.split(".")[0]
                if root in FORBIDDEN_IMPORTS:
                    violations.append(
                        f"forbidden attribute access: {full} (line {node.lineno})"
                    )
                if full in _NONDETERMINISTIC_CALLS:
                    # Allowed inside activity bodies via execute_activity, but
                    # we can't easily distinguish. Flag as violation — generated
                    # templates should call activities for these.
                    violations.append(
                        f"non-deterministic call at workflow scope: {full} (line {node.lineno})"
                    )

    # 7. Activity call manifest check
    # Walk for workflow.execute_activity(NAME, ...) calls and verify NAME is
    # one of imported_activity_names or imported_base_names.
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        # Match workflow.execute_activity(...)
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "execute_activity"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "workflow"
        ):
            if not node.args:
                violations.append(
                    f"workflow.execute_activity called without an activity argument "
                    f"(line {node.lineno})"
                )
                continue
            first_arg = node.args[0]
            if not isinstance(first_arg, ast.Name):
                # We only allow direct name references (e.g. fetch_financial_events),
                # not strings ("fetch_financial_events") because the latter
                # bypass the import-whitelist guarantee.
                violations.append(
                    f"workflow.execute_activity must take a direct name reference "
                    f"as first arg (line {node.lineno})"
                )
                continue
            name = first_arg.id
            if name not in imported_activity_names and name not in imported_base_names:
                violations.append(
                    f"workflow.execute_activity references unknown activity {name!r} "
                    f"(line {node.lineno}) — must be imported from chore_actions or _base"
                )

    return ValidationResult(ok=not violations, violations=violations)


# ---------------------------------------------------------------------------
# Internal AST helpers
# ---------------------------------------------------------------------------

def _is_temporal_imports_passed_through(node: ast.With) -> bool:
    """Return True if this With statement is `with workflow.unsafe.imports_passed_through():`.

    Allowed at module scope because it's the official Temporal pattern for
    deferred imports (used by every standard-library chore template).
    """
    if len(node.items) != 1:
        return False
    item = node.items[0]
    call = item.context_expr
    if not isinstance(call, ast.Call):
        return False
    func = call.func
    # Match workflow.unsafe.imports_passed_through (an Attribute chain)
    if not isinstance(func, ast.Attribute) or func.attr != "imports_passed_through":
        return False
    inner = func.value
    if not isinstance(inner, ast.Attribute) or inner.attr != "unsafe":
        return False
    root = inner.value
    if not isinstance(root, ast.Name) or root.id != "workflow":
        return False
    return True


def _has_workflow_defn_decorator(node: ast.ClassDef) -> bool:
    for dec in node.decorator_list:
        if isinstance(dec, ast.Attribute) and dec.attr == "defn":
            if isinstance(dec.value, ast.Name) and dec.value.id == "workflow":
                return True
        elif isinstance(dec, ast.Call):
            # @workflow.defn(name="...")
            inner = dec.func
            if (
                isinstance(inner, ast.Attribute)
                and inner.attr == "defn"
                and isinstance(inner.value, ast.Name)
                and inner.value.id == "workflow"
            ):
                return True
    return False


def _has_workflow_run_decorator(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    for dec in node.decorator_list:
        if isinstance(dec, ast.Attribute) and dec.attr == "run":
            if isinstance(dec.value, ast.Name) and dec.value.id == "workflow":
                return True
    return False


def _attribute_chain(node: ast.Attribute) -> str:
    """Return the dotted name for an attribute chain like os.path.join -> 'os.path.join'."""
    parts: list[str] = [node.attr]
    current = node.value
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
    else:
        return ""
    return ".".join(reversed(parts))


# ---------------------------------------------------------------------------
# Dynamic loader — scans the user-chores directory at worker startup
# ---------------------------------------------------------------------------

def load_user_chore_templates() -> list[type]:
    """Scan USER_CHORES_DIR for .py files, validate, import, return workflow classes.

    Returns a list of workflow classes that worker.py appends to ALL_WORKFLOWS.
    Empty list if the directory doesn't exist, contains no .py files, or every
    file failed validation.

    Each loaded module gets a unique sys.modules name prefix (alfred_learn_dynamic.<stem>)
    so we don't collide with the real packages and so dynamic reloads (if we ever
    add them) work cleanly.
    """
    base = Path(USER_CHORES_DIR)
    if not base.exists() or not base.is_dir():
        logger.debug("dynamic_loader: %s does not exist, skipping", base)
        return []

    loaded: list[type] = []
    file_count = 0
    skipped_count = 0
    for py_file in sorted(base.glob("*.py")):
        if py_file.name.startswith("_"):
            continue  # skip __init__.py / private files
        file_count += 1
        try:
            source = py_file.read_text()
        except OSError as exc:
            logger.error("dynamic_loader: failed to read %s: %s", py_file, exc)
            skipped_count += 1
            continue

        # Layer 2 validation BEFORE importing — never load code that fails checks
        result = validate_template_source(source)
        if not result.ok:
            logger.error(
                "dynamic_loader: validation failed for %s: %s",
                py_file.name,
                "; ".join(result.violations),
            )
            skipped_count += 1
            continue

        # Import via spec_from_file_location, namespacing under the stub
        # package so Temporal's workflow validator can re-import it.
        _ensure_dynamic_package_stub()
        module_name = f"{_DYNAMIC_PACKAGE_NAME}.{py_file.stem}"
        try:
            spec = importlib.util.spec_from_file_location(module_name, py_file)
            if spec is None or spec.loader is None:
                logger.error("dynamic_loader: spec_from_file_location returned None for %s", py_file)
                skipped_count += 1
                continue
            module = importlib.util.module_from_spec(spec)
            module.__package__ = _DYNAMIC_PACKAGE_NAME
            sys.modules[module_name] = module
            # Also expose the module as an attribute on the parent package
            # so Temporal can reach it via getattr(alfred_learn_dynamic, stem).
            parent_pkg = sys.modules[_DYNAMIC_PACKAGE_NAME]
            setattr(parent_pkg, py_file.stem, module)
            spec.loader.exec_module(module)
        except Exception as exc:
            logger.error("dynamic_loader: import failed for %s: %s", py_file.name, exc)
            sys.modules.pop(module_name, None)
            skipped_count += 1
            continue

        # Find workflow classes in the loaded module
        found_in_file = 0
        for attr_name in dir(module):
            attr = getattr(module, attr_name, None)
            if attr is None:
                continue
            # Temporal marks workflow classes by setting __temporal_workflow_definition
            if hasattr(attr, "__temporal_workflow_definition"):
                loaded.append(attr)
                found_in_file += 1

        if found_in_file == 0:
            logger.warning(
                "dynamic_loader: %s passed validation and imported but exported no @workflow.defn class",
                py_file.name,
            )

    logger.info(
        "dynamic_loader: scanned %d files, loaded %d templates (%d skipped)",
        file_count, len(loaded), skipped_count,
    )
    return loaded
