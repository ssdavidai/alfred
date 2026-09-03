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
  var claudeInstalled = false
}

enum Cowork {
  static let mcpName = "alfred-continuity"

  static func status() -> CoworkStatus {
    var s = CoworkStatus()
    s.folderReady = FileManager.default.fileExists(atPath: Paths.folderInstructions.path)
    s.pluginStaged = FileManager.default.fileExists(atPath: Paths.coworkPlugin.appendingPathComponent(".claude-plugin/plugin.json").path)
    s.claudeInstalled = FileManager.default.fileExists(atPath: "/Applications/Claude.app")
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
  static func revealAlfredFolder() { NSWorkspace.shared.activateFileViewerSelecting([Paths.continuity]) }
}
