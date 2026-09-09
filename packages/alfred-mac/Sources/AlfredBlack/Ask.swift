// 05 · The Ask — ⌘⇧A anywhere. One field, no tabs, no modes: Alfred sorts
// intent. He answers beneath a hairline with what he will do; ⏎ is "so
// ordered", ⇧⏎ sends without a read, ESC is never mind. On ⏎ the panel
// closes silently and the matter appears among those in flight.
import SwiftUI
import AppKit
import Carbon.HIToolbox

/// The screen dims behind the bar; a click on the dimness is "never mind".
final class Backdrop: NSWindow {
  var onClick: (() -> Void)?
  init() {
    super.init(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: false)
    backgroundColor = NSColor.black.withAlphaComponent(0.42); isOpaque = false; hasShadow = false
    level = .floating; collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]; ignoresMouseEvents = false; isReleasedWhenClosed = false
  }
  override func mouseDown(with event: NSEvent) { onClick?() }
}

final class AskPanel: NSPanel {
  let backdrop = Backdrop()
  init(state: AppState) {
    super.init(contentRect: NSRect(x: 0, y: 0, width: 700, height: 76), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true; level = .floating; collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    backgroundColor = .clear; isOpaque = false; hasShadow = true; isMovableByWindowBackground = true
    appearance = NSAppearance(named: .darkAqua); hidesOnDeactivate = false; isReleasedWhenClosed = false
    contentViewController = NSHostingController(rootView: AskView().environmentObject(state))
    backdrop.onClick = { [weak state] in state?.dismissAsk() }
  }
  override var canBecomeKey: Bool { true }
  /// Over a dimmed screen — the one the mouse is on — centred, upper third.
  func present() {
    guard let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main else { return }
    backdrop.setFrame(screen.frame, display: true); backdrop.alphaValue = 0; backdrop.orderFront(nil)
    let f = screen.visibleFrame; let h = contentView?.fittingSize.height ?? 76
    setFrame(NSRect(x: f.midX - 350, y: f.minY + f.height * 0.62, width: 700, height: h), display: true)
    alphaValue = 0; makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    NSAnimationContext.runAnimationGroup { c in c.duration = 0.16; backdrop.animator().alphaValue = 1; animator().alphaValue = 1 }
  }
  override func orderOut(_ sender: Any?) { backdrop.orderOut(sender); super.orderOut(sender) }
}

/// The bar's material — translucent over whatever is behind, like a system overlay.
struct Vibrancy: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let v = NSVisualEffectView(); v.material = .hudWindow; v.blendingMode = .behindWindow; v.state = .active
    v.wantsLayer = true; v.layer?.cornerRadius = 18; v.layer?.masksToBounds = true; return v
  }
  func updateNSView(_ v: NSVisualEffectView, context: Context) {}
}

struct AskView: View {
  @EnvironmentObject var s: AppState
  @State private var text = ""
  @FocusState private var focused: Bool
  private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 16) {
        if let m = Brand.image("logo-brass.svg") {
          Image(nsImage: m).resizable().aspectRatio(contentMode: .fit).frame(height: 26)
            .shadow(color: T.brass.opacity(0.55), radius: 10)   // the mark glows, faintly
        }
        TextField("What can I take off your desk, \(T.honorific)?", text: $text).textFieldStyle(.plain)
          .font(T.say(21)).foregroundColor(T.ink).focused($focused).disabled(s.asking)
          .onSubmit { submit(withoutRead: NSEvent.modifierFlags.contains(.shift)) }
        if s.asking { Waiting() } else { Keycap(text: "ESC") }
      }.padding(.horizontal, 24).padding(.vertical, 22)
      if s.askReply == nil && !s.asking {
        Meta(text: "⏎ to ask · Alfred proposes before he acts", size: 8.5, tracking: 1.2).padding(.horizontal, 24).padding(.bottom, 14)
      }
      if let r = s.askReply {
        Rectangle().fill(T.hair).frame(height: 1).padding(.horizontal, 24)
        Say(text: r, size: 17).padding(.horizontal, 24).padding(.top, 16)
        HStack(spacing: 22) {
          Meta(text: "⏎ so ordered", color: T.brass, tracking: 1.8)
          Meta(text: "⇧⏎ send without read", tracking: 1.8)
          Meta(text: "esc never mind", tracking: 1.8)
        }.padding(.horizontal, 22).padding(.top, 14).padding(.bottom, 18)
      }
    }
    .frame(width: 700)
    .background(ZStack { Vibrancy(); RoundedRectangle(cornerRadius: 18).fill(T.bg.opacity(0.72)) })
    .overlay(RoundedRectangle(cornerRadius: 18).stroke(T.hair2, lineWidth: 1))
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
  private static var refs: [EventHotKeyRef?] = [nil, nil]
  static var onPress: (() -> Void)?          // ⌘⇧A
  static var onStatement: (() -> Void)?      // ⌘⇧S
  static func register() {
    var a = EventHotKeyID(signature: OSType(0x414C4652), id: 1)   // "ALFR"
    var b = EventHotKeyID(signature: OSType(0x414C4652), id: 2)
    RegisterEventHotKey(UInt32(kVK_ANSI_A), UInt32(cmdKey | shiftKey), a, GetApplicationEventTarget(), 0, &refs[0])
    RegisterEventHotKey(UInt32(kVK_ANSI_S), UInt32(cmdKey | shiftKey), b, GetApplicationEventTarget(), 0, &refs[1])
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
      var id = EventHotKeyID(); GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
      if id.id == 2 { HotKey.onStatement?() } else { HotKey.onPress?() }; return noErr
    }, 1, &spec, nil, nil)
  }
}
