// Only escalations may notify. Everything else waits silently in the popover.
import Foundation
import UserNotifications

enum Notify {
  private static var asked = false
  static func yourWord(_ headline: String) {
    let c = UNUserNotificationCenter.current()
    let post = {
      let n = UNMutableNotificationContent(); n.title = "Your word, \(T.honorific)."; n.body = headline; n.sound = nil
      c.add(UNNotificationRequest(identifier: "your-word-\(Int(Date().timeIntervalSince1970))", content: n, trigger: nil))
    }
    if asked { post(); return }
    asked = true
    c.requestAuthorization(options: [.alert]) { ok, _ in if ok { post() } }
  }
}
