import Foundation
import Security

struct SessionVault {
  let account: String

  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "org.qm.portal-session",
      kSecAttrAccount as String: account,
    ]
  }

  func read() throws -> String? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw QMError.message("Could not securely read your session (Keychain status \(status)).")
    }
    guard let token = String(data: data, encoding: .utf8) else {
      throw QMError.message("The securely saved session is not valid UTF-8.")
    }
    return token
  }

  func write(_ token: String) throws {
    let data = Data(token.utf8)
    let status = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var request = query
      request[kSecValueData as String] = data
      request[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      let addStatus = SecItemAdd(request as CFDictionary, nil)
      guard addStatus == errSecSuccess else {
        throw QMError.message(
          "Could not securely save your session (Keychain status \(addStatus)).")
      }
    } else if status != errSecSuccess {
      throw QMError.message("Could not securely update your session (Keychain status \(status)).")
    }
  }

  func delete() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw QMError.message("Could not securely delete your session (Keychain status \(status)).")
    }
  }
}
