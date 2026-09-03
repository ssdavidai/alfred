// Alfred Black for Mac — menu-bar app. Always on: registers itself as a login
// item on pairing (SMAppService, no Terminal, survives restarts), renders the
// continuity file every 30s and mirrors Cowork's turns every 60s. The same
// binary is the local MCP server when launched with `--mcp`.
import SwiftUI
import AppKit
import ServiceManagement

@main
struct AlfredBlackMain {
  static func main() {
    if CommandLine.arguments.contains("--mcp") { MCPServer.run() }
    if let i = CommandLine.arguments.firstIndex(of: "--pair"), CommandLine.arguments.count > i + 3 {
      // Headless pairing: the exact code path the window runs, for scripted
      // setup and for verifying the app without a screen.
      let a = CommandLine.arguments
      var done = false
      Task { @MainActor in
        let st = AppState()
        await st.pair(url: a[i + 1], email: a[i + 2], password: a[i + 3])
        if let m = st.message { print("pair: \(m)"); exit(1) }
        print("pair: ok domain=\(st.pairing?.domain ?? "-") online=\(st.online.map(String.init) ?? "?") loginItem=\(st.loginItem) rendered=\(st.state.lastRenderEntries) pushed=\(st.state.lastPushCount) mcp=\(st.cowork.mcpRegistered) plugin=\(st.cowork.pluginStaged)")
        done = true
      }
      // Keep the main run loop turning so the @MainActor task can execute; a
      // blocking wait here would starve the very thread it is waiting for.
      let deadline = Date().addingTimeInterval(120)
      while !done && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
      if !done { print("pair: timed out"); exit(2) }
      exit(0)
    }
    // --snapshot <dir>: render the real views (bundled fonts, tokens) to PNGs,
    // one per state, without a screen. This is how the design is verified.
    if let i = CommandLine.arguments.firstIndex(of: "--snapshot"), CommandLine.arguments.count > i + 1 {
      let dir = URL(fileURLWithPath: CommandLine.arguments[i + 1])
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      _ = NSApplication.shared; AB.registerFonts()
      func write(_ view: some View, _ name: String) {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: 520, height: 640)
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
        host.cacheDisplay(in: host.bounds, to: rep)
        if let png = rep.representation(using: .png, properties: [:]) {
          try? png.write(to: dir.appendingPathComponent(name))
        }
      }
      let paired = AppState()                       // whatever this Mac is paired with
      let fresh = AppState(); fresh.pairing = nil   // first launch
      write(RootView().environmentObject(fresh), "onboarding.png")
      if paired.pairing != nil { write(RootView().environmentObject(paired), "status.png") }
      print("snapshot: \(dir.path)")
      exit(0)
    }
    if CommandLine.arguments.contains("--export-plugin") {
      do { let u = try Cowork.exportPlugin(); print("exported: \(u.path)"); exit(0) }
      catch { print("error: \((error as? TenantError)?.message ?? "\(error)")"); exit(1) }
    }
    if CommandLine.arguments.contains("--tick") {
      var done = false
      Task { @MainActor in
        let st = AppState(); st.selfHeal(); await st.tick(force: true)
        let r = st.lastReport
        print("tick: online=\(st.online.map(String.init) ?? "?") rendered=\(st.state.lastRenderEntries) pushed=\(r.pushed) skipped=\(r.skipped) tooOld=\(r.tooOld) bound=\(r.bound) failed=\(r.failed) total=\(st.state.totalPushed)")
        done = true
      }
      let deadline = Date().addingTimeInterval(120)
      while !done && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
      exit(done ? 0 : 2)
    }
    if CommandLine.arguments.contains("--status") {
      let p = Store.loadPairing(); let st = Store.loadState(); let c = Cowork.status()
      print("paired: \(p?.domain ?? "no") key: \(Keychain.get("apikey") != nil) loginItem: \(SMAppService.mainApp.status == .enabled)")
      print("render: \(st.lastRenderAt.map { ISO8601DateFormatter().string(from: $0) } ?? "never") entries=\(st.lastRenderEntries)  push: \(st.lastPushAt.map { ISO8601DateFormatter().string(from: $0) } ?? "never") total=\(st.totalPushed) lastError=\(st.lastError ?? "none")")
      print("cowork: folder=\(c.folderReady) mcp=\(c.mcpRegistered) plugin=\(c.pluginStaged) claude=\(c.claudeInstalled)")
      exit(0)
    }
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
  }
}

@MainActor
final class AppState: ObservableObject {
  @Published var pairing: Pairing? = Store.loadPairing()
  @Published var state: RunState = Store.loadState()
  @Published var online: Bool? = nil
  @Published var busy = false
  @Published var message: String? = nil
  @Published var cowork = Cowork.status()
  @Published var loginItem: Bool = SMAppService.mainApp.status == .enabled

  var tenant: Tenant? {
    guard let p = pairing, let key = Keychain.get("apikey") else { return nil }
    return Tenant(api: p.api, apiKey: key)
  }

  // MARK: pairing
  func pair(url: String, email: String, password: String) async {
    guard let domain = Tenant.domain(from: url) else { message = "Enter your Alfred address, e.g. yourname.alfred.black"; return }
    busy = true; defer { busy = false }
    message = nil
    let t = Tenant(api: URL(string: "https://api.\(domain)")!, apiKey: nil)
    do {
      let session = try await t.login(email: email, password: password)
      let name = "Alfred Black for Mac — \(Host.current().localizedName ?? "this Mac")"
      let key = try await t.createApiKey(session: session, name: name)
      guard Keychain.set(key.key, account: "apikey") else { throw TenantError(message: "Could not store the device key on this Mac.") }
      let p = Pairing(domain: domain, email: email, keyId: key.id, pairedAt: Date())
      Store.savePairing(p); pairing = p
      online = await Tenant(api: p.api, apiKey: key.key).check()
      try? Cowork.stagePlugin(); try? Cowork.registerMCP()
      enableLoginItem(true)
      cowork = Cowork.status()
      await tick(force: true)
    } catch { message = error.localizedDescription }
  }

  private func record(_ error: Error) {

    state.lastError = (error as? TenantError)?.message ?? error.localizedDescription

    state.lastErrorAt = Date()

  }

  /// Everything Cowork needs, in one action: the memory tools registered, the

  /// plugin file in Downloads and selected in Finder, Claude opened.

  func setUpCowork() {

    do { try Cowork.registerMCP(); try Cowork.exportPlugin(); Cowork.revealExport(); Cowork.openClaude() } catch { record(error) }

    cowork = Cowork.status()

  }

  func exportPlugin() {

    do { try Cowork.exportPlugin(); Cowork.revealExport() } catch { record(error) }

    cowork = Cowork.status()

  }


  func signOut() {
    Keychain.delete("apikey"); Store.savePairing(nil); pairing = nil; online = nil
    try? Cowork.unregisterMCP(); cowork = Cowork.status()
  }

  // MARK: the two agents
  private var lastRender = Date.distantPast
  private var lastPush = Date.distantPast
  var lastReport = PushReport()
  @Published var activity = Activity.load()

  /// On every launch while paired: the app may have been moved (dist → /Applications),
  /// so the MCP registration and the login item must point at THIS bundle.
  func selfHeal() {
    guard pairing != nil else { return }
    let me = Bundle.main.executablePath ?? ""
    if let d = try? Data(contentsOf: Paths.claudeDesktopConfig),
       let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
       let servers = j["mcpServers"] as? [String: Any],
       let entry = servers[Cowork.mcpName] as? [String: Any],
       (entry["command"] as? String) == me {} else { try? Cowork.registerMCP() }
    if SMAppService.mainApp.status != .enabled { try? SMAppService.mainApp.register() }
    loginItem = SMAppService.mainApp.status == .enabled
    cowork = Cowork.status()
  }
  func tick(force: Bool = false) async {
    activity = Activity.load()
    // A denied Keychain prompt must not look like a network problem.
    if pairing != nil, Keychain.get("apikey") == nil {
      state.lastError = "The device key is missing on this Mac. Sign out and pair again."
      state.lastErrorAt = Date(); online = false; return
    }
    guard let t = tenant, let p = pairing else { return }
    let now = Date()
    if force || now.timeIntervalSince(lastRender) >= 30 {
      lastRender = now
      do {
        let n = try await Continuity.refresh(tenant: t, domain: p.domain)
        state.lastRenderAt = Date(); state.lastRenderEntries = n; online = true
      } catch { online = false; state.lastError = error.localizedDescription; state.lastErrorAt = Date() }
    }
    if force || now.timeIntervalSince(lastPush) >= 60 {
      lastPush = now
      // Re-read the on-disk state first: another instance (the CLI, or a second
      // launch) may have mirrored turns since we loaded ours. Union, never replace.
      var s = state
      let disk = Store.loadState()
      s.pushedUUIDs.formUnion(disk.pushedUUIDs); s.boundSessions.formUnion(disk.boundSessions)
      s.totalPushed = max(s.totalPushed, disk.totalPushed)
      Pusher.seedFromLegacyState(into: &s)
      let rep = await Pusher.run(tenant: t, state: &s)
      s.lastPushAt = Date(); s.lastPushCount = rep.pushed
      state = s
      lastReport = rep
    }
    Store.saveState(state)
    cowork = Cowork.status()
  }

  func enableLoginItem(_ on: Bool) {
    do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch { message = error.localizedDescription }
    loginItem = SMAppService.mainApp.status == .enabled
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let state = AppState()
  var statusItem: NSStatusItem!
  var window: NSWindow?
  var timer: Timer?

  func applicationDidFinishLaunching(_ n: Notification) {

    if Self.moveToApplicationsIfNeeded() { return }
    AB.registerFonts()
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.image = Glyph.bowtie()
    statusItem.button?.image?.isTemplate = true
    statusItem.button?.toolTip = "Alfred Black"
    statusItem.menu = buildMenu()
    state.selfHeal()
    if state.pairing == nil || !Self.launchedAsLoginItem() { showWindow() }
    timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      guard let self else { return }
      Task { @MainActor in await self.state.tick(); self.statusItem.menu = self.buildMenu() }
    }
    Task { @MainActor in await state.tick(force: true); statusItem.menu = buildMenu() }
  }

  /// Launched from a mounted disk image (or anywhere read-only), the app would

  /// die on eject and its login item would point into /Volumes. Copy to

  /// /Applications, start from there, and let this copy quit.

  static func moveToApplicationsIfNeeded() -> Bool {

    let here = URL(fileURLWithPath: Bundle.main.bundlePath)

    guard here.path.hasPrefix("/Volumes/") else { return false }

    let dest = URL(fileURLWithPath: "/Applications/Alfred Black.app")

    do {

      try? FileManager.default.removeItem(at: dest)

      try FileManager.default.copyItem(at: here, to: dest)

    } catch { return false }   // keep running from here rather than not at all

    let cfg = NSWorkspace.OpenConfiguration(); cfg.createsNewApplicationInstance = true

    NSWorkspace.shared.openApplication(at: dest, configuration: cfg) { _, _ in

      DispatchQueue.main.async { NSApp.terminate(nil) }

    }

    return true

  }


  /// A login-item launch arrives as an open-application event tagged as such;

  /// a person double-clicking the app does not, and expects to see the window.

  static func launchedAsLoginItem() -> Bool {

    let aevt: UInt32 = 0x61657674, oapp: UInt32 = 0x6F617070, prdt: UInt32 = 0x70726474, lgit: UInt32 = 0x6C676974

    guard let ev = NSAppleEventManager.shared().currentAppleEvent, ev.eventClass == aevt, ev.eventID == oapp,

          let prop = ev.paramDescriptor(forKeyword: prdt) else { return false }

    return prop.enumCodeValue == lgit

  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool { showWindow(); return true }


  @MainActor func buildMenu() -> NSMenu {
    let m = NSMenu()
    let title = state.pairing.map { "Paired with \($0.domain)" } ?? "Not paired"
    m.addItem(withTitle: title, action: nil, keyEquivalent: "")
    if state.pairing != nil {
      let dot = state.online == true ? "connected" : (state.online == false ? "unreachable" : "checking")
      m.addItem(withTitle: "Tenant \(dot)", action: nil, keyEquivalent: "")
      let r = state.state.lastRenderAt.map { "Memory rendered \(Self.ago($0)) · \(state.state.lastRenderEntries) entries" } ?? "Memory not rendered yet"
      m.addItem(withTitle: r, action: nil, keyEquivalent: "")
      let p = state.state.lastPushAt.map { "Cowork mirrored \(Self.ago($0)) · \(state.state.totalPushed) turns total" } ?? "Cowork not mirrored yet"
      m.addItem(withTitle: p, action: nil, keyEquivalent: "")
    }
    m.addItem(.separator())
    m.addItem(withTitle: "Open Alfred Black…", action: #selector(openWindow), keyEquivalent: "o").target = self
    m.addItem(withTitle: "Reveal Alfred folder", action: #selector(revealFolder), keyEquivalent: "").target = self
    m.addItem(.separator())
    m.addItem(withTitle: "Quit Alfred Black", action: #selector(quit), keyEquivalent: "q").target = self
    return m
  }

  static func ago(_ d: Date) -> String {
    let s = Int(Date().timeIntervalSince(d))
    if s < 60 { return "\(s)s ago" }; if s < 3600 { return "\(s/60)m ago" }; return "\(s/3600)h ago"
  }

  @objc func openWindow() { showWindow() }
  @objc func revealFolder() { Cowork.revealAlfredFolder() }
  @objc func quit() { NSApp.terminate(nil) }

  func showWindow() {
    if window == nil {
      let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 640),
                       styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
      w.title = "Alfred Black"
      w.titlebarAppearsTransparent = true
      w.backgroundColor = NSColor(AB.paper)
      w.isReleasedWhenClosed = false
      w.contentView = NSHostingView(rootView: RootView().environmentObject(state))
      w.center()
      window = w
    }
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
}

/// The menu-bar glyph: a bowtie, drawn as a template image (monochrome, adapts to the bar).
enum Glyph {
  static func bowtie() -> NSImage {
    let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
      let p = NSBezierPath()
      p.move(to: NSPoint(x: 2, y: 4)); p.line(to: NSPoint(x: 8, y: 7)); p.line(to: NSPoint(x: 2, y: 10)); p.close()
      p.move(to: NSPoint(x: 16, y: 4)); p.line(to: NSPoint(x: 10, y: 7)); p.line(to: NSPoint(x: 16, y: 10)); p.close()
      p.appendRect(NSRect(x: 7.5, y: 5.5, width: 3, height: 3))
      NSColor.black.setFill(); p.fill()
      return true
    }
    img.isTemplate = true
    return img
  }
}
