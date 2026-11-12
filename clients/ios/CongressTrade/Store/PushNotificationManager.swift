import SwiftUI
import UserNotifications
import Combine

@MainActor
final class PushNotificationManager: ObservableObject {
    static let shared = PushNotificationManager()

    private static let tokenDefaultsKey = "apns_device_token"
    private static let lastSyncedTokenKey = "apns_last_synced_token"
    private static let lastSyncedAtKey = "apns_last_synced_at"

    @Published var isAuthorized = false
    @Published var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published var deviceToken: String? {
        didSet {
            if let token = deviceToken {
                UserDefaults.standard.set(token, forKey: Self.tokenDefaultsKey)
            }
        }
    }
    @Published var lastError: String?
    @Published var isRegistering = false
    /// True after a successful backend register_device for the current token.
    @Published var isBackendSynced = false

    /// Prevent concurrent sync storms (refresh + token callback + Settings).
    private var syncTask: Task<Void, Never>?

    init() {
        if let storedToken = UserDefaults.standard.string(forKey: Self.tokenDefaultsKey) {
            self.deviceToken = storedToken
            let lastSynced = UserDefaults.standard.string(forKey: Self.lastSyncedTokenKey)
            self.isBackendSynced = (lastSynced == storedToken)
        }
        Task { await checkPermissionStatus() }
    }

    func checkPermissionStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
        isAuthorized = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
    }

    func requestAuthorization() async {
        isRegistering = true
        lastError = nil
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(
                options: [.alert, .sound, .badge]
            )
            await checkPermissionStatus()
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
            }
        } catch {
            lastError = error.localizedDescription
        }
        isRegistering = false
    }

    func handleDeviceToken(_ tokenString: String) {
        self.deviceToken = tokenString
        self.isAuthorized = true
        self.lastError = nil
        UserDefaults.standard.set(tokenString, forKey: Self.tokenDefaultsKey)
        // Token rotation invalidates prior backend sync.
        let lastSynced = UserDefaults.standard.string(forKey: Self.lastSyncedTokenKey)
        if lastSynced != tokenString {
            isBackendSynced = false
        }
    }

    func handleRegistrationError(_ error: Error) {
        self.lastError = error.localizedDescription
    }

    /// Upsert this device's APNs token on the backend. No-ops when already
    /// synced for the same token (unless `force`). Safe to call on every
    /// signed-in refresh — uses a stable idempotency key per token so the
    /// async command queue is not flooded.
    func syncTokenWithBackend(api: CongressTradeAPIClient, force: Bool = false) async {
        let token = deviceToken ?? UserDefaults.standard.string(forKey: Self.tokenDefaultsKey)
        guard let apnsToken = token, !apnsToken.isEmpty else { return }

        if !force {
            let lastSynced = UserDefaults.standard.string(forKey: Self.lastSyncedTokenKey)
            if lastSynced == apnsToken, isBackendSynced { return }
        }

        // Coalesce concurrent callers onto one in-flight task.
        if let existing = syncTask {
            await existing.value
            if !force,
               UserDefaults.standard.string(forKey: Self.lastSyncedTokenKey) == apnsToken,
               isBackendSynced {
                return
            }
        }

        let task = Task { @MainActor in
            await self.performSync(api: api, apnsToken: apnsToken)
        }
        syncTask = task
        await task.value
        if syncTask == task { syncTask = nil }
    }

    private func performSync(api: CongressTradeAPIClient, apnsToken: String) async {
        isRegistering = true
        defer { isRegistering = false }
        do {
            // Stable key so retries/replay map to one command row per token.
            let idempotencyKey = "apns-register-\(apnsToken.prefix(16))-\(apnsToken.suffix(8))"
            #if DEBUG
            let pushEnv = "development"
            #else
            let pushEnv = "production"
            #endif
            _ = try await api.registerDevice(
                apnsToken: apnsToken,
                env: pushEnv,
                idempotencyKey: idempotencyKey
            )
            UserDefaults.standard.set(apnsToken, forKey: Self.lastSyncedTokenKey)
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.lastSyncedAtKey)
            isBackendSynced = true
            lastError = nil
        } catch is CancellationError {
            // View/task teardown — not a user-facing failure.
        } catch {
            isBackendSynced = false
            lastError = error.localizedDescription
            print("[PushNotificationManager] Failed to register push token with backend:", error.localizedDescription)
        }
    }
}
