import Cocoa
import WebKit

private let bootstrapURL = URL(string: "http://127.0.0.1:8002/admin.html")!
private let controllerURL = URL(string: "http://127.0.0.1:8002/?native=mac")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var retry: DispatchWorkItem?
    private enum LoadStage { case bootstrap, authenticating, ready }
    private var loadStage: LoadStage = .bootstrap

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "手机管理端"
        window.minSize = NSSize(width: 900, height: 620)
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        loadController()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func loadController() {
        retry?.cancel()
        loadStage = .bootstrap
        webView.load(URLRequest(url: bootstrapURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8))
    }

    private func authenticateLocalAdmin() {
        let tokenURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/PhoneCloudManager/state/admin-token")
        guard let token = try? String(contentsOf: tokenURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty else {
            retrySoon()
            return
        }
        loadStage = .authenticating
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let result = try await self.webView.callAsyncJavaScript(
                    """
                    const response = await fetch('/api/auth/local-admin', {
                        method: 'POST',
                        headers: { 'X-PhoneCloud-Admin-Token': token }
                    });
                    return response.ok;
                    """,
                    arguments: ["token": token],
                    in: nil,
                    contentWorld: .page
                )
                guard result as? Bool == true else {
                    self.retrySoon()
                    return
                }
                self.loadStage = .ready
                self.webView.load(URLRequest(
                    url: controllerURL,
                    cachePolicy: .reloadIgnoringLocalCacheData,
                    timeoutInterval: 8
                ))
            } catch {
                self.retrySoon()
            }
        }
    }

    private func retrySoon() {
        retry?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.loadController() }
        retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retrySoon() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retrySoon() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if loadStage == .bootstrap {
            authenticateLocalAdmin()
        }
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
