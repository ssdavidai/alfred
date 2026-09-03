// `AlfredBlack --mcp`: a minimal MCP server over stdio (newline-delimited
// JSON-RPC 2.0) exposing the three continuity tools, backed by the device key
// in this Mac's Keychain. Claude Desktop launches it per session from
// claude_desktop_config.json. Same tool names and semantics as the tenant's
// remote mcp-server catalogue, so a skill written for one works with both.
import Foundation

enum MCPServer {
  static let tools: [[String: Any]] = [
    ["name": "alfred_continuity_recent",
     "description": "Recall what Alfred and the principal said to each other recently across EVERY surface — Slack, Telegram, voice, Cowork, the dashboard — not just this session. Call this BEFORE answering anything that might refer to an earlier exchange. AUTHORITATIVE: direction=outbound are messages YOU (Alfred) sent; direction=inbound are messages the principal sent you. They happened even if not in this session's history. Never say you don't remember something this returns. Newest first.",
     "inputSchema": ["type": "object", "properties": ["limit": ["type": "integer", "minimum": 1, "maximum": 50],
                                                       "within_hours": ["type": "number", "minimum": 0.1, "maximum": 720]]]],
    ["name": "alfred_continuity_note",
     "description": "Write one turn into Alfred's cross-surface journal so every other surface remembers it. Record the principal's message as inbound and your reply as outbound, in their actual words.",
     "inputSchema": ["type": "object", "required": ["chat_id", "direction", "message"],
                     "properties": ["channel": ["type": "string", "default": "cowork"], "chat_id": ["type": "string"],
                                    "direction": ["type": "string", "enum": ["inbound", "outbound"]], "message": ["type": "string"]]]],
    ["name": "alfred_continuity_bind",
     "description": "Bind a conversation id on a surface to the principal so its entries join the cross-surface memory. Idempotent; once per new conversation.",
     "inputSchema": ["type": "object", "required": ["chat_id"], "properties": ["channel": ["type": "string", "default": "cowork"], "chat_id": ["type": "string"]]]],
  ]

  static func run() -> Never {
    setvbuf(stdout, nil, _IOLBF, 0)
    guard let pairing = Store.loadPairing(), let key = Keychain.get("apikey") else {
      // Not paired: still speak MCP so Claude shows a clear tool error rather than a dead server.
      serve(tenant: nil, domain: "unpaired")
    }
    serve(tenant: Tenant(api: pairing.api, apiKey: key), domain: pairing.domain)
  }

  private static func send(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) {
      print(s); fflush(stdout)
    }
  }
  private static func result(_ id: Any, _ r: Any) { send(["jsonrpc": "2.0", "id": id, "result": r]) }
  private static func error(_ id: Any, _ code: Int, _ msg: String) { send(["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": msg]]) }
  private static func text(_ s: String, isError: Bool = false) -> [String: Any] { ["content": [["type": "text", "text": s]], "isError": isError] }

  private static func serve(tenant: Tenant?, domain: String) -> Never {
    while let line = readLine(strippingNewline: true) {
      guard let d = line.data(using: .utf8), let req = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
      let method = req["method"] as? String ?? ""
      let id: Any = req["id"] ?? NSNull()
      let params = req["params"] as? [String: Any] ?? [:]
      switch method {
      case "initialize":
        result(id, ["protocolVersion": params["protocolVersion"] ?? "2025-06-18",
                    "capabilities": ["tools": [:]],
                    "serverInfo": ["name": "alfred-continuity", "version": "1.0.0"],
                    "instructions": "One Alfred across surfaces. Call alfred_continuity_recent before answering anything that may refer to an earlier exchange; journal turns with alfred_continuity_note. Tenant: \(domain)."])
      case "notifications/initialized", "notifications/cancelled": continue
      case "ping": result(id, [:])
      case "tools/list": result(id, ["tools": tools])
      case "tools/call":
        let name = params["name"] as? String ?? ""
        let args = params["arguments"] as? [String: Any] ?? [:]
        guard let tenant else { result(id, text("Alfred Black for Mac is not paired with a tenant yet. Open the app from the menu bar and sign in.", isError: true)); continue }
        let sem = DispatchSemaphore(value: 0)
        var out: [String: Any] = text("unknown tool \(name)", isError: true)
        Task {
          defer { sem.signal() }
          do {
            switch name {
            case "alfred_continuity_recent":
              let e = try await tenant.recent(limit: (args["limit"] as? Int) ?? 20, withinHours: (args["within_hours"] as? Double) ?? 24)
              out = text(Continuity.render(e, domain: domain))
              Activity.record(recent: true)
            case "alfred_continuity_note":
              let channel = (args["channel"] as? String) ?? "cowork"
              let chatId = (args["chat_id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "cowork-unknown"
              // Bind on first sight, so the sandboxed session never has to.
              var st = Store.loadState()
              if !st.boundSessions.contains(chatId) {
                try await tenant.bind(channel: channel, chatId: chatId)
                st.boundSessions.insert(chatId); Store.saveState(st)
              }
              try await tenant.append(channel: channel, chatId: chatId,
                                      direction: args["direction"] as? String ?? "inbound", message: args["message"] as? String ?? "",
                                      sourceRef: UUID().uuidString, metadata: ["via": "alfred-black-mac-mcp"])
              Activity.record(note: true)
              out = text("journaled")
            case "alfred_continuity_bind":
              try await tenant.bind(channel: (args["channel"] as? String) ?? "cowork", chatId: args["chat_id"] as? String ?? "")
              out = text("bound to the principal")
            default: break
            }
          } catch { out = text(error.localizedDescription, isError: true) }
        }
        sem.wait()
        result(id, out)
      default:
        if req["id"] != nil { error(id, -32601, "method not found: \(method)") }
      }
    }
    exit(0)
  }
}


/// What the sandboxed sessions did through the tools — kept in a file of its
/// own because the MCP server is a separate process from the menu-bar app.
struct ActivityLog: Codable {
  var notes = 0; var recents = 0; var lastNoteAt: Date?; var lastRecentAt: Date?
  var journalCowork = 0; var journalCoworkLast: Date?
  init() {}
  // Fields are added over time; an older file must still decode, not reset the counters.
  init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    notes = try c.decodeIfPresent(Int.self, forKey: .notes) ?? 0
    recents = try c.decodeIfPresent(Int.self, forKey: .recents) ?? 0
    lastNoteAt = try c.decodeIfPresent(Date.self, forKey: .lastNoteAt)
    lastRecentAt = try c.decodeIfPresent(Date.self, forKey: .lastRecentAt)
    journalCowork = try c.decodeIfPresent(Int.self, forKey: .journalCowork) ?? 0
    journalCoworkLast = try c.decodeIfPresent(Date.self, forKey: .journalCoworkLast)
  }
}
enum Activity {
  static var file: URL { Paths.support.appendingPathComponent("mcp-activity.json") }
  static func load() -> ActivityLog {
    guard let d = try? Data(contentsOf: file), let a = try? JSONDecoder().decode(ActivityLog.self, from: d) else { return ActivityLog() }
    return a
  }
  /// What the tenant's window says about Cowork — the truth regardless of which
  /// tool path a session used (this app's server or the tenant's own).
  static func recordJournal(coworkCount: Int, last: Date?) {
    var a = load(); a.journalCowork = coworkCount; a.journalCoworkLast = last
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let d = try? JSONEncoder().encode(a) { try? d.write(to: file, options: .atomic) }
  }
  static func record(note: Bool = false, recent: Bool = false) {
    var a = load()
    if note { a.notes += 1; a.lastNoteAt = Date() }
    if recent { a.recents += 1; a.lastRecentAt = Date() }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let d = try? JSONEncoder().encode(a) { try? d.write(to: file, options: .atomic) }
  }
}
