import SwiftUI
import UIKit

struct DeliveryView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @State private var deliveryMode: DeliveryMode = .sse
    @State private var webhookURL = ""
    @State private var filterChambers: Set<ChamberFilter> = []
    @State private var membersText = ""
    @State private var watchlistDraft: [String] = []
    @State private var newTicker = ""
    @State private var showPremiumInfo = false
    @State private var showExport = false

    var body: some View {
        NavigationStack {
            Form {
                // Phone alerts lead this screen, and they are the SHARED
                // control — the identical `TradeDisclosureAlertsToggle` the
                // Settings tab and the header menu render, so there is one
                // switch reachable from three places rather than three
                // switches that each claim to own push.
                //
                // What used to sit here was a "Notifications" section of four
                // `@AppStorage` toggles (All Trades / New Buys / New Sells /
                // Watchlist). Nothing in the app ever read them: they were
                // never serialized into a request, `createDelivery` ignores
                // them, and `push_devices` has no column that could receive
                // them. They looked exactly like push controls while changing
                // nothing, which is precisely why this tab read as "unsure if
                // any options there impact push notifications". Switches that
                // do nothing are worse than no switches, so they are deleted
                // rather than relabelled.
                Section {
                    TradeDisclosureAlertsToggle()
                } header: {
                    Text("Phone Alerts")
                } footer: {
                    Text("The same switch is in Settings and in the header menu.")
                }

                // Export sits directly beside the Premium entry point by
                // request. Both are account-level, so they belong above the
                // developer integration instead of buried underneath it.
                Section {
                    Button {
                        showExport = true
                    } label: {
                        Label("Export CSV", systemImage: "arrow.down.circle")
                    }
                    premiumRow
                }

                Section("Developer Delivery") {
                    // Hoisted out of the individual branches so the audience is
                    // named before anything else on this screen — including for
                    // signed-out and free accounts, which previously saw the
                    // paywall with no explanation of what they would be buying.
                    DeliveryMethodExplainer()
                        .padding(.bottom, 2)

                    if !store.signedIn {
                        Text("Sign in to create a delivery.")
                            .padding(.vertical, 4)
                    } else if !store.isPremium {
                        // Delivery creation is Premium-gated server-side, so the
                        // gate is still shown up front rather than letting a
                        // free account hit a raw 403 from `create_subscription`
                        // — but the pitch itself moved into the shared
                        // `PremiumInfoSheet`, so the app has exactly one
                        // Premium explanation instead of a bespoke paragraph
                        // per screen.
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Creating a delivery requires Premium.")
                                .font(.subheadline)
                            Button {
                                showPremiumInfo = true
                            } label: {
                                Label("See What Premium Includes", systemImage: "sparkles")
                                    .font(.subheadline.weight(.semibold))
                            }
                            Text("Existing deliveries still appear below.")
                                .font(.caption)
                                .foregroundStyle(Color.secondary)
                        }
                        .padding(.vertical, 4)
                    } else {
                        Picker("Mode", selection: $deliveryMode) {
                            ForEach(DeliveryMode.allCases) { mode in
                                Text(mode.rawValue).tag(mode)
                            }
                        }
                        .pickerStyle(.segmented)
                        .padding(.vertical, 4)

                        if deliveryMode == .webhook {
                            TextField("https://example.com/webhook", text: $webhookURL)
                                .urlKeyboard()
                                .neverAutocapitalized()
                                .autocorrectionDisabled()
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            Text("Chambers")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            HStack(spacing: 8) {
                                ForEach(ChamberFilter.allCases) { chamber in
                                    FilterChip(
                                        title: chamber.shortLabel,
                                        isSelected: filterChambers.contains(chamber)
                                    ) {
                                        if filterChambers.contains(chamber) {
                                            filterChambers.remove(chamber)
                                        } else {
                                            filterChambers.insert(chamber)
                                        }
                                    }
                                    .accessibilityLabel(chamber.label)
                                }
                            }
                            Text("No selection delivers all chambers.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)

                        TextField("Members (comma separated, optional)", text: $membersText)
                            .neverAutocapitalized()
                            .autocorrectionDisabled()

                        Button {
                            Task {
                                await store.createDelivery(
                                    mode: deliveryMode,
                                    webhookURL: webhookURL,
                                    chambers: filterChambers,
                                    members: Self.parseMembers(membersText)
                                )
                            }
                        } label: {
                            if store.isCreatingDelivery {
                                ProgressView()
                            } else {
                                Label("Create Delivery", systemImage: "paperplane.fill")
                                    .fontWeight(.medium)
                            }
                        }
                        .disabled(store.isCreatingDelivery)
                    }

                    if let notice = store.deliveryNotice {
                        NoticeView(message: notice)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                }

                // "Subscriptions" collided with the Premium billing
                // subscription in the owner's reading of this screen; these are
                // deliveries, so they are called deliveries.
                Section("Existing Deliveries") {
                    if store.subscriptions.isEmpty {
                        Text(store.signedIn ? "No deliveries yet." : "Sign in to manage deliveries.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(store.subscriptions) { subscription in
                            SubscriptionRow(
                                subscription: subscription,
                                onToggle: {
                                    Task { await store.toggleSubscription(subscription) }
                                },
                                onDelete: {
                                    Task { await store.deleteSubscription(subscription) }
                                }
                            )
                            .disabled(store.subscriptionIDsInFlight.contains(subscription.id))
                        }
                    }
                }

                Section {
                    if !store.signedIn {
                        Text("Sign in to manage your watchlist.")
                            .foregroundStyle(.secondary)
                    } else {
                        if watchlistDraft.isEmpty {
                            Text("No tickers yet. An empty watchlist delivers everything.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(watchlistDraft, id: \.self) { ticker in
                            HStack {
                                Text(ticker)
                                    .font(.body.weight(.semibold).monospaced())
                                Spacer()
                                Button(role: .destructive) {
                                    watchlistDraft.removeAll { $0 == ticker }
                                } label: {
                                    Image(systemName: "minus.circle.fill")
                                        .foregroundStyle(.red)
                                }
                                .accessibilityLabel("Remove \(ticker)")
                            }
                        }
                        HStack {
                            TextField("Add ticker (e.g. NVDA)", text: $newTicker)
                                .tickerAutocapitalized()
                                .autocorrectionDisabled()
                            Button("Add") {
                                let parsed = CongressTradeStore.parseTickers(newTicker)
                                for ticker in parsed where !watchlistDraft.contains(ticker) {
                                    watchlistDraft.append(ticker)
                                }
                                newTicker = ""
                            }
                            .disabled(CongressTradeStore.parseTickers(newTicker).isEmpty)
                        }
                        if watchlistDraft != store.watchlist {
                            Button {
                                Task { await store.saveWatchlist(watchlistDraft.joined(separator: ",")) }
                            } label: {
                                if store.isSavingWatchlist {
                                    ProgressView()
                                } else {
                                    Label("Save Watchlist", systemImage: "checkmark.circle")
                                        .fontWeight(.medium)
                                }
                            }
                            .disabled(store.isSavingWatchlist)
                        }
                    }
                } header: {
                    Text("Watchlist")
                } footer: {
                    Text("New deliveries filter to these tickers. The watchlist syncs to your Congress.Trade account.")
                }

                Section {
                    LegalFooterLinks()
                }
                .listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Delivery")
            .inlineNavigationTitle()
            .sheet(item: $store.pendingDeliveryCredential) { credential in
                DeliveryCredentialView(credential: credential)
            }
            .sheet(isPresented: $showPremiumInfo) {
                PremiumInfoSheet(isPresented: $showPremiumInfo)
                    .environmentObject(store)
            }
            // `ExportCSVSheet` lives with the Trades tab and is reused verbatim:
            // it does its own signed-in / Premium gating and exports the CURRENT
            // global Trades filter state, so it behaves identically opened from
            // here. Presented from this view (which stays alive) rather than
            // from a row that dismisses itself, so the presentation host cannot
            // be torn down in the same update that raises the sheet.
            .sheet(isPresented: $showExport) {
                ExportCSVSheet()
                    .environmentObject(store)
                    .presentationDetents([.medium])
                    .presentationDragIndicator(.visible)
            }
            .onAppear {
                watchlistDraft = store.watchlist
                Task { await store.refreshSignedInState() }
            }
            .onChange(of: store.watchlist) { _, newValue in
                watchlistDraft = newValue
            }
        }
    }

    /// The single Premium entry point on this tab, sitting next to Export CSV.
    ///
    /// It opens the shared `PremiumInfoSheet` — one screen, no hard sell, "Not
    /// Now" as its largest control, readable while signed out — rather than the
    /// paragraph-plus-buy-button that used to be inlined in the create-delivery
    /// gate. `PremiumInfoSheet` still owns the `SubscribeView` purchase path, so
    /// the money path and the server-side entitlement checks are untouched; only
    /// the explanation moved, and it is now the same explanation app-wide.
    ///
    /// Nothing renders for accounts that already have Premium: managing an
    /// existing subscription lives in Settings and in the header menu, and a
    /// third copy here would recreate the "settings in multiple illogical
    /// places" problem this pass exists to fix.
    @ViewBuilder
    private var premiumRow: some View {
        if !store.isPremium {
            Button {
                showPremiumInfo = true
            } label: {
                Label("Upgrade to Premium", systemImage: "sparkles")
            }
        }
    }

    /// Members are free-text names (not symbols), so no uppercasing.
    private static func parseMembers(_ text: String) -> [String] {
        text
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}

/// One-line-each Webhook/SSE explainer, now led by the audience.
///
/// Both delivery modes terminate at a server the user runs — the backend
/// accepts no delivery channel other than `sse` or `webhook`, so nothing
/// configured on this screen can reach a phone. The old copy described both
/// mechanisms accurately but never said who they were for, which is how a
/// non-developer read "webhook" and "live stream" as two ways of getting
/// alerts on their phone. The audience line goes first for that reason; the
/// phone control itself is the toggle at the top of this tab.
struct DeliveryMethodExplainer: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Sends filings to a server you run — not to this phone.")
                .fontWeight(.semibold)
            Text("Webhook: we POST each new filing to your HTTPS URL, HMAC-signed.")
            Text("Live stream (SSE): one open connection that pushes filings as they land.")
        }
        .font(.caption)
        .foregroundStyle(Color.secondary)
    }
}

struct SubscriptionRow: View {
    let subscription: Subscription
    let onToggle: () -> Void
    var onDelete: (() -> Void)? = nil
    @State private var confirmDelete = false

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text(subscription.delivery.uppercased())
                    .font(.headline)
                Text(subscription.targetUrl ?? subscription.streamUrl ?? "SSE stream")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text("Cursor \(subscription.cursor)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 8) {
                Button(subscription.active ? "Pause" : "Resume", action: onToggle)
                    .buttonStyle(.bordered)
                    .tint(subscription.active ? .orange : .green)
                    .clipShape(Capsule())
                if let onDelete {
                    Button {
                        if confirmDelete {
                            onDelete()
                            confirmDelete = false
                        } else {
                            withAnimation { confirmDelete = true }
                            // Auto-reset confirm after a few seconds so a
                            // stray tap doesn't permanently arm delete.
                            Task {
                                try? await Task.sleep(for: .seconds(4))
                                if confirmDelete { confirmDelete = false }
                            }
                        }
                    } label: {
                        Text(confirmDelete ? "Confirm?" : "Delete")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                    .clipShape(Capsule())
                    .accessibilityLabel(confirmDelete ? "Confirm delete delivery" : "Delete delivery")
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct DeliveryCredentialView: View {
    let credential: DeliveryCredential
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @State private var copiedField: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Shown Once — Not Recoverable", systemImage: "exclamationmark.shield.fill")
                        .foregroundStyle(.orange)
                        .font(.headline)
                    Text("Congress.Trade never returns this secret again, in this app or any other client. Copy it somewhere safe now; if you lose it, pause this delivery and create a new one.")
                        .foregroundStyle(.secondary)
                }
                if let streamURL = credential.streamURL {
                    Section("Stream URL") {
                        Text(streamURL)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                            .privacySensitive()
                        CopyButton(label: "Copy Stream URL", value: streamURL, copiedField: $copiedField)
                    }
                }
                if let secret = credential.secret {
                    Section("Subscription Secret") {
                        Text(secret)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                            .privacySensitive()
                        CopyButton(label: "Copy Secret", value: secret, copiedField: $copiedField)
                    }
                }
            }
            .navigationTitle("Delivery Credential")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.bold)
                }
            }
        }
        .onDisappear {
            // The secret is shown exactly once; drop it from app state as soon
            // as this view goes away rather than relying only on the sheet
            // binding to nil it out. CT-AUD-023.
            store.clearPendingDeliveryCredential()
        }
    }
}

/// Explicit, deliberate copy control for a one-time secret. Replaces the
/// generic system `ShareLink`, which hands the secret to an arbitrary
/// share-sheet destination (Messages, AirDrop, third-party apps, ...) with no
/// record of where it went. CT-AUD-023.
private struct CopyButton: View {
    let label: String
    let value: String
    @Binding var copiedField: String?

    var body: some View {
        Button {
            UIPasteboard.general.string = value
            copiedField = value
            Task {
                try? await Task.sleep(for: .seconds(2))
                if copiedField == value { copiedField = nil }
            }
        } label: {
            Label(copiedField == value ? "Copied" : label, systemImage: copiedField == value ? "checkmark" : "doc.on.doc")
        }
        .buttonStyle(.bordered)
    }
}
