import SwiftUI
import SwiftData

struct PoliticianDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: CongressTradeStore
    
    let memberId: String
    let memberName: String
    /// Roster / trade-row photo already on screen. Shown immediately so the
    /// sheet never flashes a party mascot while `/member/:id` loads, and used
    /// as fallback when that envelope omits `photoUrl`.
    var seedPhotoUrl: String? = nil
    
    @State private var isLoading = true
    @State private var member: ClientTrade.Member?
    @State private var summary: ClientMemberResponse.MemberSummary?
    @State private var trades: [ClientTrade] = []
    @State private var error: String?

    private var resolvedPhotoURL: URL? {
        MemberPhotoURL.resolve(
            member?.photoUrl,
            seedPhotoUrl,
            store.members.first(where: { $0.filerId == memberId })?.photoUrl
        )
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if isLoading {
                        VStack(spacing: 12) {
                            MemberAvatar(
                                photoURL: resolvedPhotoURL,
                                name: memberName,
                                size: 80
                            )
                            ProgressView("Loading \(memberName)…")
                        }
                        .padding(.top, 24)
                    } else if let error = error {
                        ContentUnavailableView("Error", systemImage: "exclamationmark.triangle", description: Text(error))
                    } else if let member = member {
                        // Header
                        VStack(spacing: 12) {
                            MemberAvatar(
                                photoURL: resolvedPhotoURL,
                                name: member.name ?? memberName,
                                size: 80
                            )
                            
                            VStack(spacing: 4) {
                                Text(member.name ?? memberName)
                                    .font(.title2.weight(.bold))
                                
                                Text([
                                    member.chamber?.chamberLabel(title: member.title),
                                    Self.partyDisplayLabel(member.party),
                                    member.state,
                                ].compactMap { $0 }.joined(separator: " · "))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                
                                // Matches on `filerId` and shows committee NAMES.
                                // `bioguideId`/`committeeCode` never existed on
                                // this endpoint — the model invented them, so
                                // every decode threw and `store.conflicts` was
                                // permanently empty; this filter has been
                                // matching against nothing since it was written.
                                let memberConflicts = store.conflicts.filter { $0.filerId == memberId }
                                let committees = Array(Set(memberConflicts.flatMap { $0.committees })).sorted()
                                if !committees.isEmpty {
                                    HStack {
                                        ForEach(committees, id: \.self) { name in
                                            StatusPill(text: name, color: .orange, icon: "exclamationmark.triangle.fill", compact: true)
                                        }
                                    }
                                    .padding(.top, 4)
                                }
                            }
                        }
                        .padding(.top, 16)

                        DetailSection("Committees") {
                            if let committees = member.committees, !committees.isEmpty {
                                VStack(alignment: .leading, spacing: 6) {
                                    ForEach(Array(committees.enumerated()), id: \.offset) { _, name in
                                        Text(name)
                                            .font(.caption.weight(.semibold))
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 4)
                                            .background(AppTheme.panel, in: Capsule())
                                            .overlay(
                                                Capsule().stroke(AppTheme.borderColor.opacity(0.55), lineWidth: 1)
                                            )
                                    }
                                }
                            } else if isExecutiveChamber(member.chamber) {
                                Text("Executive filers do not sit on congressional committees.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            } else {
                                Text("No current assignments on file.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        
                        // Performance: dual anchors when backend provides them
                        if let perf = summary?.performance {
                            DetailSection("Performance vs S&P 500") {
                                if let trade = perf.tradeDate, trade.scoredCount > 0 {
                                    performanceLegBlock(
                                        title: "Their timing (approx.)",
                                        leg: trade,
                                        matchesTopPerformers: false
                                    )
                                } else if perf.scoredCount > 0 {
                                    // Legacy flat trade-date payload
                                    HStack(spacing: 12) {
                                        MetricTile(title: "Win Rate", value: perf.winRate != nil ? String(format: "%.0f%%", perf.winRate! * 100) : "N/A")
                                        MetricTile(title: "Avg Excess", value: perf.avgExcess != nil ? String(format: "%+.1f%%", perf.avgExcess! * 100) : "N/A")
                                        MetricTile(title: "Median Return", value: perf.medianReturn != nil ? String(format: "%+.1f%%", perf.medianReturn! * 100) : "N/A")
                                    }
                                    Text("Based on \(perf.scoredCount) scored buys out of \(perf.tradeCount).")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }

                                if let filing = perf.filingDate, filing.scoredCount > 0 {
                                    performanceLegBlock(
                                        title: "If you bought at filing",
                                        leg: filing,
                                        matchesTopPerformers: true
                                    )
                                }

                                Text("Buys only · observational, not portfolio P&L or a forecast.")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
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

                            if let polName = member.name, !polName.isEmpty, polName != "Unknown" {
                                SeeAllTradesHandoff(
                                    totalTrades: summary?.totalTrades ?? 0,
                                    displayedCount: trades.count,
                                    filter: .politician(polName)
                                )
                            }
                        }
                    }
                }
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle(memberName)
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    if let shareURL = store.api.shareURL(queryItem: URLQueryItem(name: "member", value: memberId)) {
                        ShareLink(item: shareURL) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("Share politician")
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
                await loadProfile()
            }
        }
    }
    
    /// One anchor leg of the buys-only skill aggregate.
    ///
    /// `matchesTopPerformers` marks the FILING-date leg, the only one whose
    /// Avg Excess is the same statistic the Top Performers board ranks and
    /// prints (`GET /member-performance` → `avgExcessReturn`; see the anchor
    /// note in `app/src/analytics/routes.ts`). The annualized figure that used
    /// to be captioned "matches Top Performers" here never did — the backend
    /// keeps `avgAnnualizedExcess` for reference/debugging only, because a
    /// young trade's ~12x annualization multiplier made it misleading as a
    /// headline. It is gone rather than relabelled: the honest number is
    /// already the tile above, so restating it would just be a second copy.
    @ViewBuilder
    private func performanceLegBlock(
        title: String,
        leg: ClientMemberResponse.PerformanceLeg,
        matchesTopPerformers: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            HStack(spacing: 12) {
                MetricTile(
                    title: "Avg Excess",
                    value: leg.avgExcess != nil ? String(format: "%+.1f%%", leg.avgExcess! * 100) : "N/A"
                )
                MetricTile(
                    title: "Win Rate",
                    value: leg.winRate != nil ? String(format: "%.0f%%", leg.winRate! * 100) : "N/A"
                )
                MetricTile(
                    title: "Median Excess",
                    value: leg.medianExcess != nil ? String(format: "%+.1f%%", leg.medianExcess! * 100) : "N/A"
                )
            }
            Text(matchesTopPerformers
                 ? "Variable hold.  Each buy from the public filing date through the latest price.  Avg excess is versus the index; avg return is the asset alone."
                 : "Variable hold.  Each buy from the trade date through the latest price.  Avg excess is versus the index; avg return is the asset alone.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if matchesTopPerformers, leg.avgExcess != nil {
                Text("Avg Excess is the statistic Top Performers ranks by.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text("\(leg.scoredCount) of \(leg.tradeCount) buys scored")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func loadProfile() async {
        isLoading = true
        error = nil
        do {
            let response = try await fetchMember()
            if Task.isCancelled { return }
            self.member = response.member
            self.summary = response.summary
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

    private func isExecutiveChamber(_ chamber: String?) -> Bool {
        guard let chamber else { return false }
        let lowered = chamber.lowercased()
        return lowered == "executive" || lowered == "oge" || lowered.contains("exec")
    }

    private func fetchMember() async throws -> ClientMemberResponse {
        do {
            return try await store.fetchMember(id: memberId)
        } catch let error as APIError where error.isRetryable {
            try await Task.sleep(for: .milliseconds(400))
            return try await store.fetchMember(id: memberId)
        }
    }

    /// `GET /member/:id` returns `party` as a single letter ("R"/"D"), while
    /// the Directory roster and every trade-row member embed return the full
    /// word ("Republican"/"Democrat") — without this the header here read
    /// "Executive · R" next to a Directory row reading "Executive ·
    /// Republican" for the same politician (iPad audit P1-4).
    private static func partyDisplayLabel(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        switch raw.uppercased() {
        case "D": return "Democrat"
        case "R": return "Republican"
        default: return raw
        }
    }
}