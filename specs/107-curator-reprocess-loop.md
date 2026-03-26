# Issue #107: Curator processed files stay in inbox — reprocess loop

## Root Cause

Two bugs combine to create an infinite reprocess loop:

### Bug 1: `openclaw-wrapper` exits non-zero on soft failures (fixed here)

The wrapper (`packages/openclaw/openclaw-wrapper`) calls `sys.exit(1)` when:
- The agent session times out (no response after 600s polling)
- `sessions_spawn` returns but `childSessionKey` is missing from the response

These are **soft failures** — the agent may have done useful work (created vault
files) even without returning a final response. A non-zero exit code causes the
curator pipeline to treat the entire invocation as broken, which can cascade into
exceptions that skip `mark_processed`.

**Fix:** Changed these paths to exit 0 with a JSON error payload on stdout, so the
daemon pipeline handles them gracefully and still marks the file as processed.

### Bug 2: `daemon.py` has no finally-block for `mark_processed` (upstream alfred repo)

In `src/alfred/curator/daemon.py`, the `_process_file` function calls
`mark_processed` at line 169 — but this line is reached only if no exception is
thrown during pipeline execution. If `run_pipeline` or any preceding code raises
(e.g., disk full, network error, unexpected LLM response), the exception propagates
to the daemon loop's `except Exception` handler (lines 218/253), which logs the
error but never calls `mark_processed`. The file stays in inbox and gets picked up
again on the next scan.

**Required upstream fix** in `ssdavidai/alfred` at `src/alfred/curator/daemon.py`:

```python
async def _process_file(
    inbox_file: Path,
    backend: BaseBackend,
    skill_text: str,
    config: CuratorConfig,
    state_mgr: StateManager,
) -> None:
    """Process a single inbox file through the full pipeline."""
    filename = inbox_file.name
    log.info("daemon.processing", file=filename)

    files_created: list[str] = []
    files_modified: list[str] = []
    pipeline_success = False

    try:
        # ... existing processing code ...

        pipeline_success = True  # (or check pipeline_result.success / result.success)
    except Exception:
        log.exception("daemon.process_file_error", file=filename)
    finally:
        # ALWAYS mark processed — even on failure — to prevent reprocess loops.
        # A file that fails processing should not block the inbox forever.
        if inbox_file.exists():
            mark_processed(inbox_file, config.vault.processed_path)

        # Update state (record the attempt even if it failed)
        state_mgr.state.mark_processed(
            filename=filename,
            inbox_path=str(inbox_file),
            files_created=files_created,
            files_modified=files_modified,
            backend_used=config.agent.backend,
        )
        state_mgr.save()

    log.info(
        "daemon.completed",
        file=filename,
        success=pipeline_success,
        created=len(files_created),
        modified=len(files_modified),
    )
```

The key change: wrap the processing body in try/finally so `mark_processed` and
`state_mgr.save()` always run, and move `files_created`/`files_modified`
declarations before the try block so they're available in the finally block.
