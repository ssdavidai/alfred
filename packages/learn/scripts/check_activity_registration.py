"""Static check: every workflow.execute_activity target is registered.

Bug class this prevents
-----------------------

A Temporal workflow that calls ``workflow.execute_activity(foo, ...)`` where
``foo`` is NOT decorated with ``@activity.defn`` AND/OR is NOT included in
``ALL_ACTIVITIES`` in ``src/worker.py`` will silently fail at runtime.
The Temporal SDK raises ``Activity foo missing attributes, was it decorated
with @activity.defn?`` from inside a workflow task, which Temporal then
retries the workflow task on forever. The workflow looks healthy in the
Temporal CLI (state ``Running``) but never actually progresses.

This bit the fleet on 2026-05-19: ``JudgmentWorkflow`` was calling
``extract_input_metadata`` (defined in ``src/matching/metadata.py``) but
that function was a plain Python helper, never decorated with
``@activity.defn`` and never added to ``ALL_ACTIVITIES``. Every
JudgmentWorkflow run wedged on ``WORKFLOW_TASK_FAILED`` for 2.5 months
before anyone noticed. ~280 zombie workflows accumulated fleet-wide.

How it works
------------

1. AST-walk every Python file under ``src/workflows/`` looking for
   ``workflow.execute_activity(<name>, ...)`` and
   ``workflow.execute_local_activity(<name>, ...)`` call sites. The first
   positional argument is the activity reference; we capture its
   identifier name.
2. AST-walk every Python file under ``src/`` looking for
   ``FunctionDef`` / ``AsyncFunctionDef`` nodes whose decorators include
   ``activity.defn`` (bare or called). Build a set of decorated names.
3. Parse ``src/worker.py``, find the ``ALL_ACTIVITIES = [...]``
   assignment, extract the list of identifiers as a set.
4. For each call site, assert the activity is both decorated and
   included in ``ALL_ACTIVITIES``. Print a clear error naming the
   workflow file, the activity, and what's missing. Exit non-zero if any
   call site fails.

Run from ``packages/learn/`` as::

    python -m scripts.check_activity_registration

CI wires this in before the docker build step so a missing-activity bug
fails fast in pull-request CI rather than after deploy.
"""

from __future__ import annotations

import ast
import sys
from dataclasses import dataclass
from pathlib import Path


LEARN_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = LEARN_ROOT / "src"
WORKFLOWS_ROOT = SRC_ROOT / "workflows"
WORKER_FILE = SRC_ROOT / "worker.py"


@dataclass(frozen=True)
class CallSite:
    """A workflow.execute_activity reference: which file, which line, which name."""

    workflow_file: Path
    line: int
    activity_name: str
    call_kind: str  # "execute_activity" or "execute_local_activity"


def _is_workflow_execute_activity(call: ast.Call) -> str | None:
    """Return the kind of activity dispatch (execute_activity / execute_local_activity)
    if this Call node is ``workflow.execute_activity(...)`` or
    ``workflow.execute_local_activity(...)``. Else None.
    """
    func = call.func
    if not isinstance(func, ast.Attribute):
        return None
    if func.attr not in {"execute_activity", "execute_local_activity"}:
        return None
    value = func.value
    if not isinstance(value, ast.Name) or value.id != "workflow":
        return None
    return func.attr


def _extract_activity_name(call: ast.Call) -> str | None:
    """The first positional arg is the activity reference. Capture its identifier.

    Cases handled:
      * ``workflow.execute_activity(foo, ...)`` -> ``"foo"``
      * ``workflow.execute_activity("foo", ...)`` -> ``"foo"`` (string activity name —
        Temporal supports this for dynamically-named activities; we still
        require it to appear in ALL_ACTIVITIES at least as a function name).
      * ``workflow.execute_activity(mod.foo, ...)`` -> ``"foo"``

    If the first arg isn't one of these shapes (e.g. a lambda or a complex
    expression), returns None and the call site is silently skipped — we
    can't reason about it statically.
    """
    if not call.args:
        return None
    first = call.args[0]
    if isinstance(first, ast.Name):
        return first.id
    if isinstance(first, ast.Attribute):
        return first.attr
    if isinstance(first, ast.Constant) and isinstance(first.value, str):
        return first.value
    return None


def find_call_sites(workflows_root: Path) -> list[CallSite]:
    """AST-walk every .py under workflows_root and collect execute_activity refs."""
    sites: list[CallSite] = []
    for path in sorted(workflows_root.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(), filename=str(path))
        except SyntaxError as exc:
            print(
                f"ERROR: failed to parse {path}: {exc}",
                file=sys.stderr,
            )
            sys.exit(2)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            kind = _is_workflow_execute_activity(node)
            if kind is None:
                continue
            name = _extract_activity_name(node)
            if name is None:
                # Couldn't resolve the first arg statically. Skip.
                continue
            sites.append(
                CallSite(
                    workflow_file=path,
                    line=node.lineno,
                    activity_name=name,
                    call_kind=kind,
                ),
            )
    return sites


def _decorator_is_activity_defn(dec: ast.expr) -> bool:
    """True if a decorator expression is ``@activity.defn`` or ``@activity.defn(...)``."""
    # @activity.defn(...)
    if isinstance(dec, ast.Call):
        return _decorator_is_activity_defn(dec.func)
    # @activity.defn
    if isinstance(dec, ast.Attribute):
        if dec.attr != "defn":
            return False
        value = dec.value
        return isinstance(value, ast.Name) and value.id == "activity"
    return False


def find_decorated_activities(src_root: Path) -> dict[str, list[tuple[Path, int]]]:
    """Walk every .py under src_root looking for @activity.defn decorated functions.

    Returns a mapping of activity-name -> list of (file, line) definitions.
    Activities may also be registered under a custom name via
    ``@activity.defn(name="other")`` — we record both the function name and
    the explicit name= kwarg so the registration check can match either.
    """
    decorated: dict[str, list[tuple[Path, int]]] = {}
    for path in sorted(src_root.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(), filename=str(path))
        except SyntaxError as exc:
            print(
                f"ERROR: failed to parse {path}: {exc}",
                file=sys.stderr,
            )
            sys.exit(2)
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for dec in node.decorator_list:
                if not _decorator_is_activity_defn(dec):
                    continue
                names = {node.name}
                # Pick up @activity.defn(name="explicit")
                if isinstance(dec, ast.Call):
                    for kw in dec.keywords:
                        if (
                            kw.arg == "name"
                            and isinstance(kw.value, ast.Constant)
                            and isinstance(kw.value.value, str)
                        ):
                            names.add(kw.value.value)
                for name in names:
                    decorated.setdefault(name, []).append((path, node.lineno))
                break
    return decorated


def _build_import_alias_map(tree: ast.Module) -> dict[str, str]:
    """For a parsed module, build a map of local-name -> original-name for every
    aliased import. Unaliased imports map name -> name.

    ``from x import foo as bar`` -> ``{"bar": "foo"}``
    ``from x import foo`` -> ``{"foo": "foo"}``
    ``import x.y as z`` -> ``{"z": "x.y"}`` (we only take the leaf for our use)
    """
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                local = alias.asname or alias.name
                aliases[local] = alias.name
        elif isinstance(node, ast.Import):
            for alias in node.names:
                local = alias.asname or alias.name
                # ``import x.y`` exposes the local name "x"; only relevant for
                # explicit aliases like ``import x.y as z``.
                aliases[local] = alias.name
    return aliases


def find_all_activities(worker_file: Path) -> tuple[set[str], set[str]]:
    """Parse ``worker.py``, locate the ``ALL_ACTIVITIES = [...]`` assignment,
    return two sets:

      * the local names actually written in the list (e.g. ``dw_watch``)
      * the resolved-back-through-imports original names
        (e.g. ``watch_decay`` if ``dw_watch`` was imported as
        ``from src.activities.decay_watcher import watch_decay as dw_watch``).

    A workflow call site is registered iff EITHER set contains the call
    site's name (resolved through the workflow's own imports). This is
    how we tolerate the worker's heavy use of import aliasing without
    flagging false positives.

    Only simple ``ast.Name`` entries are extracted — anything more complex
    (function calls, comprehensions, starred unpackings) would not be valid
    activity references for Temporal anyway.
    """
    try:
        tree = ast.parse(worker_file.read_text(), filename=str(worker_file))
    except SyntaxError as exc:
        print(
            f"ERROR: failed to parse {worker_file}: {exc}",
            file=sys.stderr,
        )
        sys.exit(2)

    aliases = _build_import_alias_map(tree)

    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name) or target.id != "ALL_ACTIVITIES":
                continue
            if not isinstance(node.value, (ast.List, ast.Tuple)):
                print(
                    f"ERROR: ALL_ACTIVITIES in {worker_file} is not a list/tuple literal "
                    f"(found {type(node.value).__name__}). The static check needs a "
                    f"literal collection to walk.",
                    file=sys.stderr,
                )
                sys.exit(2)
            local_names: set[str] = set()
            for elt in node.value.elts:
                if isinstance(elt, ast.Name):
                    local_names.add(elt.id)
            resolved_names = {aliases.get(n, n) for n in local_names}
            return local_names, resolved_names

    print(
        f"ERROR: could not find an ``ALL_ACTIVITIES = [...]`` assignment in "
        f"{worker_file}.",
        file=sys.stderr,
    )
    sys.exit(2)


def _resolve_imported_alias(workflow_file: Path, local_name: str) -> str:
    """For aliased imports like ``from x import foo as bar``, when a workflow
    calls ``workflow.execute_activity(bar, ...)``, we need to compare against
    ``foo`` (the original function name) for the @activity.defn check.

    For unaliased imports the local name IS the original name, so return it.
    Returns the original name if found, else returns ``local_name`` unchanged.
    """
    try:
        tree = ast.parse(workflow_file.read_text(), filename=str(workflow_file))
    except SyntaxError:
        return local_name
    aliases = _build_import_alias_map(tree)
    return aliases.get(local_name, local_name)


def main() -> int:
    if not SRC_ROOT.is_dir():
        print(f"ERROR: cannot find src/ at {SRC_ROOT}", file=sys.stderr)
        return 2
    if not WORKFLOWS_ROOT.is_dir():
        print(
            f"ERROR: cannot find src/workflows/ at {WORKFLOWS_ROOT}",
            file=sys.stderr,
        )
        return 2
    if not WORKER_FILE.is_file():
        print(f"ERROR: cannot find src/worker.py at {WORKER_FILE}", file=sys.stderr)
        return 2

    call_sites = find_call_sites(WORKFLOWS_ROOT)
    decorated = find_decorated_activities(SRC_ROOT)
    all_activities_local, all_activities_resolved = find_all_activities(WORKER_FILE)

    # The same activity can be imported under multiple aliases across
    # different files. For each call site, resolve the workflow-local alias
    # back to the original function name. The decoration check matches
    # against the original name (that's what @activity.defn sees). The
    # ALL_ACTIVITIES check matches against EITHER the worker.py local alias
    # OR the resolved original name — registration is what counts, not
    # which symbol it shows up under in the list.

    failures: list[str] = []
    for site in call_sites:
        original_name = _resolve_imported_alias(
            site.workflow_file, site.activity_name,
        )
        rel = site.workflow_file.relative_to(LEARN_ROOT)

        decorated_ok = original_name in decorated or site.activity_name in decorated
        registered_ok = (
            site.activity_name in all_activities_local
            or site.activity_name in all_activities_resolved
            or original_name in all_activities_local
            or original_name in all_activities_resolved
        )

        if decorated_ok and registered_ok:
            continue

        missing: list[str] = []
        if not decorated_ok:
            missing.append(
                f"NOT decorated with @activity.defn anywhere under src/ "
                f"(looked for `{original_name}` and `{site.activity_name}`)",
            )
        if not registered_ok:
            missing.append(
                f"NOT included in ALL_ACTIVITIES in src/worker.py "
                f"(looked for `{site.activity_name}` and `{original_name}`)",
            )
        failures.append(
            f"\n  {rel}:{site.line}  workflow.{site.call_kind}({site.activity_name}, ...)"
            + "\n    - "
            + "\n    - ".join(missing),
        )

    if failures:
        print(
            "FAIL: workflow.execute_activity targets are not properly registered.",
            file=sys.stderr,
        )
        print(
            "Every activity passed to workflow.execute_activity MUST be both:",
            file=sys.stderr,
        )
        print(
            "  1. decorated with @activity.defn (or @activity.defn(...))",
            file=sys.stderr,
        )
        print(
            "  2. included in ALL_ACTIVITIES in packages/learn/src/worker.py",
            file=sys.stderr,
        )
        print(
            "Otherwise the Temporal worker will silently fail every workflow task "
            "with `Activity <name> missing attributes, was it decorated with "
            "@activity.defn?` and retry forever. This is the bug class that wedged "
            "JudgmentWorkflow on the fleet for 2.5 months (see script header).",
            file=sys.stderr,
        )
        print("\nOffending call sites:", file=sys.stderr)
        for f in failures:
            print(f, file=sys.stderr)
        print(
            f"\n{len(failures)} unregistered activity reference(s).",
            file=sys.stderr,
        )
        return 1

    print(
        f"OK: {len(call_sites)} workflow.execute_activity call site(s) checked, "
        f"all targets decorated and registered.",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
