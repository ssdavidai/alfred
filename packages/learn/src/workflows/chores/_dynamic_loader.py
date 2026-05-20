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
import importlib
import importlib.util
import logging
import sys
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
# Stage directory for dynamic templates
#
# Temporal's workflow sandbox re-imports each workflow module by qualified
# name to verify replay-safety. That re-import goes through `importlib`
# with a normal Python import path lookup — there's no way to satisfy it
# with a fake `sys.modules` entry because the sandbox runs its own module
# table.
#
# So we COPY each validated template from /alfred-data/user-chores/ (the
# persistent encrypted volume — source of truth) into /app/src/workflows/
# chores_dynamic/ at worker startup. /app is on sys.path so the copy
# becomes a real importable Python module that Temporal can re-import.
#
# Stale files (in chores_dynamic but no longer in user-chores) get
# deleted on each scan so the staged copy converges to the source of truth.
# ---------------------------------------------------------------------------

# The real, importable package the loader stages templates into. /app is on
# sys.path inside the alfred-learn container, so this resolves as a normal
# `src.workflows.chores_dynamic.<stem>` import.
_STAGED_PACKAGE_DIR = Path("/app/src/workflows/chores_dynamic")
_STAGED_PACKAGE_NAME = "src.workflows.chores_dynamic"


def _ensure_staged_package_dir() -> None:
    """Make sure the staging directory + __init__.py exist."""
    _STAGED_PACKAGE_DIR.mkdir(parents=True, exist_ok=True)
    init = _STAGED_PACKAGE_DIR / "__init__.py"
    if not init.exists():
        init.write_text(
            '"""Auto-staged dynamic chore templates.\n\n'
            "Files in this package are copied at worker startup from the persistent\n"
            "chore source directory (USER_CHORES_DIR). The loader in\n"
            "src.workflows.chores._dynamic_loader manages this staging — DO NOT\n"
            "edit files here directly, they'll be overwritten on next startup.\n"
            '"""\n'
        )


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
         allowed at module scope (no loose statements, no module-level side effects).
         Also enforces import ordering: any
         `with workflow.unsafe.imports_passed_through():` block at module
         scope MUST come AFTER `from temporalio import workflow` so the
         `workflow` name resolves at import time (tenant-c ordering bug).
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
    #   - Simple constant assignments (Assign / AnnAssign) with literal RHS:
    #     `_POLL_HOURS = 9`, `MAX_ITEMS: int = 20`, `TAGS: list[str] = ["a"]`.
    #     Opus naturally writes these and they're deterministic/replay-safe
    #     because they're evaluated once at module import time.
    #
    # Side-effect: track whether `from temporalio import workflow` has been
    # seen at module scope before any `with workflow.unsafe.imports_passed_through()`
    # block. The bug we're guarding against (tenant-c incident, 2026-04-29):
    # Opus sometimes emits the with-block BEFORE the workflow import, which
    # raises NameError("workflow") at import time, the workflow class never
    # registers, and Temporal's worker fires the schedule forever with an
    # ApplicationError on every tick.
    workflow_imported_at_module_scope = False
    for idx, node in enumerate(tree.body):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if _imports_temporal_workflow_name(node):
                workflow_imported_at_module_scope = True
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
            if not workflow_imported_at_module_scope:
                violations.append(
                    f"`with workflow.unsafe.imports_passed_through():` at line "
                    f"{node.lineno} appears before any `from temporalio import "
                    f"workflow` (or `import temporalio.workflow`) at module "
                    f"scope. The with-block references `workflow` in its "
                    f"context expression — without the import first, Python "
                    f"raises NameError at import time and the workflow class "
                    f"never registers."
                )
            # Validate imports INSIDE the with body via the same import-whitelist
            # walk we do at module scope (handled by the ast.walk pass below).
            continue
        # Simple module-level constants — only literal RHS allowed. This
        # blocks e.g. `FOO = some_function()` (which would be a side-effect
        # at import time) while permitting `FOO = 5`, `BAR: list[int] = []`.
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and _is_literal_constant_assignment(node):
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
            # If importing from chore_actions, verify each name is in the
            # manifest AND that the activity's home module is actually
            # chore_actions. The global manifest includes activities from
            # many modules (session, vault, clerk, etc.) — a naive `name in
            # manifest` check would accept hallucinated names that happen
            # to exist elsewhere in the codebase.
            if module == "src.activities.chore_actions":
                manifest = get_manifest()
                for alias in node.names:
                    descriptor = manifest.get(alias.name)
                    if descriptor is None:
                        violations.append(
                            f"unknown activity import: {alias.name} from {module} "
                            f"(line {node.lineno})"
                        )
                    elif descriptor.module != "src.activities.chore_actions":
                        violations.append(
                            f"activity {alias.name} is not exported from chore_actions "
                            f"(lives in {descriptor.module}) — line {node.lineno}"
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

def _is_literal_constant_assignment(node: ast.Assign | ast.AnnAssign) -> bool:
    """Return True for a module-level literal constant assignment.

    Allowed forms:
      FOO = 5
      FOO = "hello"
      FOO = True
      FOO = None
      FOO = [1, 2, 3]            # list of literals
      FOO = (1, 2, 3)            # tuple of literals
      FOO = {"a": 1, "b": 2}     # dict of literals
      FOO = {1, 2, 3}            # set of literals
      FOO: int = 5               # annotated
      FOO: list[str] = ["a"]     # annotated collection

    Rejected:
      FOO = some_function()      # call at import time → side effects
      FOO = x + 1                # references other names
      FOO = SomeClass()          # instantiation at import time

    The target must be a single plain Name (no tuple unpacking, no
    attribute assignment). The value must reduce to literals all the
    way down via `_is_literal_value`.
    """
    if isinstance(node, ast.Assign):
        # Must assign to exactly one plain name
        if len(node.targets) != 1:
            return False
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            return False
        value = node.value
    elif isinstance(node, ast.AnnAssign):
        # AnnAssign can be annotation-only (`FOO: int`) — that's fine
        if node.value is None:
            return isinstance(node.target, ast.Name)
        if not isinstance(node.target, ast.Name):
            return False
        value = node.value
    else:
        return False
    return _is_literal_value(value)


def _is_literal_value(node: ast.AST) -> bool:
    """Return True if an AST expression is a pure literal (no calls, no names)."""
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return all(_is_literal_value(elt) for elt in node.elts)
    if isinstance(node, ast.Dict):
        return (
            all(k is not None and _is_literal_value(k) for k in node.keys)
            and all(_is_literal_value(v) for v in node.values)
        )
    # Unary on a constant (e.g. -1, +0.5, ~3)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd, ast.Invert)):
        return _is_literal_value(node.operand)
    return False


def _imports_temporal_workflow_name(
    node: ast.Import | ast.ImportFrom | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef,
) -> bool:
    """Return True if `node` is an import that binds the name `workflow`
    referring to the temporalio module (or submodule that includes it).

    Recognised forms:
      - `from temporalio import workflow`
      - `from temporalio import workflow as workflow`  (degenerate alias)
      - `import temporalio.workflow as workflow`
      - `import temporalio.workflow`  (binds `temporalio`, NOT `workflow`,
        so this form does NOT satisfy the guard)

    The guard exists to catch the tenant-c import-ordering bug where the
    `with workflow.unsafe.imports_passed_through():` block was emitted
    before `from temporalio import workflow`, raising NameError at import
    time. Only the import forms that bind a top-level `workflow` symbol
    in the module namespace count — `import temporalio.workflow` binds
    only `temporalio`, so it would NOT prevent the NameError and is
    correctly excluded here.
    """
    if isinstance(node, ast.ImportFrom):
        if node.module != "temporalio":
            return False
        for alias in node.names:
            # `from temporalio import workflow` (alias.name='workflow', asname=None)
            # `from temporalio import workflow as workflow` (asname='workflow')
            bound = alias.asname if alias.asname else alias.name
            if bound == "workflow":
                return True
        return False
    if isinstance(node, ast.Import):
        for alias in node.names:
            # `import temporalio.workflow as workflow` binds `workflow`.
            # Plain `import temporalio.workflow` binds only `temporalio`.
            if alias.asname == "workflow":
                return True
        return False
    return False


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
    """Scan USER_CHORES_DIR, validate + stage each file, import, return workflow classes.

    Pipeline per file:
      1. Read source from /alfred-data/user-chores/<stem>.py
      2. Validate via Layer 2 static checks (validate_template_source)
      3. Copy validated source to /app/src/workflows/chores_dynamic/<stem>.py
         (a real Python package on sys.path so Temporal's sandbox can re-import it)
      4. importlib.import_module('src.workflows.chores_dynamic.<stem>')
      5. Collect classes with __temporal_workflow_definition

    Stale staged files (present in chores_dynamic but absent from user-chores)
    are deleted on each scan so the staged package mirrors the source of truth.

    Returns a list of workflow classes that worker.py appends to ALL_WORKFLOWS.
    """
    base = Path(USER_CHORES_DIR)
    if not base.exists() or not base.is_dir():
        logger.debug("dynamic_loader: %s does not exist, skipping", base)
        return []

    _ensure_staged_package_dir()

    # 1. Inventory the source-of-truth directory
    source_files = sorted(
        f for f in base.glob("*.py") if not f.name.startswith("_")
    )
    source_stems = {f.stem for f in source_files}

    # 2. Delete stale staged files (mirror the source directory)
    for staged in _STAGED_PACKAGE_DIR.glob("*.py"):
        if staged.name == "__init__.py":
            continue
        if staged.stem not in source_stems:
            try:
                staged.unlink()
                logger.info("dynamic_loader: removed stale staged template %s", staged.name)
            except OSError as exc:
                logger.warning("dynamic_loader: failed to remove stale %s: %s", staged, exc)

    loaded: list[type] = []
    file_count = 0
    skipped_count = 0
    for py_file in source_files:
        file_count += 1
        try:
            source = py_file.read_text()
        except OSError as exc:
            logger.error("dynamic_loader: failed to read %s: %s", py_file, exc)
            skipped_count += 1
            continue

        # 3. Layer 2 validation BEFORE staging — never copy code that fails checks
        result = validate_template_source(source)
        if not result.ok:
            logger.error(
                "dynamic_loader: validation failed for %s: %s",
                py_file.name,
                "; ".join(result.violations),
            )
            skipped_count += 1
            # Also remove any stale staged copy of a now-invalid file
            staged_path = _STAGED_PACKAGE_DIR / py_file.name
            if staged_path.exists():
                try:
                    staged_path.unlink()
                except OSError:
                    pass
            continue

        # 4. Copy validated source into the staging package directory
        staged_path = _STAGED_PACKAGE_DIR / py_file.name
        try:
            staged_path.write_text(source)
        except OSError as exc:
            logger.error("dynamic_loader: failed to stage %s: %s", py_file.name, exc)
            skipped_count += 1
            continue

        # 5. Import via the standard mechanism — staged dir is on sys.path
        module_name = f"{_STAGED_PACKAGE_NAME}.{py_file.stem}"
        try:
            # Drop any cached module so we re-load fresh content (handles
            # the case where a generated file was overwritten between restarts)
            sys.modules.pop(module_name, None)
            module = importlib.import_module(module_name)
        except Exception as exc:
            logger.error("dynamic_loader: import failed for %s: %s", py_file.name, exc)
            skipped_count += 1
            continue

        # 6. Find workflow classes in the loaded module
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
