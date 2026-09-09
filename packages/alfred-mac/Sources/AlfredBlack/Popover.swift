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
      case .matters: MattersView()
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

/// 03 · Matters — work in flight. At most five; older matters live in the Ledger.
struct MattersView: View {
  @EnvironmentObject var s: AppState
  private func blocked(_ m: Matter) -> Bool {
    let refs = Set(s.desk.compactMap { $0.matter_ref })
    return refs.contains(where: { $0.contains(m.id) || (m.path.map { $0.contains(m.id) } ?? false) && $0 == m.path })
  }
  private func meta(_ m: Matter) -> String {
    if blocked(m) { return "Blocked on you" }
    switch m.state ?? "" { case "done": return "Done"; case "waiting": return "Waiting"; case "dormant": return "Dormant"; default: return "In flight" }
  }
  private var inFlight: [Matter] { s.matters.filter { ($0.state ?? "active") != "done" } }
  private var overdue: Int {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; let today = f.string(from: Date())
    return inFlight.filter { ($0.next ?? "").count >= 10 && String($0.next!.prefix(10)) < today }.count
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack { Meta(text: "Matters · \(inFlight.count) in flight", color: T.brass); Spacer(); Meta(text: "L\(s.trust) trust") }
        .padding(.horizontal, 18).padding(.top, 15).padding(.bottom, 13)
      Rectangle().fill(T.hair).frame(height: 1)
      if inFlight.isEmpty {
        Say(text: "Nothing in flight, \(T.honorific). «The desk is clear.»").padding(.horizontal, 18).padding(.vertical, 18)
      }
      ForEach(Array(inFlight.prefix(5))) { m in
        let b = blocked(m)
        VStack(alignment: .leading, spacing: 0) {
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            Circle().fill(b ? T.brass : Color.clear).overlay(Circle().stroke(b ? Color.clear : T.dim, lineWidth: 1)).frame(width: 6, height: 6).alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 4 }
            VStack(alignment: .leading, spacing: 3) {
              Text(m.title).font(T.body(14)).foregroundColor(T.ink).lineLimit(1)
              if !m.subline.isEmpty { Text(m.subline).font(T.body(11.5, italic: true)).foregroundColor(T.dim).lineLimit(2) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            Meta(text: meta(m), color: b ? T.brass : T.dim, size: 8.5, tracking: 1.4)
          }.padding(.horizontal, 18).padding(.vertical, 12)
          Rectangle().fill(T.hair).frame(height: 1)
        }
      }
      HStack { Meta(text: overdue == 0 ? "Nothing overdue" : "\(overdue) past due", color: overdue == 0 ? T.dim : T.brass, tracking: 1.8); Spacer()
        Button(action: { s.open(.ledger) }) { Keycap(text: "⌘L  LEDGER") }.buttonStyle(.plain) }
        .padding(.horizontal, 18).padding(.vertical, 11)
    }
  }
}
