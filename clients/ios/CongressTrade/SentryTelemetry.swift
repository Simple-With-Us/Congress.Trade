import Foundation
import Sentry

/// Native Sentry telemetry and crash reporting for Congress.Trade iOS.
///
/// DSN is read only from Info.plist (`SENTRY_DSN`). There is no hardcoded
/// fallback — missing or empty skips init so a leaked default cannot be
/// pointed at the wrong project.
///
/// Scope for CT (filings / PII-sensitive): errors, native crashes, app hangs,
/// and error-only Session Replay (session sample 0%, same PII bar as web).
/// No screenshots, no view hierarchy, no default PII.
enum SentryTelemetry {
    static func start() {
        if isScreenshotOrUITestLaunch { return }

        guard let dsn = plistString("SENTRY_DSN"), !dsn.isEmpty else { return }

        let releaseName = plistString("CFBundleShortVersionString")
        let dist = plistString("CFBundleVersion")

        SentrySDK.start { options in
            options.dsn = dsn
            #if DEBUG
            options.environment = "development"
            #else
            options.environment = "production"
            #endif
            if let releaseName, !releaseName.isEmpty {
                options.releaseName = releaseName
            }
            if let dist, !dist.isEmpty {
                options.dist = dist
            }
            options.tracesSampleRate = 0.2
            // sentry-cocoa 9 removed transaction-based profilesSampleRate.
            options.configureProfiling = {
                $0.sessionSampleRate = 0.1
                $0.lifecycle = .trace
            }
            options.enableAppHangTracking = true
            options.appHangTimeoutInterval = 2.0
            options.enableCaptureFailedRequests = true
            options.failedRequestStatusCodes = [HttpStatusCodeRange(min: 500, max: 599)]
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.sendDefaultPii = false
            options.sessionReplay.sessionSampleRate = 0
            options.sessionReplay.onErrorSampleRate = 1.0
            options.sessionReplay.maskAllText = true
            options.sessionReplay.maskAllImages = true
            options.beforeSend = { event in
                if let request = event.request, let url = request.url {
                    var sanitized = url
                    for param in [
                        "token", "key", "secret", "auth", "password",
                        "session", "bearer", "email", "code"
                    ] {
                        sanitized = sanitized.replacingOccurrences(
                            of: "([?&]\(param)=)[^&#\\s]+",
                            with: "$1[REDACTED]",
                            options: .regularExpression
                        )
                    }
                    request.url = sanitized
                }
                return event
            }
        }
    }

    /// Asc / UITest / screenshot launches stay silent so App Store shots do not
    /// mint noise on the congress-trade project.
    private static var isScreenshotOrUITestLaunch: Bool {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-ASCScreenshots") { return true }
        if args.contains("-screenshotPaywall") { return true }
        if args.contains("-showSubscribe") { return true }
        if ProcessInfo.processInfo.environment["ASC_SCREENSHOTS"] == "1" { return true }
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
            return true
        }
        return false
    }

    /// Report a response body that did not decode.
    ///
    /// Exists because `try?` on an optional-by-design analytics section is
    /// indistinguishable from "the server sent nothing": the Committee Sector
    /// Conflicts section was hidden on every launch for weeks because a model
    /// required three keys the route never sent, and nothing anywhere said so.
    /// A decode mismatch is a client/server contract break, so it should page
    /// us, not disappear.
    ///
    /// Sends the endpoint name and the decoder's own description only — never
    /// the response body, which on this app carries filing data.
    static func captureDecodeFailure(endpoint: String, error: Error) {
        if error is CancellationError { return }
        guard let decodingError = error as? DecodingError else { return }
        SentrySDK.capture(message: "Decode failed: \(endpoint)") { scope in
            scope.setLevel(.warning)
            scope.setExtras([
                "endpoint": endpoint,
                "reason": String(describing: decodingError),
            ])
        }
    }

    /// Last user-visible view name captured for bug-report context. Cheap
    /// to set (one UserDefaults string); read once per bug report so the
    /// Sentry feedback event says where the user was when something broke.
    static var lastBreadcrumbView: String?

    /// Owner 2026-09-21 ask: bug-report entry point (account menu + shake).
    /// Submits a Sentry User Feedback event with the comments, optional
    /// email, and a payload blob (app version + view + console context).
    /// Returns true when the event was sent to Sentry, false when Sentry
    /// is unconfigured (DSN blank) — the caller surfaces a friendly
    /// "try again or email support" message instead of swallowing the tap.
    static func captureUserFeedback(comments: String, email: String, payload: [String: Any]) async -> Bool {
        // Sentry.captureUserFeedback lives on SentrySDK. If the SDK isn't
        // configured (DSN blank in Info.plist), the call is a no-op and we
        // return false so the sheet shows its retry path.
        let eventId = SentrySDK.capture(message: "user_feedback: \(comments.prefix(80))") { scope in
            scope.setLevel(.info)
            scope.setExtras(payload.merging([
                "comments": comments,
                "feedback_email": email,
                "source": "bug_report_sheet",
            ], uniquingKeysWith: { _, new in new }))
        }
        let sent = (eventId != nil)
        if !sent {
            print("[SentryTelemetry] captureUserFeedback no-op: SDK not configured (SENTRY_DSN missing)")
        }
        return sent
    }

    /// Info.plist string, treating unsubstituted `$(VAR)` build settings as missing.
    private static func plistString(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if trimmed.hasPrefix("$(") { return nil }
        return trimmed
    }
}
