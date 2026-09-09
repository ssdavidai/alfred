// The presence in the menu bar — from the design system's "Alfred Pet"
// exploration: a creature of few pixels, wool black with one brass accent,
// a monocle instead of a cursor. It sits in a corner, never speaks first,
// and brass appears only when something needs you. No badge counts, no
// bubbles, no bouncing; it blinks perhaps once a minute.
import AppKit

enum PetState { case present, attending, resting }

enum Pet {
  // The exploration's palette: wool lifted to charcoal-taupe so the silhouette holds on any menu bar.
  static let palette: [Character: NSColor] = [
    "O": AB.hex(0x3B342A), "K": AB.hex(0x4A4236), "H": AB.hex(0x5A5143), "S": AB.hex(0x3F382E),
    "T": AB.hex(0x26211B), "P": AB.hex(0xF2EDE1), "B": AB.hex(0xC69A55), "D": AB.hex(0x9A7440), "G": AB.hex(0x6E6558),
  ]
  /// 2A — the Top Hat at 32 × 39, the recommended form.
  static let topHat: [String] = [
    "..........OOOOOOOOOOOO..........", ".........OKKKKKKKKKKKKO.........", ".........OKHKKKKKKKKKKO.........",
    ".........OKHKKKKKKKKKKO.........", ".........OKKKKKKKKKKKKO.........", ".........OBBBBBBBBBBBBO.........",
    ".........ODDDDDDDDDDDDO.........", ".........OKKKKKKKKKKKKO.........", "...OKKKKKKKKKKKKKKKKKKKKKKKKO...",
    "....OSSSSSSSSSSSSSSSSSSSSSSO....", "........OKKKKKKKKKKKKKKO........", ".......OKKKKKKKKKKKKKKKKO.......",
    "......OKKKKKKKKKKKKKKKKKKO......", "......OKKTTTTTTTTTTTTTTKKO......", "......OKKTTTTTTTTTBBBTTKKO......",
    "......OKKTTPPTTTTBTPTBTKKO......", "......OKKTTTTPPTTBTTTBTKKO......", "......OKKTTPPTTTTBTTTBTKKO......",
    "......OKKTTTTTTTTTBBBTTKKO......", "......OKKTTTTTTTTTTTTDTKKO......", "......OKKTTTTTTTTTTTTTTKKO......",
    ".......OKKKKKKKKKKKKKKDKO.......", "........OKKKKKKKKKKKKKKO........", "..........OKKKKKKKKKKO..........",
    ".........OKPPKKKKKKPPKO.........", ".........OKKKBBDDBBKKKO.........", ".........OKKKBBDDBBKKKO.........",
    ".......OKKKKKKKKKKKKKKKKO.......", ".....OKKKKKKKKKKKKKKKKKKKKO.....", ".....OKKKKKKKKKKKKKKKKKKKKO.....",
    ".....OKKKKKKKKKKKKKKKKKKKKO.....", "......OKKKKKKKKKKKKKKKKKKO......", ".......OKKKKKKKKKKKKKKKKO.......",
    "........OKKKKKKKKKKKKKKO........", ".........OKKKKO..OKKKKO.........", ".........OKKKKO..OKKKKO.........",
    ".........OKKKKO..OKKKKO.........", "........OKKKKKO..OKKKKKO........", "........OOOOOOO..OOOOOOO........",
  ]
  static func cells(for state: PetState, blink: Bool) -> [[Character]] {
    var m = topHat.map { Array($0) }
    func set(_ r: Int, _ c: Int, _ ch: Character) { if r < m.count, c < m[r].count { m[r][c] = ch } }
    if state == .resting || blink {                       // eyes to dim dashes (rows 15–17 hold the P cells)
      for r in 15...17 { for c in 10...15 where m[r][c] == "P" { m[r][c] = state == .resting ? "G" : "T" } }
    }
    if state == .resting {                                // the monocle dims too
      for r in 14...19 { for c in 16...22 where m[r][c] == "B" || m[r][c] == "D" { m[r][c] = "G" } }
    }
    if state == .attending {                              // one brass dot, top right; a glint in the monocle
      for (r, row) in [".BB.", "BBBB", "BBBB", ".BB."].enumerated() { for (i, ch) in row.enumerated() where ch != "." { set(1 + r, 26 + i, ch) } }
      set(16, 19, "P")
    }
    return m
  }
  /// The image for the status item; `scale` is points per cell (0.5 → 16 × 19.5 pt, crisp on Retina).
  static func image(_ state: PetState, blink: Bool = false, scale: CGFloat = 0.5) -> NSImage {
    let m = cells(for: state, blink: blink); let w = m[0].count, h = m.count
    let img = NSImage(size: NSSize(width: CGFloat(w) * scale, height: CGFloat(h) * scale), flipped: true) { _ in
      for (y, row) in m.enumerated() { for (x, ch) in row.enumerated() { guard let c = palette[ch] else { continue }
        c.setFill(); NSRect(x: CGFloat(x) * scale, y: CGFloat(y) * scale, width: scale, height: scale).fill() } }
      return true
    }
    img.isTemplate = false; return img
  }
  /// Quiet hours: the pet rests, and brass never appears. Local time, 23:00–07:00.
  static func isQuiet(_ d: Date = Date()) -> Bool { let h = Calendar.current.component(.hour, from: d); return h >= 23 || h < 7 }
  static func line(_ state: PetState, deskCount: Int) -> String {
    switch state {
    case .resting: return "Resting — quiet hours."
    case .attending: return deskCount == 1 ? "Attending — one matter on the Desk." : "Attending — \(deskCount) matters on the Desk."
    case .present: return "Present — no urgent action is required."
    }
  }
}
