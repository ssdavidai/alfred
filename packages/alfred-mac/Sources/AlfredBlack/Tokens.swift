// The macOS app's own language, from the "Alfred for macOS" handoff: a dark
// wool ground, ivory ink, one brass accent, hairlines at 13–22% ivory; radii
// 13 (popover) · 14 (command bar) · 12 (window) · 6 (button). Alfred speaks
// in italic display serif; labels are mono, all caps, widely tracked.
import SwiftUI
import AppKit

enum T {
  static let bg    = Color(nsColor: AB.hex(0x1C1A17))   // oklch(0.17 0.005 60)
  static let bg2   = Color(nsColor: AB.hex(0x262320))
  static let bg3   = Color(nsColor: AB.hex(0x2F2B27))
  static let ink   = Color(nsColor: AB.hex(0xF0EADE))   // oklch(0.94 0.012 80)
  static let dim   = Color(nsColor: AB.hex(0xA49D8F))
  static let brass = Color(nsColor: AB.hex(0xB08D57))   // oklch(0.62 0.09 75)
  static let hair  = Color(nsColor: AB.hex(0xF0EADE, 0.13))
  static let hair2 = Color(nsColor: AB.hex(0xF0EADE, 0.22))
  static let popoverWidth: CGFloat = 400   // wider than the handoff's 344 so labels can be read
  static let rPopover: CGFloat = 13, rBar: CGFloat = 14, rWindow: CGFloat = 12, rButton: CGFloat = 6
  static let honorific = "sir"   // a per-user setting later; keep the string in one place

  /// Alfred's voice — display serif, italic.
  static func say(_ size: CGFloat = 15.5) -> Font { Font.custom("PlayfairDisplay-Italic", size: size) }
  static func title(_ size: CGFloat = 26) -> Font { Font.custom("PlayfairDisplayRoman-SemiBold", size: size) }
  static func body(_ size: CGFloat = 14, italic: Bool = false) -> Font { Font.custom(italic ? "EBGaramond-Italic" : "EBGaramond-Regular", size: size) }
  static func mono(_ size: CGFloat = 9, weight: Font.Weight = .bold) -> Font { Font.custom("JetBrains Mono", size: size).weight(weight) }
}

/// Mono microlabel: 9px w800, 0.24em tracking, uppercase.
struct Meta: View {
  let text: String; var color: Color = T.dim; var size: CGFloat = 9; var tracking: CGFloat = 2.2
  var body: some View { Text(text.uppercased()).font(T.mono(size, weight: .heavy)).tracking(tracking).foregroundColor(color).lineLimit(1) }
}

/// A keycap hint: mono 9px in a 1px hairline chip.
struct Keycap: View {
  let text: String
  var body: some View {
    Text(text).font(T.mono(9, weight: .bold)).tracking(0.9).foregroundColor(T.dim)
      .padding(.horizontal, 6).padding(.vertical, 2)
      .overlay(RoundedRectangle(cornerRadius: 4).stroke(T.hair2, lineWidth: 1))
  }
}

/// Alfred's line, with the clause that matters in brass. Mark the brass part with «…».
struct Say: View {
  let text: String; var size: CGFloat = 15.5
  var body: some View {
    let parts = text.components(separatedBy: "«")
    var t = Text(parts[0]).foregroundColor(T.ink)
    if parts.count > 1 {
      let rest = parts[1].components(separatedBy: "»")
      t = t + Text(rest[0]).foregroundColor(T.brass)
      if rest.count > 1 { t = t + Text(rest[1]).foregroundColor(T.ink) }
    }
    return t.font(T.say(size)).lineSpacing(size * 0.45 - 4).fixedSize(horizontal: false, vertical: true)
  }
}

/// Every screen names itself the same way, in the same place: the name in ink, the status beside it.
struct ScreenHeader: View {
  let name: String; var status: String = ""; var brass = false
  var body: some View {
    VStack(spacing: 0) {
      HStack(alignment: .firstTextBaseline) {
        Text(name.uppercased()).font(T.mono(10.5, weight: .heavy)).tracking(1.6).foregroundColor(T.ink)
        Spacer()
        if !status.isEmpty { Meta(text: status, color: brass ? T.brass : T.dim, size: 9, tracking: 1.4) }
      }.padding(.horizontal, 18).padding(.top, 15).padding(.bottom, 13)
      Rectangle().fill(T.hair).frame(height: 1)
    }
  }
}

/// The hand cursor over anything that can be clicked.
struct Pointer: ViewModifier {
  func body(content: Content) -> some View { content.onHover { if $0 { NSCursor.pointingHand.push() } else { NSCursor.pop() } } }
}
extension View { func pointer() -> some View { modifier(Pointer()) } }

/// One popover row: dot · title (body 14) · meta. Filled brass dot = needs the principal; hollow = in hand.
struct PopRow: View {
  let title: String; let meta: String; var needsWord = false; var metaBrass = false; var action: (() -> Void)? = nil
  @State private var hover = false
  var body: some View {
    Button(action: { action?() }) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Circle().fill(needsWord ? T.brass : Color.clear).overlay(Circle().stroke(needsWord ? Color.clear : T.dim, lineWidth: 1)).frame(width: 6, height: 6).alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 4 }
        Text(title).font(T.body(14)).foregroundColor(T.ink).lineSpacing(3).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
        Meta(text: meta, color: (needsWord || metaBrass) ? T.brass : T.dim, size: 8.5, tracking: 1.4)
      }
      .padding(.horizontal, 18).padding(.vertical, 12).contentShape(Rectangle())
      .background(hover ? T.bg2 : Color.clear)
    }.buttonStyle(.plain).onHover { hover = $0 }.pointer().accessibilityLabel("\(title), \(meta)")
    Rectangle().fill(T.hair).frame(height: 1)
  }
}

/// A ghost or brass button, mono 9px w800, 0.2em tracking, 6px radius.
struct PopButton: ButtonStyle {
  var primary = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(T.mono(9, weight: .heavy)).tracking(1.8).textCase(.uppercase)
      .padding(.horizontal, 16).padding(.vertical, 9)
      .foregroundColor(primary ? T.bg : T.ink)
      .background(RoundedRectangle(cornerRadius: T.rButton).fill(primary ? T.brass : Color.clear))
      .overlay(RoundedRectangle(cornerRadius: T.rButton).stroke(primary ? T.brass : T.hair2, lineWidth: 1))
      .opacity(configuration.isPressed ? 0.8 : 1)
  }
}
