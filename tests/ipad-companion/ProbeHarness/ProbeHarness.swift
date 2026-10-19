import UIKit
import ScreenCaptureKit

@main
final class ProbeHarness: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        _ = SCContentSharingPicker.shared
        let window = UIWindow(frame: UIScreen.main.bounds)
        let view = UIViewController()
        view.view.backgroundColor = .systemBackground
        window.rootViewController = view
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
