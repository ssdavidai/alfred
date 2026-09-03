// Alfred Black design system, as SwiftUI tokens.
// Source of truth: design-system/tokens/*.css (ivory paper, wool black, ink,
// one brass accent, radius 0, hairline rules, Playfair / EB Garamond /
// JetBrains Mono). No emoji, no shadows, no second accent.
import SwiftUI
import AppKit
import CoreText

enum AB {
  static let paper      = Color(red: 0xF4/255, green: 0xEF/255, blue: 0xE6/255)
  static let wool       = Color(red: 0x0B/255, green: 0x0B/255, blue: 0x0B/255)
  static let ink        = Color(red: 0x1A/255, green: 0x1A/255, blue: 0x1A/255)
  static let brass      = Color(red: 0xA8/255, green: 0x84/255, blue: 0x3A/255)
  static let marginalia = Color(red: 0x5C/255, green: 0x5A/255, blue: 0x55/255)
  static let rule       = Color(red: 0x1A/255, green: 0x1A/255, blue: 0x1A/255).opacity(0.55)
  static let border     = Color(red: 0x1A/255, green: 0x1A/255, blue: 0x1A/255).opacity(0.18)
  static let oxblood    = Color(red: 0x6B/255, green: 0x1F/255, blue: 0x1A/255)
  static let billiard   = Color(red: 0x2E/255, green: 0x6B/255, blue: 0x45/255)

  static func display(_ size: CGFloat, italic: Bool = false, weight: Font.Weight = .bold) -> Font {
    Font.custom(italic ? "Playfair Display Italic" : "Playfair Display", size: size).weight(weight)
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
