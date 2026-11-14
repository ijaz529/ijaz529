import UIKit
import WebKit
import Capacitor

/// CueSight's web view host (spec 002, US4).
///
/// Capacitor 8 already configures the WKWebView for inline camera video. This subclass:
/// - re-asserts inline playback with no user gesture required, so the Live camera preview
///   (`<video playsinline muted autoplay>`) plays inside the page instead of going full screen;
/// - narrows WebKit's media-capture permission to the app's own origin (`capacitor://localhost`).
///   The bundled web app's `getUserMedia` call is granted without WebKit's second, per-site prompt,
///   so the only camera prompt the player sees is the system one (`NSCameraUsageDescription`).
///   Any other origin is denied.
///
/// Frames are processed in the web view's workers and never leave the device (Constitution V).
final class CueSightViewController: CAPBridgeViewController {
    /// WKWebView.uiDelegate is weak, so the view controller keeps the delegate alive.
    private var mediaPermissionDelegate: AppOriginMediaPermissionDelegate?

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        return configuration
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let webView = webView else { return }
        let delegate = AppOriginMediaPermissionDelegate(
            appOrigin: bridge?.config.serverURL,
            fallback: webView.uiDelegate as? NSObject
        )
        mediaPermissionDelegate = delegate
        webView.uiDelegate = delegate
        #if DEBUG
        installDebugStartQuery(in: webView)
        #endif
    }

    #if DEBUG
    /// Debug builds only (never in a release/TestFlight build): launching with
    /// `xcrun simctl launch <device> <bundle id> -CueSightStartQuery "mode=practice"` starts the web app
    /// with `?mode=practice`, the same URL parameter the PWA uses. The Simulator CI job uses it to
    /// screenshot each mode. The query is applied with history.replaceState before any page script runs.
    private func installDebugStartQuery(in webView: WKWebView) {
        guard let query = UserDefaults.standard.string(forKey: "CueSightStartQuery"), !query.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: [query]),
              let literal = String(data: data, encoding: .utf8) else { return }
        let source = "(function(q){try{history.replaceState(history.state,'',location.pathname+'?'+q+location.hash);}catch(e){}})(\(literal)[0]);"
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        CAPLog.print("⚡️  CueSight debug start query: ?\(query)")
    }
    #endif
}

/// A WKUIDelegate that answers the media-capture permission request itself and forwards every other
/// WKUIDelegate call (JavaScript alert/confirm/prompt panels, new windows, ...) to Capacitor's own
/// delegation handler, so Capacitor keeps working exactly as before.
final class AppOriginMediaPermissionDelegate: NSObject, WKUIDelegate {
    private let appOrigin: URL?
    private weak var fallback: NSObject?

    init(appOrigin: URL?, fallback: NSObject?) {
        self.appOrigin = appOrigin
        self.fallback = fallback
        super.init()
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(Self.isAppOrigin(origin, appOrigin) ? .grant : .deny)
    }

    static func isAppOrigin(_ origin: WKSecurityOrigin, _ app: URL?) -> Bool {
        guard let app = app, let scheme = app.scheme, let host = app.host else { return false }
        return origin.protocol.caseInsensitiveCompare(scheme) == .orderedSame
            && origin.host.caseInsensitiveCompare(host) == .orderedSame
            && origin.port == (app.port ?? 0)
    }

    // MARK: - Forward everything else to Capacitor's WebViewDelegationHandler

    override func responds(to aSelector: Selector!) -> Bool {
        if super.responds(to: aSelector) { return true }
        return fallback?.responds(to: aSelector) ?? false
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if let fallback = fallback, fallback.responds(to: aSelector) { return fallback }
        return super.forwardingTarget(for: aSelector)
    }
}
