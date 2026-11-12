import Foundation

/// Routes "Manage Subscription" to the correct surface for the signed-in
/// user's entitlement source, shared by every manage-subscription entry
/// point (the header hamburger's `AccountQuickMenu` + `PremiumSheet`'s
/// "Your Subscription" section).
///
/// `entitlement.source` (`"stripe" | "apple" | nil`) exists precisely to
/// make this choice (`app/docs/client-mobile-api.md` "Entitlement
/// semantics"): Apple IAP subscribers manage their subscription on the App
/// Store; Stripe subscribers have NOTHING to manage there. Apple IAP was
/// disabled until 2026-08-09, so every pre-existing Premium user is
/// Stripe-sourced (or `nil`, its safe default) — routing everyone to the App
/// Store page regardless of source, as both call sites previously did,
/// landed real paying Stripe customers on a dead page.
extension CongressTradeStore {
    enum ManageSubscriptionOutcome: Equatable {
        case url(URL)
        case failed(message: String)
    }

    /// Resolves where "Manage Subscription" should send the user:
    /// - `source == "apple"` → the App Store subscriptions page directly (no
    ///   network call — Apple, not us, owns that state).
    /// - Stripe or `nil` (the safe default for website Premium) →
    ///   `POST /billing/portal` mints a short-lived Stripe-hosted portal URL
    ///   (web parity, `app/src/billing/routes.ts`). On portal failure, open
    ///   the website manage path (`/?billing=manage`) instead of ever falling
    ///   back to the Apple URL or telling a web subscriber to sign out.
    ///   Offline stays an inline message: Safari cannot help without a
    ///   network.
    func resolveManageSubscriptionURL() async -> ManageSubscriptionOutcome {
        if entitlementSource == "apple" {
            return Self.outcome(
                entitlementSource: entitlementSource,
                webFallbackURL: api.webManageSubscriptionURL,
                portalResult: nil
            )
        }
        do {
            let url = try await api.billingPortalURL()
            return Self.outcome(
                entitlementSource: entitlementSource,
                webFallbackURL: api.webManageSubscriptionURL,
                portalResult: .success(url)
            )
        } catch {
            return Self.outcome(
                entitlementSource: entitlementSource,
                webFallbackURL: api.webManageSubscriptionURL,
                portalResult: .failure(error)
            )
        }
    }

    /// Pure routing used by `resolveManageSubscriptionURL` and XCTest.
    /// `portalResult` is ignored for Apple (App Store URL wins).
    static func outcome(
        entitlementSource: String?,
        appleManageURL: URL = CongressTradeAPIClient.appStoreManageSubscriptionsURL,
        webFallbackURL: URL,
        portalResult: Result<URL, Error>?
    ) -> ManageSubscriptionOutcome {
        if entitlementSource == "apple" {
            return .url(appleManageURL)
        }
        switch portalResult {
        case .success(let url):
            return .url(url)
        case .failure(let error):
            if shouldOpenWebManageFallback(for: error) {
                return .url(webFallbackURL)
            }
            return .failed(message: portalFailureMessage(for: error))
        case nil:
            return .url(webFallbackURL)
        }
    }

    /// Website/Stripe Premium: open Congress.Trade so the signed-in web
    /// session (or Sign In on the site) can reach Stripe Customer Portal.
    /// Guideline 3.1.1: this is manage-existing-web-billing, never web
    /// checkout. Offline stays in-app because Safari cannot load either
    /// surface.
    static func shouldOpenWebManageFallback(for error: Error) -> Bool {
        if let apiError = error as? APIError, apiError.isOffline {
            return false
        }
        return true
    }

    static func portalFailureMessage(for error: Error) -> String {
        guard let apiError = error as? APIError else {
            return "Couldn't open your billing portal.  Please try again, or manage it on Congress.Trade."
        }
        switch apiError {
        case .transport:
            return apiError.isOffline
                ? "You're offline.  Reconnect and try Manage Subscription again."
                : "Couldn't reach Congress.Trade.  Please try again."
        case .server(let status, let message, _):
            switch status {
            case 401:
                return "Couldn't open the billing portal from this app session.  Open Congress.Trade on the web to manage this subscription."
            case 503:
                return "The billing portal isn't available right now.  Please try again shortly, or manage it on Congress.Trade."
            case 400:
                return "No billing account found for Manage Subscription yet.  Open Congress.Trade on the web, or contact support if this seems wrong."
            default:
                return message.isEmpty
                    ? "Couldn't open your billing portal.  Please try again, or manage it on Congress.Trade."
                    : message
            }
        case .invalidResponse:
            return "Couldn't open your billing portal right now.  Please try again, or manage it on Congress.Trade."
        }
    }
}
