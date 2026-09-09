// The tenant client. Two credentials, kept apart on purpose:
//   * a dashboard session (email + password → sessionId) proves the PERSON,
//     is used exactly once, and is discarded;
//   * a per-device API key (`alf_…`, minted by the dashboard's own
//     create-api-key action, revocable from /study) is what this Mac carries.
// Everything after pairing goes through the dashboard's authenticated
// pass-through proxy: https://api.<domain>/api/v1/* → ctrl-api.
import Foundation

struct TenantError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

struct JournalEntry: Codable {
  var ts: String
  var channel: String
  var chat_id: String
  var direction: String
  var message: String
  var source_kind: String?
}

struct Tenant {
  let api: URL
  let apiKey: String?

  private var session: URLSession {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 20
    c.httpAdditionalHeaders = ["User-Agent": "AlfredBlackMac/1.0"]
    return URLSession(configuration: c)
  }

  /// Asking Alfred can take a minute; everything else answers in seconds.
  private static let slow: URLSession = { let c = URLSessionConfiguration.ephemeral; c.timeoutIntervalForRequest = 180; return URLSession(configuration: c) }()
  private func request(_ path: String, method: String = "GET", bearer: String?, body: [String: Any]? = nil, query: [String: String] = [:], patient: Bool = false) async throws -> (Int, Data) {
    var comps = URLComponents(url: api.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
    var r = URLRequest(url: comps.url!)
    r.httpMethod = method
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.setValue("application/json", forHTTPHeaderField: "Accept")
    if let bearer { r.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    if let body { r.httpBody = try JSONSerialization.data(withJSONObject: body) }
    let (data, resp) = try await (patient ? Tenant.slow : session).data(for: r)
    return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
  }

  // MARK: pairing
  /// Sign in with the dashboard credentials; returns the Wasp session id.
  func login(email: String, password: String) async throws -> String {
    let (code, data) = try await request("auth/email/login", method: "POST", bearer: nil, body: ["email": email, "password": password])
    guard code == 200,
          let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let sid = j["sessionId"] as? String else {
      let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
      throw TenantError(message: code == 401 || code == 422 ? "That email and password were not accepted." : (msg ?? "Sign-in failed (HTTP \(code))."))
    }
    return sid
  }

  /// Mint this device's API key. Named so it is recognisable — and revocable — from /study.
  /// Wasp operations speak superjson: the body and the reply are both wrapped in `{"json": …}`.
  func createApiKey(session: String, name: String) async throws -> (id: String, key: String) {
    let (code, data) = try await request("operations/create-api-key", method: "POST", bearer: session, body: ["json": ["name": name]])
    guard code == 200,
          let env = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let j = (env["json"] as? [String: Any]) ?? env as [String: Any]?,
          let id = j["id"] as? String, let key = j["key"] as? String else {
      let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
      throw TenantError(message: msg ?? "Could not create a device key (HTTP \(code)).")
    }
    return (id, key)
  }

  /// Revoke a key this app minted (used by Sign out). Same superjson envelope.
  func revokeApiKey(session: String, id: String) async throws {
    let (code, _) = try await request("operations/revoke-api-key", method: "POST", bearer: session, body: ["json": ["id": id]])
    guard code == 200 else { throw TenantError(message: "Could not revoke the device key (HTTP \(code)).") }
  }

  // MARK: journal (device key)
  func recent(limit: Int = 20, withinHours: Double = 24) async throws -> [JournalEntry] {
    let (code, data) = try await request("api/v1/alfred-journal/recent", bearer: apiKey,
                                         query: ["principal_id": "owner", "limit": String(limit), "within_hours": String(withinHours)])
    guard code == 200 else { throw TenantError(message: code == 401 ? "The device key was rejected — pair again." : "Journal read failed (HTTP \(code)).") }
    struct Wrap: Codable { var entries: [JournalEntry] }
    return try JSONDecoder().decode(Wrap.self, from: data).entries
  }

  func append(channel: String, chatId: String, direction: String, message: String, sourceRef: String, metadata: [String: Any]) async throws {
    let body: [String: Any] = ["channel": channel, "chat_id": chatId, "direction": direction,
                               "message": message, "source_kind": channel, "source_ref": sourceRef,
                               "status": direction == "inbound" ? "received" : "delivered", "metadata": metadata]
    let (code, _) = try await request("api/v1/alfred-journal", method: "POST", bearer: apiKey, body: body)
    guard (200..<300).contains(code) else { throw TenantError(message: "Journal write failed (HTTP \(code)).") }
  }

  func bind(channel: String, chatId: String) async throws {
    let (code, _) = try await request("api/v1/alfred-journal/principal/bind", method: "POST", bearer: apiKey,
                                      body: ["channel": channel, "chat_id": chatId, "principal_id": "owner"])
    guard (200..<300).contains(code) else { throw TenantError(message: "Bind failed (HTTP \(code)).") }
  }

  /// Cheapest authenticated probe: a one-entry journal read.
  func check() async -> Bool { (try? await recent(limit: 1, withinHours: 1)) != nil }

  /// Turn whatever the person typed into the tenant domain.
  /// The Desk: cards awaiting the principal's judgment.
  func deskPending() async throws -> (items: [DeskItem], total: Int) {
    struct Page: Decodable { var records: [DeskItem]; var count: Int? }
    let (code, data) = try await request("api/v1/admin/needs-attention", bearer: apiKey)
    guard code == 200 else { throw TenantError(message: "Desk read failed (HTTP \(code)).") }
    let page = try JSONDecoder().decode(Page.self, from: data)
    return (page.records, page.count ?? page.records.count)   // the list is capped; the count is the truth
  }

  /// Ask Alfred from this Mac. ctrl-api journals both turns and puts his memory in front of him.
  func ask(_ message: String, chatId: String) async throws -> String {
    let (code, data) = try await request("api/v1/alfred/ask", method: "POST", bearer: apiKey, body: ["message": message, "chat_id": chatId, "channel": "mac"], patient: true)
    let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    guard code == 200, let reply = j["reply"] as? String, !reply.isEmpty else {
      throw TenantError(message: code == 502 ? "Alfred could not be reached just now." : "The tenant did not answer (HTTP \(code)).")
    }
    return reply
  }

  /// The most recent brief: its slot, date, and a short excerpt of the body.
  func latestBrief() async throws -> Brief? {
    struct Item: Decodable { var slug_date: String; var slot: String; var date: String; var composed_at: String? }
    struct List: Decodable { var briefings: [Item] }
    struct Detail: Decodable { var body: String }
    let (code, data) = try await request("api/v1/briefings", bearer: apiKey)
    guard code == 200, let latest = try JSONDecoder().decode(List.self, from: data).briefings.max(by: { $0.slug_date < $1.slug_date }) else { return nil }
    let (c2, d2) = try await request("api/v1/briefings/\(latest.slug_date)", bearer: apiKey)
    guard c2 == 200 else { return nil }
    let body = try JSONDecoder().decode(Detail.self, from: d2).body
    return Brief(slot: latest.slot, date: latest.date, slug_date: latest.slug_date, composed_at: latest.composed_at, excerpt: Brief.excerpt(of: body), items: Brief.items(of: body))
  }

  /// Matters in flight, with the narrative state Alfred keeps for each.
  func matters() async throws -> [Matter] {
    struct Page: Decodable { var matters: [Matter] }
    let (code, data) = try await request("api/v1/matters", bearer: apiKey)
    guard code == 200 else { throw TenantError(message: "Matters read failed (HTTP \(code)).") }
    return try JSONDecoder().decode(Page.self, from: data).matters
  }
  /// Hours returned today, after every cost (the attention statement for the day).
  func returnedToday() async throws -> Double? {
    struct Day: Decodable { var nar_hours: Double? }
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
    let (code, data) = try await request("api/v1/attention/statement", bearer: apiKey, query: ["date": f.string(from: Date())])
    guard code == 200 else { return nil }
    return try JSONDecoder().decode(Day.self, from: data).nar_hours
  }

  /// The tenant's autonomy flags, read as a trust class: L1 watches (all
  /// shadow), L2 proposes (acts only through the principal), L3 acts, then reports.
  func trustClass() async throws -> Int {
    let (code, data) = try await request("api/v1/settings", bearer: apiKey)
    guard code == 200, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return 3 }
    let bag = (j["settings"] as? [String: Any]) ?? j
    func mode(_ k: String) -> String { ((bag[k] as? [String: Any])?["value"] as? String) ?? (bag[k] as? String) ?? "live" }
    let live = ["signal_action_mode", "state_mutator_mode", "auto_task_create_mode"].map { mode($0) == "live" }
    return live.allSatisfy { $0 } ? 3 : (live[0] ? 2 : (live[1] || live[2] ? 2 : 1))
  }

  static func domain(from raw: String) -> String? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if !s.contains("://") { s = "https://" + s }
    guard let host = URLComponents(string: s)?.host, host.contains(".") else { return nil }
    var h = host
    for p in ["api.", "www."] where h.hasPrefix(p) { h = String(h.dropFirst(p.count)) }
    return h
  }
}

struct DeskItem: Decodable, Identifiable {
  var id: String; var status: String?; var created: String?; var action_what: String?; var matter_ref: String?
  var display_headline: String?; var display_body: String?; var body_preview: String?; var target_path: String?; var target_kind: String?; var decay_score: Double?
  /// The readable line: the card's headline, else what it asks, else its preview, else what it points at.
  var title: String {
    for c in [display_headline, action_what, body_preview, target_path] {
      if let c, !c.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return c.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces) }
    }
    return id
  }
  var body: String { (display_body ?? body_preview ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces) }
}

struct Brief {
  var slot: String; var date: String; var slug_date: String = ""; var composed_at: String? = nil; var excerpt: String; var items: [String] = []
  var title: String { "\(slot.prefix(1).uppercased() + slot.dropFirst()) brief · \(date)" }
  /// "THE BRIEF · TUE 9 SEP" and the time it was composed.
  var header: String {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; let o = DateFormatter(); o.dateFormat = "EEE d MMM"
    return "The Brief · " + (f.date(from: date).map { o.string(from: $0) } ?? date)
  }
  var composedTime: String {
    guard let c = composed_at, let d = ISO8601DateFormatter().date(from: c) ?? { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.date(from: c) }() else { return slot == "morning" ? "07:00" : "19:00" }
    let t = DateFormatter(); t.dateFormat = "HH:mm"; return t.string(from: d)
  }
  var isToday: Bool { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.string(from: Date()) == date }
  /// The brief's bullet lines, markdown stripped, at most three.
  static func items(of body: String) -> [String] {
    let text = body.range(of: "\n---\n").map { String(body[$0.upperBound...]) } ?? body
    var out: [String] = []
    for raw in text.components(separatedBy: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      guard line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") else { continue }
      var t = String(line.dropFirst(2)).replacingOccurrences(of: "**", with: "")
      t = t.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
      if !t.isEmpty && !out.contains(t) { out.append(t) }
      if out.count == 3 { break }
    }
    return out
  }
  /// A deadline the line names, as its meta — else nothing.
  static func deadline(in line: String) -> String? {
    let re = try! NSRegularExpression(pattern: #"\b(noon|tonight|today|tomorrow|this (?:morning|evening|week)|by (?:mon|tue|wed|thu|fri|sat|sun)\w*|\d{1,2}:\d{2})\b"#, options: .caseInsensitive)
    guard let m = re.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)), let r = Range(m.range, in: line) else { return nil }
    return String(line[r])
  }
  /// First paragraph of prose after the heading, prose only, capped.
  static func excerpt(of body: String) -> String {
    let text = body.range(of: "\n---\n").map { String(body[$0.upperBound...]) } ?? body   // skip frontmatter if present
    let para = text.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty && !$0.hasPrefix("#") && !$0.hasPrefix("-") && !$0.hasPrefix("|") } ?? ""
    let flat = para.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "\n", with: " ")
    return flat.count > 260 ? String(flat.prefix(257)).trimmingCharacters(in: .whitespaces) + "…" : flat
  }
}

struct Matter: Decodable, Identifiable {
  var id: String; var name: String?; var summary: String?; var state: String?; var current_state: String?; var path: String?; var next: String?
  /// The living state, first sentence only, for the subline.
  var subline: String {
    let st = (current_state ?? summary ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
    let first = st.components(separatedBy: ". ").first ?? st
    return first.count > 90 ? String(first.prefix(89)) + "…" : first
  }
  var title: String { (name ?? id).trimmingCharacters(in: .whitespaces) }
  /// One line for the Glance: the matter and its living state, if any.
  var glanceTitle: String {
    let st = (current_state ?? summary ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
    guard !st.isEmpty else { return title }
    let first = st.components(separatedBy: ". ").first ?? st
    return "\(title) — \(first.count > 70 ? String(first.prefix(69)) + "…" : first)"
  }
}
