import SwiftUI

struct TrendsView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var tabRouter: TabRouter
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    /// Same `@AppStorage` key as `FeedDashboardView` — the disclaimer's
    /// dismissed/expanded state is one truth across both tabs.  The filter
    /// strip is glued under the wordmark in the opaque light header so it
    /// does not sit in the cool page or leave a gap under the title.
    @AppStorage("ct_disclaimer_expanded") private var disclaimerExpanded = false
    @State private var selectedTicker: TickerSheetTarget?
    @State private var selectedPolitician: MemberSheetTarget?
    @State private var volumeMetric: VolumeChartMetric = .count
    @State private var tickerMetric: VolumeChartMetric = .count

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                FeedDisclaimerHeader(disclaimerExpanded: $disclaimerExpanded) {
                    FeedControlBar(showMetrics: false)
                }

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if store.isLoadingTrends && store.analyticsSummary == nil {
                        ProgressView("Loading trends…")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 40)
                    } else {
                        if let notice = store.trendsNotice,
                           !Self.isBenignCancellationNotice(notice) {
                            NoticeView(message: notice) {
                                Task { await store.refreshTrends() }
                            }
                        }

                        summaryStrip

                        if horizontalSizeClass == .regular {
                            LazyVGrid(columns: [GridItem(.flexible(), spacing: 16, alignment: .top), GridItem(.flexible(), spacing: 16, alignment: .top)], spacing: 16) {
                                if !store.tickerLeaderboard.isEmpty {
                                    tickerSection
                                }

                                if !store.topPerformers.isEmpty {
                                    performersSection
                                }

                                if !store.volumeSeries.isEmpty {
                                    volumeSection
                                }

                                if !store.clusterBuys.isEmpty {
                                    clusterSection
                                }

                                sectorFlowCard

                                marketCapCard

                                if store.selectedTimeRange != .all, !store.trendingAssets.isEmpty {
                                    trendingSection
                                }

                                if !store.memberLeaderboard.isEmpty {
                                    memberSection
                                }

                                if !store.conflicts.isEmpty {
                                    conflictsSection
                                }

                                if let lag = store.filingLag {
                                    timelinessSection(lag: lag)
                                }
                            }
                        } else {
                            if !store.tickerLeaderboard.isEmpty {
                                tickerSection
                            }

                            if store.selectedTimeRange != .all, !store.trendingAssets.isEmpty {
                                trendingSection
                            }

                            if !store.volumeSeries.isEmpty {
                                volumeSection
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

                            if !store.conflicts.isEmpty {
                                conflictsSection
                            }

                            if let lag = store.filingLag {
                                timelinessSection(lag: lag)
                            }
                        }

                        if let summary = store.latencySummary,
                           LatencyScorecardCopy.isPubliclyVisible(summary) {
                            Button {
                                tabRouter.selection = .delivery
                            } label: {
                                HStack {
                                    Text("Filing latency comparison")
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                                .padding(12)
                                .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Opens the Delivery tab")
                        }
                    }

                    // Same page-chrome row as Trades / Directory / Delivery.
                    // Owner punchlist: legal links at the bottom of every tab.
                    AppLegalFooter()
                        .padding(.top, 8)
                }
                // Same horizontal/top/bottom insets as Trades.  The
                // disclaimer lives in `FeedDisclaimerHeader` now, not in
                // this scrolling stack.
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            }
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .ctSolidFeedHeader()
            .toolbar {
                // ⓘ now leads (swapped to match Trades' post-swap side —
                // owner punch list item 3); brand centers via .principal;
                // hamburger is the only trailing control.
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
            }
            .task {
                if store.analyticsSummary == nil {
                    await store.refreshTrends()
                }
            }
            .refreshable {
                await store.refreshTrends()
            }
            .sheet(item: $selectedTicker) { target in
                TickerDetailView(ticker: target.ticker)
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
        }
    }

    private static func isBenignCancellationNotice(_ message: String) -> Bool {
        let lower = message.lowercased()
        return lower == "cancelled" || lower == "canceled"
            || lower.contains("cancelled") || lower.contains("canceled")
    }

    /// Extra top pad on later sections so the title sits closer to its own card
    /// than to the card above. Timeframe stays in the sticky filter row only.
    private func trendsHeading(_ title: String, extraTop: CGFloat = 10) -> some View {
        Text(title)
            .font(.headline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, extraTop)
            .accessibilityAddTraits(.isHeader)
    }

    private var summaryStrip: some View {
        let s = store.analyticsSummary
        return ViewThatFits(in: .horizontal) {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                TrendKPI(title: "Trades", value: CompactFormat.count(s?.totalTrades))
                TrendKPI(title: "Politicians", value: CompactFormat.count(s?.uniqueMembers))
                TrendKPI(title: "Est. Volume", value: CompactFormat.usd(s?.estimatedVolumeUsd))
                TrendKPI(
                    title: "Net Flow",
                    value: SignedFlowFormat.usd(s?.estimatedNetFlowUsd),
                    tint: SignedFlowFormat.tint(s?.estimatedNetFlowUsd)
                )
                TrendKPI(title: "Buys", value: CompactFormat.count(s?.buyCount), tint: AppTheme.semanticPositive)
                TrendKPI(title: "Sells", value: CompactFormat.count(s?.sellCount), tint: AppTheme.semanticNegative)
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                TrendKPI(title: "Trades", value: CompactFormat.count(s?.totalTrades))
                TrendKPI(title: "Politicians", value: CompactFormat.count(s?.uniqueMembers))
                TrendKPI(title: "Est. Volume", value: CompactFormat.usd(s?.estimatedVolumeUsd))
                TrendKPI(
                    title: "Net Flow",
                    value: SignedFlowFormat.usd(s?.estimatedNetFlowUsd),
                    tint: SignedFlowFormat.tint(s?.estimatedNetFlowUsd)
                )
                TrendKPI(title: "Buys", value: CompactFormat.count(s?.buyCount), tint: AppTheme.semanticPositive)
                TrendKPI(title: "Sells", value: CompactFormat.count(s?.sellCount), tint: AppTheme.semanticNegative)
            }
        }
    }

    private var volumeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                Text("Buys vs Sells")
                    .font(.headline)
                Spacer(minLength: 8)
                Picker("Metric", selection: $volumeMetric) {
                    ForEach(VolumeChartMetric.allCases) { metric in
                        Text(metric.label).tag(metric)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 88)
                .accessibilityLabel("Buys vs Sells metric")
            }
            .padding(.top, 10)

            let useDollars = volumeMetric == .dollars
            let totals: [Double] = store.volumeSeries.map { point in
                if useDollars {
                    return (point.estBuyVolUsd ?? 0) + (point.estSellVolUsd ?? 0)
                }
                return Double(point.buys + point.sells)
            }
            let maxVal = max(totals.max() ?? 1, 1)
            VStack(spacing: 6) {
                ForEach(store.volumeSeries.suffix(12)) { point in
                    let buyVal = useDollars ? (point.estBuyVolUsd ?? 0) : Double(point.buys)
                    let sellVal = useDollars ? (point.estSellVolUsd ?? 0) : Double(point.sells)
                    HStack(spacing: 8) {
                        Text(formatVolumePeriod(point.period))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(width: 72, alignment: .leading)
                        GeometryReader { geo in
                            HStack(spacing: 2) {
                                let buyW = geo.size.width * CGFloat(buyVal) / CGFloat(maxVal)
                                let sellW = geo.size.width * CGFloat(sellVal) / CGFloat(maxVal)
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color.green.opacity(0.75))
                                    .frame(width: max(buyW, buyVal > 0 ? 2 : 0))
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color.red.opacity(0.75))
                                    .frame(width: max(sellW, sellVal > 0 ? 2 : 0))
                                Spacer(minLength: 0)
                            }
                        }
                        .frame(height: 12)
                        Text(useDollars
                             ? CompactFormat.usd(buyVal + sellVal)
                             : CompactFormat.count(Int(buyVal + sellVal)))
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .frame(width: useDollars ? 64 : 50, alignment: .trailing)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        "\(formatVolumePeriod(point.period)), \(useDollars ? CompactFormat.usd(buyVal) : CompactFormat.count(Int(buyVal))) buys, \(useDollars ? CompactFormat.usd(sellVal) : CompactFormat.count(Int(sellVal))) sells"
                    )
                }
            }
            .padding(12)
            .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var tickerSection: some View {
        let ranked = Self.rankedTickers(store.tickerLeaderboard, metric: tickerMetric)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                Text("What Is Being Traded")
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                Picker("Metric", selection: $tickerMetric) {
                    ForEach(VolumeChartMetric.allCases) { metric in
                        Text(metric.label).tag(metric)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 88)
                .accessibilityLabel("What Is Being Traded metric")
            }
            .padding(.top, 10)
            VStack(spacing: 0) {
                ForEach(Array(ranked.enumerated()), id: \.element.id) { idx, item in
                    Button {
                        selectedTicker = TickerSheetTarget(ticker: item.ticker)
                    } label: {
                        HStack(spacing: 10) {
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
                                if tickerMetric == .dollars {
                                    Text(CompactFormat.usd(item.estVolumeUsd))
                                        .font(.subheadline.weight(.bold))
                                    Text("\(item.tradeCount) trades")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                } else {
                                    Text("\(item.tradeCount)")
                                        .font(.subheadline.weight(.bold))
                                    Text(CompactFormat.usd(item.estVolumeUsd))
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(item.ticker), \(item.formattedName ?? "—"), \(item.tradeCount) trades")
                    .accessibilityHint("Opens ticker details")
                    if idx < ranked.count - 1 {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    static func rankedTickers(
        _ items: [TickerLeaderboardItem],
        metric: VolumeChartMetric,
        limit: Int = 10
    ) -> [TickerLeaderboardItem] {
        let sorted = items.sorted { lhs, rhs in
            switch metric {
            case .count:
                if lhs.tradeCount != rhs.tradeCount { return lhs.tradeCount > rhs.tradeCount }
                return (lhs.estVolumeUsd ?? 0) > (rhs.estVolumeUsd ?? 0)
            case .dollars:
                let lv = lhs.estVolumeUsd ?? 0
                let rv = rhs.estVolumeUsd ?? 0
                if lv != rv { return lv > rv }
                return lhs.tradeCount > rhs.tradeCount
            }
        }
        return Array(sorted.prefix(limit))
    }

    private var trendingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Rising Activity")
            VStack(spacing: 0) {
                ForEach(Array(store.trendingAssets.prefix(8).enumerated()), id: \.element.id) { idx, item in
                    Button {
                        selectedTicker = TickerSheetTarget(ticker: item.ticker)
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
                                        .foregroundStyle(AppTheme.semanticPositive)
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
            .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var clusterSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Consensus Moves")
            VStack(spacing: 8) {
                ForEach(store.clusterBuys.prefix(8)) { c in
                    Button {
                        selectedTicker = TickerSheetTarget(ticker: c.ticker)
                    } label: {
                        HStack(spacing: 10) {
                            AssetMark(symbol: c.ticker, isTicker: true, size: 28)
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
                                color: (c.txType == "B" || c.txType == "P") ? AppTheme.semanticPositive : (c.txType == "S" ? AppTheme.semanticNegative : .blue),
                                compact: true
                            )
                            Text("\(c.memberCount) \(c.memberCount == 1 ? "politician" : "politicians")")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        .padding(10)
                        .frame(minHeight: 44)
                        .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 10))
                        .contentShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(c.ticker), \(c.memberCount) \(c.memberCount == 1 ? "politician" : "politicians")")
                    .accessibilityHint("Opens ticker details")
                }
            }
        }
    }

    private var sectorAndCapSection: some View {
        Group {
            if horizontalSizeClass == .regular {
                HStack(alignment: .top, spacing: 18) {
                    sectorFlowCard
                        .frame(maxWidth: .infinity)
                    marketCapCard
                        .frame(maxWidth: .infinity)
                }
            } else {
                VStack(alignment: .leading, spacing: 18) {
                    sectorFlowCard
                    marketCapCard
                }
            }
        }
        .padding(.top, 10)
    }

    @ViewBuilder
    private var sectorFlowCard: some View {
        if !store.sectorFlow.isEmpty {
            let rows = SectorFlowRow.rows(from: store.sectorFlow, topCount: 8)
            VStack(alignment: .leading, spacing: 10) {
                trendsHeading("Net Flow by Sector", extraTop: 0)
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { idx, row in
                        HStack {
                            Text(row.label)
                                .font(.subheadline.weight(row.isAggregate ? .regular : .medium))
                                .foregroundStyle(row.isAggregate ? .secondary : .primary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                            Spacer(minLength: 12)
                            Text(SignedFlowFormat.usd(row.estNetFlowUsd))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(SignedFlowFormat.tint(row.estNetFlowUsd))
                                .lineLimit(1)
                        }
                        .padding(.vertical, 8)
                        .accessibilityElement(children: .combine)
                        if idx < rows.count - 1 {
                            Divider()
                        }
                    }
                }
                .padding(.horizontal, 12)
                .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    @ViewBuilder
    private var marketCapCard: some View {
        if !store.marketCapBuckets.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                trendsHeading("By Market Cap", extraTop: 0)
                let caps = MarketCapOrder.sorted(store.marketCapBuckets)
                VStack(spacing: 0) {
                    ForEach(Array(caps.enumerated()), id: \.element.id) { idx, cap in
                        HStack(spacing: 8) {
                            Text(cap.bucket.capitalized)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                                .frame(maxWidth: 92, alignment: .leading)
                            Spacer(minLength: 4)
                            Text("\(cap.tradeCount) \(cap.tradeCount == 1 ? "trade" : "trades")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .frame(minWidth: 68, alignment: .trailing)
                            Text(SignedFlowFormat.usd(cap.estNetFlowUsd))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(SignedFlowFormat.tint(cap.estNetFlowUsd))
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                                .frame(width: 104, alignment: .trailing)
                        }
                        .padding(.vertical, 8)
                        if idx < caps.count - 1 {
                            Divider()
                        }
                    }
                }
                .padding(.horizontal, 12)
                .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    /// Smallest number of disclosed buys a politician needs before the
    /// leaderboard will rank them. iOS sends no `minTrades`, so this mirrors the
    /// server default in `buildMemberPerformanceLeaderboardQuery`
    /// (`clampLimit(p.minTrades, 5, 1000)`, `app/src/analytics/builders.ts`).
    /// Shown on the card because the owner's standing worry about this section
    /// is "prone to having wild numbers" — an unlabelled small-N guard is
    /// exactly the thing that makes a 3-trade streak look like skill. Keep in
    /// sync with the builder if that default ever moves.
    static let performersMinBuys = 5

    /// Scope line under Top Performers.  Owner: "5+ buys", not "minimum…",
    /// and "+/-200% cap per trade" instead of "each trade capped at ±200%".
    /// The selected window lives on the heading, not here.
    static func performersScopeLine() -> String {
        "\(performersMinBuys)+ buys  •  stocks only  •  +/-200% cap per trade"
    }

    /// Caption under Disclosure Timeliness.  The window is already on the
    /// filter chips / heading — do not repeat "in this window".
    static func timelinessBasis(count: Int) -> String {
        "9 in 10 filings land inside the P90 figure.  Based on \(CompactFormat.count(count)) disclosed trades."
    }

    private var performersSection: some View {
        // Rank by the SAME statistic the row prints. The API already orders by
        // `avgExcessReturn`, so this is normally a no-op — it exists so the
        // list can never again arrive sorted by one field and be painted with
        // another (the cause of the owner's "odd order" report). Rows with no
        // score sort last rather than jumping to the top as 0.
        let ranked = store.topPerformers
            .sorted { ($0.avgExcessReturn ?? -.greatestFiniteMagnitude) > ($1.avgExcessReturn ?? -.greatestFiniteMagnitude) }
            .prefix(8)
        return VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Top Performers")
            // Benchmark named ONCE here instead of stamped on every row.
            // Wording mirrors the `note` field this endpoint returns
            // (`app/src/analytics/routes.ts`); iOS only decodes `members`, so
            // if that note is ever reworded, reword this too.
            Text("How far each politician's disclosed buys beat the S&P 500, measured from the filing date — the part a follower could have acted on.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(Self.performersScopeLine())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)

            VStack(spacing: 0) {
                ForEach(Array(ranked.enumerated()), id: \.element.id) { idx, p in
                    Button {
                        selectedPolitician = MemberSheetTarget(id: p.filerId, name: p.fullName ?? p.filerId, photoUrl: p.photoUrl)
                    } label: {
                        HStack(spacing: 10) {
                            MemberAvatar(
                                photoURL: MemberPhotoURL.resolve(p.photoUrl),
                                name: p.fullName ?? "",
                                size: 28
                            )
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.fullName ?? p.filerId)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text("\(p.tradeCount) buys")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            // `avgExcessReturn`, never `avgAnnualizedExcessReturn`
                            // — see the doc comments on `TopPerformerItem`.
                            Text(SignedPercentFormat.percent(p.avgExcessReturn))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(SignedFlowFormat.tint(p.avgExcessReturn))
                                .lineLimit(1)
                        }
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    // Spell the missing case out — VoiceOver would otherwise
                    // read the em-dash placeholder as "dash vs S and P 500".
                    .accessibilityLabel(
                        p.avgExcessReturn == nil
                            ? "\(p.fullName ?? p.filerId), \(p.tradeCount) buys, no score yet"
                            : "\(p.fullName ?? p.filerId), \(p.tradeCount) buys, \(SignedPercentFormat.percent(p.avgExcessReturn)) vs S&P 500"
                    )
                    .accessibilityHint("Opens politician details")
                    if idx < ranked.count - 1 {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var memberSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Most Active Politicians")
            VStack(spacing: 0) {
                ForEach(Array(store.memberLeaderboard.prefix(10).enumerated()), id: \.element.id) { idx, m in
                    Button {
                        selectedPolitician = MemberSheetTarget(id: m.filerId, name: m.fullName ?? m.filerId, photoUrl: m.photoUrl)
                    } label: {
                        HStack(spacing: 10) {
                            MemberAvatar(
                                photoURL: MemberPhotoURL.resolve(m.photoUrl),
                                name: m.fullName ?? "",
                                size: 28
                            )
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
            .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var conflictsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Committee Sector Conflicts")
            Text("Disclosed trades in sectors that a politician's committees oversee (curated committee→sector map). Observational — not evidence of impropriety.")
                .font(.caption)
                .foregroundStyle(.secondary)

            VStack(spacing: 0) {
                ForEach(Array(store.conflicts.prefix(8).enumerated()), id: \.element.id) { idx, c in
                    Button {
                        // The route sends no photo for conflict rows; the sheet
                        // resolves one from the roster it already has.
                        selectedPolitician = MemberSheetTarget(id: c.memberTargetId, name: c.displayName, photoUrl: nil)
                    } label: {
                        HStack(spacing: 10) {
                            MemberAvatar(
                                photoURL: nil,
                                name: c.memberName ?? "",
                                size: 28
                            )
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.displayName)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text(c.contextLine)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            HStack(spacing: 6) {
                                AssetMark(symbol: c.ticker ?? "", isTicker: true, size: 22)
                                VStack(alignment: .trailing, spacing: 2) {
                                    Text(c.ticker ?? "—")
                                        .font(.caption.weight(.bold))
                                    StatusPill(
                                        text: c.txType == "B" ? "Buy" : (c.txType == "S" ? "Sell" : "Exchange"),
                                        color: c.txType == "B" ? AppTheme.semanticPositive : (c.txType == "S" ? AppTheme.semanticNegative : .blue),
                                        compact: true
                                    )
                                }
                            }
                        }
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if idx < min(7, store.conflicts.count - 1) {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func timelinessSection(lag: FilingLagResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Disclosure Timeliness")
            Text("Days from trade to official filing date (45-day STOCK Act limit).")
                .font(.caption)
                .foregroundStyle(.secondary)

            // Median / P90 / >45 days — the three figures this endpoint
            // actually returns, and the same three the website shows. The old
            // trio asked for `avgLagDays` and `lateCount`, which have never
            // been in the payload; Optional decoding hid that and shipped
            // "Avg Delay: 0 days" as if it were measured. Every value falls
            // back to an em-dash, never to a zero that reads as a real answer.
            if let s = lag.summary {
                HStack(spacing: 12) {
                    TrendKPI(title: "Median Delay", value: Self.daysLabel(s.medianLagDays))
                    TrendKPI(title: "P90 Delay", value: Self.daysLabel(s.p90LagDays))
                    TrendKPI(
                        title: "Over 45 Days",
                        value: SignedPercentFormat.plainPercent(s.overFortyFivePct),
                        tint: (s.overFortyFivePct ?? 0) > 0 ? AppTheme.semanticCaution : AppTheme.semanticPositive
                    )
                }
                if let count = s.count, count > 0 {
                    Text(Self.timelinessBasis(count: count))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if let late = lag.topLateFilers, !late.isEmpty {
                Text("Slowest Filers (Avg Delay)")
                    .font(.subheadline.weight(.bold))
                    .padding(.top, 6)
                VStack(spacing: 0) {
                    ForEach(Array(late.prefix(6).enumerated()), id: \.element.id) { idx, f in
                        Button {
                            selectedPolitician = MemberSheetTarget(id: f.filerId, name: f.fullName ?? f.filerId, photoUrl: f.photoUrl)
                        } label: {
                            HStack(spacing: 10) {
                                MemberAvatar(
                                    photoURL: MemberPhotoURL.resolve(f.photoUrl),
                                    name: f.fullName ?? "",
                                    size: 28
                                )
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
                                    .foregroundStyle(AppTheme.semanticCaution)
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
                .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    /// Whole-day label for a filing-lag figure. A missing value is an em-dash,
    /// NOT "0 days" — "we don't have this" and "they filed same-day" are
    /// opposite claims and must never render identically.
    private static func daysLabel(_ days: Double?) -> String {
        guard let days else { return "—" }
        let whole = Int(days.rounded())
        return "\(whole) \(whole == 1 ? "day" : "days")"
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

/// Signed money for net-flow readouts.
///
/// Colour alone must not carry the sign: it is invisible to a large share of
/// readers and it disappears entirely in a screenshot or a VoiceOver pass. So
/// an inflow prints "net +$" style — `+$952k` — and an outflow keeps the `-`
/// that `CompactFormat.usd` already supplies.
///
/// Two cases are deliberately NOT signed. A genuine zero is neither positive
/// nor negative, so "+$0" would be a small lie; and a missing value stays an
/// em-dash so "nothing flowed" and "we have no figure" never look the same.
enum SignedFlowFormat {
    static func usd(_ value: Double?) -> String {
        guard let value else { return "—" }
        let magnitude = CompactFormat.usd(abs(value))
        // Test the RENDERED string, not the raw double: a sub-dollar residue
        // would otherwise print as a signed "+$0" or "−$0".
        if magnitude == "$0" { return magnitude }
        if value > 0 { return "+" + magnitude }
        if value < 0 { return "\u{2212}" + magnitude }
        return magnitude
    }

    /// Green up / red down, but neutral for a real zero and for no-data — those
    /// two carry no direction to colour.
    static func tint(_ value: Double?) -> Color {
        guard let value, value != 0 else { return .primary }
        return value > 0 ? AppTheme.semanticPositive : AppTheme.semanticNegative
    }
}

/// Percentages that come off the API as fractions (0.0567 → 5.7%).
enum SignedPercentFormat {
    /// Signed, for return figures where direction is the whole point.
    static func percent(_ fraction: Double?) -> String {
        guard let fraction else { return "—" }
        let pct = fraction * 100
        // Round first, then decide the sign, so a value that rounds to 0.0
        // prints a bare "0.0%" instead of a misleading "+0.0%".
        let rounded = (pct * 10).rounded() / 10
        if rounded == 0 { return "0.0%" }
        return String(format: "%+.1f%%", rounded)
    }

    /// Unsigned, for shares of a total (a proportion has no direction).
    /// Sub-tenth-of-a-percent shares collapse to "<0.1%" rather than to a "0%"
    /// that would read as "never happens".
    static func plainPercent(_ fraction: Double?) -> String {
        guard let fraction else { return "—" }
        let pct = fraction * 100
        if pct == 0 { return "0%" }
        if pct < 0.1 { return "<0.1%" }
        if pct >= 10 { return String(format: "%.0f%%", pct) }
        return String(format: "%.1f%%", pct)
    }
}

/// Size ladder for the market-cap buckets `securities_ref.market_cap_bucket`
/// emits. `/market-cap-breakdown` runs a bare `GROUP BY bucket` with no ORDER
/// BY, so rows arrive alphabetically — Large above Mega, Micro above Mid. Any
/// label the ladder does not know (including the `unknown` sentinel) sorts to
/// the end rather than into the middle of the ladder.
enum MarketCapOrder {
    private static let rank = ["mega": 0, "large": 1, "mid": 2, "small": 3, "micro": 4, "nano": 5]

    static func sorted(_ buckets: [MarketCapItem]) -> [MarketCapItem] {
        buckets.sorted { a, b in
            let ra = rank[a.bucket.lowercased()] ?? Int.max
            let rb = rank[b.bucket.lowercased()] ?? Int.max
            // Stable tail: two unranked labels keep a predictable A→Z order
            // instead of whatever the server happened to emit.
            if ra == rb { return a.bucket.lowercased() < b.bucket.lowercased() }
            return ra < rb
        }
    }
}

/// One rendered row of "Net Flow by Sector".
///
/// `GET /api/analytics/sector-flow` returns the most-traded sectors ordered by
/// trade count (server default LIMIT 20). iOS used to paint `prefix(8)` and
/// silently drop the tail — at window=90d that hid a majority of the sectors
/// and, because one of the discards was a large outflow, the visible rows did
/// not add up to anything the reader could check. Every returned sector now
/// lands somewhere: the top 8 by name, the remainder folded into one "Other"
/// row that says how many sectors it covers, and "Unknown" kept as its own
/// trailing row so unenriched trades are never quietly mixed into "Other".
///
/// DUPLICATE LABELS ARE EXPECTED AND MUST BE MERGED. Verified live on
/// 2026-08-11 at `?window=90d`: the payload carried 'Technology' twice,
/// 'Healthcare' three times, 'Communication Services' three times and
/// 'Industrials' three times, each as its own bucket. (The canonicalizing
/// `CASE` is in the SELECT list while `GROUP BY sector` binds to the underlying
/// `sr.sector` column, so the server groups on the raw vocabulary and only
/// relabels — a backend defect, reported separately.) Two consequences the view
/// cannot ignore: identical `id`s corrupt a SwiftUI `ForEach`, and two rows
/// reading "Healthcare  −$40k" side by side is worse than either number alone.
/// Rows are therefore merged by label and given index-derived ids. When the
/// backend groups correctly the merge is a no-op.
private struct SectorFlowRow: Identifiable {
    let id: String
    let label: String
    let estNetFlowUsd: Double?
    /// Aggregate rows (Other / Unknown) are de-emphasised — they name a bucket,
    /// not a sector anyone chose to trade.
    let isAggregate: Bool

    /// A label's combined trade count and net flow. `netFlow` stays nil until a
    /// bucket actually reports one, so "no figure" never becomes a $0 claim.
    private struct Merged {
        var label: String
        var tradeCount: Int
        var netFlow: Double?
    }

    static func rows(from sectors: [SectorFlowItem], topCount: Int) -> [SectorFlowRow] {
        // Fold duplicate labels first, preserving first-seen order so the
        // server's trade-count ranking still drives the result when the payload
        // is already clean.
        var order: [String] = []
        var merged: [String: Merged] = [:]
        for item in sectors {
            let key = item.sector.lowercased()
            if merged[key] == nil {
                order.append(key)
                merged[key] = Merged(label: item.sector, tradeCount: 0, netFlow: nil)
            }
            var entry = merged[key] ?? Merged(label: item.sector, tradeCount: 0, netFlow: nil)
            entry.tradeCount += item.tradeCount ?? 0
            if let flow = item.estNetFlowUsd {
                entry.netFlow = (entry.netFlow ?? 0) + flow
            }
            merged[key] = entry
        }
        // Re-rank after merging: two halves of one sector each looked smaller
        // than they are, so the pre-merge order can no longer be trusted.
        let ranked = order.compactMap { merged[$0] }.sorted {
            ($0.netFlow ?? 0) > ($1.netFlow ?? 0)
        }

        // "Unknown" is pulled out BEFORE ranking is applied to the top slots.
        // Leaving it in would let a data-quality bucket take a top-8 slot from a
        // real sector.
        let unknown = ranked.filter { $0.label.caseInsensitiveCompare("Unknown") == .orderedSame }
        let named = ranked.filter { $0.label.caseInsensitiveCompare("Unknown") != .orderedSame }

        var out = named.prefix(topCount).enumerated().map { idx, m in
            // Index-derived id: a repeated label can never collide even if the
            // merge above is ever bypassed.
            SectorFlowRow(id: "\(idx)-\(m.label)", label: m.label, estNetFlowUsd: m.netFlow, isAggregate: false)
        }

        let rest = named.dropFirst(topCount)
        if !rest.isEmpty {
            // Sum only the sectors that reported a figure; if none did, stay an
            // em-dash rather than claiming a $0 net.
            let scored = rest.compactMap(\.netFlow)
            out.append(
                SectorFlowRow(
                    id: "__other__",
                    label: "Other (\(rest.count) \(rest.count == 1 ? "sector" : "sectors"))",
                    estNetFlowUsd: scored.isEmpty ? nil : scored.reduce(0, +),
                    isAggregate: true
                )
            )
        }

        if !unknown.isEmpty {
            let scored = unknown.compactMap(\.netFlow)
            out.append(
                SectorFlowRow(
                    id: "__unknown__",
                    label: "Unknown",
                    estNetFlowUsd: scored.isEmpty ? nil : scored.reduce(0, +),
                    isAggregate: true
                )
            )
        }
        return out
    }
}

enum VolumeChartMetric: String, CaseIterable, Identifiable {
    case count
    case dollars

    var id: String { rawValue }

    var label: String {
        switch self {
        case .count: return "#"
        case .dollars: return "$"
        }
    }
}

struct TrendKPI: View {
    let title: String
    let value: String
    var tint: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Text(value)
                .font(.headline.weight(.bold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
        .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct LatencyComparisonView: View {
    let summary: LatencySummary
    let minMatched = 2

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Speed vs. Data Providers")
                .font(.headline)
                .padding(.top, 10)
            Text("Live new imports only (seed/historical backfills excluded). Matched against provider feeds even if the gap is minutes or up to about two weeks either way.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let scope = summary.matchedOfTotal {
                Text("\(scope.matched) of \(scope.total) matched")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
            }

            let sortedProviders = summary.providers.sorted { $0.matched > $1.matched }

            ForEach(sortedProviders) { provider in
                ProviderScorecard(provider: provider, minMatched: minMatched)
            }
        }
    }
}

/// Presentation for one provider scorecard.
///
/// Sign convention matches web (`dashboardHtml.ts` leadDirection): positive
/// seconds means Congress.Trade published first (we were earlier).  The
/// headline is the median so one freak race cannot flip the direction the
/// way the mean did (FMP live 2026-08-16: median 13.0h earlier, average
/// 4.6d later).  Colour + wording only — earlier is green, later is red.
/// Do not print + or −; the word is the sign.
enum LatencyScorecardCopy {
    enum Direction: Equatable {
        case ahead, behind, even
    }

    /// Public Delivery + Trends-link gate: hide when we are behind on most
    /// usable providers (median and average must agree). Matches web
    /// `isLatencyAhead()`.
    static func isPubliclyVisible(_ summary: LatencySummary, minMatched: Int = 2) -> Bool {
        var ahead = 0
        var behind = 0
        for provider in summary.providers {
            let snap = snapshot(for: provider, minMatched: minMatched)
            let usable = (provider.comparisonStatus ?? "") == "usable"
            guard snap.hasStats, usable else { continue }
            switch snap.verdict {
            case .lead: ahead += 1
            case .lag: behind += 1
            default: break
            }
        }
        let voted = ahead + behind
        return voted > 0 && behind <= ahead
    }

    enum Verdict: Equatable {
        case lead, lag, even, mixed
    }

    struct Snapshot: Equatable {
        var hasStats: Bool
        var headlineText: String
        var headlineSec: Int?
        var direction: Direction
        var verdict: Verdict
        var badgeText: String
        var basisLabel: String
        var winPct: Int
        var averageDisagrees: Bool
        var averageCaption: String?
        var averageSec: Int?
    }

    static func formatMagnitude(_ secs: Int?) -> String {
        guard let s = secs else { return "—" }
        let absS = abs(Double(s))
        if absS < 90 { return "\(Int(round(absS)))s" }
        if absS < 5400 { return "\(Int(round(absS / 60)))m" }
        if absS < 172800 { return String(format: "%.1fh", absS / 3600) }
        return String(format: "%.1fd", absS / 86400)
    }

    static func formatLead(_ secs: Int?) -> String {
        guard secs != nil else { return "—" }
        let mag = formatMagnitude(secs)
        switch direction(of: secs) {
        case .ahead: return "\(mag) earlier"
        case .behind: return "\(mag) later"
        case .even: return "even"
        }
    }

    static func direction(of secs: Int?) -> Direction {
        guard let s = secs, s != 0 else { return .even }
        return s > 0 ? .ahead : .behind
    }

    static func snapshot(for provider: LatencyProvider, minMatched: Int = 2) -> Snapshot {
        let status = provider.comparisonStatus ?? "insufficient"
        let usable = status == "usable"
        let preliminary = status == "preliminary"
        let wins = provider.usFirstCount
        let losses = provider.providerFirstCount
        let ties = provider.tieCount
        let deltaSample = wins + losses + ties
        let headlineSec = provider.medianLeadSec ?? provider.avgLeadSec
        let hasLead = headlineSec != nil
        let hasTiming = provider.matched >= minMatched && deltaSample > 0 && hasLead
        let hasStats = hasTiming && (usable || preliminary)
        let direction = Self.direction(of: headlineSec)
        let avgDir = Self.direction(of: provider.avgLeadSec)
        let verdict: Verdict = {
            guard hasStats else { return .mixed }
            let other = provider.avgLeadSec == nil ? direction : avgDir
            if direction == other {
                switch direction {
                case .ahead: return .lead
                case .behind: return .lag
                case .even: return .even
                }
            }
            return .mixed
        }()
        let winPct = provider.matched > 0
            ? Int(round(100.0 * Double(wins) / Double(provider.matched)))
            : 0

        let badgeText: String
        if !hasStats {
            badgeText = (provider.matched >= minMatched && !usable) ? "Coverage limited" : "Gathering"
        } else {
            switch verdict {
            case .lead: badgeText = "Lead"
            case .lag: badgeText = "Lag"
            case .even: badgeText = "Even"
            case .mixed: badgeText = "Mixed"
            }
        }

        let word = direction == .behind ? "later" : (direction == .even ? "even" : "earlier")
        let basisLabel: String
        if !hasStats {
            basisLabel = ""
        } else if direction == .even {
            basisLabel = "typical even"
        } else {
            basisLabel = preliminary && verdict == .mixed
                ? "typical \(word) (coverage still building)"
                : "typical \(word)"
        }

        let averageDisagrees = hasStats
            && provider.avgLeadSec != nil
            && provider.medianLeadSec != nil
            && avgDir != direction
            && avgDir != .even
            && direction != .even
        let averageCaption: String? = {
            guard hasStats, provider.avgLeadSec != nil else { return nil }
            if provider.medianLeadSec != nil && provider.avgLeadSec == provider.medianLeadSec {
                return nil
            }
            if averageDisagrees {
                return "Average \(formatLead(provider.avgLeadSec)) — a few outlier races pull it the other way."
            }
            return "Average \(formatLead(provider.avgLeadSec))"
        }()

        return Snapshot(
            hasStats: hasStats,
            headlineText: formatLead(headlineSec),
            headlineSec: headlineSec,
            direction: direction,
            verdict: verdict,
            badgeText: badgeText,
            basisLabel: basisLabel,
            winPct: winPct,
            averageDisagrees: averageDisagrees,
            averageCaption: averageCaption,
            averageSec: provider.avgLeadSec
        )
    }

    static func leadColor(_ direction: Direction) -> Color {
        switch direction {
        case .ahead: return AppTheme.semanticPositive
        case .behind: return AppTheme.semanticNegative
        case .even: return .primary
        }
    }

    /// Colour the whole "13.1h later" phrase — not just the word.  Tint-only
    /// on "later" left the magnitude gray, which is what the owner still saw.
    static func coloredLead(_ secs: Int?, base: Color = .primary) -> Text {
        let dir = direction(of: secs)
        let color = dir == .even ? base : leadColor(dir)
        return Text(formatLead(secs)).foregroundColor(color).fontWeight(dir == .even ? .regular : .semibold)
    }

    static func coloredDirectionWords(_ text: String, base: Color = .secondary) -> Text {
        let tokens = text.split(separator: " ", omittingEmptySubsequences: false)
        return tokens.enumerated().reduce(Text("")) { acc, item in
            let (idx, raw) = item
            let token = String(raw)
            let stem = token.lowercased().trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
            let piece: Text
            if stem == "earlier" || stem == "lead" {
                piece = Text(token).foregroundColor(AppTheme.semanticPositive).fontWeight(.semibold)
            } else if stem == "later" || stem == "lag" {
                piece = Text(token).foregroundColor(AppTheme.semanticNegative).fontWeight(.semibold)
            } else {
                piece = Text(token).foregroundColor(base)
            }
            return idx == 0 ? acc + piece : acc + Text(" ") + piece
        }
    }
}

struct ProviderScorecard: View {
    let provider: LatencyProvider
    let minMatched: Int

    var body: some View {
        let snap = LatencyScorecardCopy.snapshot(for: provider, minMatched: minMatched)
        let hasLead = provider.avgLeadSec != nil || provider.medianLeadSec != nil

        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(provider.label)
                    .font(.subheadline.weight(.bold))
                Spacer()
                badge(snap.badgeText, kind: badgeKind(snap: snap))
            }

            if snap.hasStats {
                HStack(alignment: .firstTextBaseline) {
                    LatencyScorecardCopy.coloredLead(snap.headlineSec, base: .primary)
                        .font(.title3.weight(.bold))
                    LatencyScorecardCopy.coloredDirectionWords(snap.basisLabel)
                        .font(.caption)
                    Spacer()
                    Text("\(snap.winPct)% win")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                if snap.averageCaption != nil, let avgSec = snap.averageSec {
                    (Text("Average ")
                        .foregroundColor(.secondary)
                     + LatencyScorecardCopy.coloredLead(avgSec, base: .secondary)
                     + Text(snap.averageDisagrees
                            ? " — a few outlier races pull it the other way."
                            : "")
                        .foregroundColor(.secondary))
                    .font(.caption2)
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
        .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
    }

    private enum BadgeKind { case mixed, ahead, behind, muted }

    private func badgeKind(snap: LatencyScorecardCopy.Snapshot) -> BadgeKind {
        if !snap.hasStats { return .muted }
        switch snap.verdict {
        case .lead: return .ahead
        case .lag: return .behind
        case .even: return .muted
        case .mixed: return .mixed
        }
    }

    private func badge(_ text: String, kind: BadgeKind) -> some View {
        let bg: Color
        let fg: Color
        switch kind {
        case .mixed:
            bg = Color.orange.opacity(0.15)
            fg = AppTheme.semanticCaution
        case .ahead:
            bg = AppTheme.semanticPositive.opacity(0.2)
            fg = AppTheme.semanticPositive
        case .behind:
            bg = AppTheme.semanticNegative.opacity(0.2)
            fg = AppTheme.semanticNegative
        case .muted:
            bg = Color.gray.opacity(0.2)
            fg = Color.secondary
        }
        return Text(text)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(bg).foregroundStyle(fg).clipShape(Capsule())
    }
}
