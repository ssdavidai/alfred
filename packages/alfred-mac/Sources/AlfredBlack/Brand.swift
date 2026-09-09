// The brand's own material: 17 engraved monoline icons (32px box, 1.1px
// stroke, currentColor), the silhouette marks, the pressed-"A" seal, and the
// paper/wool grain — from design-system/assets, shipped in Resources/Brand.
import SwiftUI
import AppKit

enum Brand {
  static var dir: URL? {
    for b in [Bundle.module.resourceURL, Bundle.main.resourceURL].compactMap({ $0 }) {
      let u = b.appendingPathComponent("Brand"); if FileManager.default.fileExists(atPath: u.path) { return u }
    }
    return nil
  }
  static let icons: [String: String] = {
    guard let d = dir, let data = try? Data(contentsOf: d.appendingPathComponent("icons.json")),
          let j = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return [:] }
    return j
  }()
  private static var cache: [String: NSImage] = [:]
  /// An engraved icon as a template image, so it inherits the text colour.
  static func icon(_ name: String) -> NSImage? {
    if let c = cache[name] { return c }
    guard let svg = icons[name], let img = NSImage(data: Data(svg.utf8)) else { return nil }
    img.isTemplate = true; cache[name] = img; return img
  }
  static func image(_ file: String, template: Bool = false) -> NSImage? {
    guard let d = dir, let img = NSImage(contentsOf: d.appendingPathComponent(file)) else { return nil }
    img.isTemplate = template; return img
  }
}

/// `ABIcon("pocket_watch", 16)` — small, tinted via foregroundColor; never a hero illustration.
struct ABIcon: View {
  let name: String; var size: CGFloat = 16; var color: Color = AB.marginalia
  init(_ name: String, _ size: CGFloat = 16, color: Color = AB.marginalia) { self.name = name; self.size = size; self.color = color }
  var body: some View {
    if let img = Brand.icon(name) {
      Image(nsImage: img).renderingMode(.template).resizable().interpolation(.high)
        .frame(width: size, height: size).foregroundColor(color)
    } else { Color.clear.frame(width: size, height: size) }
  }
}

/// The fine grain that makes paper and wool feel like stock, not screen.
struct Grain: View {
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    if let img = Brand.image(scheme == .dark ? "wool-grain.png" : "paper-grain.png") {
      Image(nsImage: img).resizable(resizingMode: .tile)
        .opacity(scheme == .dark ? 0.35 : 0.5).blendMode(scheme == .dark ? .screen : .multiply).allowsHitTesting(false)
    }
  }
}

/// The pressed "A" that signs a surface — a watermark in the lower-right gutter, 7%.
struct Seal: View {
  var size: CGFloat = 140; var opacity: Double = 0.07
  var body: some View {
    if let img = Brand.image("seal.svg", template: true) {
      Image(nsImage: img).renderingMode(.template).resizable().frame(width: size, height: size)
        .foregroundColor(AB.ink).opacity(opacity).allowsHitTesting(false)
    }
  }
}
