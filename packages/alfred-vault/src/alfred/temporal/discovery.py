"""Discover @workflow.defn classes from configured directories."""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from typing import Any


def discover_workflows(dirs: list[str]) -> list[type]:
    """Scan directories for Python files containing Temporal workflow definitions.

    Returns a list of classes decorated with @workflow.defn.
    """
    workflows: list[type] = []
    seen_names: set[str] = set()

    for dir_path in dirs:
        p = Path(dir_path).resolve()
        if not p.is_dir():
            continue
        for py_file in sorted(p.glob("*.py")):
            if py_file.name.startswith("_"):
                continue
            found = _load_workflows_from_file(py_file, p)
            for cls in found:
                name = getattr(cls, "__temporal_workflow_definition", None)
                key = name.name if name else cls.__name__
                if key not in seen_names:
                    seen_names.add(key)
                    workflows.append(cls)

    return workflows


def _infer_module_name(path: Path) -> str | None:
    """Try to infer a real dotted module name for a file within an installed package."""
    # Walk up from the file looking for __init__.py to build a package path
    parts = [path.stem]
    current = path.parent
    while (current / "__init__.py").exists():
        parts.append(current.name)
        current = current.parent
    if len(parts) > 1:
        parts.reverse()
        return ".".join(parts)
    return None


def _load_workflows_from_file(path: Path, parent_dir: Path) -> list[type]:
    """Import a Python file and extract workflow classes."""
    # Try to use a real importable module name first (works with Temporal sandbox)
    module_name = _infer_module_name(path)

    if module_name and module_name in sys.modules:
        module = sys.modules[module_name]
    elif module_name:
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            module = _load_via_spec(path, parent_dir)
    else:
        module = _load_via_spec(path, parent_dir)

    if module is None:
        return []

    workflows: list[type] = []
    for attr_name in dir(module):
        obj = getattr(module, attr_name)
        if isinstance(obj, type) and hasattr(obj, "__temporal_workflow_definition"):
            workflows.append(obj)
    return workflows


def _load_via_spec(path: Path, parent_dir: Path) -> Any:
    """Load a module by adding its parent to sys.path so Temporal sandbox can re-import it."""
    parent_str = str(parent_dir)
    if parent_str not in sys.path:
        sys.path.insert(0, parent_str)

    module_name = path.stem
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        return None

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        return None
    return module
