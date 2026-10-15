import SwiftUI

/// Ticker profile backed by `GET /api/client/v1/ticker/:ticker`
/// (`app/src/client/routes.ts`): security-ref identity, aggregate summary,
/// and the recent trade page. Mirrors PoliticianDetailView.
struct TickerDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: CongressTradeStore

    let ticker: String

    @State private var isLoading = true
    @State private var asset: ClientTickerResponse.TickerAsset?
    @State private var summary: ClientTickerResponse.TickerSummary?
    @State private var analytics: ClientTickerAnalytics?
    @State private var selectedPolitician: MemberSheetTarget?
    @State private var trades: [ClientTrade] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if isLoading {
                        // The nav bar carries the entity class ("Ticker"), so
                        // the symbol has to live here while the hero is empty.
                        ProgressView("Loading \(ticker.uppercased())…")
                            .padding(.top, 40)
                    } else if let error = error {
                        ContentUnavailableView("Error", systemImage: "exclamationmark.triangle", description: Text(error))
                    } else {
                        // Header
                        VStack(spacing: 12) {
                            AssetMark(symbol: ticker, isTicker: true)
                                .scaleEffect(1.3)
                                .padding(.bottom, 8)

                            VStack(spacing: 4) {
                                Text(heroTitle)
                                    .font(.title2.weight(.bold))
                                    .multilineTextAlignment(.center)

                                if !headerMetaLine.isEmpty {
                                    Text(headerMetaLine)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .multilineTextAlignment(.center)
                                }
                            }

                            if let price = asset?.currentPrice {
                                Text(String(format: "$%.2f", price))
                                    .font(.title3.weight(.semibold))
                                    .foregroundStyle(.primary)
                            }
                        }
                        .padding(.top, 16)

                        // Identity / enrichment (when present in model)
                        if assetHasIdentityRows {
                            DetailSection("Security") {
                                // Providers routinely file a sub-industry as the
                                // sector, so KO came back "Beverages" under BOTH
                                // labels. One value never earns two rows.
                                if let sector = sectorValue {
                                    DetailRow("Sector", sector)
                                }
                                if let industry = distinctIndustryValue {
                                    DetailRow("Industry", industry)
                                }
                                if let cap = marketCapLine {
                                    DetailRow("Market Cap", cap)
                                }
                                if let exchange = asset?.exchangeShort, !exchange.isEmpty {
                                    DetailRow("Exchange", exchange)
                                }
                                if let assetClass = asset?.assetClass, !assetClass.isEmpty {
                                    DetailRow("Asset Class", assetClass.assetClassLabel)
                                }
                                if let currency = asset?.currency, !currency.isEmpty {
                                    DetailRow("Currency", currency.uppercased())
                                }
                            }
                        }

                        // Summary
                        if let summary {
                            DetailSection("Trading Summary") {
                                HStack(spacing: 12) {
                                    MetricTile(title: "Trades", value: CompactFormat.count(summary.totalTrades))
                                    MetricTile(title: "Buys", value: CompactFormat.count(summary.buyCount))
                                    MetricTile(title: "Sells", value: CompactFormat.count(summary.sellCount))
                                }
                                HStack(spacing: 12) {
                                    MetricTile(title: "Members", value: CompactFormat.count(summary.memberCount))
                                    MetricTile(title: "Est. Volume", value: CompactFormat.usd(summary.estimatedVolumeUsd))
                                    MetricTile(title: "Net Flow", value: CompactFormat.usd(summary.estimatedNetFlowUsd))
                                }
                                // "Exchanges" read as NYSE/Nasdaq next to the
                                // Exchange row two sections up; this is the
                                // count of exchange-type disclosures.
                                if let exchangeCount = summary.exchangeCount, exchangeCount > 0 {
                                    DetailRow("Exchange Trades", CompactFormat.count(exchangeCount))
                                }
                                DetailRow("First Trade", summary.firstTrade.shortDate)
                                DetailRow("Last Trade", summary.lastTrade.shortDate)
                            }
                        }

                        // Congressional Sentiment (Analytics)
                        if let winSummary = analytics?.summary {
                            DetailSection("Congressional Sentiment") {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack {
                                        Text("Buy Pressure")
                                            .font(.subheadline.weight(.semibold))
                                        Spacer()
                                        if let netSentiment = winSummary.netSentiment {
                                            Text(String(format: "%.0f%%", netSentiment * 100))
                                                .font(.subheadline.weight(.bold))
                                                .foregroundStyle(netSentiment >= 0.5 ? Color.green : Color.red)
                                        } else {
                                            Text("—")
                                                .font(.subheadline)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    if let netSentiment = winSummary.netSentiment {
                                        GeometryReader { geo in
                                            ZStack(alignment: .leading) {
                                                RoundedRectangle(cornerRadius: 4)
                                                    .fill(Color.red.opacity(0.35))
                                                    .frame(height: 8)
                                                RoundedRectangle(cornerRadius: 4)
                                                    .fill(Color.green)
                                                    .frame(width: max(0, min(geo.size.width, geo.size.width * CGFloat(netSentiment))), height: 8)
                                            }
                                        }
                                        .frame(height: 8)
                                    }
                                    HStack {
                                        Text("\(winSummary.buyCount ?? 0) Buys")
                                            .font(.caption2)
                                            .foregroundStyle(Color.green)
                                        Spacer()
                                        Text("\(winSummary.sellCount ?? 0) Sells")
                                            .font(.caption2)
                                            .foregroundStyle(Color.red)
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }

                        // Top Congressional Buyers
                        if let buyers = analytics?.topBuyers, !buyers.isEmpty {
                            DetailSection("Top Buyers") {
                                VStack(spacing: 8) {
                                    ForEach(buyers.prefix(5)) { trader in
                                        Button {
                                            if let fid = trader.filerId {
                                                selectedPolitician = MemberSheetTarget(
                                                    id: fid,
                                                    name: trader.fullName ?? fid,
                                                    photoUrl: trader.photoUrl
                                                )
                                            }
                                        } label: {
                                            HStack(spacing: 12) {
                                                MemberAvatar(
                                                    photoURL: MemberPhotoURL.resolve(trader.photoUrl),
                                                    name: trader.fullName ?? "",
                                                    size: 36
                                                )
                                                VStack(alignment: .leading, spacing: 2) {
                                                    Text(trader.fullName ?? trader.filerId ?? "Unknown")
                                                        .font(.subheadline.weight(.semibold))
                                                        .lineLimit(1)
                                                    if let party = trader.partyBucket {
                                                        Text(party.uppercased())
                                                            .font(.caption2.weight(.bold))
                                                            .foregroundStyle(.secondary)
                                                    }
                                                }
                                                Spacer()
                                                VStack(alignment: .trailing, spacing: 2) {
                                                    Text(CompactFormat.usd(trader.estVolumeUsd))
                                                        .font(.subheadline.weight(.semibold))
                                                    Text("\(trader.tradeCount ?? 0) buys")
                                                        .font(.caption2)
                                                        .foregroundStyle(.secondary)
                                                }
                                            }
                                            .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }

                        // Top Congressional Sellers
                        if let sellers = analytics?.topSellers, !sellers.isEmpty {
                            DetailSection("Top Sellers") {
                                VStack(spacing: 8) {
                                    ForEach(sellers.prefix(5)) { trader in
                                        Button {
                                            if let fid = trader.filerId {
                                                selectedPolitician = MemberSheetTarget(
                                                    id: fid,
                                                    name: trader.fullName ?? fid,
                                                    photoUrl: trader.photoUrl
                                                )
                                            }
                                        } label: {
                                            HStack(spacing: 12) {
                                                MemberAvatar(
                                                    photoURL: MemberPhotoURL.resolve(trader.photoUrl),
                                                    name: trader.fullName ?? "",
                                                    size: 36
                                                )
                                                VStack(alignment: .leading, spacing: 2) {
                                                    Text(trader.fullName ?? trader.filerId ?? "Unknown")
                                                        .font(.subheadline.weight(.semibold))
                                                        .lineLimit(1)
                                                    if let party = trader.partyBucket {
                                                        Text(party.uppercased())
                                                            .font(.caption2.weight(.bold))
                                                            .foregroundStyle(.secondary)
                                                    }
                                                }
                                                Spacer()
                                                VStack(alignment: .trailing, spacing: 2) {
                                                    Text(CompactFormat.usd(trader.estVolumeUsd))
                                                        .font(.subheadline.weight(.semibold))
                                                    Text("\(trader.tradeCount ?? 0) sells")
                                                        .font(.caption2)
                                                        .foregroundStyle(.secondary)
                                                }
                                            }
                                            .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }

                        // Performance After Congressional Buys (Backtest)
                        if let horizons = analytics?.backtest?.horizons, !horizons.isEmpty {
                            DetailSection("Performance After Buys") {
                                ForEach(horizons) { h in
                                    HStack {
                                        Text(Self.horizonLabel(days: h.days ?? 0))
                                            .font(.subheadline)
                                        Spacer()
                                        if let medRet = h.medianReturn {
                                            Text(String(format: "%+.1f%%", medRet * 100))
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(medRet >= 0 ? Color.green : Color.red)
                                        } else {
                                            Text("—")
                                                .font(.subheadline)
                                                .foregroundStyle(.secondary)
                                        }
                                        if let excess = h.medianExcess {
                                            Text(String(format: "(%+.1f%% vs SPX)", excess * 100))
                                                .font(.caption)
                                                .foregroundStyle(excess >= 0 ? Color.green : Color.red)
                                        }
                                    }
                                }
                            }
                        }

                        // Recent Trades
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Recent Trades")
                                .font(.headline)
                                .padding(.horizontal, 16)

                            LazyVStack(spacing: 12) {
                                ForEach(trades) { trade in
                                    NavigationLink {
                                        TradeDetailView(trade: trade)
                                    } label: {
                                        TradeCard(trade: trade)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 16)

                            SeeAllTradesHandoff(
                                totalTrades: summary?.totalTrades ?? 0,
                                displayedCount: trades.count,
                                filter: .ticker(ticker)
                            )
                        }
                    }
                }
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle(heroTitle)
            .inlineNavigationTitle()
            .sheet(item: $selectedPolitician) { target in
                PoliticianDetailView(
                    memberId: target.id,
                    memberName: target.name,
                    seedPhotoUrl: target.photoUrl
                )
                .presentationDetents([.medium, .large])
                .presentationContentInteraction(.resizes)
                .iPadFullWidthSheet()
            }
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    if let shareURL = store.api.shareURL(
                        queryItem: URLQueryItem(name: "ticker", value: ticker.uppercased())
                    ) {
                        ShareLink(item: shareURL) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("Share ticker")
                    }
                }
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    // Dark legible ink, not the app-wide blue tint (owner
                    // 2026-08-21); `.tint` is required alongside
                    // `.foregroundStyle` because the toolbar button style
                    // re-applies tint over a plain foreground colour.
                    Button("Done") {
                        dismiss()
                    }
                    .foregroundStyle(AppTheme.wordInk)
                    .tint(AppTheme.wordInk)
                }
            }
            .task {
                await loadTicker()
            }
        }
    }

    /// Hero identity: the company when we know it, otherwise the symbol.
    private var heroTitle: String {
        let name = asset?.companyName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? ticker.uppercased() : name
    }

    /// Meta line under the hero. Every fact appears exactly once: the symbol is
    /// dropped when the hero already IS the symbol, and the industry is dropped
    /// when the provider filed the same string as the sector (KO shipped
    /// "KO · NYSE · Beverages · Beverages").
    private var headerMetaLine: String {
        let symbol = heroTitle == ticker.uppercased() ? nil : ticker.uppercased()
        let exchange = asset?.exchangeShort?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let sector = sectorValue
        let industry = distinctIndustryValue
        return [symbol, exchange, sector, industry].compactMap { $0 }.joined(separator: "  •  ")
    }

    private var sectorValue: String? {
        asset?.sector?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    /// Drops the industry when it matches the sector case-insensitively (FMP
    /// filed KO as sector=Beverages, industry=Beverages - Non-Alcoholic, which
    /// both trimmed to "Beverages" under simple normalization).
    private var distinctIndustryValue: String? {
        guard let ind = asset?.industry?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty else { return nil }
        if let sec = sectorValue, ind.localizedCaseInsensitiveContains(sec) || sec.localizedCaseInsensitiveContains(ind) {
            return nil
        }
        return ind
    }

    /// One Market Cap row, not a bucket row plus a "Market Cap ($)" row: the
    /// dollar figure leads and the bucket qualifies it (`$268b  •  Mega Cap`).
    private var marketCapLine: String? {
        let bucket = asset?.marketCapBucket?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty?.capBucketLabel
        let dollars = (asset?.marketCap ?? 0) > 0 ? CompactFormat.usd(asset?.marketCap) : nil
        return [dollars, bucket].compactMap { $0 }.joined(separator: "  •  ").nilIfEmpty
    }

    private var assetHasIdentityRows: Bool {
        guard let asset else { return false }
        return [
            asset.industry,
            asset.sector,
            asset.marketCapBucket,
            asset.exchangeShort,
            asset.assetClass,
            asset.currency
        ].contains(where: { ($0 ?? "").isEmpty == false })
            || (asset.marketCap ?? 0) > 0
    }

    private func loadTicker() async {
        isLoading = true
        error = nil
        do {
            let response = try await fetchTicker()
            if Task.isCancelled { return }
            self.asset = response.asset
            self.summary = response.summary
            self.analytics = response.analytics
            self.trades = response.items
        } catch is CancellationError {
            return
        } catch let error as APIError where error.isCancellation {
            return
        } catch {
            if Task.isCancelled { return }
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }

    private func fetchTicker() async throws -> ClientTickerResponse {
        do {
            return try await store.fetchTicker(ticker, includeAnalytics: true)
        } catch {
            if Task.isCancelled { throw error }
            // If the analytics payload fails, fallback to basic ticker profile
            // without analytics so the drawer still displays gracefully.
            return try await store.fetchTicker(ticker, includeAnalytics: false)
        }
    }

    private static func horizonLabel(days: Int) -> String {
        switch days {
        case 21: return "1 Month"
        case 63: return "3 Months"
        case 126: return "6 Months"
        case 252: return "1 Year"
        default: return "\(days) Days"
        }
    }
}

/// Storage enums are not labels. `securities_ref.asset_class` is written by the
/// enricher as `equity|etf|adr|fund` (`app/src/enrichment/fmp.ts`) and
/// `market_cap_bucket` as `mega`…`nano`; both were rendered raw or merely
/// `.capitalized`, so the sheet read "Asset Class: equity" / "Market Cap:
/// Mega". Wording matches the web board's `CAP_NAMES`
/// (`app/src/ui/dashboardHtml.ts`). Deliberately fileprivate: the shared
/// labeler lives in another lane's file.
private extension String {
    var assetClassLabel: String {
        switch trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "equity", "stock", "common stock": return "Stock"
        case "etf": return "ETF"
        case "adr": return "ADR"
        case "fund", "mutual fund": return "Fund"
        case "crypto": return "Crypto"
        default: return capitalized
        }
    }

    var capBucketLabel: String {
        switch trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "mega": return "Mega Cap"
        case "large": return "Large Cap"
        case "mid": return "Mid Cap"
        case "small": return "Small Cap"
        case "micro": return "Micro Cap"
        case "nano": return "Nano Cap"
        case "unknown", "": return "Unclassified"
        default: return capitalized
        }
    }

    var nilIfEmpty: String? { isEmpty ? nil : self }
}
