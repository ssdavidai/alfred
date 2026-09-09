// 07 · The Statement — the only real window (⌘⇧S). A month of attention,
// after every cost: hours returned in brass, and the three bars — displaced,
// your time, net. "Read it sceptically, sir — every line is traceable."
import SwiftUI
import AppKit

struct MonthStatement { var month: String; var returned: Double; var displaced: Double; var engaged: Double }

final class StatementWindow: NSWindow {
  init(state: AppState) {
    super.init(contentRect: NSRect(x: 0, y: 0, width: 520, height: 420), styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
    title = "Attention Statement"; titlebarAppearsTransparent = true; titleVisibility = .hidden
    appearance = NSAppearance(named: .darkAqua); backgroundColor = AB.hex(0x1C1A17); isReleasedWhenClosed = false
    contentViewController = NSHostingController(rootView: StatementView().environmentObject(state))
    center()
  }
}

struct StatementView: View {
  @EnvironmentObject var s: AppState
  private func openPDF() { if let d = s.pairing?.domain, let u = URL(string: "https://\(d)/attention") { NSWorkspace.shared.open(u) } }
  private func bar(_ label: String, _ hours: Double, max: Double, hatched: Bool = false) -> some View {
    let h = max > 0 ? CGFloat(hours / max) * 120 : 0
    return VStack(spacing: 8) {
      ZStack(alignment: .bottom) {
        Rectangle().fill(Color.clear).frame(width: 40, height: 120)
        if hatched {
          Rectangle().fill(T.ink.opacity(0.18)).frame(width: 40, height: h)
            .overlay(HatchOverlay().clipped().frame(width: 40, height: h))
        } else { Rectangle().fill(T.brass).frame(width: 40, height: h) }
      }
      Meta(text: label, size: 8, tracking: 1.4).fixedSize()
      Meta(text: String(format: "%.1f h", hours), color: T.ink, size: 8.5, tracking: 1.2).fixedSize()
    }.frame(width: 64)
  }
  var body: some View {
    let st = s.statement
    VStack(spacing: 0) {
      Meta(text: "Attention statement · \(st?.month ?? "—")", color: T.brass, tracking: 2.6).padding(.top, 40)
      HStack(alignment: .bottom, spacing: 16) {
        VStack(alignment: .leading, spacing: 8) {
          Text(st.map { String(format: "%.1f h", $0.returned) } ?? "—").font(T.title(54)).foregroundColor(T.brass).kerning(-1.1)
          Meta(text: "Returned · after every cost", size: 8.5, tracking: 1.3).fixedSize()
        }.fixedSize()
        Spacer()
        if let st {
          let m = Swift.max(st.displaced, st.engaged, st.returned, 1)
          HStack(alignment: .bottom, spacing: 6) { bar("Displaced", st.displaced, max: m); bar("Your time", st.engaged, max: m, hatched: true); bar("Net", st.returned, max: m) }
        }
      }.padding(.horizontal, 44).padding(.top, 36)
      Spacer()
      Rectangle().fill(T.hair).frame(height: 1).padding(.horizontal, 44)
      HStack {
        Say(text: "Read it sceptically, \(T.honorific) — «every line is traceable.»", size: 14.5)
        Spacer()
        Button(action: openPDF) { Keycap(text: "⌘E  PDF") }.buttonStyle(.plain).keyboardShortcut("e", modifiers: [.command])
      }.padding(.horizontal, 44).padding(.vertical, 22)
    }
    .frame(width: 520, height: 420).background(T.bg)
  }
}

/// Diagonal ivory hatching — "your time", drawn, not filled.
struct HatchOverlay: View {
  var body: some View {
    Canvas { ctx, size in
      var p = Path(); var x: CGFloat = -size.height
      while x < size.width { p.move(to: CGPoint(x: x, y: size.height)); p.addLine(to: CGPoint(x: x + size.height, y: 0)); x += 6 }
      ctx.stroke(p, with: .color(Color(nsColor: AB.hex(0xF0EADE, 0.55))), lineWidth: 1)
    }
  }
}
