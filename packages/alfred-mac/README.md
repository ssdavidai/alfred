# Alfred Black for macOS

A small, always-on menu-bar app that keeps a principal's **Claude Cowork**
sessions inside the one-Alfred continuity layer of their tenant, in both
directions — without a terminal, a launchd agent, or an egress rule.

The rule it exists to honour: *Alfred is one memory across every surface.*
A conversation in Cowork is as much a conversation with Alfred as one on
Slack, and the next turn on either side must already know about it.

## What it does

| | |
|---|---|
| **Pair** | Enter the tenant URL and the dashboard login. The app signs in, mints a dedicated API key (visible under *Study › API keys*, revocable there), stores it in the login Keychain, and forgets the password. |
| **Read side** | Every 30 s it renders the principal's recent journal (Slack, Telegram, Cowork, …) into `~/Alfred/continuity.md` as the same `[ALFRED-CONTINUITY — authoritative]` block the Hermes plugin injects. A Cowork plugin (staged by the app) reads that file on `SessionStart`, `UserPromptSubmit` and `PostCompact`. |
| **Write side** | Every 60 s it mirrors new Cowork turns from the local session transcripts into the journal (`channel: cowork`), binding each new session to the owner. Only turns from the last 48 h are ever mirrored: the journal stamps `ts` server-side, so history mirrored late would land as "now". |
| **MCP** | Registers itself in Claude Desktop (`mcpServers.alfred-continuity`, `--mcp`) exposing `alfred_continuity_recent` / `alfred_continuity_note` / `alfred_continuity_bind` — Cowork can read and write continuity directly, through the app, over a loopback stdio pipe. |
| **Always on** | Registers as a login item (`SMAppService`). Menu-bar only (`LSUIElement`), no Dock icon. On every launch it re-points the MCP registration and the login item at its current bundle path, so moving it to `/Applications` needs nothing. |

Everything speaks to the tenant through the dashboard's own API proxy
(`https://api.<domain>/api/v1/…`, `Authorization: Bearer alf_…`). ctrl-api
remains the sole writer of the journal; the app is a client.

## Layout

```
packages/alfred-mac/
├── Package.swift                 SwiftPM, macOS 13+, no dependencies
├── Sources/AlfredBlack/
│   ├── App.swift                 entry point, AppState, menu bar, CLI modes
│   ├── Views.swift               onboarding + status (SwiftUI)
│   ├── Theme.swift               design-system tokens + font registration
│   ├── Tenant.swift              login / API key / journal client
│   ├── Continuity.swift          renders continuity.md + folder CLAUDE.md
│   ├── Pusher.swift              transcript → journal mirror
│   ├── Cowork.swift              plugin staging, MCP registration, status
│   ├── MCPServer.swift           newline-delimited JSON-RPC (stdio)
│   ├── Store.swift / Keychain.swift
│   └── Resources/
│       ├── Fonts/                Playfair Display, EB Garamond, JetBrains Mono (OFL)
│       └── CoworkPlugin/         the alfred-continuity plugin (hooks + skill)
├── Support/Info.plist, AppIcon.icns
└── scripts/build-app.sh          → dist/Alfred Black.app + dist/AlfredBlack-<version>.dmg
```

## Build

Command Line Tools are enough (no Xcode.app required).

```bash
cd packages/alfred-mac
scripts/build-app.sh 2026.09.03
```

Produces `dist/Alfred Black.app` and `dist/AlfredBlack-2026.09.03.dmg`.

### Command-line modes (for verification and scripting)

```bash
"dist/Alfred Black.app/Contents/MacOS/AlfredBlack" --pair https://<domain> <email> <password>
"dist/Alfred Black.app/Contents/MacOS/AlfredBlack" --tick       # one render + one mirror pass
"dist/Alfred Black.app/Contents/MacOS/AlfredBlack" --status
"dist/Alfred Black.app/Contents/MacOS/AlfredBlack" --snapshot /path/out.png   # render the UI to a file
```

## Signing and distribution

The build is **ad-hoc signed** (`codesign --sign -`). It runs on the Mac it
was built on; on another Mac, Gatekeeper will refuse a double-click the
first time — right-click › *Open* once, or clear the quarantine flag.
Proper distribution needs a Developer ID certificate and notarization;
`build-app.sh` is the place to add them (`codesign --sign "Developer ID
Application: …"`, then `notarytool submit` + `stapler`).

## Files it writes on the Mac

| path | purpose |
|---|---|
| `~/Alfred/continuity.md` | the rendered continuity block (Cowork's working folder) |
| `~/Alfred/CLAUDE.md` | folder instructions for a Cowork session opened in `~/Alfred` |
| `~/Library/Application Support/Alfred Black/pairing.json` | domain, email, API-key id (no secret) |
| `~/Library/Application Support/Alfred Black/state.json` | mirrored-turn ids, bound sessions, last run |
| `~/Library/Application Support/Alfred Black/cowork-plugin/` | the staged Cowork plugin |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers.alfred-continuity` (other keys preserved) |
| login Keychain, service `black.alfred.mac` | the API key |

Sign out removes the pairing, the Keychain item and the MCP registration;
the API key itself is revoked from *Study › API keys* on the tenant.

## Design

Built on the Alfred Black design system (`design-system/`): paper and wool,
ink, one brass accent, sharp corners, hairline rules, Playfair Display for
display, EB Garamond for prose, JetBrains Mono for machine truth. No emoji.
Calm copy.
