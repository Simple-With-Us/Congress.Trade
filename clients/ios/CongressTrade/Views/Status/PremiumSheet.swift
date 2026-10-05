import StoreKit
import SwiftUI

/// The one Premium screen: what Premium unlocks, the price, the actual App
/// Store products, and a prominent way out — no "See Plans" hop in between.
///
/// This used to be two sheets. `PremiumInfoSheet` sold Premium as a benefit
/// list and then pushed `SubscribeView`, which re-explained the same thing as
/// one dense paragraph and only there showed the products. Two screens meant
/// two copies of the pricing/trial line, and they drifted.
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
/// - `trade.congress.premium.monthly`
/// - `trade.congress.premium.annual`
///
/// Prices and free-trial length are NOT hardcoded here — Apple localizes the
/// real price per storefront, so all UI price/trial text is built at runtime
/// from `Product.displayPrice`, `Product.subscription?.subscriptionPeriod`, and
/// the product's introductory offer when it is a `.freeTrial` payment mode.
/// App Store Connect is the source of truth.  As of 2026-08-14, the US
/// storefront lists $8.99/mo and $79.99/yr with a 1-week free-trial intro
/// offer; other storefronts may differ.
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
        .init(systemImage: "arrow.down.doc", text: "Full-history CSV export"),
        .init(
            systemImage: "bolt.horizontal",
            text: "Instant delivery of new filings — signed webhook or SSE, up to two methods"
        ),
        .init(systemImage: "bell", text: "Push notifications when a new filing lands"),
    ]

    private var isBusy: Bool { purchasingProductID != nil || isRestoring || isLinking }

    /// Headline copy driven by loaded `Product`s.  While products are still
    /// loading, empty, or failed to load, falls back to a price-free,
    /// trial-length-free line so we never quote an amount we can't substantiate.
    private var headlineText: String {
        let quotes = products.compactMap(PremiumPlanQuote.init(product:))
        return PremiumPricing.headline(for: quotes)
    }

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

                    Text(headlineText)
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
        let quote = PremiumPlanQuote(product: product)
        let subtitle = PremiumPricing.subtitle(for: product, quote: quote)
        let button = Button {
            Task { await purchase(product) }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(product.displayName)
                        .font(.body.weight(.semibold))
                    if let subtitle {
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

/// One home for the price/trial line so the phone can never drift from the web.
/// The displayed price, period, and free-trial length come from StoreKit at
/// runtime (`Product.displayPrice`, `Product.subscription?.subscriptionPeriod`,
/// `Product.subscription?.introductoryOffer` when `paymentMode == .freeTrial`) so
/// Apple can localize the real price per storefront. App Store Connect is the
/// source of truth.  As of 2026-08-14, the US storefront lists $8.99/mo and
/// $79.99/yr with a 1-week free-trial introductory offer; other storefronts may
/// differ.
enum PremiumPricing {
    /// Used before StoreKit returns products (loading, empty catalog, or load
    /// error).  Never contains a "$" literal or a hardcoded trial length.
    static let fallbackHeadline = "Monthly or yearly plans  •  Cancel anytime"

    /// Build the headline from a list of `PremiumPlanQuote` values derived
    /// from loaded StoreKit `Product`s.  Returns `fallbackHeadline` when no
    /// quotes are supplied.
    static func headline(for quotes: [PremiumPlanQuote]) -> String {
        guard !quotes.isEmpty else { return fallbackHeadline }
        let monthly = quotes.first { $0.periodUnit == .month && $0.periodValue == 1 }
        let yearly = quotes.first { $0.periodUnit == .year && $0.periodValue == 1 }
        let trialQuote = quotes.first { $0.freeTrial != nil }

        var parts: [String] = []
        if let monthly {
            parts.append("\(monthly.displayPrice)/month")
        }
        if let yearly {
            parts.append("\(yearly.displayPrice)/year")
        }
        // For non-USD locales there's no guarantee both monthly/yearly products
        // are present; if we only have one product (or the subscription periods
        // are not 1 month / 1 year), describe the cadence from the period we
        // actually loaded so the user still sees something period-shaped.
        if parts.isEmpty {
            if let only = quotes.first {
                parts.append("\(only.displayPrice)/\(only.periodPhrase)")
            }
        }
        if let trial = trialQuote, let ft = trial.freeTrial {
            parts.append("\(ft.value)-\(ft.unit.phrase) free trial")
        }
        return parts.joined(separator: "  •  ")
    }

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
    /// Apple handles the actual price and trial copy in the App Store
    /// purchase sheet, so this string only needs to say "upgrade with In-App
    /// Purchase"; it must keep "in-app purchase" so the
    /// `testIOSNeverOffersWebCheckoutForDigitalGoods` assertion stays valid.
    static let deliveryUpgradeMessage =
        "Upgrade to Premium with In-App Purchase to create SSE/webhook deliveries.  Existing deliveries still appear below."

    /// Per-product button subtitle. Built from the StoreKit `Product` (period
    /// + free-trial intro offer) so the wording matches what App Store Connect
    /// currently publishes. Falls back to a period-only phrase when no intro
    /// offer is configured.
    static func subtitle(for product: Product, quote: PremiumPlanQuote?) -> String? {
        guard let quote else { return nil }
        if let ft = quote.freeTrial {
            return "\(ft.value)-\(ft.unit.phrase) free trial, then \(quote.displayPrice)/\(quote.periodPhrase)"
        }
        return "Billed \(quote.periodPhrase).  Cancel anytime."
    }

    /// Compute the yearly savings percentage against paying monthly, rounded
    /// down to a whole number. Returns nil when either quote is missing or the
    /// monthly price is zero (avoid divide-by-zero / meaningless math). The
    /// % claim is built from these two loaded products — never a hardcoded
    /// marketing number — so it follows App Store Connect if prices change.
    static func savingsPercent(monthly: PremiumPlanQuote?, annual: PremiumPlanQuote?) -> Int? {
        // Approximate the annualized monthly cost by multiplying the monthly
        // product's price by 12. Both `Decimal`s are positive for any real
        // StoreKit subscription; we guard against zero to keep the math sane.
        guard let monthly, let annual else { return nil }
        let monthlyPrice = monthly.price
        let annualPrice = annual.price
        guard monthlyPrice > 0 else { return nil }
        let annualizedMonthly = monthlyPrice * Decimal(12)
        guard annualizedMonthly > annualPrice else { return nil }
        let saved = annualizedMonthly - annualPrice
        // Use NSDecimalNumber for the ratio to avoid Double rounding.
        let ratio = NSDecimalNumber(decimal: saved / annualizedMonthly).doubleValue
        return Int(ratio * 100.0)
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

// MARK: - StoreKit-derived plan quote

/// Subscription-period unit translated into a small, UI-friendly vocabulary.
/// The unit words are the only English period words used in copy; Apple
/// already supplies a localized `displayName` on `Product.SubscriptionPeriod`
/// for any number other than 1 ("2 weeks", "3 months"), but the paywall copy
/// only ever needs the singular case so we do not duplicate that.
enum PremiumPeriodUnit {
    case day
    case week
    case month
    case year

    init(_ storeKit: Product.SubscriptionPeriod.Unit) {
        switch storeKit {
        case .day: self = .day
        case .week: self = .week
        case .month: self = .month
        case .year: self = .year
        @unknown default: self = .month
        }
    }

    /// Singular English noun, e.g. "month", "year", "week", "day".  All
    /// trial/period phrases in the app render with this noun — keep it
    /// singular and lowercase.
    var phrase: String {
        switch self {
        case .day: return "day"
        case .week: return "week"
        case .month: return "month"
        case .year: return "year"
        }
    }
}

/// Snapshot of everything the paywall needs to describe one Premium plan, as
/// pulled from a StoreKit `Product`.  Tests construct these directly without
/// StoreKit — see `PremiumPricing.headline(for:)` and the unit tests.
struct PremiumPlanQuote {
    let displayPrice: String
    let price: Decimal
    let periodUnit: PremiumPeriodUnit
    let periodValue: Int
    let freeTrial: (unit: PremiumPeriodUnit, value: Int)?

    /// Period rendered as "<value>-<unit>", e.g. "1-month", "1-year", "3-day".
    /// Singular noun used for all values; the App Store purchase sheet shows
    /// localized pluralization itself.
    var periodPhrase: String {
        "\(periodValue)-\(periodUnit.phrase)"
    }

    init?(product: Product) {
        guard let subscription = product.subscription else { return nil }
        let period = subscription.subscriptionPeriod
        self.displayPrice = product.displayPrice
        self.price = product.price
        self.periodUnit = PremiumPeriodUnit(period.unit)
        self.periodValue = period.value
        if let intro = subscription.introductoryOffer,
           intro.paymentMode == .freeTrial {
            self.freeTrial = .init(
                unit: PremiumPeriodUnit(intro.period.unit),
                value: intro.period.value
            )
        } else {
            self.freeTrial = nil
        }
    }

    /// Direct memberwise init for tests (no live StoreKit).
    init(
        displayPrice: String,
        price: Decimal,
        periodUnit: PremiumPeriodUnit,
        periodValue: Int,
        freeTrial: (unit: PremiumPeriodUnit, value: Int)?
    ) {
        self.displayPrice = displayPrice
        self.price = price
        self.periodUnit = periodUnit
        self.periodValue = periodValue
        self.freeTrial = freeTrial
    }
}
