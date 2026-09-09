import SwiftUI
import ServiceManagement

struct RootView: View {
  @EnvironmentObject var s: AppState
  var body: some View {
    ZStack { AB.paper.ignoresSafeArea()
      if s.pairing == nil { OnboardingView() } else { StatusView() }
    }
    .frame(width: 520, height: 640)
  }
}

struct Wordmark: View {
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 0) {
      Text("Alfred Black").font(AB.display(28, weight: .black)).foregroundColor(AB.ink)
      Text(".").font(AB.display(28, weight: .black)).foregroundColor(AB.brass)
    }
  }
}

/// 11 · The Placement — first run, one screen, then the app goes silent.
struct OnboardingView: View {
  @EnvironmentObject var s: AppState
  @State private var url = ""
  @State private var email = ""
  @State private var password = ""
  private func field(_ label: String, _ placeholder: String, _ text: Binding<String>, secure: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Meta(text: label, tracking: 1.8)
      Group { if secure { SecureField(placeholder, text: text) } else { TextField(placeholder, text: text) } }
        .textFieldStyle(.plain).font(T.body(14)).foregroundColor(T.ink)
      Rectangle().fill(T.hair2).frame(height: 1)
    }
  }
  var body: some View {
    VStack(spacing: 0) {
      if let m = Brand.image("logo-brass.svg") { Image(nsImage: m).resizable().aspectRatio(contentMode: .fit).frame(height: 52).padding(.top, 44) }
      Text("At your service.").font(T.title(26)).foregroundColor(T.ink).padding(.top, 22)
      Say(text: "I'll spend this week watching how your desk runs — «touching nothing.» By Friday you'll have my first brief, and we'll agree what I take over.", size: 15)
        .multilineTextAlignment(.center).padding(.horizontal, 48).padding(.top, 14)
      VStack(spacing: 16) {
        field("Your Alfred", "yourname.alfred.black", $url)
        field("Email", "you@example.com", $email)
        field("Password", "", $password, secure: true)
      }.padding(.horizontal, 48).padding(.top, 26)
      if let m = s.message { Text(m).font(T.body(12.5)).foregroundColor(Color(nsColor: AB.hex(0xD9776C))).padding(.top, 12).padding(.horizontal, 48).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true) }
      HStack(spacing: 10) {
        Button("The terms") { if let d = Tenant.domain(from: url), let u = URL(string: "https://\(d)/household") { NSWorkspace.shared.open(u) } }.buttonStyle(PopButton()).pointer().help("The household rules Alfred follows")
        Button(s.busy ? "One moment" : "Begin the watch") { Task { await s.pair(url: url, email: email, password: password) } }
          .buttonStyle(PopButton(primary: true)).disabled(s.busy || url.isEmpty || email.isEmpty || password.isEmpty).keyboardShortcut(.return, modifiers: []).pointer()
      }.padding(.top, 22)
      Meta(text: "Sign in and pair this Mac · ⏎", size: 8.5, tracking: 1.2).padding(.top, 10)
      Spacer(minLength: 20)
      Meta(text: "Week one · L1 · nothing leaves this machine", tracking: 1.8).padding(.bottom, 22)
    }
    .frame(width: 460, height: 560).background(T.bg)
  }
}

struct Row: View {
  let k: String; let v: String; var ok: Bool? = nil
  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Label_(text: k).frame(width: 150, alignment: .leading)
      Text(v).font(AB.mono(12)).foregroundColor(ok == false ? AB.marginalia : AB.ink)
      Spacer()
      if let ok { Text(ok ? "●" : "○").font(AB.mono(9)).foregroundColor(ok ? AB.billiard : AB.marginalia) }
    }.padding(.vertical, 7)
    Hairline()
  }
}

/// A single engraved icon in brass with reassuring copy — how the system rests.
struct EmptyState: View {
  let icon: String; let text: String
  var body: some View {
    HStack(spacing: 10) { ABIcon(icon, 18, color: AB.brass); Text(text).font(AB.body(15, italic: true)).foregroundColor(AB.marginalia) }
      .padding(.vertical, 10)
  }
}

struct StatusView: View {
  @EnvironmentObject var s: AppState
  @State private var command = ""
  @State private var ledgerOpen = false
  private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
  private func openDesk() { if let d = s.pairing?.domain, let u = URL(string: "https://\(d)/desk") { NSWorkspace.shared.open(u) } }
  private func openBrief() { if let d = s.pairing?.domain, let u = URL(string: "https://\(d)/brief") { NSWorkspace.shared.open(u) } }
  private static let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
  private func when(_ ts: String?) -> String {
    guard let ts, let d = Self.iso.date(from: ts) ?? ISO8601DateFormatter().date(from: ts) else { return "—" }
    let f = DateFormatter(); f.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "d MMM"; return f.string(from: d)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline) { Label_(text: "For Mac"); Spacer(); Label_(text: s.pairing?.domain ?? "", color: AB.brass) }
      Wordmark().padding(.top, 6)
      Text(s.online == false ? "The tenant cannot be reached at the moment." : Presence.line(deskCount: max(s.deskTotal, s.desk.count)))
        .font(AB.body(19, italic: true)).foregroundColor(AB.marginalia).padding(.top, 4)
      Hairline().padding(.vertical, 16)

      CommandField(text: $command, busy: s.asking) { let q = command; command = ""; Task { await s.ask(q) } }

      ScrollView(.vertical, showsIndicators: false) {
        VStack(alignment: .leading, spacing: 0) {
          if let r = s.reply {
            ReplyView(text: r.text).padding(.top, 14).id(r.at)
              .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 8)))
          } else if s.asking {
            Text("One moment.").font(AB.mono(11)).foregroundColor(AB.marginalia).padding(.top, 14)
          }

          HStack { Label_(text: "The Desk"); Spacer(); if !s.desk.isEmpty { Pill(text: "\(s.desk.count) awaiting", tone: .brass) } }.padding(.top, 22)
          if s.desk.isEmpty { EmptyState(icon: "pocket_watch", text: "No urgent action is required.") }
          else { ForEach(s.desk.prefix(4)) { item in LedgerRow(time: when(item.created), subject: item.title, state: Pill(text: "Awaiting")) { openDesk() } } }

          Label_(text: "The Brief").padding(.top, 22)
          if let b = s.brief, !b.excerpt.isEmpty {
            Text(b.excerpt).font(AB.body(15)).foregroundColor(AB.ink).lineSpacing(3).padding(.top, 8).fixedSize(horizontal: false, vertical: true)
            HStack { Text(b.title).font(AB.mono(10)).foregroundColor(AB.marginalia); Spacer()
              Button("Read the brief →") { openBrief() }.buttonStyle(.plain).font(AB.mono(10, weight: .bold)).foregroundColor(AB.brass) }.padding(.top, 8)
          } else { EmptyState(icon: "envelope", text: "No brief has been composed yet.") }

          Button(action: { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) { ledgerOpen.toggle() } }) {
            HStack(spacing: 8) { Label_(text: "Ledger"); Text(ledgerOpen ? "↓" : "→").font(AB.mono(10)).foregroundColor(AB.marginalia) }
          }.buttonStyle(.plain).padding(.top, 22)
          if ledgerOpen {
            VStack(spacing: 0) {
              Row(k: "Tenant", v: s.online == true ? "connected" : (s.online == false ? "unreachable" : "checking"), ok: s.online)
              Row(k: "Memory file", v: s.state.lastRenderAt.map { "\(s.state.lastRenderEntries) entries · \(AppDelegate.ago($0))" } ?? "not yet", ok: s.state.lastRenderAt != nil)
              Row(k: "Cowork journaled", v: s.activity.journalCoworkLast.map { "\(s.activity.journalCowork) turns in the window · \(AppDelegate.ago($0))" } ?? "none in the window yet", ok: s.activity.journalCoworkLast != nil)
              Row(k: "Cowork mirrored", v: "\(s.state.totalPushed) turns · " + (s.state.lastPushAt.map { AppDelegate.ago($0) } ?? "not yet"), ok: s.state.lastPushAt != nil)
              Row(k: "Starts at login", v: s.loginItem ? "yes" : (SMAppService.mainApp.status == .requiresApproval ? "approve in System Settings › Login Items" : "no"), ok: s.loginItem)
              Row(k: "Claude Desktop", v: s.cowork.claudeInstalled ? "installed" : "not found", ok: s.cowork.claudeInstalled)
              Row(k: "Memory tools", v: s.cowork.mcpRegistered ? "registered with Claude" : "not registered", ok: s.cowork.mcpRegistered)
              Row(k: "Hooks plugin", v: s.cowork.pluginExported ? "exported to Downloads" : (s.cowork.pluginStaged ? "ready to export" : "not staged"), ok: s.cowork.pluginExported)
            }.padding(.top, 6)
            if s.cowork.pluginExported {
              Text("Alfred Continuity.plugin is in your Downloads, selected in Finder. In Claude, switch to Cowork, open its Plugins panel and upload that file there — a Cowork session loads only plugins installed from Cowork. Installing one is Claude's own step.")
                .font(AB.body(14)).foregroundColor(AB.marginalia).lineSpacing(3).padding(.top, 12).frame(maxWidth: 448, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
      .animation(reduceMotion ? nil : .easeOut(duration: 0.7), value: s.reply?.at)

      if let e = s.state.lastError, let at = s.state.lastErrorAt, Date().timeIntervalSince(at) < 600 {
        Text(e).font(AB.mono(10)).foregroundColor(AB.oxblood).padding(.top, 8).lineLimit(2)
      }
      Hairline(brass: true).padding(.top, 10)
      HStack(spacing: 8) {
        Button("Set up Cowork") { s.setUpCowork() }.buttonStyle(ABButton(primary: true))
        Button("Export") { s.exportPlugin() }.buttonStyle(ABButton())
        Button("Refresh") { Task { await s.tick(force: true) } }.buttonStyle(ABButton())
        Spacer()
        Button("Sign out") { s.signOut() }.buttonStyle(ABButton())
      }.padding(.top, 14)
    }
    .padding(36)
  }
}
