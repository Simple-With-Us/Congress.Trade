import StoreKit
import SwiftUI

/// The one Premium screen: what Premium unlocks, the price, the actual App
/// Store products, and a prominent way out — no "See Plans" hop in between.
///
/// This used to be two sheets. `PremiumInfoSheet` sold Premium as a benefit
/// list and then pushed `SubscribeView`, which re-explained the same thing as
/// one dense paragraph and only there showed the products. Two screens meant
/// two copies of the pricing/trial line, and they drifted (the info sheet still
/// said "1-month free trial" months after the trial became two weeks).
///
/// Every benefit line is a gate that exists in the backend today — archived
/// filing PDFs (`serveDocumentPdf` returns 402 JSON for Bearer / Accept: pdf;
/// web browsers without those still 302 to `/pricing`), full-history CSV
/// export (`/api/export/transactions.csv` → 401/402 with `feature: 'export'`),
/// and webhook/SSE delivery (402 with `feature: 'alerts'`, capped at
/// `MAX_SUBSCRIPTIONS_PER_USER = 2`). No scarcity, no countdown, nothing the
/// server does not enforce.  Filing PDF on iOS never opens Safari checkout.
///
/// It renders in full when signed out, too: hiding what Premium is until after
/// sign-in leaves the price and the benefits invisible to exactly the people
/// deciding.
///
/// Products must exist in App Store Connect:
/// - `trade.congress.premium.monthly` ($5/mo)
/// - `trade.congress.premium.annual` ($50/yr)
struct PremiumSheet: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var products: [Product] = []
    @State private var isLoadingProducts = true
    @State private var purchasingProductID: String?
    @State private var purchaseError: String?
    @State private var notice: String?
    @State private var isRestoring = false
    @State private var isOpeningManageSubscription = false
    @State private var manageSubscriptionError: String?
    @State private var isLinking = false
    /// Sign-in stays a way IN, never a gate (Guideline 5.1.1(v)) — tapping
    /// "Sign in" opens this sheet without interrupting an in-flight purchase.
    @State private var showSignIn = false

    private struct Benefit: Identifiable {
        let id = UUID()
        let systemImage: String
        let text: String
    }

    private let benefits: [Benefit] = [
        .init(systemImage: "doc.text", text: "Open the original filing PDF from Congress"),
        .init(systemImage: "chart.bar.doc.horizontal", text: "Proprietary Enrichment Data in every payload"),
        .init(systemImage: "arrow.down.doc", text: "Full-history CSV export"),
        .init(
            systemImage: "bolt.horizontal",
            text: "Instant delivery of new filings — signed webhook or SSE, up to two methods"
        ),
        .init(systemImage: "bell", text: "Push notifications when a new filing lands"),
    ]

    private var isBusy: Bool { purchasingProductID != nil || isRestoring || isLinking }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("The public dashboard stays free.  Premium adds the filing itself and the ways to receive it.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(benefits) { benefit in
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Image(systemName: benefit.systemImage)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .frame(width: 22, alignment: .leading)
                                Text(benefit.text)
                                    .font(.subheadline)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }

                    Text(PremiumPricing.headline)
                        .font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)

                    // Guideline 3.1.2 wants length of subscription and renewal
                    // terms ON the paywall, for every viewer — not only after
                    // the products load and not only once signed in.  It sits
                    // above `actionSection` so it is present even when StoreKit
                    // returns an empty catalog.
                    Text(PremiumPricing.renewalTerms)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    actionSection

                    if let notice {
                        Text(notice)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let appleLinkNotice = store.appleLinkNotice {
                        Text(appleLinkNotice)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let purchaseError {
                        Text(purchaseError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    // The frame lives on the *label*, not on the Button: a
                    // bordered style sizes its background to the label, so an
                    // outer frame widens the hit area and leaves a small pill
                    // floating in the middle of it.
                    Button {
                        dismiss()
                    } label: {
                        Text(store.isPremium ? "Done" : "Not Now")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .foregroundStyle(AppTheme.wordInk)
                    }
                    .buttonStyle(.bordered)
                    // `.bordered` keys its border/text colour off `.tint`,
                    // which is otherwise the app-wide blue (App.swift) — dark
                    // legible ink instead (owner 2026-08-21).
                    .tint(AppTheme.wordInk)
                    .disabled(isBusy)

                    LegalFooterLinks(includePricing: false)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(20)
            }
            .background(AppTheme.background)
            .navigationTitle("Premium")
            .inlineNavigationTitle()
        }
        .iPadFullWidthSheet()
        .task { await loadProducts() }
        .sheet(isPresented: $showSignIn) {
            NavigationStack {
                ScrollView {
                    SignInPanel(onSignedIn: { showSignIn = false })
                        .padding(20)
                }
                .background(AppTheme.background)
                .navigationTitle("Sign In")
                .inlineNavigationTitle()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { showSignIn = false }
                    }
                }
            }
            .environmentObject(store)
        }
    }

    // MARK: - Sections

    /// Guideline 5.1.1(v): purchasing must work with zero prior sign-in, so
    /// this no longer branches on `store.signedIn` at all — only on whether
    /// Premium is already active (signed-in account, or this device's own
    /// anonymous Apple purchase) versus still needing a plan choice. Signing
    /// in is offered underneath as an optional way to extend access to other
    /// devices, never a gate on the purchase itself.
    @ViewBuilder
    private var actionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            primaryActionContent
            if !store.signedIn && !store.hasLocalAppleEntitlement {
                signInOptionalNotice(
                    "No account needed to buy.  It's optional — sign in to use Premium on your "
                        + "other devices, and to set up Delivery alerts, which are tied to your account."
                )
            }
        }
    }

    @ViewBuilder
    private var primaryActionContent: some View {
        if store.isPremium {
            subscribedSection
        } else if !store.signedIn && store.hasLocalAppleEntitlement {
            anonymousSubscribedSection
        } else if store.signedIn && store.hasLocalAppleEntitlement {
            signedInDeviceEntitlementSection
        } else if isLoadingProducts {
            HStack(spacing: 10) {
                ProgressView()
                Text("Loading plans…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 50)
        } else if products.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(PremiumPricing.emptyCatalogMessage)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                restoreButton
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(products, id: \.id) { product in
                    purchaseButton(for: product)
                }
                restoreButton
            }
        }
    }

    /// Signed out, but `Transaction.currentEntitlements` already shows an
    /// active purchase on this device (Guideline 5.1.1(v) anonymous path) —
    /// the same "you're subscribed" treatment as a signed-in Premium account,
    /// routed straight to the App Store (no billing-portal call, which would
    /// need a session this device does not have).
    @ViewBuilder
    private var anonymousSubscribedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("You're subscribed to Premium on this device through the App Store.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Button {
                openURL(CongressTradeAPIClient.appStoreManageSubscriptionsURL)
            } label: {
                Text("Manage on App Store")
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityHint("Opens the App Store subscriptions page")

            signInOptionalNotice(
                "It's optional — sign in to use Premium on your other devices, and to set up "
                    + "Delivery alerts, which are tied to your account."
            )
        }
    }

    /// Signed in, not yet Premium on the SERVER, but this device already
    /// holds a verified Apple purchase — truth-table rows 3/4 (owner
    /// directive 2026-08-21). Never a "Subscribe" button here: they already
    /// paid, only whether it belongs to THIS account is still open.
    @ViewBuilder
    private var signedInDeviceEntitlementSection: some View {
        switch store.appleEntitlementOwnership {
        case .linkedToOtherAccount:
            appleEntitlementConflictSection
        case .unclaimed, .unknown:
            appleLinkOfferSection
        }
    }

    /// Row 3: say plainly this Apple purchase is linked elsewhere. The way
    /// out is an explicit tap — Restore Purchases (which surfaces the
    /// conflict again if it's still true) or signing out and back in with
    /// the owning account.
    @ViewBuilder
    private var appleEntitlementConflictSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("This Apple purchase is linked to a different Congress.Trade account.  "
                + "Sign out and sign in with that account, or tap Restore Purchases to confirm.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            restoreButton
        }
    }

    /// Row 4: this device's purchase is unclaimed. Grant access already
    /// happened (`premiumFeatureAccess`) — this only ASKS for the explicit
    /// consent to make it stick to the account (owner rule: never link
    /// silently). "Not now" only silences the launch-time prompt; the Link
    /// button itself stays here either way.
    @ViewBuilder
    private var appleLinkOfferSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("You're subscribed to Premium on this device through the App Store.  "
                + "Link it to your account to use it on the website and your other devices too.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Button {
                Task { await linkToAccount() }
            } label: {
                HStack {
                    Text("Link to This Account")
                    if isLinking {
                        Spacer()
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isBusy)
            .accessibilityHint("Links this device's Apple subscription to the signed-in account")

            Button("Not Now") {
                store.dismissAppleLinkPrompt()
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(isBusy)

            restoreButton
        }
    }

    /// Apple's own suggested framing from the Guideline 5.1.1(v) rejection:
    /// explain what sign-in adds without ever implying it is required. A
    /// tappable link, not a primary action — it opens the sign-in sheet and
    /// never interrupts an in-flight purchase.
    @ViewBuilder
    private func signInOptionalNotice(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Sign in") {
                showSignIn = true
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.plain)
            .foregroundStyle(.tint)
        }
    }

    @ViewBuilder
    private var subscribedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(
                store.entitlementSource == "apple"
                    ? "You're subscribed to Premium through the App Store."
                    : "You already have Premium access."
            )
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            Button {
                Task { await openManageSubscription() }
            } label: {
                HStack {
                    Text(store.entitlementSource == "apple" ? "Manage on App Store" : "Manage Subscription")
                    if isOpeningManageSubscription {
                        Spacer()
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isOpeningManageSubscription)
            .accessibilityHint(
                store.entitlementSource == "apple"
                    ? "Opens the App Store subscriptions page"
                    : "Opens the Congress.Trade billing portal"
            )

            if let manageSubscriptionError {
                Text(manageSubscriptionError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// The first product is the prominent one; the rest are bordered so the
    /// screen has a single obvious primary action rather than two competing
    /// filled buttons.
    @ViewBuilder
    private func purchaseButton(for product: Product) -> some View {
        let isPrimary = product.id == products.first?.id
        let button = Button {
            Task { await purchase(product) }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(product.displayName)
                        .font(.body.weight(.semibold))
                    if let subtitle = PremiumPricing.subtitle(for: product) {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if purchasingProductID == product.id {
                    ProgressView()
                } else {
                    Text(product.displayPrice)
                        .font(.body.weight(.bold))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 4)
        }
        .disabled(isBusy)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Starts an App Store purchase for \(product.displayName) at \(product.displayPrice)")

        if isPrimary {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }

    private var restoreButton: some View {
        Button {
            Task { await restore() }
        } label: {
            HStack {
                Text("Restore Purchases")
                if isRestoring {
                    Spacer()
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.tint)
        .disabled(isBusy)
        .accessibilityHint("Re-sends any active App Store subscription to Congress.Trade")
    }

    // MARK: - StoreKit

    private func loadProducts() async {
        isLoadingProducts = true
        defer { isLoadingProducts = false }
        do {
            let ids = Set(AppleIAPProduct.allCases.map(\.rawValue))
            products = try await Product.products(for: ids).sorted { $0.price < $1.price }
            if products.isEmpty {
                purchaseError = PremiumPricing.emptyCatalogMessage
            }
        } catch {
            products = []
            purchaseError = PremiumPricing.catalogLoadFailureMessage(error)
        }
    }

    private func purchase(_ product: Product) async {
        purchasingProductID = product.id
        purchaseError = nil
        notice = nil
        defer { purchasingProductID = nil }
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                // Everything after StoreKit returns `.success` is post-charge:
                // verification failure and redeem failure both use
                // `redeemFailureMessage` so a charged customer is steered to
                // recovery instead of "purchase could not start / try again".
                do {
                    let transaction = try checkVerified(verification)
                    notice = "Purchase confirmed.  Unlocking Premium…"
                    // StoreKit 2 VerificationResult.jwsRepresentation is the App Store JWS.
                    // Guideline 5.1.1(v): no account required to buy — signed in,
                    // this attaches to the account; signed out, it records the
                    // purchase against this device and the transaction is finished
                    // here (redeemAppleTransaction finishes the signed-in path
                    // itself; the anonymous path does not, so it is finished here).
                    if store.signedIn {
                        try await store.redeemAppleTransaction(transaction, jws: verification.jwsRepresentation)
                        notice = "Premium unlocked.  You can create Delivery alerts now."
                    } else {
                        try await store.redeemAppleTransactionAnonymously(jws: verification.jwsRepresentation)
                        await transaction.finish()
                        notice = "Premium unlocked on this device.  Sign in any time to use it on your other devices too."
                    }
                    try? await Task.sleep(for: .seconds(1.2))
                    dismiss()
                } catch {
                    purchaseError = PremiumPricing.redeemFailureMessage(error)
                }
            case .userCancelled:
                notice = nil
            case .pending:
                notice = "Purchase is pending approval.  Premium unlocks as soon as it clears — you don't need to buy again."
            @unknown default:
                notice = "Purchase finished with an unknown status."
            }
        } catch {
            if PremiumPricing.isQuietPurchaseCancellation(error) {
                notice = nil
            } else {
                purchaseError = PremiumPricing.purchaseFailureMessage(error)
            }
        }
    }

    private func restore() async {
        isRestoring = true
        purchaseError = nil
        notice = nil
        defer { isRestoring = false }
        do {
            try await AppStore.sync()
            let confirmed = try await store.redeemCurrentAppleEntitlements()
            notice = confirmed
                ? "Purchases restored."
                : "No active Premium subscription found on this Apple Account."
        } catch let error as APIError {
            // Restore Purchases is an explicit user action — the owner's
            // rule ("linking is always explicit, Restore Purchases counts")
            // — so a 409 here is surfaced plainly rather than the generic
            // "could not confirm it yet" retry framing, which would be
            // misleading: retrying will not fix an owner conflict.
            if case .server(409, _, _) = error {
                purchaseError = "This Apple purchase is already linked to a different Congress.Trade account.  "
                    + "Sign out and sign in with that account to use it there instead."
            } else {
                purchaseError = PremiumPricing.redeemFailureMessage(error)
            }
        } catch {
            purchaseError = PremiumPricing.redeemFailureMessage(error)
        }
    }

    /// Row 4's explicit "Link" tap — the only place besides Restore
    /// Purchases this app calls the authenticated `link_apple_entitlement`
    /// command. Never automatic.
    private func linkToAccount() async {
        isLinking = true
        store.appleLinkNotice = nil
        defer { isLinking = false }
        _ = await store.linkAppleEntitlementToCurrentAccount()
    }

    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let safe):
            return safe
        }
    }

    /// Same `resolveManageSubscriptionURL` routing as the account sheet — see
    /// `Store/ManageSubscription.swift`.  Stripe/web portal failure opens the
    /// website manage path rather than the App Store or a sign-out message.
    /// Offline stays inline.
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

// MARK: - Shared Premium copy

/// One home for the price/trial line so the phone can never drift from the web
/// again. The trial length here must match BOTH the Stripe default
/// (`STRIPE_TRIAL_DAYS`, 14 days — `app/src/billing/routes.ts`) and the
/// introductory offer configured on each product in App Store Connect. Change
/// it in all three or the app is quoting a trial Apple will not honor.
///
/// Verified 2026-08-14 against live ASC + Infisical: both
/// `trade.congress.premium.monthly` and `.annual` carry `FREE_TRIAL` /
/// `ONE_WEEK`; US prices $8.99 / $79.99; prod
/// `STRIPE_TRIAL_DAYS=7`. Receipt:
/// `docs/rollouts/2026-08-14-premium-trial-asc-verified.md`.
enum PremiumPricing {
    static let headline = "$8.99/month  •  $79.99/year  •  1-week free trial"

    /// Renewal disclosure required on the paywall itself (Guideline 3.1.2).
    /// Kept factual and free of marketing so it reads the same to App Review
    /// as it does to a subscriber.
    static let renewalTerms =
        "Monthly or yearly subscription.  Payment is charged to your Apple Account at "
        + "confirmation of purchase, and renews automatically at the same price unless you "
        + "cancel at least 24 hours before the period ends.  Manage or cancel anytime in "
        + "Settings › Apple Account › Subscriptions."

    /// Empty StoreKit catalog: Restore stays, website checkout does not.
    /// Guideline 3.1.1 — same digital good as IAP.
    static let emptyCatalogMessage = "In-app purchase isn't available.  Try again later."

    /// StoreKit could not load the product list (network/App Store hiccup).
    static func catalogLoadFailureMessage(_ error: Error) -> String {
        "Couldn't load subscription plans from the App Store.  Check your connection and try again, or tap Restore Purchases if you already subscribed.  ("
            + ((error as? LocalizedError)?.errorDescription ?? error.localizedDescription) + ")"
    }

    /// StoreKit rejected or aborted the purchase sheet before Apple charged
    /// anyone.  Must not use the post-charge redeem copy.
    static func purchaseFailureMessage(_ error: Error) -> String {
        if let apiError = error as? APIError {
            switch apiError {
            case .transport:
                return apiError.isOffline
                    ? "You're offline.  Reconnect and try the purchase again."
                    : "Couldn't reach the App Store.  Try again in a moment."
            case .server(let status, let message, _):
                if status == 429 {
                    return "Too many purchase attempts.  Wait a minute and try again."
                }
                if !message.isEmpty, message != "Request failed" {
                    return "Couldn't complete the purchase.  \(message)"
                }
                return "Couldn't complete the purchase (error \(status)).  Try again or tap Restore Purchases."
            case .invalidResponse:
                return "Couldn't complete the purchase.  Try again in a moment."
            }
        }
        if let storeKit = error as? StoreKitError {
            switch storeKit {
            case .networkError:
                return "Couldn't reach the App Store.  Check your connection and try again."
            case .notAvailableInStorefront:
                return "These plans aren't available in your App Store region yet."
            case .notEntitled:
                return "This Apple ID can't purchase subscriptions right now.  Check Screen Time or payment restrictions in Settings."
            case .userCancelled:
                return ""
            default:
                break
            }
        }
        let detail = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        return "Couldn't start the App Store purchase.  Try again in a moment, or tap Restore Purchases if you already subscribed.  ("
            + detail + ")"
    }

    /// True when StoreKit reported a user cancel that surfaced as a thrown
    /// error instead of `.userCancelled` on the purchase result.
    static func isQuietPurchaseCancellation(_ error: Error) -> Bool {
        if let storeKit = error as? StoreKitError, case .userCancelled = storeKit {
            return true
        }
        let nsError = error as NSError
        return nsError.domain == SKErrorDomain && nsError.code == SKError.paymentCancelled.rawValue
    }

    /// Delivery paywall.  In-App Purchase only — no website Stripe CTA.
    static let deliveryUpgradeMessage =
        "1-week free trial, then $8.99/month or $79.99/year.  Upgrade with In-App Purchase to create SSE/webhook deliveries.  Existing deliveries still appear below."

    static func subtitle(for product: Product) -> String? {
        switch AppleIAPProduct(rawValue: product.id) {
        case .monthly: return "Billed monthly.  Cancel anytime."
        case .annual: return "Billed yearly — two months cheaper than monthly."
        case nil: return nil
        }
    }

    /// Never hand a raw transport/HTTP string to someone Apple has already
    /// charged. The purchase itself succeeded; what failed is our side
    /// recording it, and the recovery is Restore Purchases, not buying again.
    static func redeemFailureMessage(_ error: Error) -> String {
        let detail = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        return "Apple took the purchase, but Congress.Trade could not confirm it yet.  "
            + "Nothing was lost — tap Restore Purchases in a moment, or reopen the app.  ("
            + detail + ")"
    }
}
