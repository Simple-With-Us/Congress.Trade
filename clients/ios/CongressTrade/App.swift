import SwiftUI
import SwiftData
import OSLog
import UIKit
import CoreText

/// Tab identity shared with `TabRouter` so any screen can programmatically
/// switch tabs.
/// Order matches `MainTabView`: Trends | Trades | Directory | Delivery
/// (owner punch list #2, item 9 — Directory inserted between Trades and
/// Delivery).  There is no Settings tab: account, alerts, theme, export and
/// legal all live in the header hamburger's `AccountQuickMenu`, which is a
/// strict superset of the old tab.
enum AppTab: Hashable {
    case trends, trades, people, delivery
}

/// Cross-tab navigation for any screen that needs to move the user to another
/// tab.  Trends is the default/leftmost tab (owner punch list item 1).
@MainActor
final class TabRouter: ObservableObject {
    @Published var selection: AppTab =
        ProcessInfo.processInfo.arguments.contains("-startOnTrades") ? .trades : .trends
}

/// Inbound share / Universal Link / custom-scheme destinations that already
/// exist in the app.  Missing or unknown queries stay `nil` — we do not
/// invent a tab or sheet.  `congresstrade://auth` is session handoff only.
///
/// Associated Domains (`applinks:congress.trade`) still has to be flipped on
/// in Xcode's capability UI — do not hand-edit the entitlements file.
enum AppDeepLink: Equatable {
    case auth(token: String)
    case trade(id: String)
    case member(id: String)
    case ticker(symbol: String)
    case filing(docId: String)
    case tab(AppTab)

    static func parse(_ url: URL) -> AppDeepLink? {
        let scheme = url.scheme?.lowercased() ?? ""
        guard scheme == "congresstrade" || scheme == "http" || scheme == "https" else {
            return nil
        }

        let host = (url.host ?? "").lowercased()
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let pathComponents = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
        let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []

        if scheme == "congresstrade" && (host == "auth" || (host.isEmpty && path.hasPrefix("auth"))) {
            guard let token = queryValue(queryItems, names: "token") else { return nil }
            return .auth(token: token)
        }

        // Website open-from-URL priority: ticker, then member, then trade.
        if let ticker = queryValue(queryItems, names: "ticker", "asset") {
            return .ticker(symbol: ticker.uppercased())
        }
        if let member = queryValue(queryItems, names: "member", "politician") {
            return .member(id: member.removingPercentEncoding ?? member)
        }
        if let trade = queryValue(queryItems, names: "trade", "trade_id") {
            return .trade(id: trade)
        }
        if let docId = queryValue(queryItems, names: "filing", "doc", "doc_id") {
            return .filing(docId: docId)
        }
        if let view = queryValue(queryItems, names: "view") {
            return tab(fromToken: view)
        }
        if queryItems.contains(where: { $0.name.caseInsensitiveCompare("delivery") == .orderedSame }) {
            return .tab(.delivery)
        }

        if scheme == "congresstrade" {
            if let link = entity(host: host, remainder: path) { return link }
            if let tabLink = tab(fromToken: host) { return tabLink }
            if host.isEmpty, let first = pathComponents.first {
                let rest = pathComponents.dropFirst().joined(separator: "/")
                if let link = entity(host: first.lowercased(), remainder: rest) { return link }
                if let tabLink = tab(fromToken: first) { return tabLink }
            }
            return nil
        }

        if let firstIdx = pathComponents.firstIndex(where: {
            Self.recognizedPathTokens.contains($0.lowercased())
        }) {
            let section = pathComponents[firstIdx].lowercased()
            let nextVal = firstIdx + 1 < pathComponents.count ? pathComponents[firstIdx + 1] : ""
            if let link = entity(host: section, remainder: nextVal) { return link }
            return tab(fromToken: section)
        }

        return nil
    }

    private static let recognizedPathTokens: Set<String> = [
        "trade", "member", "politician", "ticker", "filing", "doc",
        "delivery", "trends", "trades", "feed", "people", "directory", "subs"
    ]

    private static func queryValue(_ items: [URLQueryItem], names: String...) -> String? {
        for name in names {
            guard let raw = items.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame })?.value
            else { continue }
            let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty { return cleaned }
        }
        return nil
    }

    private static func entity(host: String, remainder: String) -> AppDeepLink? {
        let cleaned = remainder.trimmingCharacters(in: .whitespacesAndNewlines)
        switch host {
        case "trade":
            return cleaned.isEmpty ? nil : .trade(id: cleaned)
        case "member", "politician":
            return cleaned.isEmpty ? nil : .member(id: cleaned.removingPercentEncoding ?? cleaned)
        case "ticker":
            return cleaned.isEmpty ? nil : .ticker(symbol: cleaned.uppercased())
        case "filing", "doc":
            return cleaned.isEmpty ? nil : .filing(docId: cleaned)
        default:
            return nil
        }
    }

    private static func tab(fromToken raw: String) -> AppDeepLink? {
        switch raw.lowercased() {
        case "trends":
            return .tab(.trends)
        case "trades", "feed":
            return .tab(.trades)
        case "people", "directory":
            return .tab(.people)
        case "delivery", "subs":
            return .tab(.delivery)
        default:
            return nil
        }
    }
}

@main
struct CongressTradeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = CongressTradeStore(api: CongressTradeAPIClient())
    @StateObject private var pushManager = PushNotificationManager.shared
    @StateObject private var tabRouter = TabRouter()
    @AppStorage("app_color_scheme") private var appColorScheme = "light"
    /// Flips true only after `BrandFontWarmup` has built Zilla Slab's
    /// OpenType tables off the main thread. Until then the root uses the
    /// system font so the cold-launch layout does not enter
    /// `OTL::Coverage::SearchFmt2Binary`.
    @State private var brandFontReady = false

    /// Built once, eagerly, instead of via `.modelContainer(for: ClientTrade.self)`
    /// — that convenience modifier has no error path and no recovery, so a store
    /// the current build cannot read takes the whole app down. See
    /// `makeTradeCacheContainer()`.
    private let tradeCacheContainer = CongressTradeApp.makeTradeCacheContainer()

    init() {
        // Native crashes / hangs need the Cocoa SDK before first paint.
        // sentry-cocoa requires this call on the main thread, so it stays
        // here. The Zilla warm starts from `.task` after the first frame,
        // not beside this call — a concurrent `CTLine` holds the Core Text
        // lock the first layout would wait on.
        SentryTelemetry.start()
    }

    var body: some Scene {
        WindowGroup {
            MainTabView()
                .environmentObject(store)
                .environmentObject(pushManager)
                .environmentObject(tabRouter)
                .modifier(CTPaletteInjector(pref: appColorScheme))
                .preferredColorScheme(colorScheme)
                .font(BrandFontLaunch.font(warmedOffMain: brandFontReady))
                .task {
                    let warmed = await BrandFontWarmup.waitUntilReady()
                    if warmed.ranOffMainThread {
                        brandFontReady = true
                    }
                }
                .onAppear { AppAppearance.apply(appColorScheme) }
                .onChange(of: appColorScheme) { _, pref in
                    AppAppearance.apply(pref)
                }
                // Owner 2026-09-21 ask: shake-to-report, default OFF. The
                // hook is wired at the App root so every view inherits the
                // gesture without per-screen plumbing. The detector stays
                // out of the first frame; see `ShakeToReportCoordinator`.
                .modifier(ShakeToReportCoordinator())
                .appUpdatePrompt()
        }
        .modelContainer(tradeCacheContainer)
    }

    private var colorScheme: ColorScheme? {
        switch appColorScheme {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}

// MARK: - Trade cache container

/// Opening and, when necessary, discarding the local `ClientTrade` cache.
///
/// This store is a **pure cache** of `GET /api/client/v1/feed`: the only writer
/// is `CongressTradeStore.replaceCache`, the only reader is
/// `FeedDashboardView`'s `@Query`, and every durable preference (watchlist,
/// delivery, entitlement) lives server-side. Nothing in it is user-authored, so
/// throwing it away costs one refetch — which makes "discard and refetch" the
/// correct answer to *any* doubt about the store, and makes crashing on a stale
/// one indefensible.
///
/// Four crash reports from 2026-08-10 (`~/Library/Logs/DiagnosticReports`) show
/// the failure this replaces: `EXC_BREAKPOINT` in `_assertionFailure`, three
/// SwiftData frames, then `ClientTrade.storedAsset.getter` under
/// `TradeCard.body`. Install succeeds; the first paint of a cached Trades row
/// kills the process, every launch, forever.
extension CongressTradeApp {
    private static let logger = Logger(subsystem: "trade.congress.ios", category: "tradecache")

    /// Opens the cache, in descending order of preference:
    ///
    /// 1. **Prevent.** Compare the persisted shape stamp with
    ///    `ClientTradeCacheSchema.identity` and delete the store on any
    ///    mismatch, *before* SwiftData can fault a row out of it.
    /// 2. **Break the loop.** A probe marker is written before the first read
    ///    and cleared only after it succeeds. A launch that finds the marker
    ///    still set knows the previous launch died mid-read and wipes. This is
    ///    what covers a shape change the stamp fails to notice: the crash
    ///    happens at most once instead of on every launch forever.
    /// 3. **Recover.** If the open throws, wipe and retry once.
    /// 4. **Degrade, never refuse.** If it throws again, run on an in-memory
    ///    container: the app works and refetches on every launch, which is far
    ///    better than an app that will not start.
    static func makeTradeCacheContainer() -> ModelContainer {
        let schema = Schema([ClientTrade.self])
        let configuration = ModelConfiguration(schema: schema)
        let storeURL = configuration.url
        let currentIdentity = ClientTradeCacheSchema.identity
        let stampURL = cacheStampURL(besides: storeURL)
        let probeURL = probeMarkerURL(besides: storeURL)

        // Step 1/2 — decide whether this store is safe to open at all.
        if FileManager.default.fileExists(atPath: probeURL.path) {
            logger.error("cache: previous launch did not survive its first read — wiping")
            wipeTradeCache(at: storeURL)
        } else {
            let persistedIdentity = try? String(contentsOf: stampURL, encoding: .utf8)
            if persistedIdentity != currentIdentity {
                logger.notice("""
                    cache: persisted shape \(persistedIdentity ?? "<none>", privacy: .public) \
                    != current \(currentIdentity, privacy: .public) — wiping
                    """)
                wipeTradeCache(at: storeURL)
            }
        }

        // The marker has to reach disk before the first fault, or the launch it
        // is meant to describe leaves no trace.
        writeMarker(at: probeURL)
        try? currentIdentity.write(to: stampURL, atomically: true, encoding: .utf8)

        // Step 3 — open, wipe-and-retry, then degrade.
        var container: ModelContainer
        do {
            container = try ModelContainer(for: schema, configurations: configuration)
        } catch {
            logger.error("cache: open failed (\(error.localizedDescription, privacy: .public)) — wiping and retrying")
            wipeTradeCache(at: storeURL)
            do {
                container = try ModelContainer(for: schema, configurations: configuration)
            } catch {
                logger.fault("""
                    cache: reopen failed (\(error.localizedDescription, privacy: .public)) \
                    — running in memory, every launch will refetch
                    """)
                try? FileManager.default.removeItem(at: probeURL)
                return makeInMemoryTradeCacheContainer()
            }
        }

        probeTradeCache(container, storeURL: storeURL)
        try? FileManager.default.removeItem(at: probeURL)
        return container
    }

    /// Faults every cached row's composite properties once, here at launch,
    /// while the probe marker is on disk.
    ///
    /// This is deliberate, and it is the honest answer to "guard the per-row
    /// failure": **a Swift-level guard cannot intercept it.** The failure is
    /// `_assertionFailure` inside SwiftData — a runtime trap, not a thrown error
    /// and not an ObjC exception — so `try?`, `catch` and any top-level handler
    /// are all powerless, and the standalone repro confirms the container opens
    /// and the fetch succeeds before the getter traps. What *can* be controlled
    /// is where the trap lands. Pulling it forward to a point where a marker is
    /// on disk converts an unrecoverable crash loop into one crash followed by
    /// an automatic wipe, which the stamp in step 1 should already have made
    /// unnecessary.
    ///
    /// Cost is one fetch of at most `cacheLimit` (400) small rows.
    private static func probeTradeCache(_ container: ModelContainer, storeURL: URL) {
        let context = ModelContext(container)
        guard let rows = try? context.fetch(FetchDescriptor<ClientTrade>()) else {
            logger.error("cache: probe fetch failed — leaving the store in place, next launch will wipe")
            return
        }
        // Summed rather than discarded so the optimiser cannot drop the faults.
        var faulted = 0
        for row in rows {
            faulted += row.storedMember == nil ? 0 : 1
            faulted += row.storedAsset == nil ? 0 : 1
            faulted += row.storedTransaction == nil ? 0 : 1
            faulted += row.storedFiling == nil ? 0 : 1
            faulted += row.source == nil ? 0 : 1
        }
        logger.notice("cache: opened \(storeURL.lastPathComponent, privacy: .public), \(rows.count) row(s), \(faulted) propert(ies) faulted")
    }

    private static func makeInMemoryTradeCacheContainer() -> ModelContainer {
        do {
            return try ModelContainer(
                for: Schema([ClientTrade.self]),
                configurations: ModelConfiguration(isStoredInMemoryOnly: true)
            )
        } catch {
            // One entity, no file system, nothing to migrate. If SwiftData cannot
            // build this there is no container to hand SwiftUI and no screen to
            // show an error on.
            fatalError("SwiftData cannot create an in-memory container for ClientTrade: \(error)")
        }
    }

    /// SQLite keeps its write-ahead log and shared-memory index beside the store;
    /// deleting only `default.store` leaves committed rows in `-wal` that the
    /// next open replays straight back into the poisoned state.
    private static func wipeTradeCache(at storeURL: URL) {
        for suffix in ["", "-wal", "-shm"] {
            let url = URL(fileURLWithPath: storeURL.path + suffix)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                logger.error("cache: could not delete \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private static func cacheStampURL(besides storeURL: URL) -> URL {
        URL(fileURLWithPath: storeURL.path + ".shape")
    }

    private static func probeMarkerURL(besides storeURL: URL) -> URL {
        URL(fileURLWithPath: storeURL.path + ".probe")
    }

    /// SwiftData creates the store's directory on first open, so on a clean
    /// install the marker would otherwise have nowhere to go.
    private static func writeMarker(at url: URL) {
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? Data().write(to: url, options: .atomic)
    }
}

struct MainTabView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var tabRouter: TabRouter
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    /// Same key as Trades/Trends.  Cold-start lives here so the 3s intro
    /// is not delayed by a tab's data fetch (Trends used to await
    /// `refreshTrends()` before expanding).
    @AppStorage("ct_disclaimer_expanded") private var disclaimerExpanded = false

    @State private var showSubscribeSheet = CommandLine.arguments.contains("-screenshotPaywall") || CommandLine.arguments.contains("-showSubscribe")
    @State private var activeTradeDetail: ClientTrade?
    @State private var activePolitician: MemberSheetTarget?
    @State private var activeTicker: TickerSheetTarget?
    @State private var activeFiling: FilingSheetTarget?

    var body: some View {
        TabView(selection: $tabRouter.selection) {
            // Trends is first/leftmost and the default tab on launch
            // (TabRouter.selection starts at .trends).
            TrendsView()
                .tabItem {
                    Label("Trends", systemImage: "chart.line.uptrend.xyaxis")
                }
                .tag(AppTab.trends)

            FeedDashboardView()
                .tabItem {
                    Label("Trades", systemImage: "list.bullet.rectangle")
                }
                .tag(AppTab.trades)

            PeopleDirectoryView()
                .tabItem {
                    Label("Directory", systemImage: "person.2")
                }
                .tag(AppTab.people)

            DeliveryView()
                .tabItem {
                    Label("Delivery", systemImage: "bell.badge")
                }
                .tag(AppTab.delivery)
        }
        .tint(.blue)
        .toolbarBackground(.ultraThinMaterial, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .environment(\.openPremium) { showSubscribeSheet = true }
        .sheet(isPresented: $showSubscribeSheet) {
            PremiumSheet()
                .environmentObject(store)
        }
        .sheet(item: $activeTradeDetail) { trade in
            TradeDetailView(trade: trade)
                .environmentObject(store)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(18)
                .presentationContentInteraction(.resizes)
                .iPadFullWidthSheet()
        }
        .sheet(item: $activePolitician) { target in
            PoliticianDetailView(
                memberId: target.id,
                memberName: target.name,
                seedPhotoUrl: target.photoUrl
            )
                .environmentObject(store)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(18)
                .presentationContentInteraction(.resizes)
                .iPadFullWidthSheet()
        }
        .sheet(item: $activeTicker) { target in
            TickerDetailView(ticker: target.ticker)
                .environmentObject(store)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(18)
                .presentationContentInteraction(.resizes)
                .iPadFullWidthSheet()
        }
        .sheet(item: $activeFiling) { target in
            FilingPDFSheet(docId: target.docId)
                .environmentObject(store)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(18)
                .presentationContentInteraction(.resizes)
                .iPadFullWidthSheet()
        }
        // Truth-table row 4 (owner directive 2026-08-21): a signed-in
        // account whose device already holds an UNCLAIMED Apple purchase is
        // asked once — never linked silently — whether to link it. "Not
        // now" (`dismissAppleLinkPrompt`) remembers per account so this does
        // not reappear on every launch; the Link action itself stays
        // available afterward from the Premium sheet and Restore Purchases.
        .alert(
            "Link This Subscription?",
            isPresented: Binding(get: { store.showsAppleLinkOffer }, set: { _ in })
        ) {
            Button("Not Now", role: .cancel) { store.dismissAppleLinkPrompt() }
            Button("Link") { Task { await store.linkAppleEntitlementToCurrentAccount() } }
        } message: {
            Text("This device already has an active Congress.Trade Premium subscription through the App Store.  "
                + "Link it to your account to use it on the website and your other devices too.")
        }
        // StoreKit 2 requires a listener for the whole app lifetime: Ask to Buy
        // approvals, renewals, and retries of a redeem that failed mid-purchase
        // all arrive here and nowhere else. See Store/AppleIAP.swift.
        .task {
            await store.observeAppleTransactions()
        }
        .task {
            await DisclaimerColdStart.playIfNeeded($disclaimerExpanded)
        }
        .onAppear {
            if CommandLine.arguments.contains("-screenshotPaywall") || CommandLine.arguments.contains("-showSubscribe") {
                showSubscribeSheet = true
            }
        }
        .task {
            store.modelContext = modelContext
            if store.feed == nil {
                // CT-2459: Trends is the landing tab — let its fan-out win
                // the launch bandwidth instead of racing the feed page +
                // bootstrap + signed-in probes against it (~17 requests
                // contended before first useful paint). The SwiftData
                // cache already paints the Trades list instantly; its
                // network refresh follows immediately after.
                if tabRouter.selection == .trends {
                    await store.refreshTrends()
                }
                await store.refresh()
            }
            // Catch-up for a purchase that was charged and finished locally but
            // never recorded server-side. No-op for everyone already Premium.
            await store.reconcileAppleEntitlementsQuietly()
        }
        // Pause the nextPollAfterSec poll loop while backgrounded, and play disclaimer intro on foreground.
        .onChange(of: scenePhase) { oldPhase, newPhase in
            store.setAutoRefreshPaused(newPhase != .active)
            if newPhase == .active && oldPhase == .background {
                DisclaimerColdStart.triggerFromForeground($disclaimerExpanded)
            }
        }
        // Push notification tap handlers
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("OpenTradeFromPush"))) { notification in
            guard let tradeId = (notification.userInfo?["trade_id"] as? String) ?? (notification.userInfo?["tradeId"] as? String),
                  !tradeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            let cleanId = tradeId.trimmingCharacters(in: .whitespacesAndNewlines)
            tabRouter.selection = .trades
            Task {
                if let trade = await store.fetchTrade(id: cleanId) {
                    activeTradeDetail = trade
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("OpenFilingFromPush"))) { notification in
            guard let docId = (notification.userInfo?["doc_id"] as? String) ?? (notification.userInfo?["docId"] as? String),
                  !docId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            let cleanDoc = docId.trimmingCharacters(in: .whitespacesAndNewlines)
            tabRouter.selection = .trades
            activeFiling = FilingSheetTarget(docId: cleanDoc)
        }
        // Universal Links arrive as a browsing-web activity; custom-scheme
        // and some https handoffs also hit onOpenURL.  Same parser for both.
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL {
                handleOpenURL(url)
            }
        }
        .onOpenURL { url in
            handleOpenURL(url)
        }
    }

    private func handleOpenURL(_ url: URL) {
        guard let link = AppDeepLink.parse(url) else { return }
        switch link {
        case .auth(let token):
            _ = store.saveSessionToken(token)
        case .trade(let id):
            tabRouter.selection = .trades
            Task {
                if let trade = await store.fetchInboundTrade(id: id) {
                    activeTradeDetail = trade
                }
            }
        case .member(let id):
            resolveAndOpenMember(id)
        case .ticker(let symbol):
            activeTicker = TickerSheetTarget(ticker: symbol)
        case .filing(let docId):
            tabRouter.selection = .trades
            activeFiling = FilingSheetTarget(docId: docId)
        case .tab(let tab):
            tabRouter.selection = tab
        }
    }

    private func resolveAndOpenMember(_ raw: String) {
        let unescaped = raw.removingPercentEncoding ?? raw
        let target = unescaped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else { return }

        Task {
            if store.members.isEmpty {
                await store.loadMembersDirectory()
            }
            if let match = store.members.first(where: {
                $0.filerId.caseInsensitiveCompare(target) == .orderedSame ||
                $0.fullName?.caseInsensitiveCompare(target) == .orderedSame
            }) {
                activePolitician = MemberSheetTarget(
                    id: match.filerId,
                    name: match.fullName ?? match.filerId,
                    photoUrl: match.photoUrl
                )
            } else {
                activePolitician = MemberSheetTarget(
                    id: target,
                    name: target
                )
            }
        }
    }
}

struct FilingSheetTarget: Identifiable, Hashable {
    let docId: String
    var id: String { docId }
}

// MARK: - Cold-launch font (CT-2435)

/// Zilla Slab's first `CTLine` walks `OTL::Coverage::SearchFmt2Binary` on
/// whatever thread draws it. Cold-launch hangs sampled that walk on the
/// main thread while Sentry's current screen was `ShakeDetectorViewController`.
/// The tables are built on a detached task; the root view applies the face
/// only after that task has left the main thread.
enum BrandFontWarmup {
    static let postScriptName = "ZillaSlab-Regular"

    struct Result: Equatable, Sendable {
        let ranOffMainThread: Bool
    }

    private static let lock = NSLock()
    private static var warmedOffMain = false
    private static let warmTask: Task<Result, Never> = Task.detached(priority: .userInitiated) {
        warmTables()
    }

    static func hasWarmedOffMain() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return warmedOffMain
    }

    static func waitUntilReady() async -> Result {
        await warmTask.value
    }

    /// Loads the face and builds one line so later main-thread layout hits
    /// warm coverage tables. Returns whether this call itself ran off the
    /// main thread — a main-thread call does not count as warmed.
    static func warmTables() -> Result {
        let offMain = !Thread.isMainThread
        if UIFont(name: postScriptName, size: 17) == nil,
           let url = Bundle.main.url(forResource: "ZillaSlab-Regular", withExtension: "ttf") {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        let font = UIFont(name: postScriptName, size: 17) ?? UIFont.systemFont(ofSize: 17)
        let sample = NSAttributedString(string: "Congress.Trade", attributes: [.font: font])
        _ = CTLineCreateWithAttributedString(sample as CFAttributedString)
        if offMain {
            lock.lock()
            warmedOffMain = true
            lock.unlock()
        }
        return Result(ranOffMainThread: offMain)
    }
}

enum BrandFontLaunch {
    /// The custom face stays off the cold-launch layout turn.
    static func appliesCustomFont(warmedOffMain: Bool) -> Bool {
        warmedOffMain
    }

    static func font(warmedOffMain: Bool) -> Font {
        if appliesCustomFont(warmedOffMain: warmedOffMain) {
            return .custom(BrandFontWarmup.postScriptName, size: 17, relativeTo: .body)
        }
        return .body
    }
}

// MARK: - Shake-to-report (owner 2026-09-21 ask, default OFF)

/// Opt-in flag for shake-to-report. The cold-launch read goes through
/// `load`, which hops to a detached task. `UserDefaults.standard` from
/// `updateUIViewController` used to run inside the first SwiftUI layout.
enum ShakeToReportPreference {
    static let defaultsKey = "shake_to_report_enabled"
    static let enabledUserInfoKey = "enabled"

    static func load(suiteName: String? = nil) async -> ShakePreferenceRead {
        let key = defaultsKey
        return await Task.detached(priority: .utility) {
            let defaults: UserDefaults
            if let suiteName {
                defaults = UserDefaults(suiteName: suiteName) ?? .standard
            } else {
                defaults = .standard
            }
            return ShakePreferenceRead(
                enabled: defaults.bool(forKey: key),
                readOffMainThread: !Thread.isMainThread
            )
        }.value
    }
}

struct ShakePreferenceRead: Equatable, Sendable {
    let enabled: Bool
    let readOffMainThread: Bool
}

/// When the UIKit detector may join the window. It stays out until the
/// first frame has committed and the user has opted in (default off).
/// Installing it earlier makes `viewDidAppear` call `becomeFirstResponder`
/// on the same main-thread turn Sentry records as an app hang.
enum ShakeToReportLaunch {
    static func shouldInstallDetector(isEnabled: Bool, firstFrameCommitted: Bool) -> Bool {
        isEnabled && firstFrameCommitted
    }

    static func schedule(isEnabled: Bool, firstFrameCommitted: Bool) -> ShakeResponderSchedule {
        if shouldInstallDetector(isEnabled: isEnabled, firstFrameCommitted: firstFrameCommitted) {
            return .nextMainTurn
        }
        return .skip
    }
}

enum ShakeResponderSchedule: Equatable {
    /// Do not touch the responder chain. This is the cold-launch path.
    case skip
    /// Arm on the next main turn, after the appearance layout has returned.
    case nextMainTurn
}

/// Listens for the iOS shake gesture once launch has settled. Default is
/// OFF. A zero-size view controller is inserted only after `load` returns,
/// so the first frame does not host `ShakeDetectorViewController`.
struct ShakeToReportCoordinator: ViewModifier {
    @State private var isEnabled = false
    @State private var firstFrameCommitted = false
    @State private var preferenceOverridden = false

    func body(content: Content) -> some View {
        content
            .background {
                if ShakeToReportLaunch.shouldInstallDetector(
                    isEnabled: isEnabled,
                    firstFrameCommitted: firstFrameCommitted
                ) {
                    ShakeDetectorHost(isEnabled: isEnabled)
                        .frame(width: 0, height: 0)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .task {
                let loaded = await ShakeToReportPreference.load()
                if !preferenceOverridden {
                    isEnabled = loaded.enabled
                }
                firstFrameCommitted = true
            }
            .onReceive(NotificationCenter.default.publisher(for: .shakeToReportPreferenceChanged)) { note in
                preferenceOverridden = true
                if let value = note.userInfo?[ShakeToReportPreference.enabledUserInfoKey] as? Bool {
                    isEnabled = value
                }
            }
    }
}

private struct ShakeDetectorHost: UIViewControllerRepresentable {
    let isEnabled: Bool

    func makeUIViewController(context: Context) -> ShakeDetectorViewController {
        let vc = ShakeDetectorViewController()
        vc.isShakeEnabled = isEnabled
        vc.launchFrameCommitted = true
        return vc
    }

    func updateUIViewController(_ vc: ShakeDetectorViewController, context: Context) {
        vc.isShakeEnabled = isEnabled
        vc.launchFrameCommitted = true
    }
}

final class ShakeDetectorViewController: UIViewController {
    /// Set by the host from the opt-in flag. Init leaves this false so
    /// constructing the controller does not read `UserDefaults`.
    var isShakeEnabled = false
    /// Set by the host, which is inserted only after the first frame.
    var launchFrameCommitted = false

    override var canBecomeFirstResponder: Bool {
        responderSchedule() == .nextMainTurn
    }

    func responderSchedule() -> ShakeResponderSchedule {
        ShakeToReportLaunch.schedule(
            isEnabled: isShakeEnabled,
            firstFrameCommitted: launchFrameCommitted
        )
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The host is a zero-size background. An opaque view here would
        // paint over the first frame if SwiftUI gave it a non-zero slot.
        view.backgroundColor = .clear
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        switch responderSchedule() {
        case .skip:
            return
        case .nextMainTurn:
            // The next turn, not this appearance call. `becomeFirstResponder`
            // here used to extend the cold-launch layout that Core Text was
            // still measuring.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.responderSchedule() == .nextMainTurn else { return }
                self.becomeFirstResponder()
            }
        }
    }

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        super.motionEnded(motion, with: event)
        guard motion == .motionShake else { return }
        guard isShakeEnabled else { return }
        // Single notification post per shake; the Account sheet listens
        // and presents `BugReportSheet`. Avoids any per-view re-binding.
        NotificationCenter.default.post(name: .shakeToReport, object: nil)
        // Light haptic so the user knows the gesture was caught (they
        // don't see a visual until the sheet appears ~250ms later).
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}

// AppUpdatePrompt lives in AppUpdatePrompt.swift, copied from
// scripts/ios-fleet/AppUpdatePrompt.swift.  Do not inline it here.
