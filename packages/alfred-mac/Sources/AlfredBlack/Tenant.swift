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

  /// The principal's word on a Desk card: hold (defer), take it himself, or so ordered (delegate to Alfred).
  @discardableResult
  func decide(card: DeskItem, intent: String) async throws -> String? {
    let (code, data) = try await request("api/v1/decisions", method: "POST", bearer: apiKey,
      body: ["source": "needs_attention", "source_record": card.path ?? "needs_attention/\(card.id).md", "intent": intent, "origin": "mac"])
    let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    guard code == 200 || code == 201 else { throw TenantError(message: (j["error"] as? String) ?? "The decision was not recorded (HTTP \(code)).") }
    return (j["id"] as? String) ?? ((j["decision"] as? [String: Any])?["id"] as? String)
  }
  /// Undo: the route reverses a decision and restores the card.
  func reverse(decisionId: String) async throws {
    let (code, _) = try await request("api/v1/decisions/\(decisionId)/reverse", method: "POST", bearer: apiKey, body: [:])
    guard code == 200 else { throw TenantError(message: "The decision could not be undone (HTTP \(code)).") }
  }

  /// The audit ledger — append-only, every line traceable to its session.
  func activity(limit: Int = 30) async throws -> [LedgerLine] {
    struct Page: Decodable { var items: [LedgerLine] }
    let (code, data) = try await request("api/v1/admin/activity", bearer: apiKey, query: ["limit": String(limit)])
    guard code == 200 else { throw TenantError(message: "Ledger read failed (HTTP \(code)).") }
    return try JSONDecoder().decode(Page.self, from: data).items
  }
  /// What the vault holds, counted by record type from the index.
  func vaultCounts() async throws -> [String: Int] {
    let (code, data) = try await request("api/v1/vault/index", bearer: apiKey)
    struct Entry: Decodable { var type: String?; var slug: String? }
    struct Index: Decodable { var titles: [Entry] }
    guard code == 200, let idx = try? JSONDecoder().decode(Index.self, from: data) else { return [:] }
    var out: [String: Int] = [:]
    for e in idx.titles { let t = e.type ?? String(e.slug?.split(separator: "/").first ?? ""); if !t.isEmpty { out[t, default: 0] += 1 } }
    return out
  }

  /// The standing rules Alfred follows (vault/RULES.md), whole.
  func rules() async throws -> String {
    struct Rec: Decodable { var body: String }
    let (code, data) = try await request("api/v1/vault/records/RULES.md", bearer: apiKey)
    guard code == 200 else { throw TenantError(message: "Rules read failed (HTTP \(code)).") }
    return try JSONDecoder().decode(Rec.self, from: data).body
  }
  func saveRules(_ body: String) async throws {
    let (code, _) = try await request("api/v1/vault/records/RULES.md", method: "PATCH", bearer: apiKey, body: ["body_set": body])
    guard code == 200 else { throw TenantError(message: "The arrangement was not saved (HTTP \(code)).") }
  }
  /// The trust class, applied: L3 acts (all live), L2 proposes (acts only through the principal), L1 watches.
  func setTrust(_ level: Int) async throws {
    let values = level >= 3 ? ["live", "live", "live"] : level == 2 ? ["shadow", "live", "live"] : ["shadow", "shadow", "shadow"]
    for (k, v) in zip(["signal_action_mode", "state_mutator_mode", "auto_task_create_mode"], values) {
      let (code, _) = try await request("api/v1/settings/\(k)", method: "PUT", bearer: apiKey, body: ["value": v])
      guard code == 200 else { throw TenantError(message: "Trust class not applied (\(k): HTTP \(code)).") }
    }
  }

  /// The last complete month's attention statement: returned, displaced, engaged (hours).
  func statement(monthsBack: Int = 1) async throws -> MonthStatement? {
    struct Totals: Decodable { var nar_hours: Double?; var displaced_hours: Double?; var engaged_hours: Double? }
    struct Page: Decodable { var totals: Totals? }
    let cal = Calendar.current; let now = Date()
    guard let firstOfThis = cal.date(from: cal.dateComponents([.year, .month], from: now)),
          let firstOfLast = cal.date(byAdding: .month, value: -monthsBack, to: firstOfThis),
          let firstAfter = cal.date(byAdding: .month, value: 1, to: firstOfLast),
          let lastOfLast = cal.date(byAdding: .day, value: -1, to: firstAfter) else { return nil }
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; let mf = DateFormatter(); mf.dateFormat = "MMMM yyyy"
    let (code, data) = try await request("api/v1/attention/statement", bearer: apiKey, query: ["from": f.string(from: firstOfLast), "to": f.string(from: lastOfLast)])
    guard code == 200, let t = try JSONDecoder().decode(Page.self, from: data).totals else { return nil }
    return MonthStatement(month: mf.string(from: firstOfLast), returned: t.nar_hours ?? 0, displaced: t.displaced_hours ?? 0, engaged: t.engaged_hours ?? 0)
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
  var display_headline: String?; var display_body: String?; var body_preview: String?; var target_path: String?; var target_kind: String?; var decay_score: Double?; var path: String?
  /// The readable line: the card's headline, else what it asks, else its preview, else what it points at.
  var title: String {
    for c in [display_headline, action_what, body_preview, target_path] {
      if let c, !c.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return c.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces) }
    }
    return id
  }
  var body: String { (display_body ?? body_preview ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces) }
  /// What Alfred would do if so ordered — the card's own action, when it names one distinct from the headline.
  var proposedAction: String? {
    guard let a = action_what?.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces), !a.isEmpty, a != display_headline else { return nil }
    return a.count > 90 ? String(a.prefix(89)) + "…" : a
  }
}

struct Brief {
  var slot: String; var date: String; var slug_date: String = ""; var composed_at: String? = nil; var excerpt: String; var items: [String] = []
  var title: String { "\(slot.prefix(1).uppercased() + slot.dropFirst()) brief · \(date)" }
  /// "THE BRIEF · TUE 9 SEP" and the time it was composed.
  var header: String {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; let o = DateFormatter(); o.dateFormat = "EEE d MMM"
    return "Brief · " + (f.date(from: date).map { o.string(from: $0) } ?? date)
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
  var id: String; var name: String?; var summary: String?; var state: String?; var current_state: String?; var path: String?; var next: String?; var last: String?; var as_of: String?
  /// The list gives `last` as "Wed Jul 29" and `next` as the next action in words.
  var when: String {
    guard let l = last, !l.isEmpty else { return "" }
    var parts = l.split(separator: " ").map(String.init)
    if let f = parts.first, f.count == 3, ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].contains(f) { parts.removeFirst() }   // weekday
    if parts.count > 2, parts.last?.count == 4 { parts.removeLast() }                                                    // year
    return "changed " + parts.prefix(2).joined(separator: " ")
  }
  var nextAction: String? { guard let n = next?.trimmingCharacters(in: .whitespaces), !n.isEmpty else { return nil }; return n }
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

struct LedgerLine: Decodable, Identifiable {
  var id: String; var ts: String?; var action_type: String?; var actor: String?; var summary: String?; var mode: String?; var target_path: String?
  /// A machine heartbeat (a workflow starting or finishing, a shadow check) is not something a person needs to read.
  var meaningful: Bool {
    let t = (summary ?? "").lowercased()
    if (mode ?? "live") != "live" { return false }
    if target_path == nil && (t.hasSuffix(" completed") || t.hasSuffix(" started") || t.contains("workflow")) { return false }
    return true
  }
  var time: String {
    guard let ts, let d = ISO8601DateFormatter().date(from: ts) ?? { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.date(from: ts) }() else { return "" }
    let f = DateFormatter(); f.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "d MMM"; return f.string(from: d)
  }
  /// The line in plain words: slugs become titles, workflows become their names.
  var title: String {
    var t = (summary ?? action_type ?? id).replacingOccurrences(of: "\n", with: " ")
    for prefix in ["steward-action: ", "signal-action: ", "desk-action: "] { if t.hasPrefix(prefix) { t = String(t.dropFirst(prefix.count)) } }
    if let r = t.range(of: " (conf=") { t = String(t[..<r.lowerBound]) }
    if let r = t.range(of: #"^(\w+) on (task|matter|note|chore|instinct)/(.+?)\.md$"#, options: .regularExpression) {
      let parts = String(t[r]).components(separatedBy: " on "); let verb = parts[0].replacingOccurrences(of: "_", with: " ")
      var name = parts[1].components(separatedBy: "/").last ?? parts[1]; name = name.replacingOccurrences(of: ".md", with: "")
      name = name.replacingOccurrences(of: #"^[0-9a-f]{8}-"#, with: "", options: .regularExpression).replacingOccurrences(of: "-", with: " ")
      t = "\(verb.prefix(1).uppercased() + verb.dropFirst()) — \(name)"
    }
    t = t.replacingOccurrences(of: #"([a-z])([A-Z])"#, with: "$1 $2", options: .regularExpression).replacingOccurrences(of: " Workflow", with: "")
    return t.trimmingCharacters(in: .whitespaces)
  }
}

/// The three sentences of the arrangement, kept in RULES.md under "## The arrangement".
struct Arrangement: Equatable {
  var may = "", asksFirst = "", never = ""
  static let heading = "## The arrangement"
  static let labels = ["Alfred may, without asking", "Alfred asks first", "Alfred never"]
  static func parse(_ body: String) -> Arrangement {
    var a = Arrangement()
    guard let r = body.range(of: heading) else { return a }
    let section = body[r.upperBound...].components(separatedBy: "\n## ").first ?? ""
    for line in section.components(separatedBy: "\n") {
      let l = line.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"^[-*]\s*"#, with: "", options: .regularExpression)
      for (i, label) in labels.enumerated() where l.lowercased().hasPrefix(label.lowercased() + ":") {
        let v = l.dropFirst(label.count + 1).trimmingCharacters(in: .whitespaces)
        if i == 0 { a.may = v } else if i == 1 { a.asksFirst = v } else { a.never = v }
      }
    }
    return a
  }
  /// The body with this arrangement's section replaced, or appended.
  func written(into body: String) -> String {
    let block = "\(Self.heading)\n\n- \(Self.labels[0]): \(may)\n- \(Self.labels[1]): \(asksFirst)\n- \(Self.labels[2]): \(never)\n"
    guard let r = body.range(of: Self.heading) else { return body.trimmingCharacters(in: .newlines) + "\n\n" + block }
    let after = body[r.upperBound...]; let end = after.range(of: "\n## ").map { after.index($0.lowerBound, offsetBy: 1) } ?? after.endIndex
    return String(body[..<r.lowerBound]) + block + (end < after.endIndex ? "\n" + String(after[end...]) : "")
  }
}
