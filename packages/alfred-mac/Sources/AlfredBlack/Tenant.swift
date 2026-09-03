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

  private func request(_ path: String, method: String = "GET", bearer: String?, body: [String: Any]? = nil, query: [String: String] = [:]) async throws -> (Int, Data) {
    var comps = URLComponents(url: api.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
    var r = URLRequest(url: comps.url!)
    r.httpMethod = method
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.setValue("application/json", forHTTPHeaderField: "Accept")
    if let bearer { r.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    if let body { r.httpBody = try JSONSerialization.data(withJSONObject: body) }
    let (data, resp) = try await session.data(for: r)
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
  static func domain(from raw: String) -> String? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if !s.contains("://") { s = "https://" + s }
    guard let host = URLComponents(string: s)?.host, host.contains(".") else { return nil }
    var h = host
    for p in ["api.", "www."] where h.hasPrefix(p) { h = String(h.dropFirst(p.count)) }
    return h
  }
}
