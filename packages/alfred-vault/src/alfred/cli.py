"""Top-level argparse CLI dispatcher for Alfred."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import yaml


def _load_env_file(env_path: Path | None = None) -> None:
    """Load a .env file into os.environ (without overriding existing vars).

    Supports lines of the form KEY=VALUE (with optional quoting).
    Skips blank lines and comments (#).
    """
    if env_path is None:
        env_path = Path(".env")
    if not env_path.is_file():
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            # Remove surrounding quotes if present
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            # Only set if not already in environment (don't override)
            if key not in os.environ:
                os.environ[key] = value


def _load_unified_config(config_path: str) -> dict[str, Any]:
    """Load and return raw unified config dict."""
    path = Path(config_path)
    if not path.exists():
        print(f"Config file not found: {path}")
        print("Run `alfred quickstart` to create one.")
        sys.exit(1)
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _setup_logging_from_config(raw: dict[str, Any]) -> None:
    """Set up logging from the unified config's logging section."""
    log_cfg = raw.get("logging", {})
    level = log_cfg.get("level", "INFO")
    log_dir = log_cfg.get("dir", "./data")
    # Each tool sets up its own logging, but we set a base level
    from alfred.curator.utils import setup_logging
    setup_logging(level=level, log_file=f"{log_dir}/alfred.log")


# --- Subcommand handlers ---

def cmd_quickstart(args: argparse.Namespace) -> None:
    from alfred.quickstart import run_quickstart
    run_quickstart()


def cmd_up(args: argparse.Namespace) -> None:
    raw = _load_unified_config(args.config)
    log_cfg = raw.get("logging", {})
    log_dir = log_cfg.get("dir", "./data")
    pid_path = Path(log_dir) / "alfred.pid"

    # Check if already running
    from alfred.daemon import check_already_running
    existing = check_already_running(pid_path)
    if existing:
        print(f"Alfred is already running (pid {existing}).")
        print("Use `alfred down` to stop it first.")
        sys.exit(1)

    live_mode = getattr(args, "live", False)
    foreground = getattr(args, "_internal_foreground", False) or getattr(args, "foreground", False) or live_mode

    if foreground:
        # Run in foreground (current behavior) — used by --foreground, --live, and --_internal-foreground
        if not live_mode:
            _setup_logging_from_config(raw)
        from alfred.orchestrator import run_all
        from alfred._data import get_skills_dir
        run_all(raw, only=args.only, skills_dir=get_skills_dir(), pid_path=pid_path, live_mode=live_mode)
    else:
        # Daemon mode: re-exec as detached background process
        from alfred.daemon import spawn_daemon
        log_file = f"{log_dir}/alfred.log"
        pid = spawn_daemon(config_path=args.config, only=args.only, log_file=log_file)
        print(f"Alfred started (pid {pid}). Logs: {log_file}")
        print("Stop with: alfred down")


def cmd_down(args: argparse.Namespace) -> None:
    raw = _load_unified_config(args.config)
    log_cfg = raw.get("logging", {})
    log_dir = log_cfg.get("dir", "./data")
    pid_path = Path(log_dir) / "alfred.pid"

    from alfred.daemon import stop_daemon
    if stop_daemon(pid_path):
        print("Alfred stopped.")
    else:
        print("Alfred is not running.")


def _scan_entity_linking_coverage(vault_path: Path) -> dict:
    """Walk the vault once, tally related_* frontmatter coverage.

    Returns a summary dict suitable for both human-readable status
    output and machine-readable JSON telemetry. Groups matter counts
    by slug so a tenant can see per-matter link density at a glance.
    """
    from collections import Counter

    try:
        import frontmatter  # only imported here so `alfred status` still
                            # works in environments where frontmatter is
                            # not installed — they just lose the breakdown.
    except Exception:
        return {"available": False}

    totals = {
        "records_with_related_matters": 0,
        "records_with_related_persons": 0,
        "records_with_related_orgs": 0,
        "records_with_related_projects": 0,
        "records_with_any_related": 0,
        "unlinked_non_entity_records": 0,
        "total_records_scanned": 0,
    }
    per_matter: Counter = Counter()
    ENTITY_TYPES = {"matter", "person", "org", "project"}

    for md_path in vault_path.rglob("*.md"):
        if ".git" in md_path.parts:
            continue
        try:
            post = frontmatter.load(md_path)
        except Exception:
            continue
        md = post.metadata
        totals["total_records_scanned"] += 1
        record_type = md.get("type")
        if isinstance(record_type, list):
            record_type = record_type[0] if record_type else None

        touched_any = False
        for field, key in [
            ("related_matters", "records_with_related_matters"),
            ("related_persons", "records_with_related_persons"),
            ("related_orgs", "records_with_related_orgs"),
            ("related_projects", "records_with_related_projects"),
        ]:
            v = md.get(field)
            if isinstance(v, list) and v:
                totals[key] += 1
                touched_any = True
                if field == "related_matters":
                    for p in v:
                        if isinstance(p, str):
                            slug = p.rsplit("/", 1)[-1].removesuffix(".md")
                            per_matter[slug] += 1

        if touched_any:
            totals["records_with_any_related"] += 1
        elif record_type not in ENTITY_TYPES:
            totals["unlinked_non_entity_records"] += 1

    return {
        "available": True,
        **totals,
        "per_matter": dict(per_matter.most_common(20)),
    }


def cmd_status(args: argparse.Namespace) -> None:
    raw = _load_unified_config(args.config)

    # --json: emit a single machine-readable blob instead of the
    # printed status. Used by `alfred status --json | jq .surveyor…`.
    as_json = bool(getattr(args, "json", False))
    payload: dict[str, Any] = {}

    if not as_json:
        print("=" * 60)
        print("ALFRED STATUS")
        print("=" * 60)

    # Daemon status
    log_cfg = raw.get("logging", {})
    log_dir = log_cfg.get("dir", "./data")
    pid_path = Path(log_dir) / "alfred.pid"
    from alfred.daemon import check_already_running
    running_pid = check_already_running(pid_path)
    if as_json:
        payload["daemon"] = {"running": bool(running_pid), "pid": running_pid}
    elif running_pid:
        print(f"Daemon: running (pid {running_pid})")
    else:
        print("Daemon: not running")

    # Curator status
    curator_info: dict = {}
    try:
        from alfred.curator.config import load_from_unified as curator_cfg
        cfg = curator_cfg(raw)
        from alfred.curator.state import StateManager
        sm = StateManager(cfg.state.path)
        sm.load()
        curator_info = {
            "processed_files": len(sm.state.processed),
            "last_run": sm.state.last_run or None,
        }
    except Exception as e:
        curator_info = {"error": str(e)}
    if as_json:
        payload["curator"] = curator_info
    else:
        print("\n--- Curator ---")
        if "error" in curator_info:
            print(f"  (unavailable: {curator_info['error']})")
        else:
            print(f"  Processed files: {curator_info['processed_files']}")
            print(f"  Last run: {curator_info['last_run'] or 'never'}")

    # Janitor status
    janitor_info: dict = {}
    try:
        from alfred.janitor.config import load_from_unified as janitor_cfg
        cfg = janitor_cfg(raw)
        from alfred.janitor.state import JanitorState
        st = JanitorState(cfg.state.path, cfg.state.max_sweep_history)
        st.load()
        files_with_issues = sum(1 for fs in st.files.values() if fs.open_issues)
        janitor_info = {
            "tracked_files": len(st.files),
            "files_with_issues": files_with_issues,
            "sweeps_recorded": len(st.sweeps),
        }
    except Exception as e:
        janitor_info = {"error": str(e)}
    if as_json:
        payload["janitor"] = janitor_info
    else:
        print("\n--- Janitor ---")
        if "error" in janitor_info:
            print(f"  (unavailable: {janitor_info['error']})")
        else:
            print(f"  Tracked files: {janitor_info['tracked_files']}")
            print(f"  Files with issues: {janitor_info['files_with_issues']}")
            print(f"  Sweeps recorded: {janitor_info['sweeps_recorded']}")

    # Distiller status
    distiller_info: dict = {}
    try:
        from alfred.distiller.config import load_from_unified as distiller_cfg
        cfg = distiller_cfg(raw)
        from alfred.distiller.state import DistillerState
        st = DistillerState(cfg.state.path, cfg.state.max_run_history)
        st.load()
        total_learns = sum(len(fs.learn_records_created) for fs in st.files.values())
        distiller_info = {
            "tracked_source_files": len(st.files),
            "learn_records_created": total_learns,
            "runs_recorded": len(st.runs),
        }
    except Exception as e:
        distiller_info = {"error": str(e)}
    if as_json:
        payload["distiller"] = distiller_info
    else:
        print("\n--- Distiller ---")
        if "error" in distiller_info:
            print(f"  (unavailable: {distiller_info['error']})")
        else:
            print(f"  Tracked source files: {distiller_info['tracked_source_files']}")
            print(f"  Learn records created: {distiller_info['learn_records_created']}")
            print(f"  Runs recorded: {distiller_info['runs_recorded']}")

    # Surveyor status + entity-linking telemetry (#26)
    surveyor_info: dict = {}
    try:
        from alfred.surveyor.config import load_from_unified as surveyor_cfg
        scfg = surveyor_cfg(raw)
        from alfred.surveyor.state import PipelineState
        st = PipelineState(scfg.state.path)
        st.load()
        surveyor_info = {
            "tracked_files": len(st.files),
            "clusters": len(st.clusters),
            "last_run": st.last_run or None,
        }
        # Walk vault frontmatter once for coverage stats. Only run on
        # --json or when vault is small enough that the full scan stays
        # fast — for a 3500-record vault this is ~2s, acceptable.
        vault_cfg = raw.get("vault", {}) or {}
        vault_path_str = vault_cfg.get("path") or os.environ.get("ALFRED_VAULT_PATH")
        if vault_path_str:
            vault_path = Path(vault_path_str).expanduser().resolve()
            if vault_path.is_dir():
                surveyor_info["entity_linking"] = _scan_entity_linking_coverage(vault_path)
    except Exception as e:
        surveyor_info = {"error": str(e)}
    if as_json:
        payload["surveyor"] = surveyor_info
    else:
        print("\n--- Surveyor ---")
        if "error" in surveyor_info:
            print(f"  (unavailable: {surveyor_info['error']})")
        else:
            print(f"  Tracked files: {surveyor_info['tracked_files']}")
            print(f"  Clusters: {surveyor_info['clusters']}")
            print(f"  Last run: {surveyor_info['last_run'] or 'never'}")
            el = surveyor_info.get("entity_linking", {})
            if el.get("available"):
                print(f"  Entity linking:")
                print(f"    Records scanned:       {el['total_records_scanned']}")
                print(f"    Any related_* field:   {el['records_with_any_related']}")
                print(f"    related_matters:       {el['records_with_related_matters']}")
                print(f"    related_persons:       {el['records_with_related_persons']}")
                print(f"    related_orgs:          {el['records_with_related_orgs']}")
                print(f"    related_projects:      {el['records_with_related_projects']}")
                print(f"    Non-entity unlinked:   {el['unlinked_non_entity_records']}")
                top = el.get("per_matter", {})
                if top:
                    print(f"  Top matters by link count:")
                    for slug, n in list(top.items())[:10]:
                        print(f"    {slug:<50} {n:>4}")

    if as_json:
        print(json.dumps(payload, indent=2, default=str))
    else:
        print()


def cmd_curator(args: argparse.Namespace) -> None:
    import asyncio
    raw = _load_unified_config(args.config)
    _setup_logging_from_config(raw)
    from alfred.curator.config import load_from_unified
    config = load_from_unified(raw)
    from alfred.curator.daemon import run
    from alfred._data import get_skills_dir
    try:
        asyncio.run(run(config, get_skills_dir()))
    except KeyboardInterrupt:
        print("\nStopped.")


def cmd_janitor(args: argparse.Namespace) -> None:
    raw = _load_unified_config(args.config)
    _setup_logging_from_config(raw)
    from alfred.janitor.config import load_from_unified
    config = load_from_unified(raw)
    from alfred._data import get_skills_dir
    skills_dir = get_skills_dir()

    from alfred.janitor import cli as jcli
    subcmd = args.janitor_cmd

    if subcmd == "scan":
        jcli.cmd_scan(config, skills_dir)
    elif subcmd == "fix":
        jcli.cmd_fix(config, skills_dir)
    elif subcmd == "watch":
        jcli.cmd_watch(config, skills_dir)
    elif subcmd == "status":
        jcli.cmd_status(config)
    elif subcmd == "history":
        jcli.cmd_history(config, limit=args.limit)
    elif subcmd == "ignore":
        jcli.cmd_ignore(config, args.file, reason=args.reason)
    else:
        print(f"Unknown janitor subcommand: {subcmd}")
        sys.exit(1)


def cmd_distiller(args: argparse.Namespace) -> None:
    raw = _load_unified_config(args.config)
    _setup_logging_from_config(raw)
    from alfred.distiller.config import load_from_unified
    config = load_from_unified(raw)
    from alfred._data import get_skills_dir
    skills_dir = get_skills_dir()

    from alfred.distiller import cli as dcli
    subcmd = args.distiller_cmd

    if subcmd == "scan":
        dcli.cmd_scan(config, skills_dir, project=args.project)
    elif subcmd == "run":
        dcli.cmd_run(config, skills_dir, project=args.project)
    elif subcmd == "watch":
        dcli.cmd_watch(config, skills_dir)
    elif subcmd == "status":
        dcli.cmd_status(config)
    elif subcmd == "history":
        dcli.cmd_history(config, limit=args.limit)
    else:
        print(f"Unknown distiller subcommand: {subcmd}")
        sys.exit(1)


def cmd_vault(args: argparse.Namespace) -> None:
    from alfred.vault.cli import handle_vault_command
    handle_vault_command(args)


def cmd_exec(args: argparse.Namespace) -> None:
    """Run a command with vault env vars set up automatically."""
    import os
    import subprocess

    from alfred.vault.mutation_log import (
        append_to_audit_log,
        cleanup_session_file,
        create_session_file,
        read_mutations,
    )
    from alfred.vault.scope import SCOPE_RULES

    raw = _load_unified_config(args.config)
    vault_cfg = raw.get("vault", {})
    vault_path = str(Path(vault_cfg.get("path", "./vault")).resolve())

    scope = args.scope
    if scope and scope not in SCOPE_RULES:
        print(f"Unknown scope: '{scope}'. Valid: {', '.join(sorted(SCOPE_RULES))}")
        sys.exit(1)

    session_file = create_session_file()

    env = {
        **os.environ,
        "ALFRED_VAULT_PATH": vault_path,
        "ALFRED_VAULT_SESSION": session_file,
    }
    if scope:
        env["ALFRED_VAULT_SCOPE"] = scope

    command = args.exec_command
    # Strip leading '--' separator if present
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        print("No command provided. Usage: alfred exec [--scope SCOPE] -- <command...>")
        cleanup_session_file(session_file)
        sys.exit(1)

    try:
        result = subprocess.run(command, env=env)
    except FileNotFoundError:
        print(f"Command not found: {command[0]}")
        cleanup_session_file(session_file)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted.")
        result = None

    # Report mutations
    mutations = read_mutations(session_file)
    total = sum(len(v) for v in mutations.values())

    # Audit log
    if total > 0:
        log_cfg = raw.get("logging", {})
        audit_path = Path(log_cfg.get("dir", "./data")) / "vault_audit.log"
        append_to_audit_log(str(audit_path), "exec", mutations, detail=" ".join(command))

    if total > 0:
        print(f"\n--- Vault mutations ({total}) ---")
        for path in mutations["files_created"]:
            print(f"  + {path}")
        for path in mutations["files_modified"]:
            print(f"  ~ {path}")
        for path in mutations["files_deleted"]:
            print(f"  - {path}")

    cleanup_session_file(session_file)
    sys.exit(result.returncode if result else 1)


def cmd_ingest(args: argparse.Namespace) -> None:
    """Split a bulk conversation export into individual inbox files."""
    from alfred.curator.ingest import ingest_file

    json_path = Path(args.file).resolve()
    if not json_path.exists():
        print(f"File not found: {json_path}")
        sys.exit(1)

    raw = _load_unified_config(args.config)
    vault_cfg = raw.get("vault", {})
    vault_path = Path(vault_cfg.get("path", "./vault")).resolve()
    curator_cfg = raw.get("curator", {})
    inbox_dir = curator_cfg.get("inbox_dir", "inbox")
    processed_dir = curator_cfg.get("processed_dir", "inbox/processed")
    inbox_path = vault_path / inbox_dir
    processed_path = vault_path / processed_dir

    try:
        count = ingest_file(
            json_path=json_path,
            inbox_path=inbox_path,
            processed_path=processed_path,
            dry_run=args.dry_run,
        )
    except (ValueError, json.JSONDecodeError) as e:
        print(f"Error: {e}")
        sys.exit(1)

    if not args.dry_run and count > 0:
        print(f"\nDone. The curator daemon will pick up the {count} files automatically.")


def cmd_process(args: argparse.Namespace) -> None:
    """Batch-process all unprocessed inbox files with progress display."""
    import asyncio
    raw = _load_unified_config(args.config)
    _setup_logging_from_config(raw)
    from alfred.curator.config import load_from_unified
    config = load_from_unified(raw)
    from alfred.curator.process import run_batch
    from alfred._data import get_skills_dir
    try:
        asyncio.run(run_batch(config, get_skills_dir(), limit=args.limit, dry_run=args.dry_run, concurrency=args.jobs))
    except KeyboardInterrupt:
        pass


def cmd_tui(args: argparse.Namespace) -> None:
    """Launch the Ink TUI dashboard (reads data/ files produced by daemons)."""
    import shutil
    import subprocess

    raw = _load_unified_config(args.config)
    log_cfg = raw.get("logging", {})
    log_dir = Path(log_cfg.get("dir", "./data")).resolve()

    # Check if daemons are running (warn only)
    pid_path = log_dir / "alfred.pid"
    from alfred.daemon import check_already_running
    if not check_already_running(pid_path):
        print("Note: Alfred daemons are not running. The TUI will show last-known state.")
        print("Start daemons with: alfred up\n")

    # Locate bundled JS
    from alfred._data import get_tui_js_path
    js_path = get_tui_js_path()
    if not js_path.exists():
        print(f"TUI bundle not found at {js_path}")
        print("Rebuild with: cd tui-ink && npm run build")
        sys.exit(1)

    # Check node is available
    node = shutil.which("node")
    if not node:
        print("Node.js is required for the Ink TUI but was not found on PATH.")
        print("Install Node.js 18+ from https://nodejs.org/")
        sys.exit(1)

    # Get version
    version = "0.2.1"
    try:
        from importlib.metadata import version as pkg_version
        version = pkg_version("alfred-vault")
    except Exception:
        pass

    env = {
        **os.environ,
        "ALFRED_DATA_DIR": str(log_dir),
        "ALFRED_VERSION": version,
    }

    try:
        subprocess.run([node, str(js_path)], env=env)
    except KeyboardInterrupt:
        pass


def cmd_temporal(args: argparse.Namespace) -> None:
    raw = _load_unified_config(args.config)
    _setup_logging_from_config(raw)

    try:
        from alfred.temporal import cli as tcli
    except ImportError:
        print("Temporal is not installed. Alfred's workflow engine won't work without it.")
        print("Install with: pip install alfred-vault[temporal]")
        sys.exit(1)

    subcmd = getattr(args, "temporal_cmd", None)
    if subcmd == "worker":
        tcli.cmd_worker(args, raw)
    elif subcmd == "run":
        tcli.cmd_run(args, raw)
    elif subcmd == "schedule":
        tcli.cmd_schedule(args, raw)
    elif subcmd == "list":
        tcli.cmd_list(args, raw)
    else:
        print("Usage: alfred temporal {worker|run|schedule|list}")
        print("Run `alfred temporal --help` for details.")
        sys.exit(1)


def cmd_surveyor(args: argparse.Namespace) -> None:
    # Dispatch to relink subcommand if specified; otherwise default to
    # running the daemon (preserves `alfred surveyor` legacy behaviour).
    subcmd = getattr(args, "surveyor_cmd", None)
    if subcmd == "relink":
        return cmd_surveyor_relink(args)
    # `run` and None both start the daemon.
    return cmd_surveyor_run(args)


def cmd_surveyor_run(args: argparse.Namespace) -> None:
    raw = _load_unified_config(args.config)
    _setup_logging_from_config(raw)

    try:
        from alfred.surveyor.config import load_from_unified
        from alfred.surveyor.daemon import Daemon
    except ImportError as e:
        print(f"Surveyor dependencies not installed: {e}")
        print("Install with: pip install alfred-vault[all]")
        sys.exit(1)

    import asyncio
    config = load_from_unified(raw)
    daemon = Daemon(config)
    try:
        asyncio.run(daemon.run())
    except KeyboardInterrupt:
        print("\nStopped.")


def cmd_surveyor_relink(args: argparse.Namespace) -> None:
    """One-off entity-link pass across ALL clusters + noise points.

    Rebuilds cluster membership from the current Milvus embeddings, then
    runs the same entity-linking logic the daemon would run — but across
    every semantic cluster instead of only the `changed_semantic` subset.

    No re-embedding, no re-clustering (in the sense of recomputing labels),
    no LLM calls. Pure numpy cosine + VaultWriter frontmatter appends.
    Existing links are preserved — the writer appends new entries to the
    related_* lists, it never removes.

    Intended for one-time use after surveyor v2 rollout to densify link
    coverage on a vault whose state shows most clusters unlabeled because
    only the `changed` subset ever got processed.
    """
    raw = _load_unified_config(args.config)
    _setup_logging_from_config(raw)

    try:
        from alfred.surveyor.config import load_from_unified
        from alfred.surveyor.daemon import Daemon
        from alfred.surveyor.parser import parse_file
    except ImportError as e:
        print(f"Surveyor dependencies not installed: {e}")
        sys.exit(1)

    import asyncio

    async def _run() -> int:
        config = load_from_unified(raw)
        daemon = Daemon(config)
        daemon.state.load()

        # Pull every embedding currently in Milvus.
        embedding_data = daemon.embedder.get_all_embeddings()
        if embedding_data is None:
            print("No embeddings found — run `alfred surveyor run` first to embed the vault.")
            return 1
        paths, vectors = embedding_data
        print(f"Loaded {len(paths)} embeddings from Milvus.")

        # Parse every record so we know record_type for each path. We need
        # this to tell entities from regulars in the link pass.
        records = {}
        for rel in paths:
            try:
                records[rel] = parse_file(config.vault.path, rel)
            except Exception:
                continue
        print(f"Parsed {len(records)} records.")

        # Reconstruct cluster membership purely from embeddings — we can't
        # rely on state.files[rel].semantic_cluster_id alone because fresh
        # tenants or post-migration vaults may not have those set. So run
        # the clusterer against the current embeddings. HDBSCAN is cheap
        # (~1-3s on 3500 vectors) and we need a valid cluster map anyway.
        result = daemon.clusterer.run(paths, vectors, records)
        cluster_members: dict[int, list[str]] = {}
        for p, cid in result.semantic.items():
            if cid == -1:
                continue
            cluster_members.setdefault(cid, []).append(p)
        noise_paths = [p for p, cid in result.semantic.items() if cid == -1]

        total_clusters = len(cluster_members)
        print(
            f"Clustering: {total_clusters} semantic clusters, "
            f"{len(noise_paths)} noise points."
        )

        if getattr(args, "dry_run", False):
            # Tally how many would be touched without actually writing.
            from alfred.surveyor.labeler import ENTITY_RECORD_TYPES
            with_entities = 0
            with_regulars = 0
            for cid, members in cluster_members.items():
                has_e = any(
                    records[m].record_type in ENTITY_RECORD_TYPES
                    for m in members if m in records
                )
                has_r = any(
                    records[m].record_type not in ENTITY_RECORD_TYPES
                    for m in members if m in records
                )
                if has_e: with_entities += 1
                if has_r and has_e: with_regulars += 1
            print(
                f"[dry-run] {with_entities} clusters contain >=1 entity record; "
                f"{with_regulars} of those would have links written."
            )
            return 0

        # Optional threshold override: some vaults benefit from 0.65 over
        # the default 0.75, especially when matter records are short
        # (structured frontmatter + one-paragraph description) vs.
        # long-form events + transcripts they should link to.
        if getattr(args, "threshold", None) is not None:
            daemon.cfg.entity_link.threshold = float(args.threshold)
            print(f"Threshold override: {daemon.cfg.entity_link.threshold}")

        # Process ALL semantic clusters (not just changed_semantic).
        all_cluster_ids = set(cluster_members.keys())
        print(f"Running entity linking across {total_clusters} clusters…")
        daemon._link_entities_in_clusters(
            all_cluster_ids, cluster_members, records, paths, vectors,
        )

        # And every noise point.
        if noise_paths:
            print(f"Running noise-point linking across {len(noise_paths)} records…")
            daemon._link_noise_points_to_entities(
                noise_paths, records, paths, vectors,
            )

        # Full-vault entity backfill. This is the critical densification
        # pass: for each existing entity (not just new ones from diff.new
        # like #25 does in steady state), walk every non-entity record in
        # the vault and link above threshold regardless of cluster. Catches
        # the common case where a matter M is topically close to a cluster
        # C it isn't actually a member of — cluster-scoped linking misses
        # that relationship forever.
        if not getattr(args, "no_backfill", False):
            from alfred.surveyor.labeler import ENTITY_RECORD_TYPES
            all_entity_paths = [
                p for p, r in records.items()
                if r.record_type in ENTITY_RECORD_TYPES
            ]
            by_type: dict[str, int] = {}
            for p in all_entity_paths:
                t = records[p].record_type
                by_type[t] = by_type.get(t, 0) + 1
            print(
                f"Running full-vault backfill across {len(all_entity_paths)} entities "
                f"({', '.join(f'{v} {k}s' for k, v in sorted(by_type.items()))})…"
            )
            daemon._backfill_new_entities(
                all_entity_paths, records, paths, vectors,
            )

        # Persist updated state (the writer marked frontmatter writes in
        # state.pending_writes; save so the watcher ignores them).
        daemon.state.save()

        print("\nDone. Check `alfred status --json | jq .surveyor.entity_linking`.")
        return 0

    try:
        rc = asyncio.run(_run())
        sys.exit(rc)
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)


# --- Argument parser ---

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="alfred",
        description="Alfred — unified vault operations suite",
    )
    parser.add_argument(
        "--config", default="config.yaml",
        help="Path to config.yaml (default: config.yaml)",
    )
    sub = parser.add_subparsers(dest="command")

    # quickstart
    sub.add_parser("quickstart", help="Interactive setup wizard")

    # up
    up_parser = sub.add_parser("up", help="Start all daemons (background by default)")
    up_parser.add_argument(
        "--only", type=str, default=None,
        help="Comma-separated list of tools to start (e.g. curator,janitor)",
    )
    up_parser.add_argument(
        "--foreground", action="store_true", default=False,
        help="Stay attached to the terminal (for development/debugging)",
    )
    up_parser.add_argument(
        "--_internal-foreground", dest="_internal_foreground",
        action="store_true", default=False,
        help=argparse.SUPPRESS,
    )
    up_parser.add_argument(
        "--live", action="store_true", default=False,
        help="Show live TUI dashboard (implies --foreground)",
    )

    # down
    sub.add_parser("down", help="Stop the background daemon")

    # status
    status_p = sub.add_parser("status", help="Show status from all tools")
    status_p.add_argument(
        "--json", action="store_true", default=False,
        help="Emit a machine-readable JSON blob instead of printed output.",
    )

    # curator
    sub.add_parser("curator", help="Start curator daemon")

    # janitor
    jan = sub.add_parser("janitor", help="Vault janitor subcommands")
    jan_sub = jan.add_subparsers(dest="janitor_cmd")
    jan_sub.add_parser("scan", help="Run structural scan")
    jan_sub.add_parser("fix", help="Scan + agent fix")
    jan_sub.add_parser("watch", help="Daemon mode")
    jan_sub.add_parser("status", help="Show sweep status")
    jan_hist = jan_sub.add_parser("history", help="Show sweep history")
    jan_hist.add_argument("--limit", type=int, default=10)
    jan_ignore = jan_sub.add_parser("ignore", help="Ignore a file")
    jan_ignore.add_argument("file", help="Relative file path to ignore")
    jan_ignore.add_argument("--reason", default="", help="Reason for ignoring")

    # distiller
    dist = sub.add_parser("distiller", help="Vault distiller subcommands")
    dist_sub = dist.add_subparsers(dest="distiller_cmd")
    dist_scan = dist_sub.add_parser("scan", help="Scan for candidates")
    dist_scan.add_argument("--project", "-p", default=None, help="Filter by project name")
    dist_run = dist_sub.add_parser("run", help="Scan + extract")
    dist_run.add_argument("--project", "-p", default=None, help="Filter by project name")
    dist_sub.add_parser("watch", help="Daemon mode")
    dist_sub.add_parser("status", help="Show extraction status")
    dist_hist = dist_sub.add_parser("history", help="Show run history")
    dist_hist.add_argument("--limit", type=int, default=10)

    # vault
    from alfred.vault.cli import build_vault_parser
    build_vault_parser(sub)

    # exec
    exec_parser = sub.add_parser(
        "exec",
        help="Run a command with vault env vars (ALFRED_VAULT_PATH, etc.)",
    )
    exec_parser.add_argument(
        "--scope", default=None,
        help="Agent scope: curator, janitor, distiller (default: unrestricted)",
    )
    exec_parser.add_argument(
        "exec_command", nargs=argparse.REMAINDER,
        help="Command to run (use -- before the command)",
    )

    # ingest
    ingest_parser = sub.add_parser(
        "ingest",
        help="Split a bulk conversation export (ChatGPT/Anthropic) into individual inbox files",
    )
    ingest_parser.add_argument(
        "file",
        help="Path to a conversations JSON export",
    )
    ingest_parser.add_argument(
        "--dry-run", action="store_true", default=False,
        help="Show what would be created without writing files",
    )

    # process
    process_parser = sub.add_parser(
        "process",
        help="Batch-process all unprocessed inbox files with progress display",
    )
    process_parser.add_argument(
        "--limit", "-n", type=int, default=None,
        help="Process only N files (for testing)",
    )
    process_parser.add_argument(
        "--dry-run", action="store_true", default=False,
        help="Show what would be processed without running",
    )
    process_parser.add_argument(
        "--jobs", "-j", type=int, default=4,
        help="Number of concurrent workers (default: 4)",
    )

    # temporal
    temp = sub.add_parser("temporal", help="Temporal workflow engine (requires: pip install alfred-vault[temporal])")
    temp_sub = temp.add_subparsers(dest="temporal_cmd")
    temp_sub.add_parser("worker", help="Start the Temporal worker")
    temp_run = temp_sub.add_parser("run", help="Trigger a workflow")
    temp_run.add_argument("workflow_name")
    temp_run.add_argument("--params", default=None, help="JSON params")
    temp_run.add_argument("--id", default=None, help="Workflow ID")
    temp_sched = temp_sub.add_parser("schedule", help="Manage schedules")
    temp_sched_sub = temp_sched.add_subparsers(dest="schedule_cmd")
    temp_sched_register = temp_sched_sub.add_parser("register", help="Register from file")
    temp_sched_register.add_argument("file")
    temp_sched_sub.add_parser("list", help="List schedules")
    temp_sub.add_parser("list", help="List discovered workflows")

    # surveyor
    surv = sub.add_parser("surveyor", help="Surveyor pipeline operations")
    surv_sub = surv.add_subparsers(dest="surveyor_cmd")
    surv_sub.add_parser("run", help="Start surveyor daemon (same as bare `surveyor`)")
    surv_relink = surv_sub.add_parser(
        "relink",
        help="One-off re-run of entity linking across ALL semantic clusters + noise points "
             "+ full-vault entity backfill, using current embeddings. Does NOT re-embed, "
             "re-cluster, or re-label — only writes related_* frontmatter. Preserves "
             "existing links (writer appends).",
    )
    surv_relink.add_argument(
        "--dry-run", action="store_true", default=False,
        help="Scan + report, don't write frontmatter",
    )
    surv_relink.add_argument(
        "--no-backfill", action="store_true", default=False,
        help="Skip the full-vault backfill pass (only walk clusters + noise)",
    )
    surv_relink.add_argument(
        "--threshold", type=float, default=None,
        help="Override entity_link.threshold for this run only (e.g. 0.65 for denser links)",
    )

    # tui
    sub.add_parser("tui", help="Launch interactive Ink TUI dashboard (requires Node.js)")

    return parser


def main() -> None:
    _load_env_file()

    parser = build_parser()
    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(0)

    handlers = {
        "quickstart": cmd_quickstart,
        "up": cmd_up,
        "down": cmd_down,
        "status": cmd_status,
        "curator": cmd_curator,
        "janitor": cmd_janitor,
        "distiller": cmd_distiller,
        "vault": cmd_vault,
        "exec": cmd_exec,
        "ingest": cmd_ingest,
        "process": cmd_process,
        "temporal": cmd_temporal,
        "surveyor": cmd_surveyor,
        "tui": cmd_tui,
    }

    handler = handlers.get(args.command)
    if handler:
        handler(args)
    else:
        parser.print_help()
        sys.exit(1)
