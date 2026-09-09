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
      VStack(spacing: 0) {
      Group {
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
      if let n = s.notice {
        HStack(spacing: 12) {
          Circle().fill(T.brass).frame(width: 5, height: 5)
          Text(n.text).font(T.body(13)).foregroundColor(T.ink)
          Spacer()
          if let u = n.undo { Button(action: u) { Keycap(text: "UNDO") }.buttonStyle(.plain).pointer() }
        }.padding(.horizontal, 18).padding(.vertical, 9).background(T.bg2)
        .transition(.opacity)
      }
      NavStrip()
      }
    }
    .animation(.easeOut(duration: 0.2), value: s.notice?.at)
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
    .frame(width: T.popoverWidth)
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
    let n = max(s.deskTotal, s.desk.count); let new = s.newSinceSeen
    if n == 0 { return "\(greeting), \(T.honorific). The desk is quiet — «nothing needs your word.»" }
    if new == 0 { return "\(greeting), \(T.honorific). Nothing new since you looked — «\(n) waiting.»" }
    return "\(greeting), \(T.honorific). «\(new == 1 ? "One thing is" : "\(new) things are") new» since you looked; \(n) waiting."
  }
  private var returned: String {
    guard let h = s.narToday else { return "Today · in hand" }
    return h > 0.05 ? String(format: "Today · %.1f h returned", h) : String(format: "Today · net %.1f h", h)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ScreenHeader(name: "Today", status: s.lastRefreshAt == nil ? "reading the desk…" : s.deskTotal == 0 ? "The desk is quiet" : (s.newSinceSeen > 0 ? "\(s.newSinceSeen) new · \(max(s.deskTotal, s.desk.count)) waiting" : "\(max(s.deskTotal, s.desk.count)) waiting"), brass: s.newSinceSeen > 0)
      AskInline().padding(.horizontal, 18).padding(.top, 16)
      Say(text: line).padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 14)
      ForEach(Array(s.desk.prefix(3))) { item in
        PopRow(title: item.title, meta: "Your word", needsWord: true) { s.open(.yourWord) }
      }
      ForEach(Array(s.matters.prefix(max(0, 3 - min(3, s.desk.count))))) { m in
        PopRow(title: m.glanceTitle, meta: m.state == "done" ? "Done" : "In hand")
      }
      HStack {
        Meta(text: returned, tracking: 1.8)
        Spacer()
        if s.deskTotal > 3 { Button(action: { s.open(.yourWord) }) { Meta(text: "See all \(max(s.deskTotal, s.desk.count)) in Decisions →", color: T.brass, tracking: 1.4) }.buttonStyle(.plain).pointer() }
      }.padding(.horizontal, 18).padding(.vertical, 12)
    }
  }
}

/// 02 · The Brief — mornings, in the same popover, until read.
struct BriefView: View {
  @EnvironmentObject var s: AppState
  private func openBrief() { if let d = s.pairing?.domain, let u = URL(string: "https://\(d)/brief") { NSWorkspace.shared.open(u) } }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ScreenHeader(name: "Brief", status: s.brief.map { "\($0.header.replacingOccurrences(of: "Brief · ", with: "")) · \($0.composedTime)" } ?? "none yet")
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
        Button(action: openBrief) { Meta(text: "Read the full brief →", color: T.brass, tracking: 1.4) }.buttonStyle(.plain).pointer() }
        .padding(.horizontal, 18).padding(.vertical, 12)
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
    if !m.when.isEmpty { return m.when }
    switch m.state ?? "" { case "done": return "Done"; case "dormant": return "Dormant"; default: return "In flight" }
  }
  private var inFlight: [Matter] { s.matters.filter { ($0.state ?? "active") != "done" } }
  private var overdue: Int {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; let today = f.string(from: Date())
    return inFlight.filter { ($0.next ?? "").count >= 10 && String($0.next!.prefix(10)) < today }.count
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ScreenHeader(name: "Matters", status: "\(inFlight.count) in flight · L\(s.trust) trust" + (inFlight.filter(blocked).count > 0 ? " · \(inFlight.filter(blocked).count) blocked on you" : ""), brass: inFlight.contains(where: blocked))
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
              if let n = m.nextAction { Text("Next: \(n)").font(T.body(11.5, italic: true)).foregroundColor(T.ink.opacity(0.85)).lineLimit(2) }
              else if !m.subline.isEmpty { Text(m.subline).font(T.body(11.5, italic: true)).foregroundColor(T.dim).lineLimit(2) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            Meta(text: meta(m), color: b ? T.brass : T.dim, size: 8.5, tracking: 1.4)
          }.padding(.horizontal, 18).padding(.vertical, 12).contentShape(Rectangle())
          .onTapGesture { if let d = s.pairing?.domain, let u = URL(string: "https://\(d)/matters/\(m.id)") { NSWorkspace.shared.open(u) } }.pointer()
          Rectangle().fill(T.hair).frame(height: 1)
        }
      }
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
      ScreenHeader(name: "Decisions", status: s.desk.isEmpty ? "none waiting" : "\(min(s.wordIndex + 1, max(1, s.desk.count))) of \(max(s.deskTotal, s.desk.count, 1))" + (s.newSinceSeen > 0 ? " · \(s.newSinceSeen) new" : "") + (s.desk.count > 1 ? " · ↑↓" : ""), brass: !s.desk.isEmpty)
      if let c = card {
        Say(text: c.title, size: 15.5).padding(.horizontal, 18).padding(.top, 18)
        if !c.body.isEmpty && c.body != c.title {
          Text(c.body).font(T.body(13.5)).foregroundColor(T.dim).lineSpacing(3).lineLimit(6).padding(.horizontal, 18).padding(.top, 10).fixedSize(horizontal: false, vertical: true)
        }
        HStack(spacing: 8) {
          Meta(text: (c.target_kind ?? "matter"), size: 8.5, tracking: 1.4); Meta(text: "·", size: 8.5); Meta(text: when(c.created), size: 8.5, tracking: 1.4); Spacer()
          Button(action: { if let d = s.pairing?.domain, let u = URL(string: "https://\(d)/desk") { NSWorkspace.shared.open(u) } }) { Meta(text: "Desk ⏎", color: T.brass, size: 8.5, tracking: 1.4) }.buttonStyle(.plain)
        }.padding(.horizontal, 18).padding(.top, 14)
        if let a = c.proposedAction {
          HStack(alignment: .firstTextBaseline, spacing: 8) { Meta(text: "If so ordered", color: T.brass, size: 8.5, tracking: 1.4); Text(a).font(T.body(13)).foregroundColor(T.ink).lineLimit(2) }
            .padding(.horizontal, 18).padding(.top, 12)
        } else {
          HStack(alignment: .firstTextBaseline, spacing: 8) { Meta(text: "No action proposed", size: 8.5, tracking: 1.4)
            Button(action: { s.askAbout(c) }) { Meta(text: "Ask Alfred what he'd do →", color: T.brass, size: 8.5, tracking: 1.4) }.buttonStyle(.plain).pointer() }
            .padding(.horizontal, 18).padding(.top, 12)
        }
        HStack(spacing: 8) {
          Spacer()
          Button(action: { Task { await s.decide("defer") } }) { HStack(spacing: 7) { Text("Hold"); Keycap(text: "ESC", color: T.ink) } }.buttonStyle(PopButton()).keyboardShortcut(.escape, modifiers: []).pointer()
          Button(action: { Task { await s.decide("take_mine") } }) { HStack(spacing: 7) { Text("Myself"); Keycap(text: "⌘⏎", color: T.ink) } }.buttonStyle(PopButton()).keyboardShortcut(.return, modifiers: [.command]).pointer()
          Button(action: { Task { await s.decide("delegate") } }) { HStack(spacing: 7) { Text("So ordered"); Keycap(text: "⏎", color: T.bg) } }.buttonStyle(PopButton(primary: true)).keyboardShortcut(.return, modifiers: []).pointer().disabled(c.proposedAction == nil)
        }.padding(.horizontal, 18).padding(.vertical, 16).disabled(s.deciding)
        .background(Group { Button("") { s.nextCard(-1) }.keyboardShortcut(.upArrow, modifiers: []); Button("") { s.nextCard(1) }.keyboardShortcut(.downArrow, modifiers: []) }.opacity(0).frame(width: 0, height: 0))
      } else {
        Say(text: "Nothing needs your decision, \(T.honorific). «The desk is quiet.»").padding(.horizontal, 18).padding(.vertical, 18)
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
      ScreenHeader(name: "Activity", status: s.lastRefreshAt.map { "updated \(AppDelegate.ago($0)) · every line traceable" } ?? "reading…")
      let lines = s.ledger.filter { $0.meaningful }
      if lines.isEmpty { Say(text: "Nothing that touched your things today, \(T.honorific). «The machinery ran quietly.»").padding(.horizontal, 18).padding(.vertical, 18) }
      ForEach(Array(lines.prefix(6))) { l in
        let live = (l.mode ?? "live") == "live"
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Meta(text: l.time, color: T.dim, size: 8.5, tracking: 1.2).frame(width: 40, alignment: .leading)
          Text(l.title).font(T.body(13.5)).foregroundColor(live ? T.ink : T.dim).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
          Meta(text: live ? (l.actor ?? "Alfred") : "Shadow", color: live ? T.brass : T.dim, size: 8.5, tracking: 1.4)
        }.padding(.horizontal, 18).padding(.vertical, 11)
        Rectangle().fill(T.hair).frame(height: 1)
      }
      HStack { Meta(text: "\(s.ledger.count - lines.count) machine lines hidden", size: 8.5, tracking: 1.2); Spacer()
        Button(action: openAudit) { Meta(text: "Open the full log →", color: T.brass, tracking: 1.4) }.buttonStyle(.plain).pointer() }.padding(.horizontal, 18).padding(.vertical, 12)
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
      ScreenHeader(name: "Vault", status: "private by design")
      ForEach(Self.shelves, id: \.0) { name, types in
        let n = types.reduce(0) { $0 + (s.vault[$1] ?? 0) }
        HStack { Text(name).font(T.body(14)).foregroundColor(T.ink); Spacer(); Meta(text: n == 0 ? "—" : String(n), size: 9, tracking: 1.4); Meta(text: "→", color: T.brass, size: 9) }
          .padding(.horizontal, 18).padding(.vertical, 12).contentShape(Rectangle())
          .onTapGesture { if let d = s.pairing?.domain, let u = URL(string: "https://\(d)/vault?type=\(types[0])") { NSWorkspace.shared.open(u) } }.pointer()
          .accessibilityLabel("\(name), \(n) records")
        Rectangle().fill(T.hair).frame(height: 1)
      }
      HStack { Text("Credentials").font(T.body(14)).foregroundColor(T.ink); Spacer(); Meta(text: "Sealed", color: T.brass, size: 9, tracking: 1.4) }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .help("Kept in the password vault on your tenant. Alfred can use them; he never shows or counts them here.")
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
      ScreenHeader(name: "Settings", status: since)
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

/// Where the popover can go, in plain words; the screen you are on is brass.
struct NavStrip: View {
  @EnvironmentObject var s: AppState
  private let items: [(String, Screen)] = [("Today", .glance), ("Brief", .brief), ("Matters", .matters), ("Decisions", .yourWord), ("Activity", .ledger), ("Vault", .vault), ("Settings", .arrangement)]
  var body: some View {
    VStack(spacing: 0) {
      Rectangle().fill(T.hair2).frame(height: 1)
      HStack(spacing: 1) {
        ForEach(items, id: \.0) { name, sc in NavItem(name: name, active: s.screen == sc) { s.open(sc) } }
      }.frame(maxWidth: .infinity).padding(.horizontal, 4)
    }.background(T.bg2.opacity(0.6))
  }
}

struct NavItem: View {
  let name: String; let active: Bool; let action: () -> Void
  @State private var hover = false
  var body: some View {
    Button(action: action) {
      Text(name.uppercased()).font(T.mono(9, weight: .heavy)).tracking(0.3)
        .foregroundColor(active ? T.brass : (hover ? T.ink : T.dim)).lineLimit(1).fixedSize()
        .padding(.horizontal, 5).padding(.vertical, 11).contentShape(Rectangle())
        .background(RoundedRectangle(cornerRadius: T.rButton).fill(hover && !active ? T.bg3 : Color.clear))
    }.buttonStyle(.plain).onHover { hover = $0 }.pointer().accessibilityLabel(name)
  }
}

/// The command line, in the popover: ask here, or ⌘⇧A anywhere. Alfred proposes before he acts.
struct AskInline: View {
  @EnvironmentObject var s: AppState
  @State private var text = ""
  @FocusState private var focused: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        Text("alfred.black >").font(T.mono(11, weight: .bold)).foregroundColor(T.brass)
        TextField("What shall Alfred handle?", text: $text).textFieldStyle(.plain)
          .font(T.say(15)).foregroundColor(T.ink).focused($focused).disabled(s.asking)
          .onSubmit { if s.askReply != nil { s.soOrdered(withoutRead: NSEvent.modifierFlags.contains(.shift)) } else { let q = text; text = ""; Task { await s.propose(q) } } }
        if s.asking { Waiting() } else { Button(action: { s.toggleAsk() }) { Keycap(text: "⌘⇧A") }.buttonStyle(.plain).pointer().help("Ask from anywhere") }
      }
      .padding(.horizontal, 12).padding(.vertical, 9)
      .overlay(RoundedRectangle(cornerRadius: T.rButton).stroke(focused ? T.brass : T.hair2, lineWidth: 1))
      if let r = s.askReply {
        Say(text: r, size: 14.5).padding(.top, 4)
        HStack(spacing: 18) {
          Button(action: { s.soOrdered(withoutRead: false) }) { Meta(text: "⏎ so ordered", color: T.brass, tracking: 1.6) }.buttonStyle(.plain).pointer()
          Button(action: { s.soOrdered(withoutRead: true) }) { Meta(text: "⇧⏎ without read", tracking: 1.6) }.buttonStyle(.plain).pointer()
          Button(action: { s.askReply = nil }) { Meta(text: "esc never mind", tracking: 1.6) }.buttonStyle(.plain).pointer().keyboardShortcut(.escape, modifiers: [])
        }
      } else if focused && text.isEmpty {
        Meta(text: "⏎ to ask · Alfred proposes before he acts", size: 8.5, tracking: 1.2)
      }
    }
  }
}

/// While Alfred reads the desk: the seconds, and ESC to stop waiting.
struct Waiting: View {
  @EnvironmentObject var s: AppState
  @State private var tick = 0
  private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
  var body: some View {
    let secs = Int(Date().timeIntervalSince(s.askStartedAt ?? Date())) + tick * 0
    HStack(spacing: 8) {
      Meta(text: "reading your desk · \(secs)s", size: 8.5, tracking: 1.2)
      Button(action: { s.cancelAsk() }) { Keycap(text: "ESC") }.buttonStyle(.plain).pointer().keyboardShortcut(.escape, modifiers: [])
    }.onReceive(timer) { _ in tick += 1 }
  }
}
