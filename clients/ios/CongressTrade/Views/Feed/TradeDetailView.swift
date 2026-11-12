import QuickLook
import SwiftUI

struct TradeDetailView: View {
    let trade: ClientTrade
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.openPremium) private var openPremium
    @State private var didCheckRetraction = false
    @State private var performance: TradePerformanceResponse?
    @State private var performanceLoaded = false
    @State private var performanceFailed = false
    @State private var performanceTask: Task<Void, Never>?
    @State private var showPremiumSheet = false
    @State private var pdfPreview: IdentifiedFileURL?
    @State private var pdfBusy = false
    @State private var pdfError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Hero Header — company name + chevron link like politician
                    VStack(alignment: .center, spacing: 12) {
                        AssetMark(
                            symbol: trade.asset.displayName,
                            isTicker: hasResolvedTicker
                        )
                        .scaleEffect(1.3)
                        .padding(.bottom, 8)

                        companyTitle

                        StatusPill(
                            text: trade.transaction.type.label,
                            color: trade.transaction.type.tint,
                            icon: (trade.transaction.type == "B" || trade.transaction.type == "P")
                                ? "arrow.down.right.circle.fill"
                                : (trade.transaction.type == "S"
                                    ? "arrow.up.right.circle.fill"
                                    : "arrow.left.and.right.circle.fill")
                        )
                        .padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 32)
                    .background(
                        LinearGradient(
                            colors: [chamberGradient.opacity(0.2), AppTheme.background],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )

                    VStack(spacing: 16) {
                        DetailSection("Trade Summary") {
                            if let memberId = trade.member.id {
                                linkedDetailRow("Politician", politicianValue) {
                                    PoliticianDetailView(
                                        memberId: memberId,
                                        memberName: trade.member.name ?? "Unknown",
                                        seedPhotoUrl: trade.member.photoUrl
                                    )
                                }
                            } else {
                                DetailRow("Politician", politicianValue)
                            }

                            DetailRow("Amount", trade.amountLabel)
                            DetailRow("Owner", trade.transaction.owner?.capitalized ?? "Unavailable")
                            DetailRow("Confidence", "\(Int(((trade.confidence ?? 1.0) * 100).rounded()))%")
                        }

                        // Hidden outright without a resolved ticker: the empty
                        // state used to promise prices "when market data is
                        // available", which for a ticker-less row is never.
                        if hasResolvedTicker {
                            performanceSection
                        }

                        // TODO(ios): dual-axis chart S&P vs stock since filing when
                        // a lightweight Charts series endpoint is available.

                        DetailSection("Timeline") {
                            DetailRow("Traded", trade.transaction.date.longDate)
                            DetailRow("Filed", trade.filing.filedDate.longDate)
                            DetailRow("Discovered", trade.filing.firstSeenAt.longDate)
                        }

                        DetailSection("Company Info") {
                            if hasResolvedTicker, let ticker = trade.asset.ticker {
                                linkedDetailRow("Asset", trade.asset.displayName) {
                                    TickerDetailView(ticker: ticker)
                                }
                            } else {
                                DetailRow("Asset", trade.asset.displayName)
                            }
                            DetailRow("Sector", trade.asset.sector ?? "Not Enriched Yet")
                            DetailRow("Market Cap", trade.asset.marketCapBucket?.capBucketLabel ?? "Not Enriched Yet")
                        }

                        filingButtons
                        if let pdfError {
                            Text(pdfError)
                                .font(.caption)
                                .foregroundStyle(.red)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            .background(AppTheme.background)
            .navigationTitle("Trade Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let shareURL = store.api.shareURL(queryItem: URLQueryItem(name: "trade", value: trade.id)) {
                    ToolbarItem(placement: AppToolbarPlacement.trailing) {
                        ShareLink(item: shareURL) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("Share trade")
                    }
                }
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .sheet(isPresented: $showPremiumSheet) {
            PremiumSheet()
                .environmentObject(store)
        }
        .sheet(item: $pdfPreview) { item in
            FilingPDFQuickLook(url: item.url)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        // Without this, a drag starting inside the body `ScrollView` never
        // reaches the detent-resize recognizer, so dragging the grabber up
        // to `.large` silently does nothing (iPad audit P2-1) — this makes
        // the same upward drag resize the sheet once its scroll view is
        // already at the top, matching Apple's own apps.
        .presentationContentInteraction(.resizes)
        .iPadFullWidthSheet()
        .task {
            // The feed never re-announces a row it already served once it's
            // retracted (see app/docs/client-mobile-api.md); reconcile this
            // cached copy against `GET /trade/:id` on open so a stale,
            // retracted disclosure doesn't linger silently. CT-AUD-009.
            guard !didCheckRetraction else { return }
            didCheckRetraction = true
            if await store.reconcileIfDeprecated(trade) {
                dismiss()
            }
        }
        .task(id: trade.id) {
            await loadPerformance()
        }
        .onDisappear {
            performanceTask?.cancel()
        }
    }

    /// Party mark + name as ONE value string so the row can go through the
    /// shared `DetailRow` — the emoji is decoration on the name, not a column.
    private var politicianValue: String {
        [trade.member.party?.partyEmoji ?? "", trade.member.name ?? "Unknown"]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// A ledger row that navigates.
    ///
    /// The label/value geometry is deliberately NOT re-implemented here: it
    /// delegates to the shared `DetailRow` so a linked row lines up exactly
    /// with the plain rows above and below it in the same section. Hand-rolled
    /// copies of the row (which is what these two call sites used to be) are
    /// precisely how the linked and unlinked rows drifted apart. The chevron
    /// rides the trailing edge — the standard iOS disclosure position — rather
    /// than trailing the value, so it never competes with the value column.
    @ViewBuilder
    private func linkedDetailRow<Destination: View>(
        _ label: String,
        _ value: String,
        @ViewBuilder destination: () -> Destination
    ) -> some View {
        NavigationLink(destination: destination()) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                DetailRow(label, value)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label): \(value)")
        .accessibilityAddTraits(.isButton)
    }

    /// Mirrors `TICKER_RESOLVED_SQL` (`app/src/analytics/sql.ts`): client rows
    /// are a raw passthrough of `transactions.ticker`, so the sentinels the
    /// analytics layer excludes ("NONE", "--", "N/A", "NA", "NULL", "—") arrive
    /// here verbatim and must be treated as "no ticker", not as a symbol.
    private var hasResolvedTicker: Bool {
        Self.isResolvedTicker(trade.asset.ticker)
    }

    static func isResolvedTicker(_ raw: String?) -> Bool {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else { return false }
        return !["NONE", "--", "N/A", "NA", "NULL", "—"].contains(trimmed.uppercased())
    }

    /// Company name at top with ">" link like politician when a ticker exists.
    @ViewBuilder
    private var companyTitle: some View {
        let display = trade.asset.displayName
        let companyName: String? = {
            guard let name = trade.asset.name, !name.isEmpty, name != trade.asset.ticker else { return nil }
            return name
        }()

        if hasResolvedTicker, let ticker = trade.asset.ticker {
            NavigationLink(destination: TickerDetailView(ticker: ticker)) {
                HStack(spacing: 6) {
                    Text(display)
                        .font(.largeTitle.weight(.heavy))
                        .multilineTextAlignment(.center)
                    Image(systemName: "chevron.right")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("View \(display) trades")

            if let companyName {
                Text(companyName)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        } else {
            Text(display)
                .font(.largeTitle.weight(.heavy))
                .multilineTextAlignment(.center)
            if let companyName {
                Text(companyName)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    /// Archived Filing PDF is Premium and stays in-app (Bearer + QuickLook).
    /// Source Filing is the public government URL and stays ungated.
    @ViewBuilder
    private var filingButtons: some View {
        let hasArchivedPDF = !(trade.docId ?? "").isEmpty
        let sourceURL: URL? = {
            guard let raw = trade.filing.sourceUrl,
                  let url = URL(string: raw),
                  url.scheme == "https" || url.scheme == "http" else { return nil }
            return url
        }()

        if hasArchivedPDF || sourceURL != nil {
            HStack(spacing: 10) {
                if hasArchivedPDF {
                    Button {
                        openArchivedFilingPDF()
                    } label: {
                        HStack {
                            if pdfBusy {
                                ProgressView()
                                    .controlSize(.small)
                            }
                            Label("Filing PDF", systemImage: "doc.richtext")
                        }
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                    }
                    .buttonStyle(.bordered)
                    .tint(chamberGradient.opacity(0.85))
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .disabled(pdfBusy)
                }

                if let sourceURL {
                    Button {
                        openURL(sourceURL)
                    } label: {
                        Label("Source Filing", systemImage: "doc.text.magnifyingglass")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.bordered)
                    .tint(chamberGradient.opacity(0.85))
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }
            }
            .padding(.top, 8)
        }
    }

    private func openArchivedFilingPDF() {
        pdfError = nil
        // Guideline 5.1.1(v): the filing PDF is content, not account-specific
        // functionality — a signed-out device with its own Apple purchase
        // fetches it in-app the same way a signed-in Premium session does
        // (APIClient attaches the cached device entitlement token). Signed
        // in, `premiumFeatureAccess` additionally excludes a device purchase
        // already linked to a DIFFERENT account.
        switch FilingPDFAccess.action(isPremium: store.premiumFeatureAccess) {
        case .showPremiumSheet:
            if let openPremium {
                openPremium()
            } else {
                showPremiumSheet = true
            }
        case .fetchInApp:
            Task { await loadArchivedFilingPDF() }
        }
    }

    private func loadArchivedFilingPDF() async {
        guard let docId = trade.docId, !docId.isEmpty else { return }
        await MainActor.run { pdfBusy = true }
        defer { Task { @MainActor in pdfBusy = false } }
        do {
            let fetched = try await store.api.fetchDocumentPDF(docId: docId)
            let fileURL = try store.api.writeDocumentPDFPreviewFile(
                docId: docId,
                data: fetched.data,
                contentType: fetched.contentType
            )
            await MainActor.run { pdfPreview = IdentifiedFileURL(url: fileURL) }
        } catch let error as APIError {
            if case .server(let status, _, _) = error, status == 402 {
                await MainActor.run {
                    if let openPremium {
                        openPremium()
                    } else {
                        showPremiumSheet = true
                    }
                }
                return
            }
            await MainActor.run { pdfError = error.errorDescription ?? "Could not open the filing PDF." }
        } catch {
            await MainActor.run { pdfError = "Could not open the filing PDF." }
        }
    }

    @ViewBuilder
    private var performanceSection: some View {
        DetailSection("Performance vs S&P 500") {
            if !performanceLoaded {
                HStack {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading returns…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if let perf = performance, perf.available, let leg = perf.tradeLeg {
                let isSell = (perf.txType ?? trade.transaction.type) == "S"
                let sinceLabel = isSell ? "Since sold" : "Since traded"
                let politician = trade.member.name ?? "Politician"
                let asset = perf.ticker ?? trade.asset.displayName

                Text("\(politician) · \(asset)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                HStack(spacing: 12) {
                    MetricTile(
                        title: sinceLabel,
                        value: Self.formatSignedPct(leg.assetReturn)
                    )
                    MetricTile(
                        title: "S&P 500",
                        value: Self.formatSignedPct(leg.spxReturn)
                    )
                    MetricTile(
                        title: "Excess",
                        value: Self.formatSignedPct(leg.excessReturn)
                    )
                }

                if let filing = perf.filingDatePerformance,
                   filing.assetReturn != nil || filing.excessReturn != nil {
                    let filingLabel = isSell ? "Since reported" : "Since filing"
                    VStack(alignment: .leading, spacing: 8) {
                        Text(filingLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        HStack(spacing: 12) {
                            MetricTile(
                                title: "Return",
                                value: Self.formatSignedPct(filing.assetReturn)
                            )
                            MetricTile(
                                title: "S&P 500",
                                value: Self.formatSignedPct(filing.spxReturn)
                            )
                            MetricTile(
                                title: "Excess",
                                value: Self.formatSignedPct(filing.excessReturn)
                            )
                        }
                    }
                    .padding(.top, 4)
                }

                if let from = perf.priceAtTrade ?? leg.priceAt, let to = perf.currentPrice {
                    let dateSuffix = perf.currentPriceDate.map { " (\($0))" } ?? ""
                    Text(String(format: "$%.2f → $%.2f%@", from, to, dateSuffix))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text("Observational price change for this politician’s trade, not portfolio P&L. Options are excluded.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if performance?.isOption == true {
                Text("Performance isn’t shown for options — return depends on strike, expiry, and exercise, which the filing doesn’t disclose.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Text(
                    performanceFailed
                        ? "Couldn’t load performance for this trade (timed out or market data unavailable)."
                        : "Price & performance vs the S&P 500 will appear when market data is available for this ticker."
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
        }
    }

    private func loadPerformance() async {
        performanceTask?.cancel()
        performanceLoaded = false
        performanceFailed = false
        performance = nil
        // No resolved ticker means no price series will ever exist for this
        // row, and the section is hidden — don't spend a round trip proving it.
        guard hasResolvedTicker else { return }
        let txId = trade.id
        let task = Task {
            do {
                // Bounded timeout avoids CSCO / thin-history hangs hanging the sheet.
                let result = try await store.api.tradePerformance(txId: txId, timeout: 12)
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    performance = result
                    performanceFailed = false
                    performanceLoaded = true
                }
            } catch {
                guard !Task.isCancelled else { return }
                if let apiError = error as? APIError, apiError.isCancellation {
                    await MainActor.run {
                        performanceLoaded = true
                        performanceFailed = false
                    }
                    return
                }
                await MainActor.run {
                    performance = nil
                    performanceFailed = true
                    performanceLoaded = true
                }
            }
        }
        performanceTask = task
        await task.value
    }

    private static func formatSignedPct(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(format: "%+.1f%%", value * 100)
    }

    private var chamberGradient: Color {
        let chamber = trade.member.chamber?.lowercased() ?? ""
        if chamber == "house" { return AppTheme.houseColor }
        if chamber == "senate" { return AppTheme.senateColor }
        if chamber == "executive" { return AppTheme.execColor }
        return .blue
    }
}

private struct IdentifiedFileURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

struct FilingPDFQuickLook: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator(url: url)
    }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: QLPreviewController, context: Context) {
        context.coordinator.url = url
        uiViewController.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
            url as QLPreviewItem
        }
    }
}

struct FilingPDFSheet: View {
    let docId: String
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openPremium) private var openPremium
    @State private var fileURL: URL?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showPremiumSheet = false

    var body: some View {
        NavigationStack {
            Group {
                if let fileURL {
                    FilingPDFQuickLook(url: fileURL)
                } else if isLoading {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Loading filing PDF…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage {
                    ContentUnavailableView {
                        Label("Could Not Load Filing", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("Retry") {
                            Task { await loadPDF() }
                        }
                    }
                }
            }
            .background(AppTheme.background)
            .navigationTitle("Filing PDF")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .sheet(isPresented: $showPremiumSheet) {
            PremiumSheet()
                .environmentObject(store)
        }
        .task {
            await loadPDF()
        }
    }

    private func loadPDF() async {
        let cleanDocId = docId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanDocId.isEmpty else {
            errorMessage = "Invalid document ID."
            isLoading = false
            return
        }
        isLoading = true
        errorMessage = nil

        switch FilingPDFAccess.action(isPremium: store.premiumFeatureAccess) {
        case .showPremiumSheet:
            isLoading = false
            if let openPremium {
                openPremium()
            } else {
                showPremiumSheet = true
            }
        case .fetchInApp:
            do {
                let fetched = try await store.api.fetchDocumentPDF(docId: cleanDocId)
                let url = try store.api.writeDocumentPDFPreviewFile(
                    docId: cleanDocId,
                    data: fetched.data,
                    contentType: fetched.contentType
                )
                await MainActor.run {
                    fileURL = url
                    isLoading = false
                }
            } catch let error as APIError {
                await MainActor.run {
                    isLoading = false
                    if case .server(let status, _, _) = error, status == 402 {
                        if let openPremium {
                            openPremium()
                        } else {
                            showPremiumSheet = true
                        }
                    } else {
                        errorMessage = error.errorDescription ?? "Could not open the filing PDF."
                    }
                }
            } catch {
                await MainActor.run {
                    isLoading = false
                    errorMessage = "Could not open the filing PDF."
                }
            }
        }
    }
}

/// `securities_ref.market_cap_bucket` is a storage enum (`mega`…`nano`), not a
/// label — `.capitalized` shipped a bare "Mega" to the sheet. Same vocabulary
/// and wording as the web board's `CAP_NAMES` (`app/src/ui/dashboardHtml.ts`).
/// Deliberately fileprivate: the shared labeler is another lane's file.
private extension String {
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
}
