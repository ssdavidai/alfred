// Everything Claude Cowork needs, installed or offered from the app's own UI:
//   1. ~/Alfred/CLAUDE.md + continuity.md  — folder instructions (Continuity.swift)
//   2. a local MCP server registered in claude_desktop_config.json, served by
//      this very binary in `--mcp` mode, so Cowork can call
//      alfred_continuity_{recent,note,bind} from any session with no token to
//      copy (the device key stays in this Mac's Keychain)
//   3. the alfred-continuity plugin (hooks + skill), staged to a known path
//      and offered for installation from Claude's Plugins settings — hooks
//      only load through a plugin, and installing one is a Claude UI action.
import Foundation
import AppKit

struct CoworkStatus {
  var folderReady = false
  var mcpRegistered = false
  var pluginStaged = false
  var pluginExported = false
  var claudeInstalled = false
}

enum Cowork {
  static let mcpName = "alfred-continuity"

  static func status() -> CoworkStatus {
    var s = CoworkStatus()
    s.folderReady = FileManager.default.fileExists(atPath: Paths.folderInstructions.path)
    s.pluginStaged = FileManager.default.fileExists(atPath: Paths.coworkPlugin.appendingPathComponent(".claude-plugin/plugin.json").path)
    s.claudeInstalled = FileManager.default.fileExists(atPath: "/Applications/Claude.app")
    s.pluginExported = FileManager.default.fileExists(atPath: exportedPlugin.path)
    if let d = try? Data(contentsOf: Paths.claudeDesktopConfig),
       let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
       let servers = j["mcpServers"] as? [String: Any] {
      s.mcpRegistered = servers[mcpName] != nil
    }
    return s
  }

  /// Register this binary as a local stdio MCP server for Claude Desktop/Cowork.
  /// Preserves every other key in the file; creates it if absent.
  static func registerMCP() throws {
    var j: [String: Any] = [:]
    if let d = try? Data(contentsOf: Paths.claudeDesktopConfig),
       let existing = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { j = existing }
    var servers = (j["mcpServers"] as? [String: Any]) ?? [:]
    servers[mcpName] = ["command": Bundle.main.executablePath ?? CommandLine.arguments[0], "args": ["--mcp"]]
    j["mcpServers"] = servers
    let out = try JSONSerialization.data(withJSONObject: j, options: [.prettyPrinted, .sortedKeys])
    try FileManager.default.createDirectory(at: Paths.claudeDesktopConfig.deletingLastPathComponent(), withIntermediateDirectories: true)
    try out.write(to: Paths.claudeDesktopConfig, options: .atomic)
  }

  static func unregisterMCP() throws {
    guard let d = try? Data(contentsOf: Paths.claudeDesktopConfig),
          var j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          var servers = j["mcpServers"] as? [String: Any] else { return }
    servers.removeValue(forKey: mcpName); j["mcpServers"] = servers
    try JSONSerialization.data(withJSONObject: j, options: [.prettyPrinted, .sortedKeys]).write(to: Paths.claudeDesktopConfig, options: .atomic)
  }

  /// Copy the bundled plugin to a stable, user-visible path.
  static func stagePlugin() throws {
    guard let src = Bundle.module.resourceURL?.appendingPathComponent("CoworkPlugin"),
          FileManager.default.fileExists(atPath: src.path) else { throw TenantError(message: "Plugin bundle missing from the app.") }
    let dst = Paths.coworkPlugin
    try? FileManager.default.removeItem(at: dst)
    try FileManager.default.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: src, to: dst)
    let hook = dst.appendingPathComponent("hooks/continuity-context.sh")
    try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hook.path)
  }

  static func openClaude() {
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.anthropic.claudefordesktop") {
      NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    } else {
      NSWorkspace.shared.open(URL(string: "https://claude.ai/download")!)
    }
  }
  static func revealPlugin() { NSWorkspace.shared.activateFileViewerSelecting([Paths.coworkPlugin]) }

  /// Claude Desktop installs a plugin from a `.plugin` file — a zip with
  /// `.claude-plugin/plugin.json` at its root, under 4 MB — chosen in its own
  /// Plugins UI. There is no deep link or CLI for that step, so the app makes
  /// the file, selects it in Finder, and opens Claude.
  static var exportedPlugin: URL {
    let dl = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
    return dl.appendingPathComponent("Alfred Continuity.plugin")
  }

  @discardableResult
  static func exportPlugin() throws -> URL {
    try stagePlugin()
    let root = Paths.coworkPlugin
    guard FileManager.default.fileExists(atPath: root.appendingPathComponent(".claude-plugin/plugin.json").path) else {
      throw TenantError(message: "Plugin manifest missing from the staged copy.")
    }
    let out = exportedPlugin
    try? FileManager.default.removeItem(at: out)
    let zip = Process()
    zip.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
    zip.currentDirectoryURL = root
    zip.arguments = ["-r", "-X", "-q", out.path, ".", "-x", "*.DS_Store", "-x", "__MACOSX/*"]
    try zip.run(); zip.waitUntilExit()
    guard zip.terminationStatus == 0 else { throw TenantError(message: "Could not build the plugin file (zip exited \(zip.terminationStatus)).") }
    let size = (try? FileManager.default.attributesOfItem(atPath: out.path)[.size] as? Int) ?? 0
    guard size > 0, size < 4 * 1024 * 1024 else { throw TenantError(message: "Plugin file is \(size) bytes; Claude accepts up to 4 MB.") }
    return out
  }
  /// The folders Cowork mounts into its sessions, from Claude Desktop's own
  /// per-space records. Only folders that exist on this Mac.
  static func spaceFolders() -> [URL] {
    let root = Paths.coworkSessions
    guard let accounts = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
    var out: [URL] = []
    for account in accounts {
      guard let spaces = try? FileManager.default.contentsOfDirectory(at: account, includingPropertiesForKeys: nil) else { continue }
      for space in spaces {
        let f = space.appendingPathComponent("spaces.json")
        guard let d = try? Data(contentsOf: f), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let list = j["spaces"] as? [[String: Any]] else { continue }
        for sp in list {
          for folder in (sp["folders"] as? [[String: Any]]) ?? [] {
            if let path = folder["path"] as? String, FileManager.default.fileExists(atPath: path) { out.append(URL(fileURLWithPath: path)) }
          }
        }
      }
    }
    return Array(Set(out.map { $0.path })).sorted().map { URL(fileURLWithPath: $0) }
  }
  /// Folders that replicate elsewhere are no place for private memory.
  static func isSynced(_ folder: URL) -> Bool {
    let p = folder.path
    return ["/Syncthing/", "/Dropbox/", "/Mobile Documents/", "/Google Drive/", "/OneDrive/", "/Library/CloudStorage/"].contains { p.contains($0) }
  }
  /// If the folder is a git repository, keep `entry` out of its history via the
  /// local exclude file (never touching tracked files). Idempotent.
  static func excludeFromGit(_ folder: URL, entry: String) {
    let git = folder.appendingPathComponent(".git")
    guard FileManager.default.fileExists(atPath: git.path) else { return }
    let info = git.appendingPathComponent("info", isDirectory: true)
    let exclude = info.appendingPathComponent("exclude")
    let existing = (try? String(contentsOf: exclude, encoding: .utf8)) ?? ""
    if existing.split(separator: "\n").map(String.init).contains(entry) { return }
    try? FileManager.default.createDirectory(at: info, withIntermediateDirectories: true)
    let sep = existing.isEmpty || existing.hasSuffix("\n") ? "" : "\n"
    try? (existing + sep + entry + "\n").write(to: exclude, atomically: true, encoding: .utf8)
  }
  static func revealExport() { NSWorkspace.shared.activateFileViewerSelecting([exportedPlugin]) }
  static func revealAlfredFolder() { NSWorkspace.shared.activateFileViewerSelecting([Paths.continuity]) }
}
