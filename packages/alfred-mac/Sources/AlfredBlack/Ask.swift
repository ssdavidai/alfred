// 05 · The Ask — ⌘⇧A anywhere. One field, no tabs, no modes: Alfred sorts
// intent. He answers beneath a hairline with what he will do; ⏎ is "so
// ordered", ⇧⏎ sends without a read, ESC is never mind. On ⏎ the panel
// closes silently and the matter appears among those in flight.
import SwiftUI
import AppKit
import Carbon.HIToolbox

final class AskPanel: NSPanel {
  init(state: AppState) {
    super.init(contentRect: NSRect(x: 0, y: 0, width: 620, height: 64), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true; level = .floating; collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    backgroundColor = .clear; isOpaque = false; hasShadow = true; isMovableByWindowBackground = true
    appearance = NSAppearance(named: .darkAqua); hidesOnDeactivate = false; isReleasedWhenClosed = false
    contentViewController = NSHostingController(rootView: AskView().environmentObject(state))
  }
  override var canBecomeKey: Bool { true }
  /// Upper third of the screen the mouse is on, centred.
  func present() {
    guard let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main else { return }
    let f = screen.visibleFrame; let h = contentView?.fittingSize.height ?? 64
    setFrame(NSRect(x: f.midX - 310, y: f.minY + f.height * 0.62, width: 620, height: h), display: true)
    makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
  }
}

struct AskView: View {
  @EnvironmentObject var s: AppState
  @State private var text = ""
  @FocusState private var focused: Bool
  private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 14) {
        if let m = Brand.image("logo-brass.svg") { Image(nsImage: m).resizable().aspectRatio(contentMode: .fit).frame(height: 22) }
        TextField("What can I take off your desk, \(T.honorific)?", text: $text).textFieldStyle(.plain)
          .font(T.say(19)).foregroundColor(T.ink).focused($focused).disabled(s.asking)
          .onSubmit { submit(withoutRead: NSEvent.modifierFlags.contains(.shift)) }
        if s.asking { Meta(text: "one moment", color: T.dim) } else { Keycap(text: "ESC") }
      }.padding(.horizontal, 22).padding(.vertical, 18)
      if let r = s.askReply {
        Rectangle().fill(T.hair).frame(height: 1).padding(.horizontal, 22)
        Say(text: r, size: 16).padding(.horizontal, 22).padding(.top, 16)
        HStack(spacing: 22) {
          Meta(text: "⏎ so ordered", color: T.brass, tracking: 1.8)
          Meta(text: "⇧⏎ send without read", tracking: 1.8)
          Meta(text: "esc never mind", tracking: 1.8)
        }.padding(.horizontal, 22).padding(.top, 14).padding(.bottom, 18)
      }
    }
    .frame(width: 620)
    .background(RoundedRectangle(cornerRadius: T.rBar).fill(T.bg))
    .overlay(RoundedRectangle(cornerRadius: T.rBar).stroke(T.hair2, lineWidth: 1))
    .onAppear { focused = true }
    .onExitCommand { s.dismissAsk() }
    .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: s.askReply)
  }
  private func submit(withoutRead: Bool) {
    if s.askReply != nil { s.soOrdered(withoutRead: withoutRead); return }   // ⏎ on the answer executes
    let q = text; text = ""; guard !q.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    Task { await s.propose(q) }
  }
}

/// ⌘⇧A, system-wide, without accessibility permission (Carbon hot keys).
enum HotKey {
  private static var ref: EventHotKeyRef?
  static var onPress: (() -> Void)?
  static func register() {
    var id = EventHotKeyID(signature: OSType(0x414C4652), id: 1)   // "ALFR"
    RegisterEventHotKey(UInt32(kVK_ANSI_A), UInt32(cmdKey | shiftKey), id, GetApplicationEventTarget(), 0, &ref)
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in HotKey.onPress?(); return noErr }, 1, &spec, nil, nil)
  }
}
