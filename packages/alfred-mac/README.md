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
| **Pair** | Enter the tenant URL and the dashboard login. The app signs in, mints a dedicated API key (visible under *Study › API keys*, revocable there), stores it in a 0600 file of its own, and forgets the password. |
| **Read side** | Every 30 s it renders the principal's recent journal (Slack, Telegram, Cowork, …) into `~/Alfred/continuity.md` as the same `[ALFRED-CONTINUITY — authoritative]` block the Hermes plugin injects. A Cowork plugin (staged by the app) reads that file on `SessionStart`, `UserPromptSubmit` and `PostCompact`. |
| **Write side** | Every 60 s it mirrors new Cowork turns from the local session transcripts into the journal (`channel: cowork`), binding each new session to the owner. Only turns from the last 48 h are ever mirrored: the journal stamps `ts` server-side, so history mirrored late would land as "now". |
| **Set up Cowork** | One action: registers the MCP server, exports the hooks plugin as `Alfred Continuity.plugin` into Downloads (a zip with `.claude-plugin/plugin.json` at its root — the file Claude Desktop's plugin upload accepts), selects it in Finder and opens Claude. Installing a plugin is Claude's own UI step; there is no deep link or CLI for it. Upload it from **Cowork's** Plugins panel: a Cowork session loads only plugins installed there (an upload from the Code tab installs a local plugin that only Claude Code sessions see). The hooks act only inside Cowork sessions (`ALFRED_CONTINUITY_EVERYWHERE=1` opts others in). |
| **MCP** | Registers itself in Claude Desktop (`mcpServers.alfred-continuity`, `--mcp`) exposing `alfred_continuity_recent` / `alfred_continuity_note` / `alfred_continuity_bind` — Cowork can read and write continuity directly, through the app, over a loopback stdio pipe. |
| **First launch** | Opened from a mounted disk image, the app copies itself to `/Applications`, starts from there and lets the mounted copy quit — so the login item never points into `/Volumes`. A double-click on the running app opens the window; a login-item launch stays in the menu bar. |
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
"dist/Alfred Black.app/Contents/MacOS/AlfredBlack" --export-plugin           # write ~/Downloads/Alfred Continuity.plugin
"dist/Alfred Black.app/Contents/MacOS/AlfredBlack" --snapshot /path/dir      # render both views to PNGs
```

## Signing and distribution

The build is **ad-hoc signed** (`codesign --sign -`). It runs on the Mac it
was built on; on another Mac, Gatekeeper will refuse a double-click the
first time — right-click › *Open* once, or clear the quarantine flag.
The login Keychain's ACL trusts a code identity, and an ad-hoc signature is a
new identity on every build — every update would re-ask, and for the background
MCP server that Claude Desktop spawns the question is never shown: the process
just blocks. So while the app is ad-hoc signed the key lives in a 0600 file in
its support folder, and the Keychain is only read with user interaction
disabled (to migrate a key an earlier build stored there). A Developer ID
signature is what makes a Keychain-backed store viable.

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
| `~/Library/Application Support/Alfred Black/.device-key` (0600) | the API key — see *Signing* for why not the Keychain yet |

Sign out removes the pairing, the key file and the MCP registration;
the API key itself is revoked from *Study › API keys* on the tenant.

## Design

Built on the Alfred Black design system (`design-system/`): paper and wool,
ink, one brass accent, sharp corners, hairline rules, Playfair Display for
display, EB Garamond for prose, JetBrains Mono for machine truth. No emoji.
Calm copy.
