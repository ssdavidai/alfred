// Small durable state beside the app: what has been journaled, what is bound,
// last-run facts for the status view. Not credentials (those are in Keychain).
import Foundation

struct Pairing: Codable, Equatable {
  var domain: String        // e.g. example.alfred.black — the tenant, never hard-coded
  var email: String
  var keyId: String
  var pairedAt: Date
  var api: URL { URL(string: "https://api.\(domain)")! }
  var dashboard: URL { URL(string: "https://\(domain)")! }
}

struct RunState: Codable {
  var pushedUUIDs: Set<String> = []
  var boundSessions: Set<String> = []
  var lastRenderAt: Date?
  var lastRenderEntries: Int = 0
  var lastPushAt: Date?
  var lastPushCount: Int = 0
  var totalPushed: Int = 0
  var lastError: String?
  var lastErrorAt: Date?
}

enum Paths {
  static let support = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Alfred Black", isDirectory: true)
  static let alfredDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Alfred", isDirectory: true)
  static let continuity = alfredDir.appendingPathComponent("continuity.md")
  static let folderInstructions = alfredDir.appendingPathComponent("CLAUDE.md")
  static let pairingFile = support.appendingPathComponent("pairing.json")
  static let stateFile = support.appendingPathComponent("state.json")
  static let coworkPlugin = support.appendingPathComponent("cowork-plugin/alfred-continuity", isDirectory: true)
  static let claudeDesktopConfig = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Claude/claude_desktop_config.json")
  static let coworkSessions = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Claude/local-agent-mode-sessions", isDirectory: true)
}

enum Store {
  private static let enc: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; e.outputFormatting = [.prettyPrinted, .sortedKeys]; return e }()
  private static let dec: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()

  static func loadPairing() -> Pairing? {
    guard let d = try? Data(contentsOf: Paths.pairingFile) else { return nil }
    return try? dec.decode(Pairing.self, from: d)
  }
  static func savePairing(_ p: Pairing?) {
    try? FileManager.default.createDirectory(at: Paths.support, withIntermediateDirectories: true)
    if let p, let d = try? enc.encode(p) { try? d.write(to: Paths.pairingFile, options: .atomic) }
    else { try? FileManager.default.removeItem(at: Paths.pairingFile) }
  }
  static func loadState() -> RunState {
    guard let d = try? Data(contentsOf: Paths.stateFile), let s = try? dec.decode(RunState.self, from: d) else { return RunState() }
    return s
  }
  static func saveState(_ s: RunState) {
    try? FileManager.default.createDirectory(at: Paths.support, withIntermediateDirectories: true)
    if let d = try? enc.encode(s) { try? d.write(to: Paths.stateFile, options: .atomic) }
  }
}
