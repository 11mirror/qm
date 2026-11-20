import Foundation
import os

enum Log {
  static let background = Logger(subsystem: "org.qm", category: "background")
  static let drafts = Logger(subsystem: "org.qm", category: "drafts")
  static let decoding = Logger(subsystem: "org.qm", category: "decoding")
}

extension Logger {
  func failure(_ action: String, _ error: Error) {
    guard !(error is CancellationError), (error as? URLError)?.code != .cancelled
    else { return }
    self.error(
      "\(action, privacy: .public) failed: \(String(describing: error), privacy: .public)")
  }
}

extension FileManager {
  func removeItemIfPresent(at url: URL, action: String) {
    do {
      try removeItem(at: url)
    } catch let error as CocoaError where error.code == .fileNoSuchFile {
    } catch {
      Log.background.failure(action, error)
    }
  }
}

extension KeyedDecodingContainer {
  func logged<T: Decodable>(_ type: T.Type, forKey key: Key) -> T? {
    do {
      return try decodeIfPresent(type, forKey: key)
    } catch {
      Log.decoding.failure("Decoding \(key.stringValue)", error)
      return nil
    }
  }
}
