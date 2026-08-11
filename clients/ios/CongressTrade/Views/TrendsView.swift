import SwiftUI

struct TrendsView: View {
    @EnvironmentObject private var store: CongressTradeStore
    /// Same `@AppStorage` keys as `FeedDashboardView` — the disclaimer's
    /// dismissed/expanded state is one truth across both tabs (owner punch
    /// list item 2b), and identical top/side insets keep its position/size
    /// pixel-identical to Trades (item 2a).
    @AppStorage("ct_disclaimer_expanded") private var disclaimerExpanded = true
    @AppStorage("ct_disclaimer_intro_done") private var disclaimerIntroDone = false
    @State private var selectedTicker: String?
    @State private var selectedPoliticianId: String?
    @State private var selectedPoliticianName: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    DisclaimerBanner(isExpanded: $disclaimerExpanded)

                    // Identical shared filters as Trades (no export, no politician/asset extras).
                    FeedControlBar(showMetrics: false)

                    // First load already has the big centered "Loading trends…"
                    // ProgressView below. This is the gap the owner actually hit:
                    // a SUBSEQUENT filter change on an already-loaded tab used to
                    // leave stale charts on screen with zero signal that anything
                    // was happening. `isTrendsFilterPending` spans the debounce
                    // window through the (possibly superseded) refreshTrends()
                    // call, so this reads correctly even when a fast follow-up
                    // filter tap cancels an in-flight one.
                    FilterActivityIndicator(isActive: store.isTrendsFilterPending)

                    if store.isLoadingTrends && store.analyticsSummary == nil {
                        ProgressView("Loading trends…")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 40)
                    } else {
                        if let notice = store.trendsNotice,
                           !Self.isBenignCancellationNotice(notice) {
                            NoticeView(message: notice)
                        }

                        summaryStrip

                        if !store.volumeSeries.isEmpty {
                            volumeSection
                        }

                        if !store.tickerLeaderboard.isEmpty {
                            tickerSection
                        }

                        if !store.trendingAssets.isEmpty {
                            trendingSection
                        }

                        if !store.clusterBuys.isEmpty {
                            clusterSection
                        }

                        sectorAndCapSection

                        if !store.topPerformers.isEmpty {
                            performersSection
                        }

                        if !store.memberLeaderboard.isEmpty {
                            memberSection
                        }

                        if let lag = store.filingLag {
                            timelinessSection(lag: lag)
                        }

                        if let summary = store.latencySummary {
                            LatencyComparisonView(summary: summary)
                        }
                    }

                    LegalFooterLinks()
                        .padding(.top, 8)
                }
                // Same horizontal/top/bottom insets as Trades so the
                // disclaimer banner lands at an identical position/size on
                // both tabs (owner punch list item 2a — was `.padding(16)`
                // uniformly, 8pt further from the nav bar than Trades).
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // ⓘ now leads (swapped to match Trades' post-swap side —
                // owner punch list item 3); brand centers via .principal;
                // hamburger is the only trailing control.
                ToolbarItem(placement: .topBarLeading) {
                    HeaderIconButton(
                        systemImage: "info.circle",
                        accessibilityLabel: "About Congress.Trade"
                    ) {
                        withAnimation { disclaimerExpanded.toggle() }
                    }
                }
                ToolbarItem(placement: .principal) {
                    BrandTitle()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HamburgerMenuButton()
                }
            }
            .task {
                if store.analyticsSummary == nil {
                    await store.refreshTrends()
                }
                // One-time app-lifetime intro reveal, shared with Trades via
                // the same AppStorage keys — never re-plays on tab switch.
                if !disclaimerIntroDone {
                    disclaimerIntroDone = true
                    withAnimation { disclaimerExpanded = true }
                    try? await Task.sleep(for: .seconds(4))
                    if !Task.isCancelled {
                        withAnimation { disclaimerExpanded = false }
                    }
                }
            }
            .refreshable {
                await store.refreshTrends()
            }
            .sheet(isPresented: Binding<Bool>(
                get: { selectedTicker != nil },
                set: { if !$0 { selectedTicker = nil } }
            )) {
                if let ticker = selectedTicker {
                    TickerDetailView(ticker: ticker)
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                        .presentationCornerRadius(18)
                }
            }
            .sheet(isPresented: Binding<Bool>(
                get: { selectedPoliticianId != nil },
                set: { if !$0 { selectedPoliticianId = nil } }
            )) {
                if let memberId = selectedPoliticianId {
                    PoliticianDetailView(memberId: memberId, memberName: selectedPoliticianName ?? "Politician")
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                        .presentationCornerRadius(18)
                }
            }
        }
    }

    private static func isBenignCancellationNotice(_ message: String) -> Bool {
        let lower = message.lowercased()
        return lower == "cancelled" || lower == "canceled"
            || lower.contains("cancelled") || lower.contains("canceled")
    }



    private var summaryStrip: some View {
        let s = store.analyticsSummary
        return VStack(alignment: .leading, spacing: 10) {
            Text("Market Snapshot")
                .font(.headline)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                TrendKPI(title: "Trades", value: CompactFormat.count(s?.totalTrades))
                TrendKPI(title: "Politicians", value: CompactFormat.count(s?.uniqueMembers))
                TrendKPI(title: "Est. Volume", value: CompactFormat.usd(s?.estimatedVolumeUsd))
                TrendKPI(
                    title: "Net Flow",
                    value: CompactFormat.usd(s?.estimatedNetFlowUsd),
                    tint: (s?.estimatedNetFlowUsd ?? 0) >= 0 ? .green : .red
                )
                TrendKPI(title: "Buys", value: CompactFormat.count(s?.buyCount), tint: .green)
                TrendKPI(title: "Sells", value: CompactFormat.count(s?.sellCount), tint: .red)
            }
        }
    }

    private var volumeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Buys vs Sells Over Time")
                .font(.headline)
            Text("Trade counts bucketed by period over selected window.")
                .font(.caption)
                .foregroundStyle(.secondary)

            let maxCount = max(store.volumeSeries.map { $0.buys + $0.sells }.max() ?? 1, 1)
            VStack(spacing: 6) {
                ForEach(store.volumeSeries.suffix(12)) { point in
                    HStack(spacing: 8) {
                        Text(formatVolumePeriod(point.period))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(width: 72, alignment: .leading)
                        GeometryReader { geo in
                            HStack(spacing: 2) {
                                let buyW = geo.size.width * CGFloat(point.buys) / CGFloat(maxCount)
                                let sellW = geo.size.width * CGFloat(point.sells) / CGFloat(maxCount)
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color.green.opacity(0.75))
                                    .frame(width: max(buyW, point.buys > 0 ? 2 : 0))
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color.red.opacity(0.75))
                                    .frame(width: max(sellW, point.sells > 0 ? 2 : 0))
                                Spacer(minLength: 0)
                            }
                        }
                        .frame(height: 12)
                        Text("\(point.buys + point.sells)")
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .frame(width: 50, alignment: .trailing)
                    }
                }
            }
            .padding(12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var tickerSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What Congress Is Trading")
                .font(.headline)
            VStack(spacing: 0) {
                ForEach(Array(store.tickerLeaderboard.prefix(10).enumerated()), id: \.element.id) { idx, item in
                    Button {
                        selectedTicker = item.ticker
                    } label: {
                        HStack(spacing: 10) {
                            Text("\(idx + 1)")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.secondary)
                                .frame(width: 18)
                            AssetMark(symbol: item.ticker, isTicker: true, size: 28)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.ticker)
                                    .font(.subheadline.weight(.bold))
                                Text(item.formattedName ?? "—")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 1) {
                                Text("\(item.tradeCount)")
                                    .font(.subheadline.weight(.bold))
                                Text(CompactFormat.usd(item.estVolumeUsd))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(item.ticker), \(item.formattedName ?? "—"), \(item.tradeCount) trades")
                    .accessibilityHint("Opens ticker details")
                    if idx < min(9, store.tickerLeaderboard.count - 1) {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var trendingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Rising Activity")
                .font(.headline)
            Text("Assets whose trade count rose most vs prior equal period.")
                .font(.caption)
                .foregroundStyle(.secondary)
            VStack(spacing: 0) {
                ForEach(Array(store.trendingAssets.prefix(8).enumerated()), id: \.element.id) { idx, item in
                    Button {
                        selectedTicker = item.ticker
                    } label: {
                        HStack(spacing: 10) {
                            AssetMark(symbol: item.ticker, isTicker: true, size: 26)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.ticker)
                                    .font(.subheadline.weight(.bold))
                                Text("\(item.recentMembers ?? 0) politicians")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("\(item.priorCount) → \(item.recentCount) trades")
                                    .font(.caption.weight(.medium))
                                if let pct = item.changePct {
                                    Text("+\(Int(round(pct * 100)))%")
                                        .font(.caption2.weight(.bold))
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Color.green.opacity(0.15))
                                        .foregroundStyle(.green)
                                        .clipShape(Capsule())
                                }
                            }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(item.ticker), \(item.priorCount) to \(item.recentCount) trades")
                    .accessibilityHint("Opens ticker details")
                    if idx < min(7, store.trendingAssets.count - 1) {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var clusterSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Consensus Moves")
                .font(.headline)
            Text("Assets several politicians traded the same direction in this window.")
                .font(.caption)
                .foregroundStyle(.secondary)
            VStack(spacing: 8) {
                ForEach(store.clusterBuys.prefix(8)) { c in
                    Button {
                        selectedTicker = c.ticker
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.ticker)
                                    .font(.subheadline.weight(.bold))
                                Text(c.formattedName ?? "")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            StatusPill(
                                text: (c.txType == "B" || c.txType == "P") ? "Buy" : (c.txType == "S" ? "Sell" : (c.txType == "E" ? "Exchange" : c.txType)),
                                color: (c.txType == "B" || c.txType == "P") ? .green : (c.txType == "S" ? .red : .blue),
                                compact: true
                            )
                            Text("\(c.memberCount) \(c.memberCount == 1 ? "politician" : "politicians")")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        .padding(10)
                        .frame(minHeight: 44)
                        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                        .contentShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(c.ticker), \(c.memberCount) \(c.memberCount == 1 ? "politician" : "politicians")")
                    .accessibilityHint("Opens ticker details")
                }
            }
        }
    }

    /// One row in the Net Flow by Sector list. Real sectors keep their raw
    /// API label; `isAggregate` rows ("Other" and "Unknown") render with a
    /// secondary/grey label so they read as catch-alls rather than real
    /// sectors, matching the trailing-row treatment `marketCapDisplayRows`
    /// gives the "unknown" market-cap bucket below.
    private struct SectorDisplayRow: Identifiable {
        let id: String
        let label: String
        let subtitle: String?
        let estNetFlowUsd: Double?
        let isAggregate: Bool
    }

    /// Splits `store.sectorFlow` into up to 8 real sectors (the API already
    /// orders by trade count, descending) plus a trailing "Other" row that
    /// sums whatever fell past the top 8, plus a trailing "Unknown" row when
    /// the API returns one. Fixes the previous silent truncation: the API
    /// can return up to ~39 fragmented sector buckets (see builders.ts
    /// `canonicalSectorSql`), and `prefix(8)` used to drop the rest with no
    /// indication anything was omitted.
    private var sectorDisplayRows: [SectorDisplayRow] {
        let unknownItem = store.sectorFlow.first { $0.sector.caseInsensitiveCompare("Unknown") == .orderedSame }
        let known = store.sectorFlow.filter { $0.sector.caseInsensitiveCompare("Unknown") != .orderedSame }

        var rows: [SectorDisplayRow] = known.prefix(8).map { item in
            SectorDisplayRow(id: item.id, label: item.sector, subtitle: nil, estNetFlowUsd: item.estNetFlowUsd, isAggregate: false)
        }

        let overflow = known.dropFirst(8)
        if !overflow.isEmpty {
            let overflowNetFlow = overflow.reduce(0.0) { $0 + ($1.estNetFlowUsd ?? 0) }
            rows.append(SectorDisplayRow(
                id: "__other__",
                label: "Other",
                subtitle: "\(overflow.count) more \(overflow.count == 1 ? "sector" : "sectors")",
                estNetFlowUsd: overflowNetFlow,
                isAggregate: true
            ))
        }

        if let unknownItem {
            rows.append(SectorDisplayRow(
                id: unknownItem.id,
                label: "Unknown",
                subtitle: nil,
                estNetFlowUsd: unknownItem.estNetFlowUsd,
                isAggregate: true
            ))
        }

        return rows
    }

    /// Canonical size order (mega -> nano), matching the SQL thresholds in
    /// `prices/service.ts`. `marketCapDisplayRows` sorts into this order so
    /// the list reads largest-to-smallest instead of whatever arbitrary
    /// order SQLite's unordered `GROUP BY` happens to return, and forces
    /// "unknown" to the trailing position — parity with how `sectorDisplayRows`
    /// above trails "Unknown"/"Other" rather than interleaving them.
    private static let marketCapOrder = ["mega", "large", "mid", "small", "micro", "nano"]

    private func marketCapRank(_ bucket: String) -> Int {
        let lower = bucket.lowercased()
        if let idx = Self.marketCapOrder.firstIndex(of: lower) { return idx }
        // Unrecognized bucket sorts after every known size band; "unknown"
        // specifically sorts after that so it is always the trailing row.
        return Self.marketCapOrder.count + (lower == "unknown" ? 1 : 0)
    }

    /// `store.marketCapBuckets` already covers every bucket the API returns,
    /// including "unknown" — verified against production data, so no rows
    /// are added or dropped here, only ordered (see `marketCapRank`).
    private var marketCapDisplayRows: [MarketCapItem] {
        store.marketCapBuckets.sorted { marketCapRank($0.bucket) < marketCapRank($1.bucket) }
    }

    private var sectorAndCapSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            if !store.sectorFlow.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Net Flow by Sector")
                        .font(.headline)
                    Text("Sectors come from ticker enrichment; trades without a resolved ticker aren't included.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    VStack(spacing: 0) {
                        ForEach(Array(sectorDisplayRows.enumerated()), id: \.element.id) { idx, row in
                            HStack {
                                Text(row.label)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(row.isAggregate ? Color.secondary : Color.primary)
                                    .lineLimit(1)
                                if let subtitle = row.subtitle {
                                    Text(subtitle)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(CompactFormat.usd(row.estNetFlowUsd))
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle((row.estNetFlowUsd ?? 0) >= 0 ? .green : .red)
                            }
                            .padding(.vertical, 8)
                            if idx < sectorDisplayRows.count - 1 {
                                Divider()
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }
            }

            if !store.marketCapBuckets.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("By Market Cap")
                        .font(.headline)
                    VStack(spacing: 0) {
                        ForEach(Array(marketCapDisplayRows.enumerated()), id: \.element.id) { idx, cap in
                            HStack {
                                Text(cap.bucket.capitalized)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(cap.bucket.lowercased() == "unknown" ? Color.secondary : Color.primary)
                                Spacer()
                                Text("\(cap.tradeCount) trades")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(CompactFormat.usd(cap.estNetFlowUsd))
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle((cap.estNetFlowUsd ?? 0) >= 0 ? .green : .red)
                                    .frame(width: 80, alignment: .trailing)
                            }
                            .padding(.vertical, 8)
                            if idx < marketCapDisplayRows.count - 1 {
                                Divider()
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }

    private var performersSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Top Performers (vs S&P 500)")
                .font(.headline)
            Text("Politicians whose disclosed buys beat the S&P 500 post-filing date.")
                .font(.caption)
                .foregroundStyle(.secondary)

            VStack(spacing: 0) {
                ForEach(Array(store.topPerformers.prefix(8).enumerated()), id: \.element.id) { idx, p in
                    Button {
                        selectedPoliticianId = p.filerId
                        selectedPoliticianName = p.fullName ?? p.filerId
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.fullName ?? p.filerId)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text("\(p.tradeCount) buys")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let ret = p.avgAnnualizedExcessReturn {
                                Text(String(format: "%+.1f%% vs SPX", ret * 100))
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(ret >= 0 ? .green : .red)
                            }
                        }
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(p.fullName ?? p.filerId), \(p.tradeCount) buys")
                    .accessibilityHint("Opens politician details")
                    if idx < min(7, store.topPerformers.count - 1) {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var memberSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Most Active Politicians")
                .font(.headline)
            VStack(spacing: 0) {
                ForEach(Array(store.memberLeaderboard.prefix(10).enumerated()), id: \.element.id) { idx, m in
                    Button {
                        selectedPoliticianId = m.filerId
                        selectedPoliticianName = m.fullName ?? m.filerId
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(m.fullName ?? m.filerId)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text([m.chamber?.chamberLabel, m.party, m.state].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(m.tradeCount ?? 0)")
                                .font(.subheadline.weight(.bold))
                            Text("trades")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(m.fullName ?? m.filerId), \(m.tradeCount ?? 0) trades")
                    .accessibilityHint("Opens politician details")
                    if idx < min(9, store.memberLeaderboard.count - 1) {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func timelinessSection(lag: FilingLagResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Disclosure Timeliness")
                .font(.headline)
            Text("Days from trade to official filing date (45-day STOCK Act limit).")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let s = lag.summary {
                HStack(spacing: 12) {
                    TrendKPI(title: "Avg Delay", value: "\(Int(round(s.avgLagDays ?? 0))) days")
                    TrendKPI(title: "Median Delay", value: "\(Int(round(s.medianLagDays ?? 0))) days")
                    TrendKPI(title: "Late Filings", value: CompactFormat.count(s.lateCount), tint: (s.lateCount ?? 0) > 0 ? .orange : .green)
                }
            }

            if let late = lag.topLateFilers, !late.isEmpty {
                Text("Slowest Filers (Avg Delay)")
                    .font(.subheadline.weight(.bold))
                    .padding(.top, 6)
                VStack(spacing: 0) {
                    ForEach(Array(late.prefix(6).enumerated()), id: \.element.id) { idx, f in
                        Button {
                            selectedPoliticianId = f.filerId
                            selectedPoliticianName = f.fullName ?? f.filerId
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(f.fullName ?? f.filerId)
                                        .font(.subheadline.weight(.medium))
                                        .lineLimit(1)
                                    Text("\(f.tradeCount ?? 0) trades")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("\(Int(round(f.avgLagDays ?? 0)))d avg")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(.orange)
                            }
                            .padding(.vertical, 6)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(f.fullName ?? f.filerId), \(Int(round(f.avgLagDays ?? 0))) days average delay")
                        .accessibilityHint("Opens politician details")
                        if idx < min(5, late.count - 1) {
                            Divider()
                        }
                    }
                }
                .padding(.horizontal, 12)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private func formatVolumePeriod(_ period: String) -> String {
        let parts = period.split(separator: "-")
        if parts.count == 2, let year = Int(parts[0]) {
            let numStr = parts[1]
            if numStr.hasPrefix("W"), let num = Int(numStr.dropFirst()) {
                // Week (e.g. 2026-W18)
                var components = DateComponents()
                components.yearForWeekOfYear = year
                components.weekOfYear = num
                components.weekday = 2
                let cal = Calendar(identifier: .gregorian)
                if let date = cal.date(from: components) {
                    let fmt = DateFormatter()
                    fmt.dateFormat = "MMM d"
                    return fmt.string(from: date)
                }
            } else if let num = Int(numStr) {
                // Month (e.g. 2026-05)
                var components = DateComponents()
                components.year = year
                components.month = num
                let cal = Calendar(identifier: .gregorian)
                if let date = cal.date(from: components) {
                    let fmt = DateFormatter()
                    fmt.dateFormat = "MMM yyyy"
                    return fmt.string(from: date)
                }
            }
        } else if parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) {
            // Day (e.g. 2026-05-04)
            var components = DateComponents()
            components.year = year
            components.month = month
            components.day = day
            let cal = Calendar(identifier: .gregorian)
            if let date = cal.date(from: components) {
                let fmt = DateFormatter()
                fmt.dateFormat = "MMM d"
                return fmt.string(from: date)
            }
        }
        return period
    }
}

struct TrendKPI: View {
    let title: String
    let value: String
    var tint: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.headline.weight(.bold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct LatencyComparisonView: View {
    let summary: LatencySummary
    let minMatched = 2

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Speed vs. Data Providers")
                .font(.headline)
            Text("Live new imports only (seed/historical backfills excluded). Matched against provider feeds even if the gap is minutes or up to about two weeks either way.")
                .font(.caption)
                .foregroundStyle(.secondary)

            let sortedProviders = summary.providers.sorted { $0.matched > $1.matched }

            ForEach(sortedProviders) { provider in
                ProviderScorecard(provider: provider, minMatched: minMatched)
            }
        }
    }
}

struct ProviderScorecard: View {
    let provider: LatencyProvider
    let minMatched: Int

    var body: some View {
        // Mirror web honesty gates: usable = full claim; preliminary = soft timing.
        // Never paint "tie" when W+L+T is empty or lead seconds are missing (QQ empty-publish bug).
        let status = provider.comparisonStatus ?? "insufficient"
        let usable = status == "usable"
        let preliminary = status == "preliminary"
        let wins = provider.usFirstCount
        let losses = provider.providerFirstCount
        let ties = provider.tieCount
        let deltaSample = wins + losses + ties
        let hasLead = provider.avgLeadSec != nil || provider.medianLeadSec != nil
        let hasTiming = provider.matched >= minMatched && deltaSample > 0 && hasLead
        let hasStats = hasTiming && (usable || preliminary)
        let ahead = hasStats && wins > losses
        let tied = hasStats && wins == losses && deltaSample > 0

        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(provider.label)
                    .font(.subheadline.weight(.bold))
                Spacer()
                if hasStats {
                    if preliminary {
                        Text(ahead ? "Preliminary lead" : (tied ? "Preliminary tie" : (wins < losses ? "Preliminary behind" : "Preliminary")))
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color.orange.opacity(0.15)).foregroundStyle(.orange).clipShape(Capsule())
                    } else if ahead {
                        Text("Ahead").font(.caption2.weight(.bold)).padding(.horizontal, 8).padding(.vertical, 3).background(Color.green.opacity(0.2)).foregroundStyle(.green).clipShape(Capsule())
                    } else if tied {
                        Text("Tied").font(.caption2.weight(.bold)).padding(.horizontal, 8).padding(.vertical, 3).background(Color.gray.opacity(0.2)).foregroundStyle(.secondary).clipShape(Capsule())
                    } else {
                        Text("Behind").font(.caption2.weight(.bold)).padding(.horizontal, 8).padding(.vertical, 3).background(Color.red.opacity(0.2)).foregroundStyle(.red).clipShape(Capsule())
                    }
                } else if provider.matched >= minMatched && !usable {
                    Text("Coverage limited").font(.caption2.weight(.bold)).padding(.horizontal, 8).padding(.vertical, 3).background(Color.orange.opacity(0.15)).foregroundStyle(.orange).clipShape(Capsule())
                } else {
                    Text("Gathering").font(.caption2.weight(.bold)).padding(.horizontal, 8).padding(.vertical, 3).background(Color.gray.opacity(0.2)).foregroundStyle(.secondary).clipShape(Capsule())
                }
            }

            if hasStats {
                let winPct = provider.matched > 0 ? Int(round(100.0 * Double(wins) / Double(provider.matched))) : 0
                // Prefer average lead (matches human mean lead/lag); median is secondary.
                let leadSecs = provider.avgLeadSec ?? provider.medianLeadSec
                HStack {
                    Text(formatLead(leadSecs))
                        .font(.title3.weight(.bold))
                        .foregroundStyle(ahead ? .green : (tied ? .primary : .red))
                    Text(preliminary ? "prelim. avg lead" : "avg lead")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(winPct)% win")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            } else {
                let unmatched = provider.unmatchedProvider ?? 0
                let strong = provider.strongMatched
                let strongNote: String = {
                    if let s = strong, s > provider.matched {
                        return " \(s) strong overlaps total."
                    }
                    return ""
                }()
                Text(
                    provider.matched > 0 && !hasLead
                        ? "Matched \(provider.matched) races but no usable first-seen timestamps for lead/lag yet."
                            + strongNote
                        : provider.matched > 0
                        ? "Timed \(provider.matched) concurrent races of \(provider.candidates) CT filings so far."
                            + strongNote
                            + (unmatched > 0 ? " \(unmatched) provider-only rows still unmatched." : "")
                        : "Probes haven't found concurrent races yet."
                            + strongNote
                )
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private func formatLead(_ secs: Int?) -> String {
        guard let s = secs else { return "—" }
        let absS = abs(Double(s))
        let sign = s > 0 ? "+" : (s < 0 ? "−" : "")
        if absS < 90 { return "\(sign)\(Int(round(absS)))s" }
        if absS < 5400 { return "\(sign)\(Int(round(absS / 60)))m" }
        if absS < 172800 { return "\(sign)\(String(format: "%.1f", absS / 3600))h" }
        return "\(sign)\(String(format: "%.1f", absS / 86400))d"
    }
}
