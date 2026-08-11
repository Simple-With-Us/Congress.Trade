import SwiftUI
import AuthenticationServices

/// UIKit presentation anchor for `ASWebAuthenticationSession`.
///
/// The Google OAuth round trip itself now lives in `SignInPanel`
/// (`Views/Components/Components.swift`) so the app has exactly ONE sign-in
/// implementation — but `ASWebAuthenticationSession` still needs a real window
/// to present over and SwiftUI has no equivalent. This shim stays in this file
/// and is used by reference from `SignInPanel.startGoogleSignIn()`. It holds no
/// SwiftUI state, so there is nothing here to duplicate or keep in sync.
class AuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AuthPresentationContext()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        guard let windowScene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
              let window = windowScene.windows.first(where: { $0.isKeyWindow }) else {
            return ASPresentationAnchor()
        }
        return window
    }
}

/// Settings tab — deliberately header-less and caption-light.
///
/// The owner's complaint was that this tab explained itself instead of just
/// working: "Don't need bunch of words on that tab like Appearance or Theme or
/// explanations of what light and dark are for." So section *grouping* does the
/// organizing rather than prose, and every control is either self-evident (the
/// account card, the pictographic theme segment) or carries at most one
/// sentence-case status line (`TradeDisclosureAlertsToggle`).
///
/// Every control on this tab is a SHARED component that the header quick menu
/// (`AccountQuickMenu`) renders too, so the two surfaces cannot drift: one
/// sign-in implementation, one push toggle, one Premium explanation, one legal
/// footer. That is the fix for "the settings … in multiple illogical places".
struct SettingsView: View {
    @EnvironmentObject private var store: CongressTradeStore
    /// Not read directly here any more — `TradeDisclosureAlertsToggle` pulls the
    /// push manager out of the environment itself. Declared anyway so this tab's
    /// dependency on it is stated at THIS boundary: if a future refactor stops
    /// injecting it, the failure points at the tab instead of crashing deep
    /// inside a nested component with no obvious owner.
    @EnvironmentObject private var pushManager: PushNotificationManager
    @Environment(\.openURL) private var openURL
    @AppStorage("app_color_scheme") private var appColorScheme = "system"
    @State private var showPremiumInfo = false
    @State private var isOpeningManageSubscription = false
    @State private var manageSubscriptionError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    accountSection
                } footer: {
                    accountFooter
                }

                // No "Appearance" header and no "Theme" label. The three
                // pictographic options say what they are; the owner explicitly
                // asked for the surrounding words to go.
                Section {
                    ThemeSegmentControl(selection: $appColorScheme)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 2)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }

                // No headers. "Push Notifications (APNs)" is gone app-wide — the
                // toggle names the thing it actually turns on and owns its single
                // status line, including the honest "alerts start when the
                // service goes live" state.
                //
                // Alerts and Premium share one section for the same reason
                // `AccountQuickMenu` groups them: they are both account-level
                // switches, and as separate sections the inset-grouped gaps left
                // a mostly-empty screen with two lone rows floating in it.
                Section {
                    TradeDisclosureAlertsToggle()
                    premiumRow
                }

                // Replaces the old four-`Link` "About" section: the same legal
                // row every other tab shows, so there is one set of URLs and one
                // appearance for them.
                Section {
                    LegalFooterLinks()
                }
                .listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(AppTheme.background)
            .navigationTitle("Settings")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    // The magic-link field lives inside `SignInPanel` now, so its
                    // `@FocusState` is not reachable from here. Resigning first
                    // responder through UIKit dismisses whichever field in this
                    // tab raised the keyboard, without this view having to own
                    // focus state it has no other use for.
                    Button("Done") {
                        UIApplication.shared.sendAction(
                            #selector(UIResponder.resignFirstResponder),
                            to: nil,
                            from: nil,
                            for: nil
                        )
                    }
                }
            }
            .sheet(isPresented: $showPremiumInfo) {
                PremiumInfoSheet(isPresented: $showPremiumInfo)
                    .environmentObject(store)
            }
        }
    }

    // MARK: - Account

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
                                // Concrete `Color.secondary`, never the bare
                                // hierarchical `.secondary`: the latter resolves
                                // against the current foreground style, which
                                // under this app's `.tint(.blue)` renders blue.
                                .foregroundStyle(Color.secondary)
                        }
                    }
                    .frame(width: 44, height: 44)
                    .clipShape(Circle())
                } else {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(Color.secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(user.name?.isEmpty == false ? user.name! : user.email)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    Text(user.email)
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                    Text(store.entitlementLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.blue)
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)

            Button(role: .destructive) {
                Task { await store.signOut() }
            } label: {
                Label(
                    store.isLoggingOut ? "Signing Out…" : "Sign Out",
                    systemImage: "rectangle.portrait.and.arrow.right"
                )
            }
            .disabled(store.isLoggingOut)
        } else if store.hasStoredSessionToken && !store.signedIn {
            // A token is on the device but the bootstrap has not resolved a user
            // (offline, or the session expired). Offer retry + clear rather than
            // silently dropping them back to the sign-in panel, which would look
            // like the previous sign-in never happened.
            Text("Session could not be verified.")
                .font(.subheadline)
                .foregroundStyle(Color.secondary)
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
            // The app's ONE sign-in implementation. This tab used to carry its
            // own Apple + Google + magic-link stack (and its own copy of the
            // Google mark), which is how the two surfaces ended up looking and
            // failing differently. `SignInPanel` also renders every sign-in
            // error itself, so failures are visible wherever it appears.
            SignInPanel()
        }
    }

    /// `SignInPanel` surfaces `store.watchlistNotice` inside itself, so the
    /// footer only carries it for the signed-in / unverified branches. Without
    /// this guard a failed sign-in would print the same sentence twice, one row
    /// apart.
    @ViewBuilder
    private var accountFooter: some View {
        if store.signedIn || store.hasStoredSessionToken,
           let notice = store.watchlistNotice,
           !notice.isEmpty {
            Text(notice)
        }
    }

    // MARK: - Premium

    /// Premium entry point, intentionally NOT gated on being signed in:
    /// `PremiumInfoSheet` is readable signed out by design (the owner asked for
    /// a one-screen explanation that is easy to walk away from) and it owns the
    /// sign-in / subscribe branching internally. That is why this tab no longer
    /// carries its own price string, its own `SubscribeView` presentation, or a
    /// second "subscribe on the web" link — there is one Premium explanation in
    /// the app and this is a door to it.
    @ViewBuilder
    private var premiumRow: some View {
        if store.isPremium {
            Button {
                Task { await openManageSubscription() }
            } label: {
                HStack {
                    Label("Manage Subscription", systemImage: "creditcard")
                    if isOpeningManageSubscription {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(isOpeningManageSubscription)
            .accessibilityHint(
                store.entitlementSource == "apple"
                    ? "Opens the App Store subscriptions page"
                    : "Opens the Congress.Trade billing portal"
            )
            if let manageSubscriptionError {
                Text(manageSubscriptionError)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Button {
                showPremiumInfo = true
            } label: {
                Label("Upgrade to Premium", systemImage: "sparkles")
            }
        }
    }

    /// Routes by `entitlementSource` — an Apple subscriber must land on the App
    /// Store subscriptions page and a Stripe subscriber on the billing portal;
    /// sending either to the other's surface is a dead end. See
    /// `Store/ManageSubscription.swift`, which also supplies the user-ready
    /// failure copy. A failure renders inline instead of opening a dead link.
    private func openManageSubscription() async {
        manageSubscriptionError = nil
        isOpeningManageSubscription = true
        defer { isOpeningManageSubscription = false }
        switch await store.resolveManageSubscriptionURL() {
        case .url(let url):
            openURL(url)
        case .failed(let message):
            manageSubscriptionError = message
        }
    }
}
