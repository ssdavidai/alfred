// Credentials live in the login Keychain, never on disk in plaintext.
import Foundation
import Security

enum Keychain {
  static let service = "black.alfred.mac"

  static func set(_ value: String, account: String) -> Bool {
    let data = Data(value.utf8)
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                            kSecAttrService as String: service,
                            kSecAttrAccount as String: account]
    SecItemDelete(q as CFDictionary)
    var add = q
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }

  static func get(_ account: String) -> String? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                            kSecAttrService as String: service,
                            kSecAttrAccount as String: account,
                            kSecReturnData as String: true,
                            kSecMatchLimit as String: kSecMatchLimitOne]
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
          let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }

  static func delete(_ account: String) {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                            kSecAttrService as String: service,
                            kSecAttrAccount as String: account]
    SecItemDelete(q as CFDictionary)
  }
}
