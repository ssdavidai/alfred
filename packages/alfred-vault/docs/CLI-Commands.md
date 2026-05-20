# CLI Commands

All commands accept `--config path/to/config.yaml` (default: `config.yaml` in current directory).

## Daemon Management

| Command | Description |
|---------|-------------|
| `alfred up` | Start all daemons in background |
| `alfred up --foreground` | Start attached to terminal (for dev/debug) |
| `alfred up --live` | Start with real-time TUI dashboard (Textual) |
| `alfred up --only curator,janitor` | Start only specific tools |
| `alfred down` | Stop all background daemons |
| `alfred status` | Show per-tool status overview |
| `alfred tui` | Launch standalone Ink TUI dashboard (requires Node.js) |

### How `alfred up` Works

`alfred up` (without flags) daemonizes by re-executing itself with an internal flag. It writes a PID file to `data/alfred.pid` and detaches from the terminal.

`alfred up --foreground` stays attached and prints log output to the terminal. Useful for development and debugging.

`alfred up --live` starts the [Live Dashboard](Live-Dashboard) — a Textual TUI showing a 2x2 grid of per-worker interpreted feeds with health indicators, pipeline step tracking, and LLM usage stats.

`alfred tui` launches the standalone [Ink TUI dashboard](Live-Dashboard#ink-tui) — a Node.js-based terminal UI with sparklines, inline progress bars, pipeline visualizations, and hex color theming. It reads the same `data/` files as `--live` but runs as a separate process. Requires Node.js 18+.

`alfred down` creates a sentinel file (`data/alfred.stop`) and sends SIGTERM. The orchestrator catches the signal and gracefully shuts down all workers.

## Batch Processing

| Command | Description |
|---------|-------------|
| `alfred process` | Batch-process all inbox files |
| `alfred process -j 8` | Use 8 parallel workers (default: 4) |
| `alfred process -n 10` | Process only first 10 files |
| `alfred process --dry-run` | Preview what would be processed |

Batch processing uses a Rich progress display and runs multiple curator pipelines in parallel. Useful for initial vault population or catching up on a large inbox.

## Bulk Import

| Command | Description |
|---------|-------------|
| `alfred ingest <file>` | Split ChatGPT/Anthropic JSON export into inbox files |
| `alfred ingest <file> --dry-run` | Preview without writing |

Supports conversation export formats from ChatGPT and Anthropic. Each conversation becomes a separate inbox file.

## Individual Tool Commands

### Curator

| Command | Description |
|---------|-------------|
| `alfred curator` | Run curator daemon in foreground |

The curator also runs as part of `alfred up`. For standalone use, it watches the inbox and processes files as they appear.

### Janitor

| Command | Description |
|---------|-------------|
| `alfred janitor scan` | One-shot structural scan, print report |
| `alfred janitor fix` | Scan + apply fixes (with agent for deep issues) |
| `alfred janitor watch` | Run periodic sweep daemon |

`scan` is read-only and fast — it just reports issues. `fix` actually modifies files. `watch` runs both light and deep sweeps on configurable intervals.

### Distiller

| Command | Description |
|---------|-------------|
| `alfred distiller scan` | Find extraction candidates and print scores |
| `alfred distiller run` | Scan + extract knowledge records |
| `alfred distiller watch` | Run periodic extraction daemon |

`scan` analyzes vault records for keyword signals indicating latent knowledge. `run` processes the top candidates through the full extraction pipeline.

### Surveyor

| Command | Description |
|---------|-------------|
| `alfred surveyor` | Run full embed/cluster/label/write pipeline |

The surveyor runs its 4-stage pipeline once and exits. As part of `alfred up`, it runs as a daemon with configurable intervals.

## Temporal (Kinetic Layer)

Requires `pip install alfred-vault[temporal]` and a running Temporal server.

| Command | Description |
|---------|-------------|
| `alfred temporal worker` | Start the workflow worker (connects to Temporal, runs workflows) |
| `alfred temporal run <workflow>` | Trigger a one-off workflow execution |
| `alfred temporal run <workflow> --params '{"key": "value"}'` | Trigger with JSON parameters |
| `alfred temporal run <workflow> --id my-run-id` | Trigger with a custom workflow ID |
| `alfred temporal schedule register <file>` | Register cron schedules from a Python file |
| `alfred temporal schedule list` | List registered schedules |
| `alfred temporal list` | List discovered workflow definitions |

The worker discovers workflows from directories configured in `temporal.workflow_dirs` plus bundled examples. See [Kinetic Layer](Kinetic-Layer) for details on writing workflows and schedules.

## Vault Operations

Direct CRUD operations on vault records:

| Command | Description |
|---------|-------------|
| `alfred vault create <type> <name>` | Create a new record |
| `alfred vault read <path>` | Read a record (JSON output) |
| `alfred vault edit <path>` | Edit record fields |
| `alfred vault list [type]` | List records, optionally filtered by type |
| `alfred vault search --grep <pattern>` | Search vault content |
| `alfred vault move <old> <new>` | Move/rename a record |
| `alfred vault delete <path>` | Delete a record |
| `alfred vault context` | Print vault summary (used by agents) |

### Vault Create Options

```bash
alfred vault create project "My Project" \
  --set status=active \
  --set 'client="[[org/Acme Corp]]"' \
  --body-stdin < body.md
```

- `--set key=value` — set frontmatter fields
- `--body-stdin` — read body content from stdin
- Without `--body-stdin`, the template body (with base-view embeds) is used automatically

### Vault Edit Options

```bash
alfred vault edit project/My\ Project.md \
  --set status=completed \
  --append related='[[project/Other]]' \
  --body-append "## New Section\nContent here"
```

- `--set key=value` — overwrite a field
- `--append key=value` — append to a list field
- `--body-append text` — append text to the body

## Exec

Run external commands with vault environment variables injected:

```bash
alfred exec -- <command>               # injects ALFRED_VAULT_PATH
alfred exec --scope curator -- <cmd>   # also sets ALFRED_VAULT_SCOPE
```

Environment variables injected:
- `ALFRED_VAULT_PATH` — absolute path to the vault
- `ALFRED_VAULT_SCOPE` — tool scope (restricts which operations are allowed)
- `ALFRED_VAULT_SESSION` — path to mutation log session file

## Quickstart

```bash
alfred quickstart
```

Interactive wizard that scaffolds a new vault and writes configuration. See [Installation](Installation) for details.
