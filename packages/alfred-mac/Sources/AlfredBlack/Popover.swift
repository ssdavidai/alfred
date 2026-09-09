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
      case .yourWord: YourWordView()
      case .ledger: LedgerView()
      case .vault: VaultView()
      case .arrangement: ArrangementView()
      default: GlanceView()
      }
    }
    .background(   // the screens' keys: ⌘G glance · ⌘B brief · ⌘M matters · ⌘L ledger · ⌘V vault · ⌘, arrangement
      Group {
        Button("") { s.open(.glance) }.keyboardShortcut("g", modifiers: [.command])
        Button("") { s.open(.brief) }.keyboardShortcut("b", modifiers: [.command])
        Button("") { s.open(.matters) }.keyboardShortcut("m", modifiers: [.command])
        Button("") { s.open(.ledger) }.keyboardShortcut("l", modifiers: [.command])
        Button("") { s.open(.vault) }.keyboardShortcut("v", modifiers: [.command])
        Button("") { s.open(.arrangement) }.keyboardShortcut(",", modifiers: [.command])
        Button("") { if !s.desk.isEmpty { s.open(.yourWord) } }.keyboardShortcut("w", modifiers: [.command])
      }.opacity(0).frame(width: 0, height: 0))
    .frame(width: s.screen == .arrangement ? 380 : T.popoverWidth)
    .overlay(RoundedRectangle(cornerRadius: T.rPopover).stroke(T.brass.opacity(s.screen == .yourWord ? 0.5 : 0), lineWidth: 1))
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

/// 04 · Your Word — an escalation, one decision. The border shifts to brass.
struct YourWordView: View {
  @EnvironmentObject var s: AppState
  private var card: DeskItem? { s.wordIndex < s.desk.count ? s.desk[s.wordIndex] : nil }
  private func when(_ ts: String?) -> String {
    guard let ts, let d = ISO8601DateFormatter().date(from: ts) ?? { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.date(from: ts) }() else { return "" }
    let f = DateFormatter(); f.dateFormat = "d MMM"; return f.string(from: d)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack { Meta(text: "Your word, \(T.honorific)", color: T.brass); Spacer(); Meta(text: "\(min(s.wordIndex + 1, max(1, s.desk.count))) of \(max(s.desk.count, 1))") }
        .padding(.horizontal, 18).padding(.top, 15).padding(.bottom, 13)
      Rectangle().fill(T.hair).frame(height: 1)
      if let c = card {
        Say(text: c.title, size: 15.5).padding(.horizontal, 18).padding(.top, 18)
        if !c.body.isEmpty && c.body != c.title {
          Text(c.body).font(T.body(13.5)).foregroundColor(T.dim).lineSpacing(3).lineLimit(6).padding(.horizontal, 18).padding(.top, 10).fixedSize(horizontal: false, vertical: true)
        }
        HStack(spacing: 8) {
          Meta(text: (c.target_kind ?? "matter"), size: 8.5, tracking: 1.4); Meta(text: "·", size: 8.5); Meta(text: when(c.created), size: 8.5, tracking: 1.4); Spacer()
          Button(action: { if let d = s.pairing?.domain, let u = URL(string: "https://\(d)/desk") { NSWorkspace.shared.open(u) } }) { Meta(text: "Desk ⏎", color: T.brass, size: 8.5, tracking: 1.4) }.buttonStyle(.plain)
        }.padding(.horizontal, 18).padding(.top, 14)
        HStack(spacing: 8) {
          Spacer()
          Button("Hold") { Task { await s.decide("defer") } }.buttonStyle(PopButton()).keyboardShortcut(.escape, modifiers: [])
          Button("Myself") { Task { await s.decide("take_mine") } }.buttonStyle(PopButton()).keyboardShortcut(.return, modifiers: [.command])
          Button("So ordered") { Task { await s.decide("delegate") } }.buttonStyle(PopButton(primary: true)).keyboardShortcut(.return, modifiers: [])
        }.padding(.horizontal, 18).padding(.vertical, 16).disabled(s.deciding)
      } else {
        Say(text: "Nothing needs your word, \(T.honorific). «The desk is quiet.»").padding(.horizontal, 18).padding(.vertical, 18)
      }
    }
  }
}

/// 08 · The Ledger — history, append-only. No edit or delete affordance anywhere.
struct LedgerView: View {
  @EnvironmentObject var s: AppState
  private func openAudit() { if let d = s.pairing?.domain, let u = URL(string: "https://\(d)/decisions") { NSWorkspace.shared.open(u) } }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack { Meta(text: "The Ledger · today", color: T.brass); Spacer(); Button(action: openAudit) { Meta(text: "Open ⌘F") }.buttonStyle(.plain) }
        .padding(.horizontal, 18).padding(.top, 15).padding(.bottom, 13)
      Rectangle().fill(T.hair).frame(height: 1)
      if s.ledger.isEmpty { Say(text: "Nothing recorded yet today, \(T.honorific).").padding(.horizontal, 18).padding(.vertical, 18) }
      ForEach(Array(s.ledger.sorted { (($0.mode ?? "live") == "live" ? 0 : 1) < (($1.mode ?? "live") == "live" ? 0 : 1) }.prefix(6))) { l in
        let live = (l.mode ?? "live") == "live"
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Meta(text: l.time, color: T.dim, size: 8.5, tracking: 1.2).frame(width: 40, alignment: .leading)
          Text(l.title).font(T.body(13.5)).foregroundColor(live ? T.ink : T.dim).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
          Meta(text: live ? (l.actor ?? "Alfred") : "Shadow", color: live ? T.brass : T.dim, size: 8.5, tracking: 1.4)
        }.padding(.horizontal, 18).padding(.vertical, 11)
        Rectangle().fill(T.hair).frame(height: 1)
      }
      Meta(text: "Every line traceable to its session", tracking: 1.8).padding(.horizontal, 18).padding(.vertical, 11)
    }
  }
}

/// 09 · The Vault — what Alfred holds. Credentials are sealed; never a count.
struct VaultView: View {
  @EnvironmentObject var s: AppState
  private static let shelves: [(String, [String])] = [
    ("Matters & commitments", ["matter", "commitment"]), ("Tasks & chores", ["task", "chore"]), ("People, orgs & places", ["person", "org", "place"]),
    ("Notes & daybook", ["note", "daybook"]), ("Decisions & briefs", ["decision", "briefing"]), ("Instincts", ["instinct"]),
  ]
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack { Meta(text: "The Vault", color: T.brass); Spacer(); Meta(text: "Private by design") }
        .padding(.horizontal, 18).padding(.top, 15).padding(.bottom, 13)
      Rectangle().fill(T.hair).frame(height: 1)
      ForEach(Self.shelves, id: \.0) { name, types in
        let n = types.reduce(0) { $0 + (s.vault[$1] ?? 0) }
        HStack { Text(name).font(T.body(14)).foregroundColor(T.ink); Spacer(); Meta(text: n == 0 ? "—" : String(n), size: 9, tracking: 1.4) }
          .padding(.horizontal, 18).padding(.vertical, 12)
        Rectangle().fill(T.hair).frame(height: 1)
      }
      HStack { Text("Credentials").font(T.body(14)).foregroundColor(T.ink); Spacer(); Meta(text: "Sealed", color: T.brass, size: 9, tracking: 1.4) }
        .padding(.horizontal, 18).padding(.vertical, 12)
      Rectangle().fill(T.hair).frame(height: 1)
      Text("Nothing leaves this machine without your word, \(T.honorific).").font(T.say(13.5)).foregroundColor(T.dim).padding(.horizontal, 18).padding(.vertical, 14)
    }
  }
}

/// 10 · The Arrangement — settings as a contract, not toggles. 380 pt.
struct ArrangementView: View {
  @EnvironmentObject var s: AppState
  @State private var draft = Arrangement()
  @State private var loaded = false
  private var since: String {
    guard let d = s.pairing?.pairedAt else { return "" }
    let f = DateFormatter(); f.dateFormat = "MMM yyyy"; return "Since " + f.string(from: d)
  }
  private func field(_ label: String, _ text: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Meta(text: label, tracking: 1.8)
      TextField("Not yet written", text: text).textFieldStyle(.plain).font(T.body(14)).foregroundColor(T.ink)
    }.padding(.horizontal, 18).padding(.vertical, 12)
  }
  private func chip(_ level: Int, _ name: String) -> some View {
    let active = (s.state.pendingTrust ?? s.trust) == level
    return Button(action: { s.chooseTrust(level) }) {
      Meta(text: name, color: active ? T.brass : T.dim, size: 8.5, tracking: 1.4).padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: T.rButton).fill(active ? T.brass.opacity(0.08) : Color.clear))
        .overlay(RoundedRectangle(cornerRadius: T.rButton).stroke(active ? T.brass : T.hair2, lineWidth: 1))
    }.buttonStyle(.plain)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack { Meta(text: "The Arrangement", color: T.brass); Spacer(); Meta(text: since) }
        .padding(.horizontal, 18).padding(.top, 15).padding(.bottom, 13)
      Rectangle().fill(T.hair).frame(height: 1)
      field("Alfred may, without asking", $draft.may); Rectangle().fill(T.hair).frame(height: 1)
      field("Alfred asks first", $draft.asksFirst); Rectangle().fill(T.hair).frame(height: 1)
      field("Alfred never", $draft.never); Rectangle().fill(T.hair).frame(height: 1)
      VStack(alignment: .leading, spacing: 10) {
        Meta(text: "Trust class", tracking: 1.8)
        HStack(spacing: 8) { chip(1, "L1 Watch"); chip(2, "L2 Propose"); chip(3, "L3 Act, then report") }
      }.padding(.horizontal, 18).padding(.vertical, 14)
      Rectangle().fill(T.hair).frame(height: 1)
      HStack {
        Meta(text: s.state.pendingTrust != nil ? "L\(s.state.pendingTrust!) takes effect at midnight" : "Changes take effect at midnight", color: s.state.pendingTrust != nil ? T.brass : T.dim, tracking: 1.8)
        Spacer()
        if draft != s.arrangement { Button(action: { Task { await s.saveArrangement(draft) } }) { Keycap(text: "SAVE ⏎") }.buttonStyle(.plain).keyboardShortcut(.return, modifiers: []) }
      }.padding(.horizontal, 18).padding(.vertical, 11)
    }
    .onAppear { if !loaded { draft = s.arrangement; loaded = true } }
    .onChange(of: s.arrangement) { a in if draft == Arrangement() { draft = a } }
  }
}
