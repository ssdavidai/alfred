// Alfred Black design system, as SwiftUI tokens.
// Source of truth: design-system/tokens/*.css (ivory paper, wool black, ink,
// one brass accent, radius 0, hairline rules, Playfair / EB Garamond /
// JetBrains Mono). No emoji, no shadows, no second accent.
import SwiftUI
import AppKit
import CoreText

enum AB {
  // A dark mode inverts ink and paper while brass holds (design-system readme).
  static func dyn(_ light: NSColor, _ dark: NSColor) -> Color {
    Color(nsColor: NSColor(name: nil) { a in a.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light })
  }
  static func hex(_ v: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((v >> 16) & 0xFF)/255, green: CGFloat((v >> 8) & 0xFF)/255, blue: CGFloat(v & 0xFF)/255, alpha: alpha)
  }
  static let paper      = dyn(hex(0xF4EFE6), hex(0x0B0B0B))          // the ground
  static let wool       = Color(nsColor: hex(0x0B0B0B))               // wool is always dark and never theme-swaps
  static let ink        = dyn(hex(0x1A1A1A), hex(0xF4EFE6))
  static let brass      = dyn(hex(0xA8843A), hex(0xC69A55))
  static let marginalia = dyn(hex(0x5C5A55), hex(0x9A958C))
  static let rule       = dyn(hex(0x1A1A1A, 0.55), hex(0xF4EFE6, 0.35))
  static let border     = dyn(hex(0x1A1A1A, 0.18), hex(0xF4EFE6, 0.18))
  static let oxblood    = dyn(hex(0x6B1F1A), hex(0xB5524A))
  static let billiard   = dyn(hex(0x2E6B45), hex(0x5E9C76))

  /// Playfair ships as two variable faces; CoreText exposes named instances
  /// (PlayfairDisplayRoman-Black, PlayfairDisplayItalic-Black, …), so ask for one by name.
  static func display(_ size: CGFloat, italic: Bool = false, weight: Font.Weight = .bold) -> Font {
    let w: String = weight == .black ? "Black" : weight == .bold ? "Bold" : weight == .semibold ? "SemiBold" : weight == .medium ? "Medium" : ""
    let name = w.isEmpty ? (italic ? "PlayfairDisplay-Italic" : "PlayfairDisplay-Regular")
                         : (italic ? "PlayfairDisplayItalic-" : "PlayfairDisplayRoman-") + w
    return Font.custom(name, size: size)
  }
  static func body(_ size: CGFloat = 17, italic: Bool = false) -> Font {
    Font.custom(italic ? "EB Garamond Italic" : "EB Garamond", size: size)
  }
  static func mono(_ size: CGFloat = 11, weight: Font.Weight = .medium) -> Font {
    Font.custom("JetBrains Mono", size: size).weight(weight)
  }

  /// Register the bundled OFL faces so `Font.custom` resolves outside an
  /// installed .app too (e.g. `swift run` during development).
  static func registerFonts() {
    let candidates: [URL] = [
      Bundle.module.resourceURL?.appendingPathComponent("Fonts"),
      Bundle.main.resourceURL?.appendingPathComponent("Fonts"),
    ].compactMap { $0 }
    for dir in candidates {
      guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { continue }
      for f in files where f.pathExtension.lowercased() == "ttf" {
        CTFontManagerRegisterFontsForURL(f as CFURL, .process, nil)
      }
    }
  }
}

/// Uppercase mono label with the design system's tracking — the "machine truth" voice.
struct Label_: View {
  let text: String
  var color: Color = AB.marginalia
  var body: some View {
    Text(text.uppercased()).font(AB.mono(10, weight: .bold)).tracking(2.2).foregroundColor(color)
  }
}

/// A hairline rule. Structure is drawn with rules, not cards.
struct Hairline: View {
  var brass = false
  var body: some View { Rectangle().fill(brass ? AB.brass : AB.rule).frame(height: 1) }
}

/// The one button style: sharp corners, ink border, inverted when primary.
struct ABButton: ButtonStyle {
  var primary = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(AB.mono(11, weight: .bold)).tracking(1.6)
      .fixedSize().padding(.horizontal, 14).padding(.vertical, 8)
      .foregroundColor(primary ? AB.paper : AB.ink)
      .background(primary ? AB.ink : AB.paper)
      .overlay(Rectangle().stroke(AB.ink, lineWidth: 1.5))
      .opacity(configuration.isPressed ? 0.85 : 1)
  }
}

struct ABField: ViewModifier {
  func body(content: Content) -> some View {
    content
      .textFieldStyle(.plain)
      .font(AB.mono(13))
      .foregroundColor(AB.ink)
      .padding(.horizontal, 10).padding(.vertical, 8)
      .background(AB.paper)
      .overlay(Rectangle().stroke(AB.border, lineWidth: 1))
  }
}
extension View { func abField() -> some View { modifier(ABField()) } }
