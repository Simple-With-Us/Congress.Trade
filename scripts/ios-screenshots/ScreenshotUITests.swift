import XCTest

/// App Store screenshot capture.  Runs only from the ios-screenshots workflow.
/// Writes PNGs to $SHOT_DIR (passed as TEST_RUNNER_SHOT_DIR) and also attaches
/// them to the result bundle.  The paywall relies on the StoreKit test config
/// in Shots.storekit (monthly 8.99, annual 79.99, 1-week free trial).
final class ScreenshotUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launch()
        sleep(6)
    }

    private func shot(_ name: String) {
        sleep(2)
        let image = XCUIScreen.main.screenshot()
        let env = ProcessInfo.processInfo.environment
        let dir = env["SHOT_DIR"] ?? NSTemporaryDirectory()
        let prefix = env["SHOT_PREFIX"] ?? "device"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = (dir as NSString).appendingPathComponent("\(prefix)_\(name).png")
        try? image.pngRepresentation.write(to: URL(fileURLWithPath: path))
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = "\(prefix)_\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func openTab(_ name: String) {
        let tab = app.tabBars.buttons[name]
        if tab.waitForExistence(timeout: 15) {
            tab.tap()
        } else {
            let any = app.buttons[name].firstMatch
            XCTAssertTrue(any.waitForExistence(timeout: 10), "tab \(name) not found")
            any.tap()
        }
        sleep(8)
    }

    func testTrends() {
        openTab("Trends")
        shot("01_trends")
    }

    func testTrades() {
        openTab("Trades")
        shot("02_trades")
    }

    func testDirectory() {
        openTab("Directory")
        shot("03_directory")
    }

    func testDelivery() {
        openTab("Delivery")
        shot("04_delivery")
    }

    func testPaywall() {
        let menu = app.buttons["Menu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 20), "Menu button not found")
        menu.tap()
        let premium = app.buttons["Premium"].firstMatch
        if premium.waitForExistence(timeout: 15) {
            premium.tap()
        } else {
            let text = app.staticTexts["Premium"].firstMatch
            XCTAssertTrue(text.waitForExistence(timeout: 5), "Premium row not found")
            text.tap()
        }
        let trial = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'free trial'")).firstMatch
        let trialButton = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'free trial'")).firstMatch
        let found = trial.waitForExistence(timeout: 30) || trialButton.waitForExistence(timeout: 5)
        shot("05_paywall")
        XCTAssertTrue(found, "no free-trial copy on the paywall (StoreKit products missing?)")
        app.swipeUp()
        shot("06_paywall_scrolled")
    }
}
