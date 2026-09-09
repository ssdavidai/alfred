// 00 · The Presence — a mark in the menu bar, nothing more. The white Alfred
// mark, 15 pt tall, as a template image so it holds on any menu bar; one
// brass dot (5 pt, to its right) when at least one matter needs the
// principal's word. No dot is total silence: no badge counts, no animation.
import AppKit

enum Presence {
  static let markHeight: CGFloat = 15
  static let dot: CGFloat = 5
  static let brass = AB.hex(0xB08D57)

  private static var mark: NSImage? = { let i = Brand.image("logo-white.svg", template: true); return i }()
  private static var markWidth: CGFloat { guard let m = mark, m.size.height > 0 else { return 12 } ; return (m.size.width / m.size.height * markHeight).rounded() }

  /// The status-item image. Silent: the mark alone, a template image. Attending:
  /// the mark in the menu bar's own text colour plus the brass dot, composed.
  static func image(needsWord: Bool, dark: Bool) -> NSImage {
    guard let m = mark else { return NSImage(size: NSSize(width: 14, height: markHeight)) }
    if !needsWord { let t = m.copy() as! NSImage; t.size = NSSize(width: markWidth, height: markHeight); t.isTemplate = true; return t }
    let gap: CGFloat = 5, w = markWidth + gap + dot, h = markHeight
    let img = NSImage(size: NSSize(width: w, height: h), flipped: false) { _ in
      let tint: NSColor = dark ? .white : .black
      m.draw(in: NSRect(x: 0, y: 0, width: markWidth, height: markHeight), from: .zero, operation: .sourceOver, fraction: 1)
      tint.setFill(); NSRect(x: 0, y: 0, width: markWidth, height: markHeight).fill(using: .sourceAtop)
      brass.setFill(); NSBezierPath(ovalIn: NSRect(x: markWidth + gap, y: (h - dot) / 2, width: dot, height: dot)).fill()
      return true
    }
    img.isTemplate = false; return img
  }
  static func line(deskCount: Int) -> String {
    deskCount == 0 ? "The desk is quiet." : deskCount == 1 ? "One matter needs your word." : "\(deskCount) matters need your word."
  }
}
