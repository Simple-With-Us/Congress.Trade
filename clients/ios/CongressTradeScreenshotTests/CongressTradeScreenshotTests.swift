import StoreKitTest
import XCTest

/// App Store screenshot lane (`.github/workflows/ios-screenshots.yml`).
///
/// Drives the real app UI on a booted simulator. A local StoreKit
/// configuration (`CongressTradeScreenshots.storekit`) makes StoreKit return
/// the current offer - 1-week free trial, $8.99/month, $79.99/year - so the
/// paywall renders the same copy App Review and subscribers see, with no
/// sandbox account and no App Store round trip.
///
/// Every capture is an XCTAttachment with lifetime `.keepAlways`; the
/// workflow exports them from the .xcresult bundle and renames them into the
/// App Store Connect asset names.
final class CongressTradeScreenshotTests: XCTestCase {

    private var storeKitSession: SKTestSession!

    override func setUpWithError() throws {
        continueAfterFailure = false
        storeKitSession = try SKTestSession(configurationFileNamed: "CongressTradeScreenshots")
        storeKitSession.resetToDefaultState()
        storeKitSession.disableDialogs = true
        storeKitSession.clearTransactions()
    }

    override func tearDownWithError() throws {
        storeKitSession = nil
    }

    @MainActor
    func testCaptureAppStoreScreenshots() throws {
        // Scene 1: the paywall. `-screenshotPaywall` is an existing app launch
        // argument (App.swift) that presents the Premium sheet on launch.
        let app = XCUIApplication()
        app.launchArguments = ["-screenshotPaywall"]
        app.launch()

        // The paywall must show the current offer; a stale or empty render
        // fails the run so a bad screenshot can never ship silently.
        let trialLine = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS[c] %@", "1-week free trial"))
            .firstMatch
        XCTAssertTrue(
            trialLine.waitForExistence(timeout: 90),
            "Paywall did not render '1-week free trial' within 90s"
        )
        let monthlyPrice = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS[c] %@", "$8.99"))
            .firstMatch
        let annualPrice = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS[c] %@", "$79.99"))
            .firstMatch
        XCTAssertTrue(monthlyPrice.waitForExistence(timeout: 30), "Paywall missing $8.99 monthly price")
        XCTAssertTrue(annualPrice.waitForExistence(timeout: 30), "Paywall missing $79.99 annual price")
        capture("paywall")

        // Scene 2+: the tabs. Fresh launch without the paywall flag.
        app.terminate()
        let tabs = XCUIApplication()
        tabs.launchArguments = []
        tabs.launch()

        // The cold-start disclaimer intro expands for ~4s, then auto-hides.
        // Wait for the Trends content before the first capture.
        _ = tabs.tabBars.firstMatch.waitForExistence(timeout: 60)
        sleep(8)
        capture("trends")

        tapTab(tabs, label: "Trades")
        sleep(4)
        capture("trades")

        // The account surface (sign-in, Premium, theme, legal) lives behind
        // the header hamburger (accessibility label "Menu").
        let menuButton = tabs.buttons["Menu"].firstMatch
        if menuButton.waitForExistence(timeout: 10) {
            menuButton.tap()
            sleep(3)
            capture("account")
        }
    }

    @MainActor
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func tapTab(_ app: XCUIApplication, label: String) {
        let tabButton = app.tabBars.buttons[label].firstMatch
        if tabButton.waitForExistence(timeout: 10) {
            tabButton.tap()
            return
        }
        // iPad can surface the tab items as plain buttons depending on the
        // tab bar / sidebar presentation.
        let plainButton = app.buttons[label].firstMatch
        if plainButton.waitForExistence(timeout: 5) {
            plainButton.tap()
        }
    }
}
