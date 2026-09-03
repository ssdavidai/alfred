// The device key. Where it lives follows what the code signature can support:
//
// The legacy login-Keychain ACL trusts a *code identity*. An ad-hoc signature
// is a new identity on every build, so every update re-asks — and for the
// stdio MCP server that Claude Desktop spawns in the background, that question
// is never shown: the process simply blocks inside SecItemCopyMatching. Until
// the app ships with a Developer ID (a stable identity), the key is kept in a
// 0600 file inside the app's own support folder — the protection a personal
// credential file gets on this Mac — and the Keychain is only ever consulted
// with user interaction disabled, so nothing can hang.
import Foundation
import Security

enum Keychain {
  static let service = "black.alfred.mac"
  static var fileURL: URL { Paths.support.appendingPathComponent(".device-key") }

  static func set(_ value: String, account: String) -> Bool {
    do {
      try FileManager.default.createDirectory(at: Paths.support, withIntermediateDirectories: true)
      try Data(value.utf8).write(to: fileURL, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
      return true
    } catch { return false }
  }

  static func get(_ account: String) -> String? {
    if let d = try? Data(contentsOf: fileURL), let s = String(data: d, encoding: .utf8), !s.isEmpty { return s }
    // A key stored by an earlier build in the Keychain: read it without ever
    // prompting, and move it to the file so the next read is local.
    guard let s = keychainRead(account) else { return nil }
    _ = set(s, account: account)
    return s
  }

  static func delete(_ account: String) {
    try? FileManager.default.removeItem(at: fileURL)
    SecKeychainSetUserInteractionAllowed(false)
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                            kSecAttrService as String: service, kSecAttrAccount as String: account]
    SecItemDelete(q as CFDictionary)
  }

  private static func keychainRead(_ account: String) -> String? {
    SecKeychainSetUserInteractionAllowed(false)   // fail fast instead of waiting on a dialog nobody sees
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                            kSecAttrService as String: service, kSecAttrAccount as String: account,
                            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }
}
