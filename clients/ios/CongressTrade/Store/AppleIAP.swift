import Foundation
import StoreKit

/// Redeeming App Store purchases against the Congress.Trade backend.
///
/// Four rules this file exists to keep:
///
/// 1. **Apple's money is already gone by the time we run.** `product.purchase()`
///    returning `.success` means the customer was charged. Every failure after
///    that point is OUR bookkeeping failing, so it must be retried
///    automatically and never reported as if the purchase itself failed.
/// 2. **A transaction is finished only once the server has it** (with one
///    exception — see `observeAppleTransactions()`). Calling
///    `transaction.finish()` before the server call succeeds throws away the
///    only durable record that we still owe this customer Premium.
///    Unfinished transactions are re-delivered by `Transaction.updates`, which
///    is what makes retry work at all.
/// 3. **No account is required to buy** (Guideline 5.1.1(v)). PDF download and
///    CSV export are content, not account-specific functionality, so a
///    signed-out purchase must work end to end: `redeemAppleTransactionAnonymously`
///    records it against this DEVICE via `POST
///    /api/client/v1/entitlements/apple/redeem`, no session required. Signing
///    in later is optional and only adds cross-device access + Delivery
///    alerts — it is never the gate on the purchase itself.
/// 4. **Linking a purchase to an account is always an explicit user action**
///    (owner directive 2026-08-21 — Premium belongs to the ACCOUNT, usable on
///    website or app once linked). A device's Apple purchase must never make
///    every account that signs into it look Premium, and a claimed ledger row
///    cannot be reassigned later — so this app only ever calls the
///    authenticated `link_apple_entitlement` / `redeem_apple_purchase`
///    commands from an explicit Link tap (`linkAppleEntitlementToCurrentAccount`)
///    or an explicit Restore Purchases tap. Every automatic/background path
///    (sign-in, the `Transaction.updates` listener, the launch-time quiet
///    reconcile) only PROBES ownership read-only
///    (`refreshAppleEntitlementOwnership`) and never claims anything.
extension CongressTradeStore {
    /// Redeem one verified StoreKit transaction against the SIGNED-IN
    /// account, then finish it.
    ///
    /// `finish()` is deliberately *after* the server call: an unfinished
    /// transaction is redelivered to `observeAppleTransactions()` on the next
    /// launch, so a failed redeem self-heals instead of stranding a paying
    /// customer on the free tier.
    func redeemAppleTransaction(_ transaction: Transaction, jws: String) async throws {
        _ = try await api.redeemApplePurchase(signedTransaction: jws)
        await transaction.finish()
        await refresh()
        await refreshLocalAppleEntitlement()
    }

    /// Anonymous counterpart of `redeemAppleTransaction` (Guideline
    /// 5.1.1(v)) — no session required or sent. Records the purchase against
    /// this DEVICE (`apple_subscriptions.user_id = NULL`) and caches the
    /// resulting device entitlement token so PDF / CSV requests can present
    /// it. Returns whether the purchase is now recognized as Premium.
    ///
    /// Also doubles as the READ-ONLY row-3/row-4 ownership probe (see
    /// `refreshAppleEntitlementOwnership` below) when called while signed
    /// in: the server route this hits never assigns an account (it always
    /// upserts with `userId: null`), so calling it cannot silently link
    /// anything — an already-claimed row simply 409s, which is a fact-find,
    /// not a side effect.
    ///
    /// Does NOT finish the transaction — callers decide (see call sites):
    /// the live `.updates` listener wants it left open so it is redelivered
    /// once the person signs in and can be linked to an account; the
    /// `currentEntitlements`-based sweeps (reconcile/restore) finish it
    /// themselves because sign-in re-derives the same transaction from
    /// `Transaction.currentEntitlements`, not from `.updates` redelivery.
    @discardableResult
    func redeemAppleTransactionAnonymously(jws: String) async throws -> Bool {
        let result = try await api.redeemAppleEntitlementAnonymously(signedTransaction: jws)
        if let token = result.deviceEntitlementToken, !token.isEmpty {
            try? api.deviceEntitlementStore.save(token)
        }
        await refreshLocalAppleEntitlement()
        return result.entitlement?.premium == true
    }

    /// Recomputes `hasLocalAppleEntitlement` from `Transaction.currentEntitlements`.
    /// UI state only — never treated as authorization for a network request;
    /// every server call still carries a real signed JWS or the server-issued
    /// device entitlement token, never this flag by itself.
    func refreshLocalAppleEntitlement() async {
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  AppleIAPProduct(rawValue: transaction.productID) != nil,
                  transaction.revocationDate == nil else { continue }
            if let expirationDate = transaction.expirationDate, expirationDate < Date() { continue }
            hasLocalAppleEntitlement = true
            return
        }
        hasLocalAppleEntitlement = false
    }

    /// Redeem every current entitlement on this Apple Account. Returns whether
    /// any active subscription was found. Used by Restore Purchases (explicit
    /// tap — `allowSignedInLink` defaults `true`) and by the silent
    /// launch-time reconcile (`reconcileAppleEntitlementsQuietly`, which
    /// passes `false`).
    ///
    /// Signed out: anonymous redeem (Guideline 5.1.1(v) — device-scoped, no
    /// account required). Signed in and already Premium: authenticated
    /// redeem — this is only ever a renewal/refresh of a grant this account
    /// already has, never a new claim. Signed in and NOT Premium: the
    /// authenticated CLAIM only runs when `allowSignedInLink` is true, i.e.
    /// the caller is an explicit user action (Restore Purchases); the silent
    /// reconcile instead falls back to the read-only ownership probe so a
    /// launch never silently links an unclaimed-or-foreign transaction to
    /// whoever happens to be signed in.
    @discardableResult
    func redeemCurrentAppleEntitlements(allowSignedInLink: Bool = true) async throws -> Bool {
        var confirmed = false
        var firstError: Error?
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result else { continue }
            do {
                if signedIn {
                    if isPremium || allowSignedInLink {
                        _ = try await api.redeemApplePurchase(signedTransaction: result.jwsRepresentation)
                        await transaction.finish()
                        confirmed = true
                    } else {
                        await refreshAppleEntitlementOwnership(force: true)
                    }
                } else {
                    _ = try await redeemAppleTransactionAnonymously(jws: result.jwsRepresentation)
                    await transaction.finish()
                    confirmed = true
                }
            } catch {
                // Keep going: one bad row must not block the others. Signed
                // in, that's typically "already linked to a different
                // account" (surfaced to the caller below, not swallowed —
                // see `PremiumSheet.restore()`); signed out, the anonymous
                // route returns the same 409 when this transaction is
                // already claimed by SOME account.
                if firstError == nil { firstError = error }
            }
        }
        await refresh()
        if !confirmed, let firstError { throw firstError }
        return confirmed
    }

    /// Long-lived listener for transactions that arrive outside a purchase
    /// call: Ask to Buy approvals, renewals, subscription changes made in
    /// Settings, purchases interrupted by a crash — and, crucially, retries of
    /// a purchase whose redeem failed the first time.
    ///
    /// StoreKit 2 requires an app to observe this for the whole of its
    /// lifetime; the app previously had no such listener anywhere, which is why
    /// a redeem that failed once stayed failed until the customer happened to
    /// find Restore Purchases themselves.
    func observeAppleTransactions() async {
        for await result in Transaction.updates {
            guard case .verified(let transaction) = result else { continue }
            guard signedIn else {
                // Not signed in: grant this DEVICE its own access right away
                // (Guideline 5.1.1(v) — a purchase that is not account-based
                // must not wait on an account) but leave the transaction
                // UNFINISHED so it is delivered again after sign-in and can
                // still be linked to an account, rather than silently dropped.
                try? await redeemAppleTransactionAnonymously(jws: result.jwsRepresentation)
                continue
            }
            guard PremiumAccessGate.shouldAutoRedeemOnTransactionUpdate(
                isPremium: isPremium,
                entitlementSource: entitlementSource
            ) else {
                // Signed in but this is not a renewal of an Apple grant this
                // account already has. A leftover unfinished signed-out
                // purchase (Guideline 5.1.1(v)) is still unclaimed — Stripe
                // Premium must not attach it. Probe only; Link / Restore
                // claim. Left unfinished so it keeps being redelivered.
                await refreshAppleEntitlementOwnership(force: true)
                continue
            }
            // Apple-backed Premium already on this account — renewal/refresh
            // of that SAME grant, not a new claim. Left unfinished on
            // failure so the next launch retries.
            try? await redeemAppleTransaction(transaction, jws: result.jwsRepresentation)
        }
    }

    /// One-shot catch-up at launch for anything `Transaction.updates` will not
    /// replay on its own (a transaction finished locally before the server
    /// ever recorded it). Silent by design: the customer is not waiting on it.
    ///
    /// Runs signed in OR signed out — a signed-out launch also refreshes/
    /// claims this device's own anonymous access (Guideline 5.1.1(v)), which
    /// doubles as how the device entitlement token gets renewed before its
    /// short (<=24h) expiry on every app open. Signed in and not yet
    /// Premium, this only probes ownership (`allowSignedInLink: false`) —
    /// silent paths never claim a purchase to whoever happens to be signed
    /// in.
    func reconcileAppleEntitlementsQuietly() async {
        await refreshLocalAppleEntitlement()
        guard !isPremium else { return }
        _ = try? await redeemCurrentAppleEntitlements(allowSignedInLink: false)
    }

    /// Read-only probe for the current account's row-3/row-4 status (see
    /// `AppleEntitlementOwnership`). Reuses the anonymous redeem route —
    /// it never assigns an account, so calling it while signed in cannot
    /// silently link anything: it only confirms the transaction is still
    /// unclaimed (success) or reports the existing owner-mismatch (a 409,
    /// surfaced into `appleEntitlementOwnership` instead of swallowed).
    ///
    /// Resets to `.unknown` whenever the signed-in account changes (a
    /// different account gets its own fresh check, never a stale
    /// conflict/offer left over from someone else), and no-ops once already
    /// resolved for the CURRENT account unless `force` — cheap to call from
    /// every `refresh()` without hammering the network.
    ///
    /// Deliberately does NOT gate on the cached `hasLocalAppleEntitlement`
    /// flag: a caller reached via `Transaction.updates`
    /// (`observeAppleTransactions`) can have a fresher, still-unflushed
    /// verified entitlement in hand than that flag reflects, and checking
    /// `Transaction.currentEntitlements` directly below is a local StoreKit
    /// read (no network) even when there is nothing to find.
    func refreshAppleEntitlementOwnership(force: Bool = false) async {
        guard signedIn, let userID = signedInUser?.id else {
            appleEntitlementOwnership = .unknown
            appleEntitlementOwnershipAccountID = nil
            return
        }
        if appleEntitlementOwnershipAccountID != userID {
            appleEntitlementOwnershipAccountID = userID
            appleEntitlementOwnership = .unknown
            appleLinkPromptDismissedForCurrentAccount = Self.loadAppleLinkPromptDismissed(userID: userID)
        }
        guard !isPremium else { return }
        guard force || appleEntitlementOwnership == .unknown else { return }
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  AppleIAPProduct(rawValue: transaction.productID) != nil,
                  transaction.revocationDate == nil else { continue }
            do {
                _ = try await redeemAppleTransactionAnonymously(jws: result.jwsRepresentation)
                appleEntitlementOwnership = PremiumAccessGate.ownership(afterProbe: .success(()))
            } catch {
                appleEntitlementOwnership = PremiumAccessGate.ownership(afterProbe: .failure(error))
            }
            return
        }
    }

    /// Explicit-consent claim of THIS device's own Apple purchase for the
    /// signed-in account — the row-4 "Link" tap. The ONLY places besides
    /// Restore Purchases (`redeemCurrentAppleEntitlements`) this app calls
    /// the authenticated `link_apple_entitlement` command. Never invoked
    /// automatically: a claimed ledger row cannot be reassigned later, so
    /// someone who signs in, decides they want a DIFFERENT account, and
    /// signs out again must still be free to link there instead — which is
    /// exactly what silent auto-linking used to take away.
    @discardableResult
    func linkAppleEntitlementToCurrentAccount() async -> Bool {
        guard signedIn, !isPremium, hasLocalAppleEntitlement else { return false }
        var linked = false
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  AppleIAPProduct(rawValue: transaction.productID) != nil else { continue }
            do {
                _ = try await api.linkAppleEntitlement(signedTransaction: result.jwsRepresentation)
                await transaction.finish()
                linked = true
            } catch {
                appleEntitlementOwnership = PremiumAccessGate.ownership(afterProbe: .failure(error))
                appleLinkNotice = appleEntitlementOwnership == .linkedToOtherAccount
                    ? "This Apple purchase is already linked to a different account.  "
                        + "Sign out and sign in with that account, or tap Restore Purchases to confirm."
                    : "Could not link this purchase yet.  \(PremiumPricing.redeemFailureMessage(error))"
            }
        }
        if linked {
            appleLinkNotice = "Linked.  This Apple purchase now unlocks Premium on this account everywhere."
            await refresh()
        }
        return linked
    }

    /// "Not now" on the row-4 link offer (`PremiumSheet` / the launch-time
    /// alert) — remembered per account so it does not nag every launch. The
    /// Link action itself stays permanently available afterward from the
    /// Premium sheet and Restore Purchases either way.
    func dismissAppleLinkPrompt() {
        guard let userID = signedInUser?.id else { return }
        UserDefaults.standard.set(true, forKey: Self.appleLinkPromptDismissedKey(userID: userID))
        appleLinkPromptDismissedForCurrentAccount = true
    }

    private static func appleLinkPromptDismissedKey(userID: String) -> String {
        "trade.congress.appleLinkPromptDismissed.\(userID)"
    }

    fileprivate static func loadAppleLinkPromptDismissed(userID: String) -> Bool {
        UserDefaults.standard.bool(forKey: appleLinkPromptDismissedKey(userID: userID))
    }
}

/// Who currently owns THIS device's verified Apple subscription, from the
/// Congress.Trade account's point of view — truth-table rows 3 vs 4 (see
/// `PremiumAccessGate` below). Resolved by `refreshAppleEntitlementOwnership`,
/// a READ-ONLY probe that never claims anything; only an explicit Link tap
/// or Restore Purchases calls the authenticated commands.
enum AppleEntitlementOwnership: Equatable {
    /// Not yet checked for the current account (or nothing to check yet).
    /// Feature gating treats this the same as `.unclaimed` — a payer must
    /// never be stranded while a background probe is still in flight.
    case unknown
    /// Nobody has claimed this transaction yet.
    case unclaimed
    /// A DIFFERENT Congress.Trade account already claimed this transaction
    /// (the `owner_mismatch` 409 from `upsertAppleSubscription`).
    case linkedToOtherAccount
}

/// Pure truth-table gate — owner directive 2026-08-21 ("It should be linked
/// to an account which can be used via website or iOS app both"). Kept
/// separate from `CongressTradeStore` so it is directly unit-testable
/// without StoreKit:
///
/// | # | signed in | server Premium | device entitlement          | access |
/// |---|-----------|-----------------|------------------------------|--------|
/// | 1 | no        | n/a             | verified, unclaimed          | YES (Guideline 5.1.1(v)) |
/// | 2 | yes       | true            | any                          | YES |
/// | 3 | yes       | false           | linked to ANOTHER account    | NO  |
/// | 4 | yes       | false           | unclaimed / not yet resolved | YES (never strand a payer) |
enum PremiumAccessGate {
    /// Whether the UI should currently treat the device as Premium for
    /// feature gating (archived filing PDF, CSV export). Replaces the old
    /// `isPremium || hasLocalAppleEntitlement` OR-gate, which let ANY
    /// device purchase unlock EVERY signed-in account.
    static func granted(
        isPremium: Bool,
        signedIn: Bool,
        hasLocalAppleEntitlement: Bool,
        ownership: AppleEntitlementOwnership
    ) -> Bool {
        if isPremium { return true }
        guard hasLocalAppleEntitlement else { return false }
        guard signedIn else { return true }
        return ownership != .linkedToOtherAccount
    }

    /// Row 4: should the "Link this subscription to your account?" prompt
    /// show right now. Never itself the gate for `granted` above — access is
    /// already open; this only controls whether to ASK for the explicit
    /// consent to persist it (never link silently).
    static func showsLinkOffer(
        isPremium: Bool,
        signedIn: Bool,
        hasLocalAppleEntitlement: Bool,
        ownership: AppleEntitlementOwnership,
        dismissedForAccount: Bool
    ) -> Bool {
        signedIn && !isPremium && hasLocalAppleEntitlement
            && ownership == .unclaimed && !dismissedForAccount
    }

    /// Row 3: say plainly this Apple purchase belongs to a different
    /// account, rather than silently gating out with no explanation.
    static func showsConflict(
        isPremium: Bool,
        signedIn: Bool,
        hasLocalAppleEntitlement: Bool,
        ownership: AppleEntitlementOwnership
    ) -> Bool {
        signedIn && !isPremium && hasLocalAppleEntitlement && ownership == .linkedToOtherAccount
    }

    /// `Transaction.updates` may authenticated-redeem only when this account
    /// already has an Apple-backed grant.  `isPremium` is also true for
    /// Stripe, and `resolveEntitlementAsync` returns `source: "stripe"`
    /// without reading the Apple ledger — so a Stripe session on a device
    /// with an unfinished signed-out purchase must not call
    /// `redeem_apple_purchase` (that command assigns `user.id` onto a
    /// NULL-owner row, permanently).  Unknown/`nil` source is treated the
    /// same as Stripe: probe only.  Apple renewals still auto-apply.
    static func shouldAutoRedeemOnTransactionUpdate(
        isPremium: Bool,
        entitlementSource: String?
    ) -> Bool {
        isPremium && entitlementSource == "apple"
    }

    /// Interprets the outcome of the read-only ownership probe
    /// (`POST /entitlements/apple/redeem`, called while signed in — it never
    /// assigns an account, it only reports whether the row is still
    /// unclaimed or already owned by someone else). A 409 here is the
    /// `owner_mismatch` conflict, surfaced as `.linkedToOtherAccount` rather
    /// than swallowed (the old `linkAppleEntitlementIfNeeded` used to
    /// `try?` this away). Any other failure (offline, 5xx) leaves ownership
    /// `.unknown` so a transient error never wrongly reports a conflict.
    static func ownership(afterProbe result: Result<Void, Error>) -> AppleEntitlementOwnership {
        switch result {
        case .success:
            return .unclaimed
        case .failure(let error):
            if let apiError = error as? APIError, case .server(let status, _, _) = apiError, status == 409 {
                return .linkedToOtherAccount
            }
            return .unknown
        }
    }
}
