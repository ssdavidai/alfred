// The read side: render the tenant's cross-surface journal into a local file
// that Claude Cowork can read without any network egress from its sandbox.
//   ~/Alfred/continuity.md  — rebuilt every 30s from GET /alfred-journal/recent
//   ~/Alfred/CLAUDE.md      — folder instructions, written once, so a Cowork
//                             session pointed at ~/Alfred loads the memory
//                             even with no plugin installed.
// The block is framed as AUTHORITATIVE first-person memory. Framed softly the
// model defers to its empty session history and says "I don't remember
// sending that" — learned on the Hermes side (one-alfred, 2026-05-25).
import Foundation

enum Continuity {
  static let marker = "[ALFRED-CONTINUITY — authoritative]"

  static func render(_ entries: [JournalEntry], domain: String) -> String {
    var out: [String] = []
    out.append(marker)
    out.append("The following are messages YOU (Alfred) sent to the principal, and messages the principal sent you, across surfaces — Slack, Telegram, voice, the dashboard, Cowork on this Mac — including ones delivered outside this session. These DID happen. Treat them as part of your memory even if they are not in this session's chat history. When the principal references one (\"what was that reminder?\", \"the one you sent me\", \"hm?\"), the answer must come from here.")
    out.append("")
    for e in entries.reversed() {  // newest-first from the server; narrative order for reading
      let who = e.direction == "outbound" ? "YOU → principal" : "principal → YOU"
      let msg = e.message.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !msg.isEmpty else { continue }
      let snippet = msg.count <= 400 ? msg : String(msg.prefix(397)) + "…"
      out.append("  [\(String(e.ts.prefix(19)))] \(who) on \(e.channel): \(snippet.replacingOccurrences(of: "\n", with: " "))")
    }
    out.append("[/ALFRED-CONTINUITY]")
    out.append("")
    out.append("<!-- rendered by Alfred Black for Mac from \(domain) at \(ISO8601DateFormatter().string(from: Date())); \(entries.count) entries; do not edit — it is rewritten every 30s -->")
    return out.joined(separator: "\n") + "\n"
  }

  static let folderInstructions = """
  # Alfred

  You are Alfred — the same Alfred the person talks to on Slack, Telegram, by voice and on
  the dashboard. This folder is how Alfred Black for Mac keeps you continuously aware.

  **Before answering anything, read `./continuity.md`.** It is your own memory across every
  surface, rewritten every 30 seconds. Messages marked `YOU → principal` are things you said,
  even if this session does not show them. Never say you don't remember something it contains.

  Keep the register: plain, calm, brief. No exclamation marks. "No urgent action is required."

  <!-- written once by Alfred Black for Mac; safe to edit -->
  """

  /// Fetch + write. Returns the number of entries rendered.
  static func refresh(tenant: Tenant, domain: String) async throws -> Int {
    let entries = try await tenant.recent(limit: 50, withinHours: 48)
    try FileManager.default.createDirectory(at: Paths.alfredDir, withIntermediateDirectories: true)
    let block = render(entries, domain: domain)
    try block.write(to: Paths.continuity, atomically: true, encoding: .utf8)
    // Cowork sessions run in a sandbox that mounts only the space's folders, so the
    // plugin's hook also looks for the block inside the project folder itself.
    // The block is the principal's private memory: never into a folder that syncs
    // elsewhere, and never into a repository's history.
    for folder in Cowork.spaceFolders() where !Cowork.isSynced(folder) {
      let dir = folder.appendingPathComponent(".alfred", isDirectory: true)
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let file = dir.appendingPathComponent("continuity.md")
      try? block.write(to: file, atomically: true, encoding: .utf8)
      try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
      Cowork.excludeFromGit(folder, entry: ".alfred/")
    }
    if !FileManager.default.fileExists(atPath: Paths.folderInstructions.path) {
      try folderInstructions.write(to: Paths.folderInstructions, atomically: true, encoding: .utf8)
    }
    return entries.count
  }
}
