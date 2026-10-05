import SwiftUI
import UIKit

struct DeliveryView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @AppStorage("ct_disclaimer_expanded") private var disclaimerExpanded = false
    @State private var deliveryMode: DeliveryMode = .sse
    @State private var webhookURL = ""
    @State private var filterChambers: Set<ChamberFilter> = []
    @State private var selectedMembers: [MemberDirectoryEntry] = []
    @State private var showMemberPicker = false
    @State private var showSubscribe = false
    @State private var showExportSheet = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if disclaimerExpanded {
                    DisclaimerBanner()
                        .padding(.horizontal, 16)
                        .padding(.top, 6)
                        .padding(.bottom, 4)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }

                Form {
                    Section {
                        TradeDisclosureAlertsToggle(isCompact: true)
                    } footer: {
                        Text("Customize push alerts in the \(Image(systemName: "line.3.horizontal")) menu at top right.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    // Export sits beside the upgrade entry point on purpose (owner
                    // asked for that adjacency): the thing you want and the thing
                    // that unlocks it should not be on different screens.
                    Section {
                        Button {
                            showExportSheet = true
                        } label: {
                            Label {
                                Text("Export CSV").foregroundStyle(AppTheme.wordInk)
                            } icon: {
                                Image(systemName: "arrow.down.circle").foregroundStyle(AppTheme.glyphGrey)
                            }
                        }
                    } header: {
                        Text("Premium")
                    } footer: {
                        Text("CSV files export according to the filters set on the Trades tab.  Premium plans and any free trial are shown in the App Store purchase sheet.")
                    }

                    Section {
                        if !store.signedIn {
                            VStack(alignment: .leading, spacing: 10) {
                                DeliveryMethodExplainer()
                                Text("Sign in to create delivery alerts.")
                                    .foregroundStyle(.primary)
                            }
                            .padding(.vertical, 4)
                        } else if !store.isPremium {
                            VStack(alignment: .leading, spacing: 10) {
                                Label("Premium Feature", systemImage: "star.fill")
                                    .font(.headline)
                                    .foregroundStyle(.orange)
                                Text(PremiumPricing.deliveryUpgradeMessage)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                // Subscribe with Apple prominent button
                                SubscribeWithAppleProminentButton {
                                    showSubscribe = true
                                }
                                Text("Deliveries connect your server or app to real-time data. Configure push alerts in the \(Image(systemName: "line.3.horizontal")) menu.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(.top, 2)
                            }
                            .padding(.vertical, 4)
                        } else {
                            DeliveryMethodExplainer()
                                .padding(.bottom, 2)

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

                            // Members are picked from the directory and sent as filer ids:
                            // the server matches on ids, so typed names used to save a
                            // subscription that could never deliver (board a6058af2).
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Members")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                if selectedMembers.isEmpty {
                                    Text("No selection delivers every member.")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                } else {
                                    ForEach(selectedMembers) { member in
                                        HStack {
                                            Text(member.fullName ?? member.filerId)
                                                .font(.subheadline)
                                            Spacer()
                                            Button {
                                                selectedMembers.removeAll { $0.filerId == member.filerId }
                                            } label: {
                                                Image(systemName: "xmark.circle.fill")
                                                    .foregroundStyle(.secondary)
                                            }
                                            .buttonStyle(.plain)
                                            .accessibilityLabel("Remove \(member.fullName ?? member.filerId)")
                                        }
                                    }
                                }
                                Button {
                                    showMemberPicker = true
                                } label: {
                                    Label(
                                        selectedMembers.isEmpty ? "Choose Members" : "Add or Remove Members",
                                        systemImage: "person.crop.circle.badge.plus"
                                    )
                                }
                            }
                            .padding(.vertical, 4)

                            Button {
                                Task {
                                    await store.createDelivery(
                                        mode: deliveryMode,
                                        webhookURL: webhookURL,
                                        chambers: filterChambers,
                                        members: selectedMembers.map(\.filerId)
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
                    } header: {
                        Text("Create Delivery")
                    } footer: {
                        if store.signedIn && store.isPremium {
                            Text("Deliveries connect your server or app to real-time data. Configure push alerts in the \(Image(systemName: "line.3.horizontal")) menu.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Section("Existing Subscriptions") {
                        if store.subscriptions.isEmpty {
                            Text(store.signedIn ? "No delivery subscriptions yet." : "Sign in to manage delivery subscriptions.")
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

                    if let summary = store.latencySummary,
                       LatencyScorecardCopy.isPubliclyVisible(summary) {
                        Section {
                            LatencyComparisonView(summary: summary)
                        }
                        .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                        .listRowBackground(Color.clear)
                    }
                }
            }
            .animation(.easeInOut(duration: 0.32), value: disclaimerExpanded)
            .frame(maxWidth: horizontalSizeClass == .regular ? 640 : .infinity)
            .frame(maxWidth: .infinity)
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .ctSolidFeedHeader()
            .toolbar {
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
            .sheet(item: $store.pendingDeliveryCredential) { credential in
                DeliveryCredentialView(credential: credential)
            }
            .sheet(isPresented: $showSubscribe) {
                PremiumSheet()
                    .environmentObject(store)
            }
            .sheet(isPresented: $showMemberPicker) {
                DeliveryMemberPicker(selection: $selectedMembers)
                    .environmentObject(store)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                    .iPadFullWidthSheet()
            }
            .sheet(isPresented: $showExportSheet) {
                ExportCSVSheet()
                    .environmentObject(store)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .iPadFullWidthSheet()
            }
            .onAppear {
                Task {
                    await store.refreshSignedInState()
                    if store.latencySummary == nil {
                        await store.refreshLatency()
                    }
                }
            }
        }
    }

}

/// Multi-select member picker for a delivery's `members` filter, built on the
/// People directory (`store.members`, `MemberDirectorySearch`).  Selecting a row
/// keeps the directory entry so the create call sends its `filerId` — the id the
/// backend matches trades against.
struct DeliveryMemberPicker: View {
    @Binding var selection: [MemberDirectoryEntry]
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    /// Same cap as the server (`validateSubscriptionFilters`: at most 50 members).
    static let maxMembers = 50

    private var visibleMembers: [MemberDirectoryEntry] {
        let matching = store.members.filter { MemberDirectorySearch.matches($0, query: query) }
        return MemberDirectorySearch.sort(matching, key: .name, ascending: true)
    }

    private var selectedIDs: Set<String> { Set(selection.map(\.filerId)) }

    var body: some View {
        NavigationStack {
            List {
                if store.isLoadingMembers && store.members.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Loading members…").foregroundStyle(.secondary)
                    }
                } else if let notice = store.membersNotice, store.members.isEmpty {
                    NoticeView(message: notice)
                } else if visibleMembers.isEmpty {
                    Text("No members match \"\(query)\".").foregroundStyle(.secondary)
                }
                ForEach(visibleMembers) { member in
                    let isSelected = selectedIDs.contains(member.filerId)
                    Button {
                        toggle(member)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(member.fullName ?? member.filerId)
                                    .foregroundStyle(.primary)
                                let detail = Self.detail(for: member)
                                if !detail.isEmpty {
                                    Text(detail)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if isSelected {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(AppTheme.wordInk)
                            }
                        }
                    }
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
            }
            .searchable(text: $query, prompt: "Search members")
            .navigationTitle("Members")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.bold)
                        .foregroundStyle(AppTheme.wordInk)
                        .tint(AppTheme.wordInk)
                }
            }
            .task { await store.loadMembersDirectory() }
        }
    }

    private func toggle(_ member: MemberDirectoryEntry) {
        if let index = selection.firstIndex(where: { $0.filerId == member.filerId }) {
            selection.remove(at: index)
        } else if selection.count < Self.maxMembers {
            selection.append(member)
        }
    }

    private static func detail(for member: MemberDirectoryEntry) -> String {
        [member.chamber?.capitalized, member.state, member.party]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }
}

/// One-line-each Webhook/SSE explainer (owner punch list #2, item 10) —
/// mirrors the web's shortened Delivery copy (lane W2, `app/src/ui/dashboardHtml.ts`),
/// replacing the old single long paragraph that tried to cover both methods
/// at once.
struct DeliveryMethodExplainer: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // One POST per transaction, not per filing — a filing with several
            // trades sends several requests (`app/src/delivery/webhook.ts`
            // sets X-Tx-Id per POST).  "New filings" read as one-per-filing and
            // sent integrators dedupe on the wrong key.
            Text("Webhooks: POST each new trade to your URL (HMAC signed).")
            Text("SSE: Live stream over an open connection.")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
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
                if let members = subscription.memberSummary {
                    Text(members)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
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
                    // Dark legible ink, not the app-wide blue tint (owner
                    // 2026-08-21); `.tint` is required alongside
                    // `.foregroundStyle` because the toolbar button style
                    // re-applies tint over a plain foreground colour.
                    Button("Done") { dismiss() }
                        .fontWeight(.bold)
                        .foregroundStyle(AppTheme.wordInk)
                        .tint(AppTheme.wordInk)
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
