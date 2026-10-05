import SwiftUI
import SwiftData
import UIKit

struct FeedDashboardView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Query private var cachedTrades: [ClientTrade]
    @State private var searchText = ""
    @State private var filterTask: Task<Void, Never>?
    @State private var selectedTrade: ClientTrade?
    @State private var selectedPolitician: MemberSheetTarget?
    @State private var selectedTicker: TickerSheetTarget?
    /// Shared with Trends via the same `@AppStorage` key so the disclaimer's
    /// dismissed/expanded state is one truth across both tabs — never a
    /// per-view `@State` that resets on tab switch.
    @AppStorage("ct_disclaimer_expanded") private var disclaimerExpanded = false
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @FocusState private var searchFocused: Bool
    /// True while a debounce window is open that the store has been told about
    /// via `beginFilterChange()`. Tracked here (not inferred from `filterTask`)
    /// because every keystroke cancels and replaces that task, and the intent
    /// must be opened exactly once per debounce window, not once per keystroke.
    @State private var searchIntentOpen = false

    /// Orders the loaded page per the active Trades sort control (owner
    /// punch list #2, item 7). Date is a real backend sort key — the server
    /// already returned rows in this order — but re-sorting here keeps the
    /// list stable/consistent even if a poll races the display. Amount has
    /// no backend sort key, so this IS the sort: a local re-sort of the
    /// already-loaded page only, never a fetch beyond it.
    private var sortedCached: [ClientTrade] {
        let ascending = store.feedSortDirection == .ascending
        switch store.feedSortKey {
        case .date:
            return cachedTrades.sorted { lhs, rhs in
                let ld = lhs.transaction.date ?? ""
                let rd = rhs.transaction.date ?? ""
                if ld != rd { return ascending ? ld < rd : ld > rd }
                let lf = lhs.filing.filedDate ?? ""
                let rf = rhs.filing.filedDate ?? ""
                if lf != rf { return ascending ? lf < rf : lf > rf }
                let lc = lhs.cursor ?? 0
                let rc = rhs.cursor ?? 0
                return ascending ? lc < rc : lc > rc
            }
        case .amount:
            return cachedTrades.sorted { lhs, rhs in
                let la = lhs.transaction.amountMin ?? 0
                let ra = rhs.transaction.amountMin ?? 0
                if la != ra { return ascending ? la < ra : la > ra }
                // Stable tie-break: newest trade date first, regardless of direction.
                return (lhs.transaction.date ?? "") > (rhs.transaction.date ?? "")
            }
        case .ticker:
            return cachedTrades.sorted { lhs, rhs in
                let lt = (lhs.asset.ticker ?? "").uppercased()
                let rt = (rhs.asset.ticker ?? "").uppercased()
                if lt != rt { return ascending ? lt < rt : lt > rt }
                return (lhs.transaction.date ?? "") > (rhs.transaction.date ?? "")
            }
        }
    }

    var filteredTrades: [ClientTrade] {
        let searchNeedle = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let chambers = store.selectedChambers
        let filteringChambers = !chambers.isEmpty
        let fromISO = store.selectedTimeRange.fromDateISO
        let toISO = store.selectedTimeRange.toDateISO
        let types = store.selectedTradeTypes
        let parties = store.selectedParties

        return sortedCached.filter { trade in
            if let fromISO {
                let tx = trade.transaction.date ?? ""
                if !tx.isEmpty, tx < fromISO { return false }
            }
            if let toISO {
                let tx = trade.transaction.date ?? ""
                if !tx.isEmpty, tx > toISO { return false }
            }

            if filteringChambers {
                if let raw = trade.member.chamber?.lowercased(), let chamber = ChamberFilter(rawValue: raw) {
                    if !chambers.contains(chamber) { return false }
                } else {
                    // Unresolved chamber drops out only when a filter is active.
                    return false
                }
            }

            // Multi-select side filter. Server `type=` is CSV; keep a local
            // pass so a stale cached page cannot show the wrong sides.
            if !types.isEmpty, !types.contains(where: { $0.matches(txType: trade.transaction.type) }) {
                return false
            }

            // Party is also sent as `party=` CSV; keep a local pass for cache.
            if !parties.isEmpty {
                // `bucket(for:)` is total: a no-party row is "Other / No party",
                // matching the server's `party=O` (board efd94c45).
                guard parties.contains(PartyFilter.bucket(for: trade.member.party)) else {
                    return false
                }
            }

            // Unified multi-token search (any order): each token may match
            // politician name, ticker, asset name, state, or party.
            if !searchNeedle.isEmpty {
                if !TradeSearch.matches(trade, query: searchNeedle) {
                    return false
                }
            }
            return true
        }
    }

    private var hasActiveTextFilter: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Status that occupies the search-field slot. Reload wins over Updating
    /// because it is actionable. `nil` shows the typed search field.
    private var tradesSearchSlotStatus: TradesSearchSlotStatus? {
        Self.searchSlotStatus(
            notice: store.feedNotice,
            isOffline: store.isOffline,
            isTradesUpdating: store.isTradesUpdating,
            isSearchFocused: searchFocused
        )
    }

    /// Pure so it can be tested; the view only supplies the four facts.
    ///
    /// The `isSearchFocused` clause is the fix for the one-character-per-tap
    /// bug.  The slot swaps the `TextField` out of the hierarchy whenever this
    /// returns non-nil, and the first keystroke sets `isApplyingFilters`
    /// synchronously, so before this the field was destroyed on keystroke one
    /// and only came back — unfocused — after the server round trip.  While the
    /// user is typing, an in-flight refresh is reported by a spinner *inside*
    /// the field instead (see `TradesUnifiedSearchField.isUpdating`), which
    /// keeps the field, the caret and the keyboard alive.
    ///
    /// `.reload` deliberately still wins over focus: it is the only recovery
    /// control on this tab, and silently swallowing it to preserve a keystroke
    /// would leave a failed load with no way out.
    static func searchSlotStatus(
        notice: String?,
        isOffline: Bool,
        isTradesUpdating: Bool,
        isSearchFocused: Bool
    ) -> TradesSearchSlotStatus? {
        if let notice,
           isOffline || (!notice.isEmpty && !Self.isBenignCancellationNotice(notice)) {
            return .reload(message: isOffline ? "You are offline." : notice)
        }
        if isTradesUpdating && !isSearchFocused {
            return .updating
        }
        return nil
    }

    /// Never the page limit. `CongressTradeStore.tradeCountSummary` owns the
    /// decision of which number (if any) is honest for the active combination
    /// of server-side and client-only filters; the view only supplies the two
    /// facts the store cannot see — what it is actually rendering, and the
    /// live search text.
    private func tradeCountLabel(showing shown: Int) -> String? {
        store.tradeCountSummary(visibleCount: shown, localSearchText: searchText).label
    }

    var body: some View {
        // Read once per render. `filteredTrades` re-sorts the whole loaded page
        // every time it is touched, and the body needs it for the count, the
        // empty state and the list — three full sorts per frame before this.
        let trades = filteredTrades
        return NavigationStack {
            VStack(spacing: 0) {
                FeedDisclaimerHeader(disclaimerExpanded: $disclaimerExpanded) {
                    VStack(spacing: 6) {
                        FeedControlBar()
                        TradesUnifiedSearchField(
                            text: $searchText,
                            countLabel: tradeCountLabel(showing: trades.count),
                            focused: $searchFocused,
                            status: tradesSearchSlotStatus,
                            isUpdating: store.isTradesUpdating,
                            onSubmit: { applyUnifiedSearch() },
                            onClear: {
                                searchText = ""
                                Task {
                                    await store.setSearch(nil)
                                    await store.setPoliticianFilter("")
                                    await store.setAssetFilter("")
                                }
                            },
                            onReload: { Task { await store.refresh() } }
                        )
                        .onChange(of: searchText) { _, _ in
                            scheduleSearchDebounce()
                        }
                        .onChange(of: tradesSearchSlotStatus) { _, status in
                            // Only `.reload` takes focus away.  Dropping focus
                            // on `.updating` was the second half of the
                            // one-character-per-tap bug: it dismissed the
                            // keyboard on every keystroke.
                            if case .reload = status { searchFocused = false }
                        }
                    }
                }

            ScrollView {
                VStack(spacing: 8) {
                    if trades.isEmpty && !store.isRefreshing {
                        ContentUnavailableView {
                            Label(
                                hasActiveTextFilter ? "No Matching Trades" : "No Trades in Range",
                                systemImage: "tray"
                            )
                        } description: {
                            Text(
                                hasActiveTextFilter
                                    ? "Try another ticker, politician, or state."
                                    : "Try a wider time range, or pull to refresh."
                            )
                        } actions: {
                            Button("Retry") { Task { await store.refresh() } }
                                .buttonStyle(.bordered)
                                .clipShape(Capsule())
                        }
                        .padding(.top, 40)
                    }

                    // Same component top and bottom, over the same store — one
                    // paging code path, so the two bars can never disagree
                    // (owner: the pagination controls were "way at bottom and
                    // missing from top of the list of trades").
                    if !trades.isEmpty {
                        FeedPaginationBar(showSort: true)
                    }

                    if horizontalSizeClass == .regular {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 360, maximum: 600), spacing: 12)], spacing: 12) {
                            ForEach(trades) { trade in
                                TradeCard(
                                    trade: trade,
                                    onRowTap: { selectedTrade = trade },
                                    onPoliticianTap: trade.member.id.map { memberId in
                                        {
                                            selectedPolitician = MemberSheetTarget(
                                                id: memberId,
                                                name: trade.member.name ?? "Politician",
                                                photoUrl: trade.member.photoUrl
                                            )
                                        }
                                    },
                                    onTickerTap: trade.asset.ticker.map { ticker in
                                        { selectedTicker = TickerSheetTarget(ticker: ticker) }
                                    }
                                )
                            }
                        }
                    } else {
                        LazyVStack(spacing: 8) {
                            ForEach(trades) { trade in
                                TradeCard(
                                    trade: trade,
                                    onRowTap: { selectedTrade = trade },
                                    onPoliticianTap: trade.member.id.map { memberId in
                                        {
                                            selectedPolitician = MemberSheetTarget(
                                                id: memberId,
                                                name: trade.member.name ?? "Politician",
                                                photoUrl: trade.member.photoUrl
                                            )
                                        }
                                    },
                                    onTickerTap: trade.asset.ticker.map { ticker in
                                        { selectedTicker = TickerSheetTarget(ticker: ticker) }
                                    }
                                )
                            }
                        }
                    }

                    if !trades.isEmpty {
                        FeedPaginationBar()
                    }

                    AppLegalFooter()
                        .padding(.top, 8)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            }
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .ctSolidFeedHeader()
            .toolbar {
                // Exactly Trends' three slots — ⓘ leading, brand principal,
                // hamburger trailing. CSV export moved to the header menu and
                // the Delivery tab; dropping that second trailing item is also
                // what un-squeezes the principal slot, since a centred
                // principal item only gets the width left after *twice* the
                // wider side (owner: "the Trades tab shouldn't have a smaller
                // logo").
                ToolbarItem(placement: .topBarLeading) {
                    HeaderIconButton(
                        systemImage: "info.circle",
                        accessibilityLabel: "About Congress.Trade"
                    ) {
                        DisclaimerColdStart.cancelAutoHide()
                        withAnimation(.easeInOut(duration: 0.32)) {
                            disclaimerExpanded.toggle()
                        }
                    }
                }
                ToolbarItem(placement: .principal) {
                    BrandTitle()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HamburgerMenuButton()
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    // Dark legible ink, not the app-wide blue tint (owner
                    // 2026-08-21); `.tint` is required alongside
                    // `.foregroundStyle` because the toolbar button style
                    // re-applies tint over a plain foreground colour.
                    Button("Done") { searchFocused = false }
                        .foregroundStyle(AppTheme.wordInk)
                        .tint(AppTheme.wordInk)
                }
            }
            .refreshable { await store.refresh() }
            .overlay {
                if store.isRefreshing && cachedTrades.isEmpty {
                    ProgressView()
                        .controlSize(.large)
                        .padding(24)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
            .sheet(item: $selectedTrade) { trade in
                TradeDetailView(trade: trade)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(18)
                    .presentationContentInteraction(.resizes)
                    .iPadFullWidthSheet()
            }
            .sheet(item: $selectedPolitician) { target in
                PoliticianDetailView(
                    memberId: target.id,
                    memberName: target.name,
                    seedPhotoUrl: target.photoUrl
                )
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(18)
                    .presentationContentInteraction(.resizes)
                    .iPadFullWidthSheet()
            }
            .sheet(item: $selectedTicker) { target in
                TickerDetailView(ticker: target.ticker)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(18)
                    .presentationContentInteraction(.resizes)
                    .iPadFullWidthSheet()
            }
            .onDisappear {
                filterTask?.cancel()
                // Leaving the tab mid-debounce would otherwise leave the
                // store's intent counter raised until its watchdog fires.
                if searchIntentOpen {
                    searchIntentOpen = false
                    store.endFilterChange()
                }
            }
            .simultaneousGesture(
                TapGesture().onEnded { searchFocused = false }
            )
        }
    }

    private func scheduleFilterApply(_ work: @escaping @MainActor () async -> Void) {
        filterTask?.cancel()
        filterTask = Task {
            try? await Task.sleep(for: .milliseconds(320))
            guard !Task.isCancelled else { return }
            await work()
        }
    }

    /// Submit path for the unified search field: reaches the server via
    /// `CongressTradeStore.setSearch` (ticker-vs-politician-name heuristic
    /// lives in `CongressTradeStore.looksLikeTicker`) immediately, rather
    /// than waiting for the typing debounce below.
    private func applyUnifiedSearch() {
        filterTask?.cancel()
        openSearchIntent()
        Task {
            await store.setSearch(searchText)
            closeSearchIntent()
        }
    }

    /// Typing itself only needs the already-loaded page's local re-filter
    /// (`filteredTrades`, via `TradeSearch.matches`, recomputes automatically
    /// off `searchText` — no explicit trigger needed); this debounce is
    /// purely so a pause in typing also reaches the server, same 320ms
    /// pattern `scheduleFilterApply` used for the old per-field search.
    ///
    /// The store is told a filter change is pending BEFORE the debounce runs,
    /// so the "updating" indicator covers the wait the user actually feels
    /// (debounce + round trip) rather than lighting up 320ms late.
    private func scheduleSearchDebounce() {
        openSearchIntent()
        scheduleFilterApply { [searchText] in
            await store.setSearch(searchText)
            closeSearchIntent()
        }
    }

    /// Opened once per debounce window — never once per keystroke, which would
    /// leave the counter permanently ahead of its closes.
    private func openSearchIntent() {
        guard !searchIntentOpen else { return }
        searchIntentOpen = true
        store.beginFilterChange()
    }

    private func closeSearchIntent() {
        guard searchIntentOpen else { return }
        searchIntentOpen = false
        store.endFilterChange()
    }

    /// Grey full-width "cancelled" cards under the filter bar came from
    /// URLError.cancelled / Task cancel being painted as feedNotice.
    private static func isBenignCancellationNotice(_ message: String) -> Bool {
        let lower = message.lowercased()
        return lower == "cancelled" || lower == "canceled" || lower.contains("cancelled") || lower.contains("canceled")
    }
}

// MARK: - Header / controls

/// Website-parity brand lockup: eagle+bag with CONGRESS / TRADE baked into the
/// light/dark lockup assets. No trailing "Congress.Trade" text after the mark.
/// Sized ~50% larger than the old 28pt bar, then +10% (42→46 / 300→330) and
/// lockup art has ~½ capital-width extra gap between CONGRESS|eagle|TRADE.
struct BrandTitle: View {
    var body: some View {
        Image("BrandLockup")
            .resizable()
            .scaledToFit()
            .frame(height: 46)
            .frame(maxWidth: 330)
            .accessibilityLabel("Congress.Trade")
    }
}

/// Process-lifetime cold-start and foreground intro for the header disclaimer.
///
/// Plays on initial app launch (4s auto-hide) and upon returning from background.
/// Shared across the entire app so switching tabs preserves the 4s timer and
/// auto-hides simultaneously on all tabs. A tap on ⓘ cancels auto-hide.
@MainActor
enum DisclaimerColdStart {
    private static var isPlaying = false
    private static var hideTask: Task<Void, Never>?

    static func playIfNeeded(
        _ expanded: Binding<Bool>,
        hold: Duration = .seconds(4)
    ) async {
        cancelAutoHide()
        isPlaying = true
        withAnimation(.easeInOut(duration: 0.32)) {
            expanded.wrappedValue = true
        }
        let task = Task {
            try? await Task.sleep(for: hold)
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: 0.32)) {
                expanded.wrappedValue = false
            }
            isPlaying = false
        }
        hideTask = task
        await task.value
        hideTask = nil
    }

    static func cancelAutoHide() {
        hideTask?.cancel()
        hideTask = nil
        isPlaying = false
    }

    static func triggerFromForeground(_ expanded: Binding<Bool>) {
        cancelAutoHide()
        Task {
            await playIfNeeded(expanded, hold: .seconds(4))
        }
    }

    #if DEBUG
    static func resetForTests() {
        cancelAutoHide()
    }
    #endif
}

/// Disclaimer under the wordmark, above the filter/search strip.
///
/// Lives *outside* the vertical `ScrollView` so ⓘ works at any scroll
/// offset (the old banner was the first row of the list, so a tap while
/// scrolled looked like a no-op and glitched the offset).  Expanding it
/// pushes the filter pills down; collapsing slides them back up under
/// the title.
struct FeedDisclaimerHeader<Content: View>: View {
    @Binding var disclaimerExpanded: Bool
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            if disclaimerExpanded {
                DisclaimerBanner()
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
                    .padding(.bottom, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            FeedStickyBar(content: content)
        }
        .animation(.easeInOut(duration: 0.32), value: disclaimerExpanded)
    }
}

/// Opaque strip that pins the filter pills under the wordmark.
///
/// Not `ultraThinMaterial` and not `AppTheme.panel` (92% white): both
/// composite over the cool page and read as a blue wash (owner screenshots
/// 2026-08-22).  Keep this *outside* the vertical `ScrollView` so the pills
/// stay put on scroll, glued to the light header instead of sitting in the
/// grey page with a gap under the title.
struct FeedStickyBar<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(.horizontal, 16)
            .padding(.top, 2)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AppTheme.headerChrome)
    }
}

/// Shared under-header filter strip used on both Trades and Trends.
struct FeedControlBar: View {
    @EnvironmentObject private var store: CongressTradeStore
    var showMetrics: Bool = true

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                // Timeframe Filter — stays fully visible (icon+value) at all
                // times and sits first/top-left (owner punch list item 5).
                Menu {
                    // Owner 2026-09-21 ask: drop "1 Month" (less than 10% of
                    // 3-Month count, misleading given the 45-day STOCK Act
                    // reporting window) and "All Time" (5-year retention is
                    // now the longest available window; "All Time" timed
                    // out on iOS even when it returned the same count as
                    // 5 Years). Enum cases stay in place for backward
                    // compat with persisted UserDefaults.
                    ForEach(TimeRange.surfaceCases) { range in
                        Button {
                            Task { await store.setTimeRange(range) }
                        } label: {
                            HStack {
                                Text(range.label)
                                if store.selectedTimeRange == range {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Color.blue)
                                }
                            }
                        }
                    }
                } label: {
                    FilterMenuLabel(
                        title: store.selectedTimeRange.label,
                        icon: "calendar",
                        isActive: store.selectedTimeRange != .ninetyDays,
                        alwaysShowLabel: true,
                        accessibilityLabel: "Time range, \(store.selectedTimeRange.label)"
                    )
                }
                .tint(AppTheme.glyphGrey)

                // Branch/Chamber Filter — multi-select: each row is a Toggle
                // (not a Button) so tapping it flips membership without
                // dismissing the menu, matching native multi-select menu
                // idiom (Button-only menu items always dismiss on tap;
                // Toggle/Picker items don't). Wired into the `chamber=` CSV
                // param exactly as the web sends it (`app/docs/
                // client-mobile-api.md`).
                Menu {
                    Button {
                        Task { await store.setChamberSelection([]) }
                    } label: {
                        Label("All Branches", systemImage: "xmark.circle")
                    }
                    Divider()
                    ForEach(ChamberFilter.allCases) { chamber in
                        Toggle(isOn: chamberBinding(for: chamber)) {
                            Text(chamber.label)
                        }
                        .tint(.blue)
                        .accessibilityLabel(chamber.label)
                        .accessibilityValue(store.selectedChambers.contains(chamber) ? "Selected" : "Not selected")
                    }
                } label: {
                    FilterMenuLabel(
                        // Full labels joined "+" once modified (owner spec:
                        // "House+Senate"); icon-only "All" at default.
                        title: store.selectedChambers.isEmpty
                            ? "All"
                            : ChamberFilter.allCases
                                .filter { store.selectedChambers.contains($0) }
                                .map(\.label)
                                .joined(separator: "+"),
                        icon: "building.columns",
                        isActive: !store.selectedChambers.isEmpty,
                        accessibilityLabel: "Branch filter, \(store.selectedChambers.isEmpty ? "all" : ChamberFilter.allCases.filter { store.selectedChambers.contains($0) }.map(\.label).joined(separator: ", "))"
                    )
                }
                .tint(AppTheme.glyphGrey)

                // Party Filter — multi-select. Server `party=` is CSV
                // (`asPartyBuckets`); Trends and detail sheets get the same
                // value. See `CongressTradeStore.selectedParties`.
                Menu {
                    Button {
                        Task { await store.setPartySelection([]) }
                    } label: {
                        Label("All Parties", systemImage: "xmark.circle")
                    }
                    Divider()
                    ForEach(PartyFilter.allCases) { party in
                        Toggle(isOn: partyBinding(for: party)) {
                            Label {
                                Text(party.label)
                            } icon: {
                                Circle()
                                    .fill(Self.partyDotColor(party))
                                    .frame(width: 8, height: 8)
                            }
                        }
                        .tint(.blue)
                        .accessibilityLabel(party.label)
                        .accessibilityValue(store.selectedParties.contains(party) ? "Selected" : "Not selected")
                    }
                } label: {
                    FilterMenuLabel(
                        title: store.selectedParties.isEmpty
                            ? "All"
                            : PartyFilter.allCases
                                .filter { store.selectedParties.contains($0) }
                                .map(\.summaryLabel)
                                .joined(separator: "+"),
                        icon: "person.2.fill",
                        isActive: !store.selectedParties.isEmpty,
                        accessibilityLabel: "Party filter, \(store.selectedParties.isEmpty ? "all" : PartyFilter.allCases.filter { store.selectedParties.contains($0) }.map(\.label).joined(separator: ", "))"
                    )
                }
                .tint(AppTheme.glyphGrey)

                // Side/Trade Type Filter (Buy/Sell/Exchange) — multi-select.
                // Server `type=` accepts CSV (`asTxTypes`).
                Menu {
                    Button {
                        Task { await store.setTradeTypeSelection([]) }
                    } label: {
                        Label("All Sides", systemImage: "xmark.circle")
                    }
                    Divider()
                    ForEach(TradeTypeFilter.allCases) { type in
                        Toggle(isOn: tradeTypeBinding(for: type)) {
                            Text(type.label)
                        }
                        .tint(.blue)
                        .accessibilityLabel(type.label)
                        .accessibilityValue(store.selectedTradeTypes.contains(type) ? "Selected" : "Not selected")
                    }
                } label: {
                    SidesFilterMenuLabel(
                        title: store.selectedTradeTypes.isEmpty
                            ? "All"
                            : TradeTypeFilter.allCases
                                .filter { store.selectedTradeTypes.contains($0) }
                                .map(\.summaryLabel)
                                .joined(separator: "+"),
                        isActive: !store.selectedTradeTypes.isEmpty,
                        selected: store.selectedTradeTypes
                    )
                }
                .tint(AppTheme.glyphGrey)

            }
            .padding(.horizontal, 2)
            .padding(.vertical, 4)
        }
    }

    /// Same party palette as the web dashboard's `--party-d` / `--party-r` /
    /// `--party-o` CSS variables (`app/src/ui/dashboardHtml.ts`, used for the
    /// avatar rings) — Democrat blue, Republican red, Other/Independent the
    /// neutral purple, reused verbatim rather than inventing new hexes.  This
    /// replaces an earlier green/red/blue set that did not match the web
    /// palette at all (owner 2026-08-21: party symbols must read as their
    /// real party colours, not an arbitrary local guess).
    private static func partyDotColor(_ party: PartyFilter) -> Color {
        switch party {
        case .democrat: return Color(red: 0x3B / 255.0, green: 0x82 / 255.0, blue: 0xF6 / 255.0)   // --party-d #3b82f6
        case .republican: return Color(red: 0xEF / 255.0, green: 0x44 / 255.0, blue: 0x44 / 255.0) // --party-r #ef4444
        case .other: return Color(red: 0xA7 / 255.0, green: 0x8B / 255.0, blue: 0xFA / 255.0)      // --party-o #a78bfa
        }
    }

    private func chamberBinding(for chamber: ChamberFilter) -> Binding<Bool> {
        Binding(
            get: { store.selectedChambers.contains(chamber) },
            set: { _ in toggleChamber(chamber) }
        )
    }

    private func partyBinding(for party: PartyFilter) -> Binding<Bool> {
        Binding(
            get: { store.selectedParties.contains(party) },
            set: { _ in toggleParty(party) }
        )
    }

    private func tradeTypeBinding(for type: TradeTypeFilter) -> Binding<Bool> {
        Binding(
            get: { store.selectedTradeTypes.contains(type) },
            set: { _ in toggleTradeType(type) }
        )
    }

    private func toggleParty(_ party: PartyFilter) {
        var next = store.selectedParties
        if next.contains(party) {
            next.remove(party)
        } else {
            next.insert(party)
        }
        Task { await store.setPartySelection(next) }
    }

    private func toggleTradeType(_ type: TradeTypeFilter) {
        var next = store.selectedTradeTypes
        if next.contains(type) {
            next.remove(type)
        } else {
            next.insert(type)
        }
        Task { await store.setTradeTypeSelection(next) }
    }

    private func toggleChamber(_ chamber: ChamberFilter) {
        var next = store.selectedChambers
        if next.contains(chamber) {
            next.remove(chamber)
        } else {
            next.insert(chamber)
        }
        Task { await store.setChamberSelection(next) }
    }
}

// MARK: - Shared tab chrome
//
// These two live here rather than in `Components.swift` on purpose. The
// components lane owns that file and is landing its own `LegalFooterLinks` /
// `FilterActivityIndicator`; deliberately different names mean the two can
// coexist on main without a duplicate-declaration break, and swapping these
// call sites for the shared versions afterwards is a mechanical rename.

/// Website-tab footer on every iOS tab: disclaimer, then Privacy / Terms /
/// Pricing / Support.  App Store review expects the links reachable from
/// inside the app, and the owner asked for them on all tabs rather than
/// buried in Settings.
///
/// Buttons (`LegalFooterLinks`), not Markdown `Text`.  SwiftUI only parses
/// Markdown for string *literals*; a concatenated `[label](url)` string
/// prints as source (owner screenshot, TestFlight 1.0.15).  `AttributedString`
/// can still fall back to that raw source if parsing throws.  Buttons cannot.
struct AppLegalFooter: View {
    var body: some View {
        SiteFooterStack()
            .padding(.vertical, 6)
    }
}

/// Occupies the Trades search-field geometry so a reload / updating message
/// does not add a second row. The typed query stays on the binding.
enum TradesSearchSlotStatus: Equatable {
    case updating
    case reload(message: String)
}

/// The one chrome every interactive control on these screens wears — filter
/// pills, both sort controls, and every pagination bar. Before this the Trades
/// tab carried three unrelated languages at once: capsule pills for filters, a
/// 30pt bordered circle for sort direction, and an `ultraThinMaterial` rounded
/// panel for the pager. The pill's geometry won because it was already the
/// dominant language here *and* the one shared with Trends, so unifying inward
/// changed the fewest pixels the owner had already signed off on.
///
/// `isActive` is the only appearance variant — filled accent means a
/// non-default value is applied. `compact` trims 2pt of horizontal padding for
/// icon-only content so a lone glyph lands on a near-square target instead of a
/// wide slab. `isEnabled` only dims; `.disabled()` still has to be applied by
/// the caller, since a chip is a label and cannot refuse its own taps.
struct ControlChip<Content: View>: View {
    var isActive: Bool = false
    var isEnabled: Bool = true
    var compact: Bool = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(.horizontal, compact ? 10 : 12)
            .padding(.vertical, 8)
            .foregroundStyle(.primary)
            .background(AppTheme.card, in: Capsule())
            .overlay(Capsule().stroke(AppTheme.borderColor, lineWidth: isActive ? 1.5 : 1))
            .opacity(isEnabled ? 1 : 0.35)
    }
}

/// Shared sort-row wrapper (Trades, Directory People, Directory Assets).
/// No "Sort:" caption — the dropdown labels the key.
struct SortRow<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            content()
        }
        .accessibilityElement(children: .contain)
    }
}

/// Directory sort: a single dropdown of keys plus a reverse-order button,
/// the same language as Trades (`FeedSortControl`). A row of capsules for
/// every key reads as filters, which is why Directory People/Assets used
/// to look like a second filter bar.
struct SortMenuControl<Key: Hashable>: View {
    let keys: [Key]
    @Binding var sortKey: Key
    @Binding var sortAscending: Bool
    let label: (Key) -> String
    var defaultAscending: ((Key) -> Bool)? = nil

    var body: some View {
        SortRow {
            HStack(spacing: 2) {
                Button {
                    sortAscending.toggle()
                } label: {
                    ControlChip(compact: true) {
                        // Bare chrome glyph, no meaning of its own — stays
                        // the lighter grey (owner 2026-08-21). Needs its own
                        // concrete `Color`: `ControlChip`'s container-level
                        // `.foregroundStyle(.primary)` is a hierarchical
                        // style, which resolves against the app-wide
                        // `.tint(.blue)` (App.swift) even with
                        // `.buttonStyle(.plain)` below.
                        Image(systemName: sortAscending ? "arrow.up" : "arrow.down")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(AppTheme.glyphGrey)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(sortAscending ? "Ascending, tap to reverse" : "Descending, tap to reverse")

                Menu {
                    ForEach(keys, id: \.self) { key in
                        Button {
                            if sortKey != key {
                                sortKey = key
                                if let defaultAscending {
                                    sortAscending = defaultAscending(key)
                                }
                            }
                        } label: {
                            HStack {
                                Text(label(key))
                                if sortKey == key {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    ControlChip {
                        // Same ink as the direction arrow (owner 2026-08-22):
                        // Menu labels pick up `.tint(.blue)` unless both the
                        // text and the Menu tint are a concrete grey.
                        Text(label(sortKey))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AppTheme.glyphGrey)
                    }
                }
                .tint(AppTheme.glyphGrey)
                .accessibilityLabel("Sort by \(label(sortKey))")
            }
        }
    }
}

/// Trades-only sort control: direction chip flush against the Date / Amount /
/// Ticker menu so they read as one group. The flip icon is the live direction
/// (`arrow.up` / `arrow.down`); the menu chevron is only "this opens a list".
struct FeedSortControl: View {
    @EnvironmentObject private var store: CongressTradeStore

    var body: some View {
        HStack(spacing: 2) {
            Button {
                Task { await store.toggleFeedSortDirection() }
            } label: {
                ControlChip(compact: true) {
                    // Bare chrome glyph, no meaning of its own — stays the
                    // lighter grey (owner 2026-08-21); needs its own concrete
                    // `Color` because `ControlChip`'s container-level
                    // `.foregroundStyle(.primary)` is hierarchical and
                    // resolves against the app-wide `.tint(.blue)`.
                    Image(systemName: store.feedSortDirection.systemImage)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(AppTheme.glyphGrey)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(store.feedSortDirection.accessibilityLabel), tap to reverse")

            Menu {
                ForEach(FeedSortKey.allCases) { key in
                    Button {
                        Task { await store.setFeedSortKey(key) }
                    } label: {
                        HStack {
                            Text(key.label)
                            if store.feedSortKey == key {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                ControlChip {
                    // Same ink as the direction arrow (owner 2026-08-22).
                    Text(store.feedSortKey.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.glyphGrey)
                }
            }
            .tint(AppTheme.glyphGrey)
            .accessibilityLabel("Sort by \(store.feedSortKey.label)")
        }
    }
}

/// "Page X of Y" + prev/next + rows-per-page, in the shared `ControlChip`
/// language — one pager for every paged list in the app (Trades server paging,
/// Directory local paging). Source of the page numbers is the caller's, so this
/// view never guesses; it renders what it is handed.
///
/// The page controls hide themselves on a single-page result (nothing to page
/// to) while rows-per-page stays. That is a branch inside the one component
/// rather than a second, trimmed-down copy of it — the whole point of this
/// existing separately from `FeedPaginationBar`.
struct PaginationBar: View {
    /// 0-indexed, so the label adds one exactly once, here.
    let currentPage: Int
    let totalPages: Int
    let pageSize: Int
    var pageSizeOptions: [Int] = [50, 100, 200]
    let canGoPrevious: Bool
    let canGoNext: Bool
    var onPrevious: () -> Void
    var onNext: () -> Void
    var onPageSize: (Int) -> Void
    var sortControls: AnyView? = nil

    private var pageLabel: String {
        "\(CompactFormat.count(currentPage + 1)) of \(CompactFormat.count(totalPages))"
    }

    var body: some View {
        HStack(spacing: 0) {
            if totalPages > 1 {
                HStack(spacing: 8) {
                    Button(action: onPrevious) {
                        ControlChip(isEnabled: canGoPrevious, compact: true) {
                            // Bare chrome glyph — stays the lighter grey
                            // (owner 2026-08-21); needs its own concrete
                            // `Color` because `ControlChip`'s hierarchical
                            // `.foregroundStyle(.primary)` resolves against
                            // the app-wide `.tint(.blue)` (App.swift).
                            Image(systemName: "chevron.left")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(AppTheme.glyphGrey)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(!canGoPrevious)
                    .accessibilityLabel("Previous page")

                    // Plain text, never a chip: it is a readout, and giving it the
                    // tappable shape would promise an action it does not have.
                    Text(pageLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .accessibilityLabel(pageLabel)

                    Button(action: onNext) {
                        ControlChip(isEnabled: canGoNext, compact: true) {
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(AppTheme.glyphGrey)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(!canGoNext)
                    .accessibilityLabel("Next page")
                }
            }

            if sortControls != nil || totalPages > 1 {
                Spacer(minLength: 4)
            }

            if let sortControls {
                sortControls
            }

            Spacer(minLength: 4)

            Menu {
                ForEach(pageSizeOptions, id: \.self) { size in
                    Button {
                        onPageSize(size)
                    } label: {
                        HStack {
                            Text("\(size) per page")
                            if pageSize == size {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                ControlChip {
                    HStack(spacing: 4) {
                        // Same ink as the sort-direction arrow (owner 2026-08-22).
                        Text("\(pageSize)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AppTheme.glyphGrey)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(AppTheme.glyphGrey)
                            .opacity(0.5)
                            .padding(.leading, 2)
                    }
                }
            }
            .tint(AppTheme.glyphGrey)
            .accessibilityLabel("Rows per page, \(pageSize)")
        }
    }
}

/// Trades' store-bound pager (owner punch list #2, item 8) — mirrors the web's
/// `#prevPageBtn`/`#nextPageBtn`/`#pageSize` (`app/src/ui/dashboardHtml.ts`).
/// Reads `total`/`limit` from the feed's own response metadata via the store's
/// `totalPages`/`pageSize`; never a client-side estimate.
///
/// Rendered twice — above and below the list — as the *same* view over the same
/// store, so there is exactly one paging code path and the two bars cannot
/// disagree.
struct FeedPaginationBar: View {
    @EnvironmentObject private var store: CongressTradeStore
    var showSort: Bool = false

    var body: some View {
        PaginationBar(
            currentPage: store.currentPage,
            totalPages: store.totalPages,
            pageSize: store.pageSize,
            canGoPrevious: store.canGoToPreviousPage,
            canGoNext: store.canGoToNextPage,
            onPrevious: { Task { await store.goToPreviousPage() } },
            onNext: { Task { await store.goToNextPage() } },
            onPageSize: { size in Task { await store.setPageSize(size) } },
            sortControls: showSort ? AnyView(FeedSortControl()) : nil
        )
    }
}

/// Tiny green up / red down / grey left-right arrows for the shared
/// multi-select Sides control (Buy/Sell/Exchange). Icon-only (compact) at
/// the default "All" state — every arrow shows its normal color, since
/// nothing selected means every side is shown. Once a subset is selected,
/// the unselected sides' arrows dim and the compact summary label (e.g.
/// "Buys+Sells") appears (owner punch list item 5 pattern, extended to
/// multi-select 2026-08-09).
struct SidesFilterMenuLabel: View {
    let title: String
    let isActive: Bool
    let selected: Set<TradeTypeFilter>

    /// A side reads as "on" when nothing is selected (default = show all) or
    /// when it's explicitly in the selection.
    private func isOn(_ type: TradeTypeFilter) -> Bool {
        selected.isEmpty || selected.contains(type)
    }

    private var dimColor: Color { Color.secondary.opacity(isActive ? 0.45 : 1) }

    var body: some View {
        ControlChip(isActive: isActive, compact: !isActive) {
            HStack(spacing: 4) {
                HStack(spacing: 1) {
                    Image(systemName: "arrow.up")
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(isOn(.buy) ? Color.green : dimColor)
                    Image(systemName: "arrow.down")
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(isOn(.sell) ? Color.red : dimColor)
                    // Same semi-dark grey as the other filter glyphs (owner
                    // 2026-08-22). Green/red stay on buy/sell because those
                    // colours mean something; exchange does not.
                    Image(systemName: "arrow.left.arrow.right")
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(isOn(.exchange) ? AppTheme.glyphGrey : dimColor)
                }
                if isActive {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.glyphGrey)
                }
                // Bare chrome glyph, no meaning of its own — stays the
                // lighter grey rather than the word ink above (owner
                // 2026-08-21), matching every other dropdown caret.
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(AppTheme.glyphGrey)
                    .opacity(0.8)
                    .padding(.leading, 2)
            }
        }
        .accessibilityLabel("Trade side filter, \(title)")
    }
}

/// Filter pill shared by Branch/Party/$/Timeframe. Icon-only (compact) when
/// at the default/unmodified state; expands to icon+value once active —
/// except `alwaysShowLabel` (Timeframe), which stays icon+value always
/// (owner punch list item 5).
struct FilterMenuLabel: View {
    let title: String
    let icon: String
    let isActive: Bool
    var alwaysShowLabel: Bool = false
    var accessibilityLabel: String? = nil

    private var showsLabel: Bool { alwaysShowLabel || isActive }

    var body: some View {
        ControlChip(isActive: isActive, compact: !showsLabel) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppTheme.glyphGrey)
                if showsLabel {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.glyphGrey)
                }
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(AppTheme.glyphGrey)
                    .opacity(0.8)
                    .padding(.leading, 2)
            }
        }
        .accessibilityLabel(accessibilityLabel ?? title)
    }
}

/// Trades-only unified search field (name / ticker / state / party, any
/// order) — replaces the old side-by-side Name + Asset/Ticker fields.
/// `TradeSearch.matches` (`MemberDirectorySearch.swift`) does the actual
/// any-order token matching against the already-loaded page; submitting or
/// pausing while typing (`FeedDashboardView.scheduleSearchDebounce`) also
/// reaches the server via `CongressTradeStore.setSearch`.
struct TradesUnifiedSearchField: View {
    @Binding var text: String
    var countLabel: String? = nil
    var focused: FocusState<Bool>.Binding
    var status: TradesSearchSlotStatus? = nil
    /// Refresh in flight.  Shown as a spinner inside the field so the field is
    /// never swapped out from under someone who is typing.
    var isUpdating: Bool = false
    var onSubmit: () -> Void = {}
    var onClear: () -> Void = {}
    var onReload: () -> Void = {}

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Group {
                if let status {
                    statusSlot(status)
                } else {
                    searchSlot
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
            .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 10))
            .overlay(AppTheme.border(cornerRadius: 10))

            if let countLabel {
                Text(countLabel)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.primary)
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .fixedSize()
                    // Without its own label this inherited the container's, so
                    // the number itself — the only thing it conveys — was never
                    // announced.
                    .accessibilityLabel("\(countLabel) matching")
            }
        }
        .animation(.easeInOut(duration: 0.15), value: status)
    }

    private var searchSlot: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                // Decorative twin of the field's own label.
                .accessibilityHidden(true)
            TextField("Name, ticker, state, or party", text: $text)
                .neverAutocapitalized()
                .autocorrectionDisabled()
                .font(.subheadline)
                .focused(focused)
                .submitLabel(.search)
                .onSubmit {
                    onSubmit()
                    focused.wrappedValue = false
                }
                // Labelled here rather than on the enclosing HStack.  A label on
                // a non-element container is inherited by every child, which is
                // what made the magnifier, the count and the Reload button all
                // announce the search field's label.
                .accessibilityLabel("Search trades by politician name, ticker, state, or party")
            if isUpdating {
                ProgressView()
                    .controlSize(.mini)
                    .transition(.opacity)
                    .accessibilityLabel("Updating results")
            }
            if !text.isEmpty {
                Button {
                    withAnimation { text = "" }
                    onClear()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear Search")
            }
        }
        .animation(.easeInOut(duration: 0.15), value: isUpdating)
    }

    @ViewBuilder
    private func statusSlot(_ status: TradesSearchSlotStatus) -> some View {
        switch status {
        case .updating:
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.mini)
                Text("Updating results…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            // One element, announced once, instead of two children that each
            // inherited the container's label.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Updating results")
        case .reload(let message):
            HStack(spacing: 8) {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                Spacer(minLength: 4)
                Button("Reload", action: onReload)
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.bordered)
                    .clipShape(Capsule())
                    // The button used to inherit the container label and so
                    // announced as "Request failed, button", which says nothing
                    // about what it does.  The failure text belongs in the hint.
                    .accessibilityLabel("Reload trades")
                    .accessibilityHint(message)
            }
        }
    }
}

struct SearchField: View {
    @Binding var text: String
    var onSubmit: () -> Void = {}
    var onClear: () -> Void = {}
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search ticker, politician, or state", text: $text)
                .neverAutocapitalized()
                .autocorrectionDisabled()
                .focused($isFocused)
                .submitLabel(.search)
                .onSubmit {
                    onSubmit()
                    isFocused = false
                }
            if !text.isEmpty {
                Button {
                    withAnimation { text = "" }
                    onClear()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Clear Search")
            }
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(AppTheme.border(cornerRadius: 12))
    }
}

/// Shared educational disclaimer used on Trades and Trends.
struct DisclaimerBanner: View {
    var body: some View {
        Text(AppTheme.siteFooterDisclaimer)
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 8))
            .accessibilityLabel("About Congress.Trade")
    }
}

/// Trades-only export popup: From / To dates + small ↓ CSV (Premium-gated).
struct ExportCSVSheet: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @State private var fromDate = Calendar.current.date(byAdding: .month, value: -3, to: Date()) ?? Date()
    @State private var toDate = Date()
    @State private var isExporting = false
    @State private var notice: String?
    @State private var shareURL: URL?
    @State private var showSubscribe = false

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("From", selection: $fromDate, displayedComponents: .date)
                    DatePicker("To", selection: $toDate, displayedComponents: .date)
                } header: {
                    Text("Date range")
                } footer: {
                    Text("Exports the filtered feed for this range. Premium required.")
                }

                if let notice {
                    Section {
                        Text(notice)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    // Guideline 5.1.1(v): CSV export is content, not
                    // account-specific functionality, so it is never
                    // sign-in-gated — only Premium-gated. A signed-out device
                    // with its own Apple purchase (store.hasLocalAppleEntitlement)
                    // exports the same way a signed-in Premium account does;
                    // APIClient attaches the cached device entitlement token.
                    // Signed in, `premiumFeatureAccess` additionally excludes
                    // a device purchase already linked to a DIFFERENT account
                    // (Premium belongs to the account, not the device).
                    if !store.premiumFeatureAccess {
                        Text("CSV export is a Premium feature.  No account needed to buy.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Button {
                            showSubscribe = true
                        } label: {
                            // Owner (2026-08-21): the Apple logo glyph itself
                            // must be the same near-black as the text, not
                            // the app-wide blue tint (App.swift).
                            Label("Subscribe with Apple", systemImage: "apple.logo")
                                .foregroundStyle(AppTheme.wordInk)
                        }
                    } else {
                        Button {
                            Task { await runExport() }
                        } label: {
                            if isExporting {
                                ProgressView()
                                    .frame(maxWidth: .infinity)
                            } else {
                                Text("↓ CSV")
                                    .font(.caption.weight(.bold))
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .disabled(isExporting)
                    }
                }
            }
            .navigationTitle("Export")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .sheet(isPresented: $showSubscribe) {
                PremiumSheet()
                    .environmentObject(store)
            }
            .sheet(isPresented: Binding(
                get: { shareURL != nil },
                set: { if !$0 { shareURL = nil } }
            )) {
                if let shareURL {
                    ShareSheet(items: [shareURL])
                }
            }
        }
    }

    private func runExport() async {
        isExporting = true
        notice = nil
        defer { isExporting = false }
        let from = Self.dayFormatter.string(from: min(fromDate, toDate))
        let to = Self.dayFormatter.string(from: max(fromDate, toDate))
        do {
            let data = try await store.exportCSV(from: from, to: to)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("congress-trades-\(from)-\(to).csv")
            try data.write(to: url, options: .atomic)
            shareURL = url
            notice = "Ready to share."
        } catch {
            notice = error.localizedDescription
        }
    }
}

/// UIKit share sheet bridge for the exported CSV file URL.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Compact trade row

/// Row in the Trades list. Three destinations live here — the trade sheet, the
/// politician sheet and the ticker sheet — and which one a tap reached used to
/// depend on layout accident: the whole row was a `Button` whose *label*
/// contained two more `Button`s, so a tap near the row's centre landed on the
/// politician button's stretched frame and opened the wrong sheet.
///
/// The fix is structural rather than a hit-testing tweak. The row is no longer
/// a Button at all: it carries a `contentShape` + tap gesture for "open this
/// trade", and the politician / ticker controls are ordinary sibling Buttons
/// that win inside their own frames because SwiftUI resolves the innermost
/// gesture first. Nothing is nested inside anything, so every tap has exactly
/// one owner. The asset title is *also* a Button for the row action, which is
/// what gives VoiceOver a real target — a bare tap gesture is invisible to it.
struct TradeCard: View {
    let trade: ClientTrade
    var onRowTap: (() -> Void)? = nil
    var onPoliticianTap: (() -> Void)? = nil
    var onTickerTap: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            // Only reserve logo column when a ticker exists; AssetMark is EmptyView
            // until a real logo loads (no blue monogram tiles that steal width).
            if trade.asset.ticker != nil {
                if let onTickerTap {
                    Button(action: onTickerTap) {
                        AssetMark(symbol: assetTitle, isTicker: true, size: 40)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("View \(assetTitle) Trades")
                } else {
                    AssetMark(symbol: assetTitle, isTicker: true, size: 40)
                        .accessibilityLabel(assetTitle)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if let onRowTap {
                        Button(action: onRowTap) { assetTitleText }
                            .buttonStyle(.plain)
                            .accessibilityHint("Opens trade details")
                    } else {
                        assetTitleText
                    }
                    StatusPill(
                        text: shortTypeLabel,
                        color: trade.transaction.type.tint,
                        compact: true
                    )
                }

                // A plain Text when there is no member to open, so a dead
                // Button never sits between the finger and the row.
                if let onPoliticianTap {
                    Button(action: onPoliticianTap) { politicianText }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens politician details")
                } else {
                    politicianText
                }
            }

            Spacer(minLength: 4)

            VStack(alignment: .trailing, spacing: 2) {
                Text(trade.amountLabel)
                    .font(.subheadline.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(trade.transaction.date.shortDate)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppTheme.borderColor.opacity(0.55), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        // Whole-card affordance for everything that is not one of the two
        // sub-destinations: the amount, the date, the badge, the padding.
        //
        // Attached ONLY when the host supplied a row action. `PoliticianDetail`
        // and `TickerDetail` wrap this card in a `NavigationLink`; an
        // unconditional tap gesture there would consume the tap and silently
        // kill their navigation.
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .modifier(RowTapModifier(action: onRowTap))
    }

    /// Adds the whole-row tap only when there is something for it to do — see
    /// the call site. A `ViewModifier` rather than an inline `if`, because an
    /// `if` in the view body would give the two branches different identities
    /// and re-create the row on every state change.
    private struct RowTapModifier: ViewModifier {
        let action: (() -> Void)?

        func body(content: Content) -> some View {
            if let action {
                content.onTapGesture(perform: action)
            } else {
                content
            }
        }
    }

    private var assetTitleText: some View {
        Text(assetTitle)
            .font(.subheadline.weight(.bold))
            .lineLimit(2)
            .multilineTextAlignment(.leading)
    }

    private var politicianText: some View {
        Text(politicianLine)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
    }

    private var assetTitle: String {
        trade.asset.displayName
    }

    private var shortTypeLabel: String {
        switch trade.transaction.type {
        case "B", "P": return "Buy"
        case "S": return "Sell"
        case "E": return "Exch"
        default: return trade.transaction.type
        }
    }

    /// Single meta line: "Sen. Name · D-CA" — chamber once, never duplicated.
    private var politicianLine: String {
        let name = trade.member.name ?? "Unknown"
        let chamber = trade.member.chamber?.chamberLabel
        let party = partyLetter(trade.member.party)
        let state = trade.member.state?.uppercased()
        let partyState: String? = {
            switch (party, state) {
            case let (p?, s?): return "\(p)-\(s)"
            case let (p?, nil): return p
            case let (nil, s?): return s
            default: return nil
            }
        }()

        var parts: [String] = []
        if let chamber {
            parts.append("\(chamber) · \(name)")
        } else {
            parts.append(name)
        }
        if let partyState {
            parts.append(partyState)
        }
        if let owner = trade.transaction.owner?.trimmingCharacters(in: .whitespacesAndNewlines),
           !owner.isEmpty {
            parts.append(owner.capitalized)
        }
        return parts.joined(separator: " · ")
    }

    private func partyLetter(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        switch raw.lowercased() {
        case "democrat", "dem", "d": return "D"
        case "republican", "rep", "r": return "R"
        case "independent", "ind", "i": return "I"
        default: return String(raw.prefix(1)).uppercased()
        }
    }
}
