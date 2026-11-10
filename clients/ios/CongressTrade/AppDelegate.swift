import UIKit
import UserNotifications

/// Destination encoded on an APNs payload.  Fan-out historically sent
/// camelCase (`docId`, `txIds`) while this delegate only read snake_case
/// (`trade_id`, `doc_id`), so a tap did nothing.  Accept both.
enum PushNotificationOpen: Equatable {
    case trade(id: String)
    case filing(docId: String)

    static func parse(_ userInfo: [AnyHashable: Any]) -> PushNotificationOpen? {
        if let tradeId = pushUserInfoString(userInfo, keys: ["trade_id", "tradeId"])
            ?? pushUserInfoFirstString(userInfo["txIds"]) {
            return .trade(id: tradeId)
        }
        if let docId = pushUserInfoString(userInfo, keys: ["doc_id", "docId"]) {
            return .filing(docId: docId)
        }
        return nil
    }
}

func pushUserInfoString(_ userInfo: [AnyHashable: Any], keys: [String]) -> String? {
    for key in keys {
        if let cleaned = pushUserInfoNonEmptyString(userInfo[key]) {
            return cleaned
        }
    }
    return nil
}

func pushUserInfoFirstString(_ value: Any?) -> String? {
    if let items = value as? [Any] {
        for item in items {
            if let cleaned = pushUserInfoNonEmptyString(item) {
                return cleaned
            }
        }
    }
    return pushUserInfoNonEmptyString(value)
}

func pushUserInfoNonEmptyString(_ value: Any?) -> String? {
    guard let value, let text = value as? String else { return nil }
    let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return cleaned.isEmpty ? nil : cleaned
}

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let tokenParts = deviceToken.map { String(format: "%02.2hhx", $0) }
        let tokenString = tokenParts.joined()
        Task { @MainActor in
            PushNotificationManager.shared.handleDeviceToken(tokenString)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in
            PushNotificationManager.shared.handleRegistrationError(error)
        }
    }

    // Handle in-app notification banner when app is in foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    // Handle user tapping on a push notification
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        switch PushNotificationOpen.parse(userInfo) {
        case .trade(let tradeId):
            NotificationCenter.default.post(
                name: NSNotification.Name("OpenTradeFromPush"),
                object: nil,
                userInfo: ["trade_id": tradeId]
            )
        case .filing(let docId):
            NotificationCenter.default.post(
                name: NSNotification.Name("OpenFilingFromPush"),
                object: nil,
                userInfo: ["doc_id": docId]
            )
        case nil:
            break
        }
        completionHandler()
    }
}
