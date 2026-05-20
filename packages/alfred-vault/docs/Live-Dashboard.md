# Live Dashboard

Alfred provides two dashboard options for real-time visibility into workers:

| Dashboard | Command | Runtime | Best for |
|-----------|---------|---------|----------|
| **Ink TUI** | `alfred tui` | Node.js 18+ | Standalone monitoring, rich visuals |
| **Textual TUI** | `alfred up --live` | Python (built-in) | Integrated mode, no extra deps |

Both read the same `data/` files (logs, state, audit log, workers.json) and show the same information — they just render differently.

---

## Ink TUI (`alfred tui`)

A React Ink terminal dashboard with sparklines, progress bars, pipeline visualizations, and hex color theming. Runs as a separate Node.js process.

```bash
alfred tui
```

Requires Node.js 18+ on PATH. The bundled JS ships inside the pip wheel — no `npm install` needed.

### Dashboard Screen

```
 alfred v0.2.2  ██▓░ 4/4   ⚠ 0  ✕ 0  ⏱ 23m   ▁▂▃▅▇▅▃▁ 8/min
 ────────────────────────────────────────────────────────────────────
 ◐ curator    Processing inbox/mtg.md        ████░░░░ 2/4   ⚡12  ⚠0
 ● janitor    Idle                                          ⚡ 3  ⚠0
 ● distiller  Idle                                          ⚡ 0  ⚠0
 ◐ surveyor   Embedding diff                 ██░░░░░░ 1/4   ⚡ 5  ⚠0
 ────────────────────────────────────────────────────────────────────
 │ 14:23  curator    ✓ Created person/Alice Johnson
 │ 14:22  curator    → Stage 3 done — linked 4 entities
 ▌ 14:21  janitor    ⚠ Broken link in project/X.md
 │ 14:20  surveyor     Embedded meeting-notes.md
 ↑↓ select  ⏎ detail  l logs  m mutations  ? actions  q quit
```

### Header

- **Health blocks**: One per tool (`█` working, `▓` idle, `▒` degraded, `░` stopped), colored per tool
- **Aggregate counts**: Workers up, warnings, errors, uptime
- **Activity sparkline**: Rolling 10-minute event rate graph

### Worker Lines

- Tool name colored by tool identity
- Inline progress bar (`████░░░░ 2/4`) when in a pipeline stage
- `⚡` LLM call count, `⚠` error/warning count

### Activity Stream

Merged chronological feed from all tools plus vault mutations. Each line has a severity gutter:
- `│` for info and success events
- `▌` for warnings and errors

### Worker Detail Screen

Press Enter on a worker to see the expanded view:

```
 ◐ CURATOR — Processing inbox/meeting-notes.md            pid 12345
   ✓ Extract → ✓ Resolve → ◐ Enrich → ○ Write
 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
   LLM Calls   12   ▁▂▃▅▇▃▁▁       Tokens   48.2k  ▁▁▃▅▇▅▃▁
   Restarts     0                    Errors       1
   Processed    6                    Warnings     0
 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
 │ 14:23  ✓ Created person/Alice Johnson
 │ 14:22  → Stage 3 done — linked 4 entities
```

- **Pipeline visualization**: Per-tool stage labels with done/active/pending indicators
- **Stats grid**: 2-column layout with sparklines for LLM calls and activity
- **Filtered feed**: Events for this tool only

### Mutations Screen

Press `m` for the mutations view:

```
 Mutations — 23 total                   5m: 8  30m: 15  older: 0
 ────────────────────────────────────────────────────────────────────
  14:23  curator    + person       Alice Johnson
  14:22  curator    ~ note         2024 meeting notes
  14:20  janitor    ~ project      X
```

- Parses vault paths into record type + name
- Record types colored by category
- Time-grouped counts in header

### Logs Screen

Press `l` for the filtered log viewer:
- Filter by tool (keys `0`-`4`)
- Filter by severity (key `f` to cycle)
- Scroll with arrows, Page Up/Down, `g` to jump to top

### Keyboard Shortcuts

| Key | Dashboard | Detail | Logs | Mutations |
|-----|-----------|--------|------|-----------|
| `↑↓` | Select worker | Scroll | Scroll | Scroll |
| `⏎` | Open detail | — | — | — |
| `Esc` | — | Back | Back | Back |
| `l` | Logs view | — | — | — |
| `m` | Mutations view | — | — | — |
| `r` | — | Restart worker | — | — |
| `0`-`4` | — | — | Filter tool | — |
| `f` | — | — | Filter severity | — |
| `g` | — | — | Jump to top | — |
| `?` | Actions menu | Actions menu | — | — |
| `q` | Quit | Quit | Quit | Quit |

### Actions Menu

Press `?` to open the command palette:
- Restart a worker
- Trigger curator (process inbox)
- Force janitor sweep
- Force distiller extraction
- Refresh stats

### Visual Features

| Feature | Description |
|---------|-------------|
| **Sparklines** | `▁▂▃▅▇▅▃▁` — rolling 10-min window, sampled every 10s |
| **Progress bars** | `████░░░░` — inline stage progress |
| **Pipeline stages** | `✓ Extract → ◐ Enrich → ○ Write` — per-tool stage names |
| **Health blocks** | `██▓░` — one block per tool in header |
| **Severity gutters** | `│` info/success, `▌` warning/error |
| **Hex colors** | Rich color theming for tools, severities, record types |

### Time Series

The dashboard samples metrics every 10 seconds and maintains a rolling 60-sample window (~10 minutes). Sparklines become meaningful after about 2 minutes of activity. Tracked metrics:
- Activity rate (events per interval across all tools)
- Per-tool activity
- LLM call rate
- Error rate
- Mutation rate

---

## Textual TUI (`alfred up --live`)

A Python Textual dashboard that runs integrated with the daemon orchestrator. No extra runtime needed.

```bash
alfred up --live
```

### Layout

2x2 grid of per-worker feed panels:

```
+-- Curator --- * healthy -- pid 1234 --------++-- Janitor --- @ degraded -- pid 1235 --------+
| Processing inbox/meeting-notes.md            || Starting fix sweep #5                         |
|                                              ||                                               |
| 14:23:01  v Pipeline complete - 3 entities   || 14:22:45  Scan found 12 issues                |
| 14:22:58  Stage 4 done - enriched 2 entities || 14:22:40  Autofix - 8 fixed, 2 flagged        |
|                            12 calls  45k chars||                           8 calls  23k chars   |
+----------------------------------------------++-----------------------------------------------+
```

Each panel shows: tool name, health indicator, PID, current step, event feed, and LLM usage.

### Health Indicators

| Indicator | Meaning |
|-----------|---------|
| * healthy | Running, no errors |
| @ degraded | Running, 1-4 errors |
| ! failing | Running, 5+ errors |
| * stopped | Process exited |
| * restarting | Waiting to restart |
| o pending | Not yet started |

---

## Event Interpretation

Both dashboards interpret ~60+ structlog events into human-readable messages. Examples:

### Curator Events

| Raw Event | Dashboard Message |
|-----------|------------------|
| `daemon.processing file=notes.md` | Processing inbox/notes.md |
| `pipeline.s1_complete entities_found=3` | Stage 1 done - 3 entities found |
| `pipeline.s2_entity_created entity=person/John` | Created person/John |
| `pipeline.complete entities_resolved=3` | Pipeline complete - 3 entities |
| `daemon.no_changes` | (warning) Agent produced no vault changes |

### Janitor Events

| Raw Event | Dashboard Message |
|-----------|------------------|
| `sweep.start sweep_id=5 fix_mode=true` | Starting fix sweep #5 |
| `scanner.scan_complete issues=12` | Scan found 12 issues |
| `autofix.complete fixed=8 flagged=2` | Autofix - 8 fixed, 2 flagged |
| `sweep.complete issues=12 fixed=10` | Sweep done - 10/12 issues fixed |

### Distiller Events

| Raw Event | Dashboard Message |
|-----------|------------------|
| `extraction.start run_id=3` | Starting extraction run #3 |
| `pipeline.s1_complete source=src.md learnings=4` | Extracted 4 learnings from src.md |
| `pipeline.s2_complete candidates=8 after_dedup=5` | Dedup - 8 candidates, 5 unique |
| `extraction.complete records_created=5` | Run complete - 5 records created |

### Surveyor Events

| Raw Event | Dashboard Message |
|-----------|------------------|
| `embedder.diff_processed upserted=15 deleted=2` | Embedded 15 files, removed 2 |
| `clusterer.complete semantic_clusters=8 changed=3` | Found 8 clusters (3 changed) |
| `daemon.labeling_complete clusters_processed=3` | Labeled 3 clusters |
| `writer.tags_written path=project/X tags=[...]` | Tagged project/X with [...] |

## Silent Failure Detection

Both dashboards flag anomalous "successes" that may indicate problems:

- Curator pipeline "complete" with 0 entities created
- Curator Stage 1 found 0 entities (warning)
- File marked processed but no vault changes
- Janitor fixed less than half of detected issues
- Distiller run complete with 0 records created
- Distiller manifest file missing (LLM didn't write it)
