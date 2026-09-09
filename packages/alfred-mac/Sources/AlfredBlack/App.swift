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
      if CommandLine.arguments.contains("--dark") { NSApp.appearance = NSAppearance(named: .darkAqua) }
      if CommandLine.arguments.contains("--light") { NSApp.appearance = NSAppearance(named: .aqua) }
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
      let sfx = CommandLine.arguments.contains("--dark") ? "-dark" : (CommandLine.arguments.contains("--light") ? "-light" : "")
      write(RootView().environmentObject(fresh), "onboarding\(sfx).png")
      if paired.pairing != nil { write(RootView().environmentObject(paired), "status\(sfx).png") }
      print("snapshot: \(dir.path)")
      exit(0)
    }
    if CommandLine.arguments.contains("--export-plugin") {
      do { let u = try Cowork.exportPlugin(); print("exported: \(u.path)"); exit(0) }
      catch { print("error: \((error as? TenantError)?.message ?? "\(error)")"); exit(1) }
    }
    if let i = CommandLine.arguments.firstIndex(of: "--presence"), CommandLine.arguments.count > i + 1 {
      let dir = URL(fileURLWithPath: CommandLine.arguments[i + 1]); try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      for (name, need, dark) in [("silent-dark", false, true), ("attending-dark", true, true), ("attending-light", true, false)] {
        let src = Presence.image(needsWord: need, dark: dark)
        let big = NSImage(size: NSSize(width: src.size.width * 8, height: src.size.height * 8), flipped: false) { r in
          (dark ? AB.hex(0x1C1A17) : AB.hex(0xE8E4DC)).setFill(); r.fill()
          if src.isTemplate { src.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1); (dark ? NSColor.white : NSColor.black).setFill(); r.fill(using: .sourceAtop) }
          else { src.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1) }
          return true
        }
        if let tiff = big.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: dir.appendingPathComponent("presence-\(name).png")) }
      }
      print("presence: \(dir.path)"); exit(0)
    }
    if let i = CommandLine.arguments.firstIndex(of: "--ask"), CommandLine.arguments.count > i + 1 {   // ask Alfred from a shell
      var done = false
      Task { @MainActor in
        let st = AppState(); await st.ask(CommandLine.arguments[i + 1])
        print(st.reply.map { "Alfred: \($0.text)" } ?? "error: \(st.state.lastError ?? "no reply")"); done = true
      }
      let deadline = Date().addingTimeInterval(200)
      while !done && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
      exit(done ? 0 : 2)
    }
    if let i = CommandLine.arguments.firstIndex(of: "--screen"), CommandLine.arguments.count > i + 2 {
      let dir = URL(fileURLWithPath: CommandLine.arguments[i + 2]); try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      _ = NSApplication.shared; AB.registerFonts(); NSApp.appearance = NSAppearance(named: .darkAqua)
      var done = false
      Task { @MainActor in
        let st = AppState(); await st.tick(force: true)
        let name = CommandLine.arguments[i + 1]
        st.screen = ["brief": Screen.brief, "matters": .matters, "yourword": .yourWord, "ledger": .ledger, "vault": .vault, "arrangement": .arrangement][name] ?? .glance
        if let r = CommandLine.arguments.firstIndex(of: "--reply"), CommandLine.arguments.count > r + 1 { st.askReply = CommandLine.arguments[r + 1] }
        let host: NSHostingView<AnyView> = name == "ask" ? NSHostingView(rootView: AnyView(AskView().environmentObject(st))) : NSHostingView(rootView: AnyView(PopoverView().environmentObject(st)))
        let w: CGFloat = name == "ask" ? 620 : T.popoverWidth
        host.frame = NSRect(x: 0, y: 0, width: w, height: host.fittingSize.height); host.layoutSubtreeIfNeeded()
        if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) { host.cacheDisplay(in: host.bounds, to: rep); try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("screen-\(CommandLine.arguments[i + 1]).png")) }
        print("screen: \(CommandLine.arguments[i + 1]) \(Int(host.bounds.height))pt desk=\(st.desk.count) matters=\(st.matters.count) nar=\(st.narToday.map { String($0) } ?? "-")"); done = true
      }
      let deadline = Date().addingTimeInterval(120)
      while !done && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
      exit(done ? 0 : 2)
    }
    if CommandLine.arguments.contains("--tick") {
      var done = false
      Task { @MainActor in
        let st = AppState(); st.selfHeal(); await st.tick(force: true)
        let r = st.lastReport
        print("tick: online=\(st.online.map(String.init) ?? "?") rendered=\(st.state.lastRenderEntries) pushed=\(r.pushed) skipped=\(r.skipped) tooOld=\(r.tooOld) bound=\(r.bound) failed=\(r.failed) total=\(st.state.totalPushed) desk=\(st.desk.count) brief=\(st.brief.map { $0.title } ?? "none")")
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


  /// The Ask, step one: Alfred says what he would do — before doing it.


  func propose(_ text: String) async {


    let q = text.trimmingCharacters(in: .whitespacesAndNewlines); guard !q.isEmpty, !asking, let t = tenant else { return }


    asking = true; defer { asking = false }


    let framed = "\(T.honorific.capitalized) asks: «\(q)». Before acting, say in one short paragraph what you would do and any specifics you can see — then wait for his word. Do not act yet."


    do { askReply = try await t.ask(framed, chatId: Store.deviceId()) } catch { record(error) }


  }


  /// Step two: his word. The panel closes silently; the matter appears in flight.


  func soOrdered(withoutRead: Bool) {


    guard let t = tenant else { return }


    let word = withoutRead ? "So ordered — send without my read." : "So ordered."


    dismissAsk(); Task { _ = try? await t.ask(word, chatId: Store.deviceId()) }


  }


  func dismissAsk() { askReply = nil; askPanel?.orderOut(nil) }


  func toggleAsk() {


    if askPanel == nil { askPanel = AskPanel(state: self) }


    if askPanel?.isVisible == true { dismissAsk() } else { askReply = nil; askPanel?.present() }


  }


  /// One question, one reply, both remembered on every other surface.


  func ask(_ text: String) async {


    let q = text.trimmingCharacters(in: .whitespacesAndNewlines); guard !q.isEmpty, !asking, let t = tenant else { return }


    asking = true; defer { asking = false }


    do { reply = (try await t.ask(q, chatId: Store.deviceId()), Date()) } catch { record(error) }


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
  @Published var desk: [DeskItem] = []
  @Published var deskTotal = 0
  @Published var matters: [Matter] = []
  @Published var narToday: Double? = nil
  @Published var screen: Screen = .glance
  private var lastNar = Date.distantPast
  func open(_ sc: Screen) { screen = sc }
  /// Priority when the popover opens: an unread brief of the day, else the Glance.
  func popoverOpened() { screen = (brief.map { $0.isToday && state.briefReadSlug != $0.slug_date } ?? false) ? .brief : .glance }
  func popoverClosed() { if screen == .brief, let b = brief { state.briefReadSlug = b.slug_date }; screen = .glance }
  @Published var reply: (text: String, at: Date)? = nil
  @Published var asking = false
  @Published var askReply: String? = nil
  var askPanel: AskPanel? = nil
  @Published var brief: Brief? = nil
  private var lastBrief = Date.distantPast
  private var lastDesk = Date.distantPast
  var needsWord: Bool { !desk.isEmpty }

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
    if force || now.timeIntervalSince(lastNar) >= 300 {
      lastNar = now; if let h = try? await t.returnedToday() { narToday = h }
    }
    if force || now.timeIntervalSince(lastBrief) >= 600 {
      lastBrief = now; if let b = try? await t.latestBrief() { brief = b }
    }
    if force || now.timeIntervalSince(lastDesk) >= 60 {
      lastDesk = now
      if let page = try? await t.deskPending() { desk = page.items.filter { ($0.status ?? "pending") == "pending" }.sorted { ($0.created ?? "") > ($1.created ?? "") }; deskTotal = page.total }   // newest first
      if let ms = try? await t.matters() { matters = ms.filter { ($0.state ?? "active") != "archived" } }
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
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
  func popoverDidClose(_ n: Notification) { state.popoverClosed() }
  let state = AppState()
  var statusItem: NSStatusItem!
  var window: NSWindow?
  let popover: NSPopover = { let p = NSPopover(); p.behavior = .transient; p.animates = true; p.appearance = NSAppearance(named: .darkAqua); return p }()
  var timer: Timer?

  func applicationDidFinishLaunching(_ n: Notification) {

    if Self.moveToApplicationsIfNeeded() { return }
    AB.registerFonts()
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    refreshPresence()
    statusItem.button?.toolTip = "Alfred Black"
    statusItem.button?.target = self; statusItem.button?.action = #selector(markClicked); statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
    popover.contentViewController = NSHostingController(rootView: PopoverView().environmentObject(state)); popover.delegate = self
    state.selfHeal()
    HotKey.onPress = { [weak self] in self?.state.toggleAsk() }; HotKey.register()
    if state.pairing == nil || !Self.launchedAsLoginItem() { showWindow() }
    timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      guard let self else { return }
      Task { @MainActor in await self.state.tick(); self.refreshPresence() }
    }
    Task { @MainActor in await state.tick(force: true); refreshPresence() }
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
    let title = state.pairing.map { _ in Presence.line(deskCount: max(state.deskTotal, state.desk.count)) } ?? "Not paired"
    m.addItem(withTitle: title, action: nil, keyEquivalent: "")
    for item in state.desk.prefix(3) where !item.title.isEmpty {
      let t = item.title.count > 64 ? String(item.title.prefix(63)) + "…" : item.title
      m.addItem(withTitle: "· " + t, action: #selector(openDesk), keyEquivalent: "").target = self
    }
    if state.pairing != nil { m.addItem(withTitle: "Open the Desk", action: #selector(openDesk), keyEquivalent: "d").target = self }
    if state.pairing != nil {
      let dot = state.online == true ? "connected" : (state.online == false ? "unreachable" : "checking")
      m.addItem(withTitle: "Tenant \(dot)", action: nil, keyEquivalent: "")
      let r = state.state.lastRenderAt.map { "Memory rendered \(Self.ago($0)) · \(state.state.lastRenderEntries) entries" } ?? "Memory not rendered yet"
      m.addItem(withTitle: r, action: nil, keyEquivalent: "")
      let p = state.state.lastPushAt.map { "Cowork mirrored \(Self.ago($0)) · \(state.state.totalPushed) turns total" } ?? "Cowork not mirrored yet"
      m.addItem(withTitle: p, action: nil, keyEquivalent: "")
    }
    m.addItem(.separator())
    m.addItem(withTitle: "Ask Alfred…", action: #selector(askAlfred), keyEquivalent: "").target = self
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

  /// Left click: the popover. Right click: the utility menu.

  @objc func markClicked() {

    guard let button = statusItem.button else { return }

    if NSApp.currentEvent?.type == .rightMouseUp || state.pairing == nil {

      if state.pairing == nil { showWindow(); return }

      statusItem.menu = buildMenu(); button.performClick(nil); statusItem.menu = nil; return

    }

    if popover.isShown { popover.performClose(nil) }

    else { state.popoverOpened(); popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY); popover.contentViewController?.view.window?.makeKey() }

  }

  @objc func askAlfred() { state.toggleAsk() }

  @objc func openWindow() { showWindow() }

  /// The mark, and the dot only while something needs the principal's word.

  func refreshPresence() {

    let dark = statusItem.button?.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua

    let img = Presence.image(needsWord: state.needsWord, dark: dark)

    if statusItem.button?.image?.size != img.size || statusItem.button?.image?.isTemplate != img.isTemplate || state.needsWord { statusItem.button?.image = img }

  }

  @objc func openDesk() { if let d = state.pairing?.domain, let u = URL(string: "https://\(d)/desk") { NSWorkspace.shared.open(u) } }
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
