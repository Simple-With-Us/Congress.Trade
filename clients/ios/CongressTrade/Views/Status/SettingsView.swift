import SwiftUI
import AuthenticationServices

/// Holds the in-flight Google OAuth session.
///
/// `ASWebAuthenticationSession` cancels as soon as the last strong reference
/// drops.  A local in `SignInPanel.startGoogleSignIn` is not enough: the
/// session must be held until the callback fires, or
/// `SFAuthenticationViewController` deallocates while loading its first view.
@MainActor
enum GoogleAuthSession {
    static var current: ASWebAuthenticationSession?
}

/// Presentation anchor for `ASWebAuthenticationSession` (the Google OAuth hop).
/// The session itself lives in `SignInPanel` (Components.swift) — this stays
/// here because it is the app's one window-anchor provider and has no other
/// home.
class AuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AuthPresentationContext()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let activeScene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
        if let scene = activeScene {
            // Prefer the key window, then any visible normal-level window.
            // On iPad a sheet can be frontmost while `isKeyWindow` is still
            // false for the hosting window — falling through to an empty
            // `ASPresentationAnchor()` made Google sign-in look hung.
            if let window = scene.windows.first(where: { $0.isKeyWindow }) {
                return window
            }
            if let window = scene.windows.first(where: { $0.windowLevel == .normal && !$0.isHidden }) {
                return window
            }
            if let window = scene.windows.first {
                return window
            }
        }
        if let window = scenes.flatMap(\.windows).first(where: { $0.isKeyWindow }) {
            return window
        }
        if let window = scenes.flatMap(\.windows).first {
            return window
        }
        return ASPresentationAnchor()
    }
}

/// Settings is deliberately short: an account, a switch, a theme, the legal
/// row. Sign-in, alerts and Premium are all shared components (`SignInPanel`,
/// `TradeDisclosureAlertsToggle`, `PremiumSheet`) so this view and the
/// header account sheet cannot drift apart again.
///
/// NOTE: no longer mounted as a tab — `AccountQuickMenu` (the header hamburger
/// sheet) is a strict superset of this screen and is the single account
/// surface. Kept because it is built entirely from those shared components, so
/// it costs nothing to keep in sync; `AuthPresentationContext` above is still
/// live and is used by `SignInPanel`'s Google hop.
struct SettingsView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @AppStorage("app_color_scheme") private var appColorScheme = "light"
    @State private var showPremiumInfo = false
    @State private var showDeleteAccountConfirm = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    accountSection
                } footer: {
                    // Keep the notice after delete/sign-out so "Account deleted."
                    // is not hidden by the signed-out SignInPanel.
                    if let notice = store.watchlistNotice, !notice.isEmpty {
                        Text(notice)
                    }
                }

                if store.showsAdminRow {
                    Section {
                        NavigationLink(value: AdminRoute.panel) {
                            Label("Admin", systemImage: "gearshape.2")
                        }
                    }
                }

                Section {
                    TradeDisclosureAlertsToggle()
                }

                Section {
                    // No "Appearance" header, no "Theme" label, no explanation
                    // of what Light/Dark do (owner: "Don't need bunch of words
                    // on that tab").
                    ThemeSegmentControl(selection: $appColorScheme)
                        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                }

                if !store.isPremium {
                    Section {
                        Button {
                            showPremiumInfo = true
                        } label: {
                            Label("Premium", systemImage: "sparkles")
                        }
                    }
                }

                Section {
                    SiteFooterStack()
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .ctThemedForm()
            .modifier(ForcedColorScheme(pref: appColorScheme))
            .modifier(CTPaletteInjector(pref: appColorScheme))
            .navigationTitle("Settings")
            .inlineNavigationTitle()
            .navigationDestination(for: AdminRoute.self) { route in
                switch route {
                case .panel:
                    AdminPanelView()
                case .reviewQueue:
                    ReviewQueueView()
                case .reviewDetail(let docId):
                    ReviewDetailView(docId: docId)
                }
            }
            .environment(\.openPremium) { showPremiumInfo = true }
            .sheet(isPresented: $showPremiumInfo) {
                PremiumSheet()
                    .environmentObject(store)
            }
            .confirmationDialog("Delete Account?", isPresented: $showDeleteAccountConfirm, titleVisibility: .visible) {
                Button("Delete Account", role: .destructive) {
                    Task { await store.deleteAccount() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently deletes your account, delivery subscriptions, and personal information.  Apple subscriptions must also be cancelled in Settings → Apple ID → Subscriptions.  This cannot be undone.")
            }
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        if store.signedIn, let user = store.signedInUser {
            HStack(spacing: 12) {
                if let picture = user.picture, let url = URL(string: picture) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        default:
                            Image(systemName: "person.crop.circle.fill")
                                .resizable()
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(width: 44, height: 44)
                    .clipShape(Circle())
                } else {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(user.name?.isEmpty == false ? user.name! : user.email)
                        .font(.body.weight(.semibold))
                    Text(user.email)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(store.entitlementLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.blue)
                }
            }
            .padding(.vertical, 4)

            Button(role: .destructive) {
                Task { await store.signOut() }
            } label: {
                Label(
                    store.isLoggingOut ? "Signing Out…" : "Sign Out",
                    systemImage: "rectangle.portrait.and.arrow.right"
                )
            }
            .disabled(store.isLoggingOut || store.isDeletingAccount)
            Button(role: .destructive) {
                showDeleteAccountConfirm = true
            } label: {
                Label(
                    store.isDeletingAccount ? "Deleting Account…" : "Delete Account",
                    systemImage: "trash"
                )
            }
            .disabled(store.isLoggingOut || store.isDeletingAccount)
        } else if store.hasStoredSessionToken && !store.signedIn {
            // Token present but bootstrap hasn't resolved a user yet
            // (offline / expired). Offer retry + clear.
            Text("Session could not be verified.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button {
                Task { await store.refresh() }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
            }
            Button(role: .destructive) {
                Task { await store.signOut() }
            } label: {
                Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
            }
            .disabled(store.isLoggingOut)
        } else {
            SignInPanel()
                .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
        }
    }
}

// MARK: - Admin (compiled here so the Xcode target needs no pbxproj edit)

struct AdminPanelView: View {
    @EnvironmentObject private var store: CongressTradeStore

    var body: some View {
        List {
            if let notice = store.adminNotice, !notice.isEmpty, store.adminAccessGranted {
                Section {
                    Text(notice)
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            pipelineSection
            pollingSection
            extractionSection
            haltSection
            marketDataSection
            senateEgressSection
            freshnessSection
            deadLetterSection
            latencySection
            infrastructureSection
            uncoveredPipelineChecksSection

            Section {
                NavigationLink(value: AdminRoute.reviewQueue) {
                    Label("Review Queue", systemImage: "checklist")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(AppTheme.background)
        .navigationTitle("Admin")
        .inlineNavigationTitle()
        .refreshable { await store.refreshAdminSurface() }
        .task { await store.refreshAdminSurface() }
    }

    @ViewBuilder
    private var pipelineSection: some View {
        Section("Pipeline") {
            AdminStatusRow(
                title: "Pipeline Status",
                check: store.publicHealth?.pipeline.map { PipelineCheckProxy(id: "pipeline", status: $0.status, detail: nil, value: nil) }
                    ?? store.publicHealth.map { PipelineCheckProxy(id: "status", status: $0.status, detail: nil, value: nil) }
            )
            if store.isLoadingAdmin && store.publicHealth == nil {
                ProgressView()
            }
        }
    }

    @ViewBuilder
    private var pollingSection: some View {
        Section("Polling Ages") {
            ForEach(["house", "senate", "executive"], id: \.self) { chamber in
                let check = store.publicHealth?.pipeline?.check(id: "polling_\(chamber)")
                    ?? store.pollingHealth?.checks.first { $0.id == "polling_\(chamber)" }
                AdminStatusRow(title: chamber.capitalized, check: check.map(PipelineCheckProxy.init))
            }
        }
    }

    @ViewBuilder
    private var extractionSection: some View {
        let pipeline = store.publicHealth?.pipeline
        let buckets = pipeline?.reviewQueue ?? store.autopilotStatus?.reviewQueue
        Section("Extraction") {
            AdminStatusRow(title: "Extraction Provider", check: pipeline?.check(id: "extraction_provider").map(PipelineCheckProxy.init))
            AdminStatusRow(title: "Extraction Backlog", check: pipeline?.check(id: "extraction_backlog").map(PipelineCheckProxy.init))
            if let buckets {
                LabeledContent("Unresolved") { Text("\(buckets.unresolved)") }
                LabeledContent("Eligible") { Text("\(buckets.eligible)") }
                LabeledContent("Suppressed") { Text("\(buckets.suppressed)") }
                LabeledContent("Terminal") { Text("\(buckets.terminal)") }
            }
            if let today = store.autopilotStatus?.today {
                let spend = today.spendUsd.map { String(format: "$%.2f", $0) } ?? "—"
                let budget = today.budgetUsd.map { String(format: "$%.2f", $0) } ?? "—"
                LabeledContent("Autopilot Spend") { Text("\(spend) of \(budget)") }
            }
        }
    }

    @ViewBuilder
    private var haltSection: some View {
        let halt = store.publicHealth?.pipeline?.check(id: "autopilot_halt")
        let receipt = store.autopilotStatus?.unacknowledgedHalt
        let halted = (halt?.status ?? "ok").lowercased() != "ok" || receipt != nil
        Section("Autopilot Halt") {
            AdminStatusRow(title: "Halt", check: halt.map(PipelineCheckProxy.init))
            if let reason = receipt?.haltReason, !reason.isEmpty {
                Text(reason)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let detail = halt?.detail, !detail.isEmpty {
                Text(detail)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Acknowledge Halt") {
                Task { await store.acknowledgeAutopilotHalt() }
            }
            .disabled(!halted || store.reviewActionDocId != nil)
        }
    }

    @ViewBuilder
    private var marketDataSection: some View {
        let pipeline = store.publicHealth?.pipeline
        Section("Market Data") {
            AdminStatusRow(
                title: "Price / S&P Freshness",
                check: pipeline?.check(id: "price_freshness").map(PipelineCheckProxy.init)
            )
            AdminStatusRow(
                title: "ST → CT Peer Prices",
                check: pipeline?.check(id: "st_peer_prices").map(PipelineCheckProxy.init)
            )
            if let notCovered = pipeline?.check(id: "st_peer_prices")?.notCovered, notCovered > 0 {
                Text("Not covered by ST: \(notCovered)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var senateEgressSection: some View {
        let pipeline = store.publicHealth?.pipeline
        Section("Senate Egress") {
            AdminStatusRow(title: "Residential Proxy", check: pipeline?.check(id: "senate_relay").map(PipelineCheckProxy.init))
            AdminStatusRow(title: "Senate eFD Direct", check: pipeline?.check(id: "senate_efd").map(PipelineCheckProxy.init))
        }
    }

    @ViewBuilder
    private var freshnessSection: some View {
        Section("Data Freshness") {
            AdminStatusRow(
                title: "Latest Transaction",
                check: store.publicHealth?.pipeline?.check(id: "data_freshness").map(PipelineCheckProxy.init)
            )
        }
    }

    @ViewBuilder
    private var infrastructureSection: some View {
        let pipeline = store.publicHealth?.pipeline
        Section("Infrastructure") {
            AdminStatusRow(title: "Ingestion Backlog", check: pipeline?.check(id: "ingestion_backlog").map(PipelineCheckProxy.init))
            AdminStatusRow(title: "Cron Deadline", check: pipeline?.check(id: "cron_deadline").map(PipelineCheckProxy.init))
            AdminStatusRow(title: "Delivery Quarantine", check: pipeline?.check(id: "delivery_quarantine").map(PipelineCheckProxy.init))
            AdminStatusRow(title: "Filing Skips", check: pipeline?.check(id: "filing_skips").map(PipelineCheckProxy.init))
            AdminStatusRow(title: "FMP Latency", check: pipeline?.check(id: "fmp_latency").map(PipelineCheckProxy.init))
            AdminStatusRow(title: "Review Integrity", check: pipeline?.check(id: "review_resolution_integrity").map(PipelineCheckProxy.init))
            AdminStatusRow(title: "Stranded Filings", check: pipeline?.check(id: "stranded_filings").map(PipelineCheckProxy.init))
        }
    }

    private static let pinnedPipelineCheckIds: Set<String> = [
        "polling_house", "polling_senate", "polling_executive", "polling_liveness",
        "extraction_provider", "extraction_backlog", "autopilot_halt",
        "data_freshness", "price_freshness", "st_peer_prices",
        "ingestion_dead_letter", "ingestion_backlog", "cron_deadline", "delivery_quarantine",
        "filing_skips", "fmp_latency", "review_resolution_integrity", "stranded_filings",
        "latency_probes", "senate_relay", "senate_efd",
    ]

    @ViewBuilder
    private var uncoveredPipelineChecksSection: some View {
        let checks = store.publicHealth?.pipeline?.checks.filter {
            !Self.pinnedPipelineCheckIds.contains($0.id)
        } ?? []
        if !checks.isEmpty {
            Section("Other Pipeline Checks") {
                ForEach(checks, id: \.id) { check in
                    AdminStatusRow(title: AdminPipelineCheckTitles.title(for: check.id), check: PipelineCheckProxy(check))
                }
            }
        }
    }

    @ViewBuilder
    private var deadLetterSection: some View {
        Section("Dead Letter") {
            AdminStatusRow(
                title: "Ingestion Dead Letter",
                check: store.publicHealth?.pipeline?.check(id: "ingestion_dead_letter").map(PipelineCheckProxy.init)
            )
        }
    }

    @ViewBuilder
    private var latencySection: some View {
        Section("Latency Probes") {
            AdminStatusRow(
                title: "Latency Probes",
                check: store.publicHealth?.pipeline?.check(id: "latency_probes").map(PipelineCheckProxy.init)
            )
        }
    }
}

private enum AdminPipelineCheckTitles {
    static func title(for id: String) -> String {
        switch id {
        case "st_peer_prices": return "ST → CT Peer Prices"
        case "price_freshness": return "Price / S&P Freshness"
        case "senate_efd": return "Senate eFD Direct"
        case "senate_relay": return "Residential Proxy"
        default:
            return id.split(separator: "_").map { $0.capitalized }.joined(separator: " ")
        }
    }
}

struct PipelineCheckProxy: Hashable {
    let id: String
    let status: String?
    let detail: String?
    let value: Double?

    init(id: String, status: String?, detail: String?, value: Double?) {
        self.id = id
        self.status = status
        self.detail = detail
        self.value = value
    }

    init(_ check: PipelineCheck) {
        self.init(id: check.id, status: check.status, detail: check.detail, value: check.value)
    }
}

struct AdminStatusRow: View {
    let title: String
    let check: PipelineCheckProxy?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                Spacer()
                Text(check?.status.flatMap { PipelineCheck.statusLabel(for: $0) } ?? "—")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AdminStatusRow.color(for: check?.status))
            }
            if let detail = check?.detail, !detail.isEmpty {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    static func color(for status: String?) -> Color {
        switch (status ?? "").lowercased() {
        case "ok": return AppTheme.semanticPositive
        case "degraded": return AppTheme.semanticCaution
        case "stalled", "down": return AppTheme.semanticNegative
        default: return .secondary
        }
    }
}

private extension PipelineCheck {
    static func statusLabel(for status: String) -> String {
        switch status.lowercased() {
        case "ok": return "OK"
        case "degraded": return "Degraded"
        case "stalled": return "Stalled"
        case "unknown": return "Unknown"
        case "down": return "Down"
        default: return status.capitalized
        }
    }
}

struct ReviewQueueView: View {
    @EnvironmentObject private var store: CongressTradeStore

    var body: some View {
        List {
            Section {
                Picker("Queue", selection: Binding(
                    get: { store.reviewQueueShowsResolved },
                    set: { next in Task { await store.refreshReviewQueue(resolved: next) } }
                )) {
                    Text("Pending").tag(false)
                    Text("Reviewed").tag(true)
                }
                .pickerStyle(.segmented)
                if let totals = store.reviewQueueTotals {
                    Text(store.reviewQueueShowsResolved
                         ? "\(totals.matching) reviewed item\(totals.matching == 1 ? "" : "s")."
                         : "\(totals.unresolved) unresolved.  \(totals.matching) match this page.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if store.reviewQueueItems.isEmpty && !store.isLoadingReviewQueue {
                Section {
                    Text(store.reviewQueueShowsResolved
                         ? "No reviewed documents yet."
                         : "Nothing awaiting review.  The queue is clear.")
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(store.reviewQueueItems) { item in
                NavigationLink(value: AdminRoute.reviewDetail(item.docId)) {
                    ReviewQueueRow(item: item)
                }
            }

            if store.reviewQueueNextCursor != nil {
                Section {
                    Button("Load More") {
                        Task { await store.loadMoreReviewQueue() }
                    }
                    .disabled(store.isLoadingReviewQueue)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(AppTheme.background)
        .navigationTitle("Review Queue")
        .inlineNavigationTitle()
        .refreshable { await store.refreshReviewQueue() }
        .task { await store.refreshReviewQueue() }
    }
}

struct ReviewQueueRow: View {
    let item: ReviewQueueItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(item.docId)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer()
                Text((item.status ?? "pending").replacingOccurrences(of: "_", with: " "))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(item.reasonLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                if let chamber = item.chamber, !chamber.isEmpty {
                    Text(chamber.capitalized)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(item.primaryModelLabel)
                    .font(.caption2.weight(.semibold))
                if let createdAt = item.createdAt, !createdAt.isEmpty {
                    Text(createdAt)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct ReviewDetailView: View {
    @EnvironmentObject private var store: CongressTradeStore
    let docId: String
    @State private var confirmRunId: String?
    @State private var showRejectConfirm = false
    @State private var showUnpublishConfirm = false

    private var item: ReviewQueueItem? {
        store.reviewQueueItems.first { $0.docId == docId }
    }

    private var extractions: ReviewExtractionsResponse? {
        store.reviewExtractions[docId]
    }

    var body: some View {
        List {
            if let item {
                Section("Filing") {
                    LabeledContent("Document") { Text(item.docId) }
                    LabeledContent("Status") { Text((item.status ?? "pending").replacingOccurrences(of: "_", with: " ")) }
                    LabeledContent("Chamber") { Text((item.chamber ?? "—").capitalized) }
                    LabeledContent("Kind") { Text(item.docKind ?? "—") }
                    Text(item.reasonLabel)
                        .fixedSize(horizontal: false, vertical: true)
                    if let model = item.models.first {
                        LabeledContent("Model") { Text(model.displayName) }
                    }
                }

                if !item.queuedRows.isEmpty {
                    Section("Queued Rows") {
                        ForEach(Array(item.queuedRows.enumerated()), id: \.offset) { _, row in
                            ReviewExtractedRowView(row: row)
                        }
                    }
                }

                Section("Actions") {
                    if item.resolved {
                        if ["published", "modified", "verified_empty", "unverified_empty"].contains(item.status ?? "") {
                            Button(item.status == "verified_empty" || item.status == "unverified_empty" ? "Reopen" : "Unpublish") {
                                showUnpublishConfirm = true
                            }
                        }
                    } else {
                        if let run = preferredConfirmRun(item: item) {
                            Button("Confirm From \(run.displayName)") {
                                confirmRunId = run.id
                            }
                        } else if !item.queuedRows.compactMap(\.confirmEditBody).isEmpty {
                            Button("Confirm Queued Rows") {
                                confirmRunId = "queued"
                            }
                        }
                        Button("Reject", role: .destructive) {
                            showRejectConfirm = true
                        }
                        if item.isHeldFromAutomation {
                            Button("Retry Auto") {
                                Task { await store.retryReviewAuto(item) }
                            }
                        }
                    }
                }
                .disabled(store.reviewActionDocId != nil)
            } else {
                Section {
                    Text("This filing is no longer in the loaded queue.  Pull to refresh the list.")
                        .foregroundStyle(.secondary)
                }
            }

            Section("Extractions") {
                if let runs = extractions?.runs, !runs.isEmpty {
                    ForEach(runs) { run in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(run.displayName)
                                    .font(.subheadline.weight(.semibold))
                                Spacer()
                                Text(run.ok == true ? "ok" : "error")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(run.ok == true ? AppTheme.semanticPositive : AppTheme.semanticNegative)
                            }
                            if let provider = run.provider, !provider.isEmpty {
                                Text("Provider \(provider)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            if let error = run.error, !error.isEmpty {
                                Text(error)
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.semanticNegative)
                            }
                            ForEach(Array(run.rows.prefix(8).enumerated()), id: \.offset) { _, row in
                                ReviewExtractedRowView(row: row)
                            }
                            if run.rows.count > 8 {
                                Text("+\(run.rows.count - 8) more rows")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            if let item, !item.resolved, run.canConfirmFrom {
                                Button("Confirm This Reading") {
                                    confirmRunId = run.id
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                } else {
                    Text("No stored readings yet.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(AppTheme.background)
        .navigationTitle("Review")
        .inlineNavigationTitle()
        .task { await store.loadReviewExtractions(docId: docId) }
        .confirmationDialog("Reject this filing?", isPresented: $showRejectConfirm, titleVisibility: .visible) {
            Button("Reject", role: .destructive) {
                if let item { Task { await store.rejectReviewItem(item) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This marks the filing as rejected.  It is not published.")
        }
        .confirmationDialog("Unpublish this filing?", isPresented: $showUnpublishConfirm, titleVisibility: .visible) {
            Button("Unpublish", role: .destructive) {
                if let item { Task { await store.unpublishReviewItem(item) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Live rows are retracted and the item returns to the pending queue.")
        }
        .confirmationDialog("Confirm this reading?", isPresented: Binding(
            get: { confirmRunId != nil },
            set: { if !$0 { confirmRunId = nil } }
        ), titleVisibility: .visible) {
            Button("Confirm") {
                confirmSelectedReading()
            }
            Button("Cancel", role: .cancel) { confirmRunId = nil }
        } message: {
            Text("Publishes only the selected extracted rows.  This is not a bulk confirm.")
        }
    }

    private func preferredConfirmRun(item _: ReviewQueueItem) -> ReviewExtractionRun? {
        extractions?.runs.first(where: \.canConfirmFrom)
    }

    private func confirmSelectedReading() {
        guard let item else { return }
        let runId = confirmRunId
        confirmRunId = nil
        if runId == "queued" {
            Task { await store.confirmReviewItem(item, edits: item.queuedRows.compactMap(\.confirmEditBody), modelName: "queued rows") }
            return
        }
        if let run = extractions?.runs.first(where: { $0.id == runId }) {
            Task { await store.confirmReviewItem(item, edits: run.confirmEdits, modelName: run.displayName) }
        }
    }
}

struct ReviewExtractedRowView: View {
    let row: ReviewExtractedRow

    var body: some View {
        HStack {
            Text(row.symbolLabel)
                .font(.caption.weight(.semibold))
            Spacer()
            Text((row.txType ?? "—").uppercased())
                .font(.caption2)
            Text(row.txDate ?? "—")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
