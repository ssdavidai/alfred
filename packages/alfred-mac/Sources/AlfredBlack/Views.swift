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

struct OnboardingView: View {
  @EnvironmentObject var s: AppState
  @State private var url = ""
  @State private var email = ""
  @State private var password = ""
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Label_(text: "For Mac")
      Wordmark().padding(.top, 6)
      Text("Service is the standard.").font(AB.body(19, italic: true)).foregroundColor(AB.marginalia).padding(.top, 4)
      Hairline().padding(.vertical, 24)

      Text("Pair this Mac with your Alfred. Sign in once with the same details you use for the dashboard; this Mac then keeps a key of its own, which you can revoke at any time from Study.")
        .font(AB.body(17)).foregroundColor(AB.ink).fixedSize(horizontal: false, vertical: true)

      VStack(alignment: .leading, spacing: 14) {
        VStack(alignment: .leading, spacing: 6) { Label_(text: "Your Alfred"); TextField("yourname.alfred.black", text: $url).abField() }
        VStack(alignment: .leading, spacing: 6) { Label_(text: "Email"); TextField("you@example.com", text: $email).abField() }
        VStack(alignment: .leading, spacing: 6) { Label_(text: "Password"); SecureField("", text: $password).abField() }
      }.padding(.top, 24)

      if let m = s.message {
        Text(m).font(AB.mono(11)).foregroundColor(AB.oxblood).padding(.top, 14).fixedSize(horizontal: false, vertical: true)
      }
      Spacer()
      Hairline(brass: true)
      HStack {
        Text(s.busy ? "Pairing…" : "Nothing leaves this Mac but the key it mints.").font(AB.mono(10)).foregroundColor(AB.marginalia)
        Spacer()
        Button(s.busy ? "Pairing" : "Pair") { Task { await s.pair(url: url, email: email, password: password) } }
          .buttonStyle(ABButton(primary: true)).disabled(s.busy || url.isEmpty || email.isEmpty || password.isEmpty)
      }.padding(.top, 14)
    }
    .padding(36)
  }
}

struct Row: View {
  let k: String; let v: String; var ok: Bool? = nil
  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Label_(text: k).frame(width: 150, alignment: .leading)
      Text(v).font(AB.mono(12)).foregroundColor(ok == false ? AB.oxblood : AB.ink)
      Spacer()
      if let ok { Text(ok ? "●" : "○").font(AB.mono(9)).foregroundColor(ok ? AB.billiard : AB.marginalia) }
    }.padding(.vertical, 7)
    Hairline()
  }
}

struct StatusView: View {
  @EnvironmentObject var s: AppState
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline) { Label_(text: "For Mac"); Spacer(); Label_(text: s.pairing?.domain ?? "", color: AB.brass) }
      Wordmark().padding(.top, 6)
      Text(s.online == false ? "The tenant cannot be reached at the moment." : "Everything important is in hand.")
        .font(AB.body(19, italic: true)).foregroundColor(AB.marginalia).padding(.top, 4)
      Hairline().padding(.vertical, 20)

      Label_(text: "Continuity")
      VStack(spacing: 0) {
        Row(k: "Tenant", v: s.online == true ? "connected" : (s.online == false ? "unreachable" : "checking"), ok: s.online)
        Row(k: "Memory file", v: s.state.lastRenderAt.map { "\(s.state.lastRenderEntries) entries · \(AppDelegate.ago($0))" } ?? "not yet", ok: s.state.lastRenderAt != nil)
        Row(k: "Cowork mirrored", v: "\(s.state.totalPushed) turns · " + (s.state.lastPushAt.map { AppDelegate.ago($0) } ?? "not yet"), ok: s.state.lastPushAt != nil)
        Row(k: "Starts at login", v: s.loginItem ? "yes" : (SMAppService.mainApp.status == .requiresApproval ? "approve in System Settings › Login Items" : "no"), ok: s.loginItem)
      }.padding(.top, 6)

      Label_(text: "Claude Cowork").padding(.top, 18)
      VStack(spacing: 0) {
        Row(k: "Claude Desktop", v: s.cowork.claudeInstalled ? "installed" : "not found", ok: s.cowork.claudeInstalled)
        Row(k: "Alfred folder", v: s.cowork.folderReady ? "~/Alfred ready" : "pending", ok: s.cowork.folderReady)
        Row(k: "Memory tools", v: s.cowork.mcpRegistered ? "registered with Claude" : "not registered", ok: s.cowork.mcpRegistered)
        Row(k: "Hooks plugin", v: s.cowork.pluginExported ? "exported to Downloads" : (s.cowork.pluginStaged ? "ready to export" : "not staged"), ok: s.cowork.pluginExported)
      }.padding(.top, 6)
      if s.cowork.pluginExported {
        Text("Alfred Continuity.plugin is in your Downloads, selected in Finder. In Claude, open Plugins and choose upload, then pick that file. Hooks load only through a plugin, and installing one is Claude's own step.")
          .font(AB.body(14)).foregroundColor(AB.marginalia).lineSpacing(3).padding(.top, 12).frame(maxWidth: 448, alignment: .leading).fixedSize(horizontal: false, vertical: true)
      }

      if let e = s.state.lastError, let at = s.state.lastErrorAt, Date().timeIntervalSince(at) < 600 {
        Text(e).font(AB.mono(10)).foregroundColor(AB.oxblood).padding(.top, 10).lineLimit(2)
      }
      Spacer()
      Hairline(brass: true)
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
