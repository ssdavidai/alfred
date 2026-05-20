"""Static analyzer for chore Python source files.

For each generated chore template, parse the AST and derive a manifest of:

  - activities_used: every name imported from chore_actions and every
    call to one of those activities (so the analyzer catches both
    "from … import X" + later "X()" usage). Authoritative because it
    reflects what the running code actually does — the LLM-emitted
    manifest documents intent; this module measures reality.
  - tools_used: any Composio action name passed as the first arg to
    `call_composio(...)`. We normalize to toolkit slugs (e.g.
    ``"GMAIL_SEND_EMAIL"`` → ``"composio.gmail"``).
  - uses_llm: True iff the source touches a known LLM-gateway entry
    point (``ask_alfred_to_judge_anomalies``, ``write_matter_digest_via_llm``,
    ``call_self``, ``spawn_subagent``, ``call_clerk``, ``_call_clerk``).
  - llm_agent_id: the agent_id string when one of the LLM calls passes
    it explicitly (e.g. ``call_self(agent_id="learn-clerk", ...)``).
  - vault_writes / vault_reads: heuristic — derived from the activity
    names a chore uses. ``save_*_to_vault`` / ``write_*`` → write;
    ``fetch_*`` / ``load_*`` / ``read_*`` → read. Best-effort only;
    augmented by the LLM-emitted manifest where conflicts exist.

This is read-only; the analyzer never modifies the chore source. It's
called from the backfill script (one pass over david's 9 existing
chores) and at generation time as a sanity check against the LLM's
self-reported manifest.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from typing import Any


# Known LLM-gateway entry points. Importing or calling any of these
# from a chore means the chore uses an LLM.
_LLM_ACTIVITIES = frozenset({
    "ask_alfred_to_judge_anomalies",
    "write_matter_digest_via_llm",
    "call_self",
    "spawn_subagent",
    "_call_clerk",
    "call_clerk",
    "clerk_classify",
    "clerk_extract_observation",
    "clerk_extract_instruction_observation",
    "clerk_session_boundary",
    "clerk_compare_topics",
    "clerk_match_session_context",
    "clerk_reflect",
    "clerk_execute_instructions",
})


# Composio toolkit prefixes for naming the tools_used field. Maps the
# uppercase action prefix to the canonical toolkit slug shown on
# /connections. (gmail.com → composio.gmail, googlecalendar →
# composio.googlecalendar, etc.) We keep it permissive — unknown
# prefixes pass through as the raw action name so the UI still gets
# something readable.
_COMPOSIO_TOOLKIT_PREFIXES = {
    "GMAIL": "composio.gmail",
    "GOOGLECALENDAR": "composio.googlecalendar",
    "GOOGLEDRIVE": "composio.googledrive",
    "GCAL": "composio.googlecalendar",
    "SLACK": "composio.slack",
    "TELEGRAM": "composio.telegram",
    "NOTION": "composio.notion",
    "LINEAR": "composio.linear",
    "GITHUB": "composio.github",
    "PLANE": "composio.plane",
    "ASANA": "composio.asana",
    "AIRTABLE": "composio.airtable",
    "DROPBOX": "composio.dropbox",
    "ONEDRIVE": "composio.onedrive",
    "OUTLOOK": "composio.outlook",
    "STRIPE": "composio.stripe",
    "TYPEFORM": "composio.typeform",
    "TWITTER": "composio.twitter",
    "ZOOM": "composio.zoom",
}


@dataclass
class ChoreManifest:
    activities_used: list[str] = field(default_factory=list)
    tools_used: list[str] = field(default_factory=list)
    uses_llm: bool = False
    llm_agent_id: str = ""
    vault_writes: list[str] = field(default_factory=list)
    vault_reads: list[str] = field(default_factory=list)
    # Soft errors that don't stop analysis but worth surfacing.
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "activities_used": sorted(self.activities_used),
            "tools_used": sorted(self.tools_used),
            "uses_llm": self.uses_llm,
            "llm_agent_id": self.llm_agent_id,
            "vault_writes": sorted(self.vault_writes),
            "vault_reads": sorted(self.vault_reads),
            "warnings": self.warnings,
        }


def _composio_action_to_toolkit(action: str) -> str:
    """Map a Composio action name like ``GMAIL_SEND_EMAIL`` to its
    toolkit slug ``composio.gmail``. Unknown prefixes pass through as
    ``composio.<lowercased-prefix>`` so the UI still has something to
    render (and so we don't silently lose tools when a new toolkit
    shows up)."""
    if not action:
        return ""
    prefix = action.split("_", 1)[0].upper()
    if prefix in _COMPOSIO_TOOLKIT_PREFIXES:
        return _COMPOSIO_TOOLKIT_PREFIXES[prefix]
    if prefix.isalpha():
        return f"composio.{prefix.lower()}"
    return f"composio.{action.lower()}"


def _infer_vault_io(activity_name: str) -> tuple[list[str], list[str]]:
    """Best-effort split of an activity name into vault reads vs writes
    based on the verb. Returns (reads, writes). The patterns mirror the
    naming conventions used throughout chore_actions.py.
    """
    # Common verbs → side
    write_verbs = ("save_", "write_", "store_", "persist_", "log_", "append_", "record_")
    read_verbs = ("fetch_", "load_", "read_", "list_", "scan_", "search_", "get_", "find_")

    name = activity_name.lower()
    reads: list[str] = []
    writes: list[str] = []

    for verb in write_verbs:
        if name.startswith(verb):
            # Try to extract the record type from the activity name
            # ("save_subscription_snapshot" → "subscription_snapshot",
            # "save_digest_to_vault" → "digest"). The "_to_vault" suffix
            # is noise; strip it.
            stem = name[len(verb):]
            stem = re.sub(r"_to_vault$", "", stem)
            stem = re.sub(r"_record$", "", stem)
            writes.append(stem or activity_name)
            return reads, writes

    for verb in read_verbs:
        if name.startswith(verb):
            stem = name[len(verb):]
            stem = re.sub(r"_from_vault$", "", stem)
            stem = re.sub(r"_record$", "", stem)
            reads.append(stem or activity_name)
            return reads, writes

    return reads, writes


class _Walker(ast.NodeVisitor):
    """Single-pass AST walker that builds a ChoreManifest."""

    def __init__(self) -> None:
        self.manifest = ChoreManifest()
        self._imported_from_chore_actions: set[str] = set()
        self._activities_called: set[str] = set()
        self._tools: set[str] = set()
        self._vault_writes: set[str] = set()
        self._vault_reads: set[str] = set()
        self._agent_ids: set[str] = set()

    # ---------------------------------------------------------------
    # imports
    # ---------------------------------------------------------------

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        # Activities that come from chore_actions are the canonical
        # surface for chores. Other src.activities imports are allowed
        # but don't count toward activities_used.
        if module.endswith("activities.chore_actions") or module == "chore_actions":
            for alias in node.names:
                name = alias.asname or alias.name
                if name == "*":
                    self.manifest.warnings.append(
                        f"chore_actions imported with star at line {node.lineno}; "
                        "activities_used may be incomplete",
                    )
                    continue
                self._imported_from_chore_actions.add(alias.name)
        self.generic_visit(node)

    # ---------------------------------------------------------------
    # function calls
    # ---------------------------------------------------------------

    def visit_Call(self, node: ast.Call) -> None:
        callable_name = self._call_target_name(node.func)
        if callable_name:
            # Direct invocation of an imported activity (e.g. `await
            # save_subscription_snapshot(...)`) — rare in Temporal
            # workflows but supported in the analyzer for completeness.
            if callable_name in self._imported_from_chore_actions:
                self._activities_called.add(callable_name)
            if callable_name in _LLM_ACTIVITIES:
                self.manifest.uses_llm = True
                self._activities_called.add(callable_name)

            # Temporal-style invocation: workflow.execute_activity(
            # name_or_function, args=..., ...). First positional is the
            # activity (a Name reference to the imported function), or
            # a string literal naming the activity. Both forms are
            # idiomatic; capture both.
            if callable_name == "execute_activity" and node.args:
                target = node.args[0]
                activity_name = ""
                if isinstance(target, ast.Name):
                    activity_name = target.id
                elif isinstance(target, ast.Attribute):
                    activity_name = target.attr
                elif isinstance(target, ast.Constant) and isinstance(
                    target.value, str,
                ):
                    activity_name = target.value
                if activity_name:
                    self._activities_called.add(activity_name)
                    if activity_name in _LLM_ACTIVITIES:
                        self.manifest.uses_llm = True
                    # If the activity is call_composio invoked through
                    # execute_activity, the action name comes in via
                    # the `args=[...]` keyword. Walk that list for a
                    # leading string literal.
                    if activity_name == "call_composio":
                        for kw in node.keywords:
                            if kw.arg in ("args", "arg"):
                                action = self._first_str_in_list(kw.value)
                                if action:
                                    self._tools.add(
                                        _composio_action_to_toolkit(action),
                                    )
                    # call_self / spawn_subagent through execute_activity:
                    # pull agent_id from the args list when the LLM
                    # passed it as a positional or kw inside the list.
                    if activity_name in ("call_self", "spawn_subagent"):
                        for kw in node.keywords:
                            if kw.arg in ("args", "arg"):
                                agent = self._extract_agent_id_from_args(
                                    kw.value,
                                )
                                if agent:
                                    self._agent_ids.add(agent)

            # Direct (non-Temporal) invocation patterns kept for the
            # cases where a chore happens to call helpers directly.
            if callable_name == "call_composio" and node.args:
                action = self._literal_str(node.args[0])
                if action:
                    self._tools.add(_composio_action_to_toolkit(action))
            if callable_name in ("call_self", "spawn_subagent"):
                self.manifest.uses_llm = True
                for kw in node.keywords:
                    if kw.arg == "agent_id":
                        v = self._literal_str(kw.value)
                        if v:
                            self._agent_ids.add(v)

        self.generic_visit(node)

    # ---------------------------------------------------------------
    # arg-list inspection helpers
    # ---------------------------------------------------------------

    @staticmethod
    def _first_str_in_list(node: ast.expr) -> str:
        """Given an args=[…] literal, return the first string element.
        Used to extract the Composio action name when call_composio is
        invoked via workflow.execute_activity(call_composio, args=[…]).
        """
        if isinstance(node, (ast.List, ast.Tuple)):
            for el in node.elts:
                if isinstance(el, ast.Constant) and isinstance(el.value, str):
                    return el.value
        return ""

    @staticmethod
    def _extract_agent_id_from_args(node: ast.expr) -> str:
        """Given an args=[…] literal, return any agent_id string found
        in keyword pairs or as a positional string."""
        if isinstance(node, (ast.List, ast.Tuple)):
            for el in node.elts:
                # Dict literal: {"agent_id": "learn-clerk", ...}
                if isinstance(el, ast.Dict):
                    for k, v in zip(el.keys, el.values):
                        if (
                            isinstance(k, ast.Constant)
                            and k.value == "agent_id"
                            and isinstance(v, ast.Constant)
                            and isinstance(v.value, str)
                        ):
                            return v.value
                # Bare string positional — assumed to be agent_id when
                # call_self/spawn_subagent receive a single string.
                # Agent ids are lowercase kebab-case slugs ("learn-clerk",
                # "exec-abc123") or the single literal "main". Anything
                # else (HTTP verbs, URLs, prose) is some other argument
                # and gets rejected.
                if isinstance(el, ast.Constant) and isinstance(el.value, str):
                    s = el.value.strip()
                    if not s:
                        continue
                    if s == "main":
                        return s
                    # Slug shape: lowercase, may include digits and
                    # hyphens, must contain at least one hyphen.
                    if (
                        re.fullmatch(r"[a-z][a-z0-9-]+", s)
                        and "-" in s
                        and len(s) < 40
                    ):
                        return s
        return ""

    # ---------------------------------------------------------------
    # helpers
    # ---------------------------------------------------------------

    @staticmethod
    def _call_target_name(node: ast.expr) -> str:
        """Extract the bare callable name from a Call.func node.

        Handles:
          foo(...)                  -> "foo"
          mod.foo(...)              -> "foo"
          await foo(...)            -> "foo"
          await workflow.execute_activity(foo, ...) — NOT extracted here
          (the activity arg is handled implicitly via the import
          binding).
        """
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return node.attr
        return ""

    @staticmethod
    def _literal_str(node: ast.expr) -> str:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        return ""

    # ---------------------------------------------------------------
    # finalise
    # ---------------------------------------------------------------

    def finalise(self) -> ChoreManifest:
        # activities_used = imported AND not unused. We err on the
        # generous side: include every imported chore_action, even if
        # not yet called from the body (the LLM sometimes imports
        # ahead of use). Anything actually called shows up either way.
        used = set(self._imported_from_chore_actions) | self._activities_called
        self.manifest.activities_used = sorted(used)
        self.manifest.tools_used = sorted(self._tools)
        # Vault I/O — derive from activity names. Best-effort.
        for act in used:
            reads, writes = _infer_vault_io(act)
            self._vault_reads.update(reads)
            self._vault_writes.update(writes)
        self.manifest.vault_writes = sorted(self._vault_writes)
        self.manifest.vault_reads = sorted(self._vault_reads)
        # Agent id — take the first one seen. Multiple agent_ids in a
        # single chore is unusual but valid; the UI just shows one.
        if self._agent_ids:
            self.manifest.llm_agent_id = sorted(self._agent_ids)[0]
        return self.manifest


def analyze_chore_source(source: str) -> ChoreManifest:
    """Parse a chore .py source and return its derived manifest.

    Raises SyntaxError on malformed Python — the caller should treat
    that as a hard generation failure (the source wouldn't run anyway).
    """
    tree = ast.parse(source)
    walker = _Walker()
    walker.visit(tree)
    return walker.finalise()
