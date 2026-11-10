import Foundation
import SwiftUI

/// Unified multi-token trade search (any word order, partial matches):
/// each token may match politician name, ticker, asset name, state, or party.
enum TradeSearch {
    static func matches(_ trade: ClientTrade, query: String) -> Bool {
        let raw = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !raw.isEmpty else { return true }
        let tokens = raw.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let name = (trade.member.name ?? "").lowercased()
        let nameParts = name.split { !$0.isLetter && !$0.isNumber }.map(String.init)
        let state = (trade.member.state ?? "").lowercased()
        let party = trade.member.party ?? ""
        let ticker = (trade.asset.ticker ?? "").lowercased()
        let asset = (trade.asset.name ?? "").lowercased()
        return tokens.allSatisfy { tok in
            if name.contains(tok) { return true }
            if nameParts.contains(where: { $0.hasPrefix(tok) || $0.contains(tok) }) { return true }
            if ticker.contains(tok) { return true }
            if asset.contains(tok) { return true }
            if MemberDirectorySearch.stateMatchesPublic(tok, stateAbbr: state) { return true }
            if MemberDirectorySearch.partyMatchesPublic(tok, party: party) { return true }
            return false
        }
    }
}

/// Shared Directory search: multi-token AND matching for name (first/last/partial),
/// state abbreviation **or full name**, and party labels
/// (Democrat(s)/Republican(s)/Independent(s)/Other).
/// Example: `"CA Ro"` matches Ro Khanna (CA).
enum MemberDirectorySearch {
    /// US state / territory abbr → full name (lowercase).
    static let stateAbbrToName: [String: String] = [
        "al": "alabama", "ak": "alaska", "az": "arizona", "ar": "arkansas",
        "ca": "california", "co": "colorado", "ct": "connecticut", "de": "delaware",
        "fl": "florida", "ga": "georgia", "hi": "hawaii", "id": "idaho",
        "il": "illinois", "in": "indiana", "ia": "iowa", "ks": "kansas",
        "ky": "kentucky", "la": "louisiana", "me": "maine", "md": "maryland",
        "ma": "massachusetts", "mi": "michigan", "mn": "minnesota", "ms": "mississippi",
        "mo": "missouri", "mt": "montana", "ne": "nebraska", "nv": "nevada",
        "nh": "new hampshire", "nj": "new jersey", "nm": "new mexico", "ny": "new york",
        "nc": "north carolina", "nd": "north dakota", "oh": "ohio", "ok": "oklahoma",
        "or": "oregon", "pa": "pennsylvania", "ri": "rhode island", "sc": "south carolina",
        "sd": "south dakota", "tn": "tennessee", "tx": "texas", "ut": "utah",
        "vt": "vermont", "va": "virginia", "wa": "washington", "wv": "west virginia",
        "wi": "wisconsin", "wy": "wyoming", "dc": "district of columbia",
        "pr": "puerto rico", "vi": "virgin islands", "gu": "guam",
        "as": "american samoa", "mp": "northern mariana islands",
    ]

    static let stateNameToAbbr: [String: String] = {
        var map: [String: String] = [:]
        for (abbr, name) in stateAbbrToName { map[name] = abbr }
        return map
    }()

    enum SortKey: String, CaseIterable, Identifiable {
        case name, chamber, party, state, trades
        var id: String { rawValue }
        var label: String {
            switch self {
            case .name: return "Name"
            case .chamber: return "Branch"
            case .party: return "Party"
            case .state: return "State"
            case .trades: return "Trades"
            }
        }
    }

    static func matches(_ member: MemberDirectoryEntry, query: String) -> Bool {
        let raw = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !raw.isEmpty else { return true }
        let tokens = raw.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let name = (member.fullName ?? "").lowercased()
        let nameParts = name.split { !$0.isLetter && !$0.isNumber }.map(String.init)
        let filer = member.filerId.lowercased()
        let state = (member.state ?? "").lowercased()
        let chamber = (member.chamber ?? "").lowercased()
        let district = (member.district ?? "").lowercased()
        let party = member.party ?? ""

        return tokens.allSatisfy { tok in
            if stateMatches(tok, stateAbbr: state) { return true }
            if partyMatches(tok, party: party) { return true }
            if name.contains(tok) { return true }
            if filer.contains(tok) { return true }
            if chamber.contains(tok) { return true }
            if !district.isEmpty && district.contains(tok) { return true }
            if nameParts.contains(where: { $0.hasPrefix(tok) || $0.contains(tok) }) { return true }
            return false
        }
    }

    static func sort(
        _ members: [MemberDirectoryEntry],
        key: SortKey,
        ascending: Bool
    ) -> [MemberDirectoryEntry] {
        members.sorted { a, b in
            let cmp: ComparisonResult
            switch key {
            case .trades:
                let av = a.txCount ?? 0
                let bv = b.txCount ?? 0
                cmp = av == bv ? .orderedSame : (av < bv ? .orderedAscending : .orderedDescending)
            case .name:
                cmp = (a.fullName ?? a.filerId).localizedCaseInsensitiveCompare(b.fullName ?? b.filerId)
            case .chamber:
                cmp = (a.chamber ?? "").localizedCaseInsensitiveCompare(b.chamber ?? "")
            case .party:
                cmp = (a.party ?? "").localizedCaseInsensitiveCompare(b.party ?? "")
            case .state:
                cmp = (a.state ?? "").localizedCaseInsensitiveCompare(b.state ?? "")
            }
            if cmp == .orderedSame {
                let nameCmp = (a.fullName ?? a.filerId).localizedCaseInsensitiveCompare(b.fullName ?? b.filerId)
                if nameCmp != .orderedSame { return nameCmp == .orderedAscending }
                return (a.txCount ?? 0) > (b.txCount ?? 0)
            }
            return ascending ? cmp == .orderedAscending : cmp == .orderedDescending
        }
    }

    /// Public wrappers used by `TradeSearch`.
    static func stateMatchesPublic(_ token: String, stateAbbr: String) -> Bool {
        stateMatches(token, stateAbbr: stateAbbr)
    }
    static func partyMatchesPublic(_ token: String, party: String) -> Bool {
        partyMatches(token, party: party)
    }

    private static func stateMatches(_ token: String, stateAbbr: String) -> Bool {
        guard !stateAbbr.isEmpty else { return false }
        if token == stateAbbr { return true }
        let full = stateAbbrToName[stateAbbr] ?? ""
        if !full.isEmpty {
            if full == token || full.hasPrefix(token) || full.contains(token) { return true }
            for word in full.split(separator: " ") {
                if word == token || word.hasPrefix(token) { return true }
            }
        }
        if let abbr = stateNameToAbbr[token], abbr == stateAbbr { return true }
        // token is full name that maps to this abbr via prefix on keys
        for (name, abbr) in stateNameToAbbr where abbr == stateAbbr {
            if name.hasPrefix(token) || name.contains(token) { return true }
        }
        return false
    }

    private static func partyMatches(_ token: String, party: String) -> Bool {
        let blob = partySearchBlob(party)
        if blob.contains(token) { return true }
        let families: [(prefixes: [String], needles: [String])] = [
            (["d", "dem"], ["democrat", "democrats", "d"]),
            (["r", "rep", "gop"], ["republican", "republicans", "r", "gop"]),
            (["i", "ind", "oth"], ["independent", "independents", "other", "i"]),
        ]
        for fam in families {
            let tokenHitsFamily = fam.prefixes.contains { token.hasPrefix($0) || $0.hasPrefix(token) }
                || fam.needles.contains { $0.hasPrefix(token) || token.hasPrefix($0) }
            guard tokenHitsFamily else { continue }
            if fam.needles.contains(where: { blob.contains($0) }) { return true }
        }
        return false
    }

    private static func partySearchBlob(_ party: String) -> String {
        let p = party.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if p.isEmpty { return "other independent independents" }
        if p == "d" || p.hasPrefix("dem") { return p + " democrat democrats d" }
        if p == "r" || p.hasPrefix("rep") { return p + " republican republicans r gop" }
        if p == "i" || p == "id" || p.hasPrefix("ind") || p.hasPrefix("other") {
            return p + " independent independents other i"
        }
        return p + " other independent independents"
    }
}

/// Assets directory search/sort (web parity: `app/src/ui/dashboardHtml.ts`
/// `assetMatchesQuery` / `assetsSortValue` / `sortAssetsDirectory`, reached
/// via the Directory tab's People|Assets segmented toggle). Multi-token AND
/// match against ticker and company name, order-independent — same shape as
/// `MemberDirectorySearch.matches` above, just a narrower field set.
enum AssetDirectorySearch {
    enum SortKey: String, CaseIterable, Identifiable {
        case name, trades, members
        var id: String { rawValue }
        var label: String {
            switch self {
            case .name: return "Asset"
            case .trades: return "Trades"
            case .members: return "Politicians"
            }
        }
    }

    static func matches(_ asset: AssetDirectoryEntry, query: String) -> Bool {
        let raw = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !raw.isEmpty else { return true }
        let tokens = raw.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let ticker = asset.ticker.lowercased()
        let name = (asset.name ?? "").lowercased()
        return tokens.allSatisfy { tok in ticker.contains(tok) || name.contains(tok) }
    }

    /// Trades-descending default (`ASSETS_SORT = { key: 'trades', dir: -1 }`
    /// on web) — callers seed `sortKey: .trades, sortAscending: false`.
    static func sort(_ assets: [AssetDirectoryEntry], key: SortKey, ascending: Bool) -> [AssetDirectoryEntry] {
        assets.sorted { a, b in
            let cmp: ComparisonResult
            switch key {
            case .trades:
                let av = a.txCount ?? 0
                let bv = b.txCount ?? 0
                cmp = av == bv ? .orderedSame : (av < bv ? .orderedAscending : .orderedDescending)
            case .members:
                let av = a.memberCount ?? 0
                let bv = b.memberCount ?? 0
                cmp = av == bv ? .orderedSame : (av < bv ? .orderedAscending : .orderedDescending)
            case .name:
                cmp = (a.name ?? a.ticker).localizedCaseInsensitiveCompare(b.name ?? b.ticker)
            }
            if cmp == .orderedSame {
                // Same tie-break as web's renderAssetsDirectory sort comparator.
                return (a.txCount ?? 0) > (b.txCount ?? 0)
            }
            return ascending ? cmp == .orderedAscending : cmp == .orderedDescending
        }
    }
}

/// Self-contained Assets directory screen — the iOS side of the Directory
/// tab's People|Assets toggle (web: `setDirectoryMode('assets')` in
/// `app/src/ui/dashboardHtml.ts`). Loads and caches its own roster via
/// `store.api.assetsDirectory()` rather than adding state to
/// `CongressTradeStore`, so it drops into `PeopleDirectoryView` (or any other
/// host) with a single mode toggle and no store changes. See the iOS
/// asset-directory lane's PR body for that one-line integration snippet.
struct AssetDirectoryView: View {
    var wrapsNavigation: Bool = true
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool
    @State private var selectedTicker: TickerSheetTarget?
    @State private var sortKey: AssetDirectorySearch.SortKey = .trades
    @State private var sortAscending = false
    @State private var assets: [AssetDirectoryEntry] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    /// 0-indexed page of `filteredAssets`. Same rationale as
    /// `PeopleDirectoryView`: `GET /api/assets` is a full-roster endpoint
    /// (4,212 tickers, ~72KB gzipped, 30-minute KV cache) with no paging
    /// parameters — paging here is purely about not rendering thousands of
    /// rows at once, never a request.
    @State private var currentPage = 0
    @State private var pageSize = 50

    private var filteredAssets: [AssetDirectoryEntry] {
        let matched = assets.filter { AssetDirectorySearch.matches($0, query: searchText) }
        return AssetDirectorySearch.sort(matched, key: sortKey, ascending: sortAscending)
    }

    private func totalPages(for count: Int) -> Int {
        max(1, Int((Double(count) / Double(pageSize)).rounded(.up)))
    }

    private func pageSlice(of rows: [AssetDirectoryEntry], page: Int) -> ArraySlice<AssetDirectoryEntry> {
        let start = max(0, page) * pageSize
        guard start < rows.count else { return rows.prefix(pageSize) }
        return rows[start..<min(start + pageSize, rows.count)]
    }

    var body: some View {
        let rows = filteredAssets
        let pages = totalPages(for: rows.count)
        let page = min(currentPage, pages - 1)
        let chrome = directoryChrome(rows: rows, pages: pages, page: page)
        return Group {
            if wrapsNavigation {
                NavigationStack { chrome }
            } else {
                chrome
            }
        }
    }

    private func directoryChrome(rows: [AssetDirectoryEntry], pages: Int, page: Int) -> some View {
            ScrollView {
                    VStack(spacing: 8) {
                        AssetSearchField(text: $searchText, focused: $searchFocused)
                            .accessibilityLabel("Search assets by ticker or company name")

                        HStack {
                            // Truthful by construction: the roster endpoint returns
                            // every ticker, so both numbers are real totals.
                            Text("\(CompactFormat.count(rows.count)) of \(CompactFormat.count(assets.count)) shown")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                            Spacer(minLength: 0)
                        }

                        assetPager(page: page, pages: pages)

                        if let errorMessage {
                            FeedFreshnessView(
                                isOffline: false,
                                lastRefresh: nil,
                                notice: errorMessage,
                                onRetry: { Task { await load(force: true) } }
                            )
                        }

                        if isLoading && assets.isEmpty {
                            ProgressView("Loading Assets…")
                                .padding(.top, 40)
                        } else if rows.isEmpty {
                            ContentUnavailableView {
                                Label(searchText.isEmpty ? "No Assets Yet" : "No Matches", systemImage: "chart.bar")
                            } description: {
                                Text(
                                    searchText.isEmpty
                                        ? "The directory fills in as filings are ingested."
                                        : "Try a ticker or company name."
                                )
                            }
                            .padding(.top, 40)
                        } else if horizontalSizeClass == .regular {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 320, maximum: 540), spacing: 12)], spacing: 12) {
                                ForEach(pageSlice(of: rows, page: page)) { asset in
                                    Button {
                                        selectedTicker = TickerSheetTarget(ticker: asset.ticker)
                                    } label: {
                                        AssetDirectoryRow(asset: asset)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityHint("Opens asset details")
                                }
                            }

                            assetPager(page: page, pages: pages)
                                .padding(.top, 4)
                        } else {
                            LazyVStack(spacing: 8) {
                                ForEach(pageSlice(of: rows, page: page)) { asset in
                                    Button {
                                        selectedTicker = TickerSheetTarget(ticker: asset.ticker)
                                    } label: {
                                        AssetDirectoryRow(asset: asset)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityHint("Opens asset details")
                                }
                            }

                            assetPager(page: page, pages: pages)
                                .padding(.top, 4)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 24)
                }
                .scrollDismissesKeyboard(.interactively)
            .background(AppTheme.background)
            .navigationTitle("Assets")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await load(force: true) }
            .task { await load(force: false) }
            .sheet(item: $selectedTicker) { target in
                TickerDetailView(ticker: target.ticker)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(18)
                    .presentationContentInteraction(.resizes)
                    .iPadFullWidthSheet()
            }
            // Same invalidation rule as PeopleDirectoryView: narrowing or
            // reordering can strand the current page past the new result count.
            .onChange(of: searchText) { _, _ in currentPage = 0 }
            .onChange(of: sortKey) { _, _ in currentPage = 0 }
            .onChange(of: sortAscending) { _, _ in currentPage = 0 }
    }

    private func assetPager(page: Int, pages: Int) -> some View {
        PaginationBar(
            currentPage: page,
            totalPages: pages,
            pageSize: pageSize,
            canGoPrevious: page > 0,
            canGoNext: page + 1 < pages,
            onPrevious: { currentPage = max(0, page - 1) },
            onNext: { currentPage = min(pages - 1, page + 1) },
            onPageSize: { size in
                pageSize = size
                currentPage = 0
            },
            sortControls: AnyView(
                SortMenuControl(
                    keys: Array(AssetDirectorySearch.SortKey.allCases),
                    sortKey: $sortKey,
                    sortAscending: $sortAscending,
                    label: { $0.label },
                    defaultAscending: { $0 == .name }
                )
            )
        )
    }

    /// Loads (or reloads) the full roster into local `@State` — this view owns
    /// its data, `CongressTradeStore` is untouched. `force: false` (the
    /// initial `.task`) skips the round trip once a prior appearance already
    /// populated `assets`; pull-to-refresh always passes `force: true`. The
    /// server itself caches the roster 30 minutes either way.
    private func load(force: Bool) async {
        guard force || assets.isEmpty else { return }
        isLoading = true
        errorMessage = nil
        do {
            let response = try await store.api.assetsDirectory()
            assets = response.assets
        } catch let error as APIError where error.isCancellation {
            // View dismissed mid-fetch — nothing to surface.
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? "Could not load the assets directory."
        }
        isLoading = false
    }
}

/// One Assets row: ticker mark, ticker + company name, trade/politician counts.
private struct AssetDirectoryRow: View {
    let asset: AssetDirectoryEntry

    var body: some View {
        HStack(spacing: 12) {
            AssetMark(symbol: asset.ticker, isTicker: true, size: 40)

            VStack(alignment: .leading, spacing: 3) {
                Text(asset.ticker)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.primary)
                if let name = asset.name, !name.isEmpty {
                    Text(name)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 4)

            HStack(spacing: 14) {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(CompactFormat.count(asset.txCount))
                        .font(.subheadline.weight(.bold))
                    Text("trades")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .trailing, spacing: 2) {
                    Text(CompactFormat.count(asset.memberCount))
                        .font(.subheadline.weight(.bold))
                    Text("politicians")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppTheme.borderColor.opacity(0.55), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(asset.ticker), \(asset.name ?? ""), \(asset.txCount ?? 0) trades, \(asset.memberCount ?? 0) politicians"
        )
    }
}

private struct AssetSearchField: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            TextField("Ticker or company…", text: $text)
                .neverAutocapitalized()
                .autocorrectionDisabled()
                .font(.subheadline)
                .focused(focused)
                .submitLabel(.search)
                .onSubmit { focused.wrappedValue = false }
            if !text.isEmpty {
                Button {
                    withAnimation { text = "" }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
