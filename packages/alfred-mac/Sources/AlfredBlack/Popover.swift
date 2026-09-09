// 01 · The Glance — click the mark. One popover that swaps content; the
// silent state is the default state, and every screen renders meaningfully
// with zero items.
import SwiftUI
import AppKit

enum Screen { case glance, brief, matters, yourWord, ledger, vault, arrangement }

struct PopoverView: View {
  @EnvironmentObject var s: AppState
  var body: some View {
    ZStack { T.bg
      switch s.screen {
      case .brief: BriefView()
      default: GlanceView()
      }
    }
    .frame(width: T.popoverWidth)
    .animation(.easeInOut(duration: 0.15), value: s.screen)
  }
}

struct GlanceView: View {
  @EnvironmentObject var s: AppState
  private var greeting: String {
    let h = Calendar.current.component(.hour, from: Date())
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
  }
  private var line: String {
    let n = max(s.deskTotal, s.desk.count)
    if n == 0 { return "\(greeting), \(T.honorific). The desk is quiet — «nothing needs your word.»" }
    if n == 1 { return "\(greeting), \(T.honorific). The desk is quiet — «one matter needs your word.»" }
    return "\(greeting), \(T.honorific). «\(n) matters need your word.»"
  }
  private var returned: String {
    guard let h = s.narToday else { return "Today · in hand" }
    return h > 0.05 ? String(format: "Today · %.1f h returned", h) : String(format: "Today · net %.1f h", h)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Say(text: line).padding(.horizontal, 18).padding(.top, 20).padding(.bottom, 16)
      ForEach(Array(s.desk.prefix(3))) { item in
        PopRow(title: item.title, meta: "Your word", needsWord: true) { s.open(.yourWord) }
      }
      ForEach(Array(s.matters.prefix(max(0, 3 - min(3, s.desk.count))))) { m in
        PopRow(title: m.glanceTitle, meta: m.state == "done" ? "Done" : "In hand")
      }
      HStack {
        Meta(text: returned, tracking: 1.8)
        Spacer()
        Keycap(text: "⌘⇧A  ASK")
      }.padding(.horizontal, 18).padding(.vertical, 11)
    }
  }
}

/// 02 · The Brief — mornings, in the same popover, until read.
struct BriefView: View {
  @EnvironmentObject var s: AppState
  private func openBrief() { if let d = s.pairing?.domain, let u = URL(string: "https://\(d)/brief") { NSWorkspace.shared.open(u) } }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack { Meta(text: s.brief?.header ?? "The Brief", color: T.brass); Spacer(); Meta(text: s.brief?.composedTime ?? "") }
        .padding(.horizontal, 18).padding(.top, 15).padding(.bottom, 13)
      Rectangle().fill(T.hair).frame(height: 1)
      if let b = s.brief {
        let items = b.items
        Say(text: b.excerpt.isEmpty ? "Nothing pressing today, \(T.honorific). «Everything is in hand.»" : b.excerpt).padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 16)
        ForEach(Array(items.enumerated()), id: \.offset) { i, line in
          let dl = Brief.deadline(in: line)
          PopRow(title: line, meta: dl ?? (i == 0 ? "First" : "In hand"), needsWord: i == 0, metaBrass: dl != nil) { openBrief() }
        }
      } else {
        Say(text: "No brief has been composed yet, \(T.honorific).").padding(.horizontal, 18).padding(.vertical, 18)
      }
      HStack { Meta(text: "Everything else is in hand", tracking: 1.8); Spacer()
        Button(action: openBrief) { Keycap(text: "RETURN  OPEN") }.buttonStyle(.plain) }
        .padding(.horizontal, 18).padding(.vertical, 11)
    }
  }
}
