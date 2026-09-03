// The write side: mirror Claude Cowork's local-agent-mode transcripts into the
// journal, so every other surface remembers what was said here.
//
// Cowork runs its local sessions on this Mac and writes each one as JSONL under
// ~/Library/Application Support/Claude/local-agent-mode-sessions/**/.claude/
// projects/**/*.jsonl. We read those files off disk — the Cowork sandbox never
// has to reach the tenant — and POST each user/assistant turn once.
//
// Idempotent + fail-soft, ported from ~/.alfred/cowork-journal/push.py: a
// global set of pushed entry uuids (transcripts get copied between session
// dirs, so a per-file cursor would re-send); on any failure the uuid is NOT
// recorded, so the next run retries. Sidechains (subagent transcripts) and
// scheduled-task / system-reminder injections are not conversation and are
// skipped. Every new session id is bound to the owner principal once, which is
// what makes it visible to Hermes' cross-channel window.
import Foundation

struct PushReport { var pushed = 0; var skipped = 0; var failed = 0; var bound = 0; var tooOld = 0 }

enum Pusher {
  static let maxChars = 4000
  static let channel = "cowork"
  /// The journal stamps `ts` server-side, so a turn mirrored late lands as
  /// "now". Mirroring history would therefore rewrite the recent window with
  /// stale conversation — it did, once, in testing. Only turns this fresh are
  /// mirrored; older ones are skipped for good.
  static let liveWindow: TimeInterval = 48 * 3600

  /// Seed the pushed set from the earlier command-line pusher's state so a Mac
  /// that ran it does not re-send the same turns.
  static func seedFromLegacyState(into state: inout RunState) {
    let legacy = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".alfred/cowork-journal/state.json")
    guard state.pushedUUIDs.isEmpty, let d = try? Data(contentsOf: legacy),
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let seen = j["_seen"] as? [String] else { return }
    state.pushedUUIDs.formUnion(seen)
  }

  private static let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
  private static let isoPlain = ISO8601DateFormatter()
  static func timestamp(of e: [String: Any]) -> Date? {
    guard let t = e["timestamp"] as? String else { return nil }
    return iso.date(from: t) ?? isoPlain.date(from: t)
  }

  static func transcripts() -> [URL] {
    guard let e = FileManager.default.enumerator(at: Paths.coworkSessions, includingPropertiesForKeys: [.isRegularFileKey],
                                                 options: [.skipsHiddenFiles]) else { return [] }
    var out: [URL] = []
    for case let u as URL in e where u.pathExtension == "jsonl" && u.path.contains("/.claude/projects/") { out.append(u) }
    // .skipsHiddenFiles would skip .claude; enumerate again without it if nothing found
    if out.isEmpty, let e2 = FileManager.default.enumerator(at: Paths.coworkSessions, includingPropertiesForKeys: nil) {
      for case let u as URL in e2 where u.pathExtension == "jsonl" && u.path.contains("/.claude/projects/") { out.append(u) }
    }
    return out.sorted { $0.path < $1.path }
  }

  static func text(of entry: [String: Any]) -> String {
    guard let m = entry["message"] as? [String: Any] else { return "" }
    if let s = m["content"] as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
    if let blocks = m["content"] as? [[String: Any]] {
      return blocks.compactMap { ($0["type"] as? String) == "text" ? ($0["text"] as? String) : nil }
        .joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return ""
  }

  static func run(tenant: Tenant, state: inout RunState) async -> PushReport {
    var rep = PushReport()
    for file in transcripts() {
      guard let raw = try? String(contentsOf: file, encoding: .utf8) else { continue }
      let sessionFallback = file.deletingPathExtension().lastPathComponent
      for line in raw.split(separator: "\n", omittingEmptySubsequences: true) {
        guard let d = line.data(using: .utf8),
              let e = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let type = e["type"] as? String, type == "user" || type == "assistant" else { continue }
        if (e["isSidechain"] as? Bool) == true { continue }
        guard let uid = e["uuid"] as? String, !uid.isEmpty else { continue }
        if state.pushedUUIDs.contains(uid) { rep.skipped += 1; continue }
        guard let when = timestamp(of: e), Date().timeIntervalSince(when) <= liveWindow else {
          state.pushedUUIDs.insert(uid); rep.tooOld += 1; continue   // history: never mirror, never retry
        }
        let body = text(of: e)
        guard !body.isEmpty, !body.hasPrefix("<scheduled-task"), !body.hasPrefix("<system-reminder") else { continue }
        let sessionId = (e["sessionId"] as? String) ?? sessionFallback
        do {
          if !state.boundSessions.contains(sessionId) {
            try await tenant.bind(channel: channel, chatId: sessionId)
            state.boundSessions.insert(sessionId); rep.bound += 1
          }
          try await tenant.append(channel: channel, chatId: sessionId,
                                  direction: type == "user" ? "inbound" : "outbound",
                                  message: String(body.prefix(maxChars)), sourceRef: uid,
                                  metadata: ["entry_uuid": uid, "timestamp": e["timestamp"] ?? "", "cwd": e["cwd"] ?? "",
                                             "transcript": file.lastPathComponent, "pusher": "alfred-black-mac"])
          state.pushedUUIDs.insert(uid); rep.pushed += 1; state.totalPushed += 1
        } catch {
          rep.failed += 1
          state.lastError = error.localizedDescription; state.lastErrorAt = Date()
          if rep.failed >= 5 { return rep }  // tenant unreachable: stop hammering, retry next tick
        }
      }
    }
    return rep
  }
}
