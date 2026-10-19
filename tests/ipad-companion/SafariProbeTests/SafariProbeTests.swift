import XCTest

final class SafariProbeTests: XCTestCase {
    private let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    private func photograph(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func contains(_ text: String) -> Bool {
        safari.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch.exists
    }

    private func click(_ title: String) {
        let button = safari.webViews.buttons[title].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 25), "Missing probe button: \(title)")
        if !button.isHittable { safari.swipeDown() }
        XCTAssertTrue(button.isHittable, "Probe button is not tappable: \(title)")
        button.tap()
    }

    private func resolvePrompt(allow: Bool, result: String, timeout: TimeInterval = 40) {
        let deadline = Date().addingTimeInterval(timeout)
        let labels = allow
            ? ["Start Broadcast", "Start Sharing", "Share Screen", "Share Entire Screen", "Share", "Allow", "Start Recording"]
            : ["Cancel", "Don’t Allow", "Don't Allow", "Not Now"]
        var tapped = Set<String>()
        while Date() < deadline {
            if contains(result) { return }
            for (index, app) in [springboard, safari].enumerated() {
                for label in labels {
                    let button = app.buttons[label].firstMatch
                    let key = "\(index):\(label)"
                    if button.exists && button.isHittable && !tapped.contains(key) {
                        photograph("permission-before-\(label)")
                        button.tap()
                        tapped.insert(key)
                    }
                }
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        photograph("permission-unresolved-\(result)")
        XCTFail("The browser did not return a bounded capability result for \(result)")
    }

    private func trySystemStop() {
        for label in ["Screen Sharing", "Screen Recording", "Broadcasting"] {
            let indicator = springboard.buttons[label].firstMatch
            if indicator.exists && indicator.isHittable {
                photograph("system-stop-before-\(label)")
                indicator.tap()
                for stop in ["Stop Broadcast", "Stop Sharing", "Stop Recording", "Stop"] {
                    let button = springboard.buttons[stop].firstMatch
                    if button.waitForExistence(timeout: 2) && button.isHittable {
                        button.tap()
                        photograph("system-stop-after-\(stop)")
                        return
                    }
                }
            }
        }
        photograph("system-stop-control-not-found")
    }

    func testActualSafariCapabilityAndLifecycle() throws {
        safari.activate()
        for title in ["Continue", "Not Now", "Start Browsing"] {
            let setup = safari.buttons[title].firstMatch
            if setup.waitForExistence(timeout: 2) && setup.isHittable {
                photograph("fresh-safari-setup-\(title)")
                setup.tap()
            }
        }
        XCTAssertTrue(safari.webViews.firstMatch.waitForExistence(timeout: 30))
        let ready = NSPredicate { [self] _, _ in contains("Probe ready") }
        expectation(for: ready, evaluatedWith: nil)
        waitForExpectations(timeout: 30)
        photograph("trusted-safari-ready")

        click("Deny screen capture")
        resolvePrompt(allow: false, result: "deny:")
        photograph("screen-denial-result")

        click("Request camera and microphone")
        resolvePrompt(allow: true, result: "camera:")
        photograph("camera-microphone-result")

        click("Request screen capture")
        resolvePrompt(allow: true, result: "capture:")
        Thread.sleep(forTimeInterval: 8)
        photograph("screen-capture-result")

        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 3)
        photograph("landscape")
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 3)
        safari.activate()
        Thread.sleep(forTimeInterval: 3)
        photograph("foreground-after-home")

        trySystemStop()
        safari.activate()
        Thread.sleep(forTimeInterval: 2)
        click("Stop screen capture")
        click("Take over transport")
        let takeover = NSPredicate { [self] _, _ in contains("Transport ready 2") }
        expectation(for: takeover, evaluatedWith: nil)
        waitForExpectations(timeout: 20)
        photograph("same-cookie-takeover")

        click("Reconnect transport")
        let reconnected = NSPredicate { [self] _, _ in contains("Transport ready 3") }
        expectation(for: reconnected, evaluatedWith: nil)
        waitForExpectations(timeout: 20)
        photograph("reconnect-without-capture")

        // Old output is removed by this button so the second result must be new.
        click("Request screen capture")
        resolvePrompt(allow: true, result: "capture:")
        Thread.sleep(forTimeInterval: 8)
        photograph("fresh-capture-after-reconnect")
        click("Stop screen capture")
        click("Finish probe")
        XCTAssertTrue(contains("Probe complete"))
        photograph("complete")
    }
}
