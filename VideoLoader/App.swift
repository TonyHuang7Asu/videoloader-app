import SwiftUI
import WebKit

@main
struct VideoLoaderApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        DownloadManager.shared.backgroundCompletionHandler = completionHandler
    }
}

struct ContentView: View {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @ObservedObject var dm = DownloadManager.shared
    @State private var showQueue = false
    @Environment(\.scenePhase) var scenePhase

    static let startURL = URL(string: "https://videoloader.7hvn4hvz8h.workers.dev")!

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            AppWebView()
                .ignoresSafeArea(edges: .bottom)
            Button {
                showQueue = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "tray.and.arrow.down")
                    let active = dm.items.filter { ["等待","下载中","保存中"].contains($0.state) }.count
                    Text(active > 0 ? "队列 \(active)" : "下载队列")
                }
                .font(.footnote).bold()
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Capsule().fill(.ultraThinMaterial))
            }
            .padding(.trailing, 14)
            .padding(.bottom, 90)
            .opacity(dm.items.isEmpty ? 0.55 : 1)
        }
        .sheet(isPresented: $showQueue) { QueueView() }
        .onChange(of: scenePhase) { phase in
            if phase == .active { dm.reviveStalled() }
        }
    }
}

struct AppWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        lazy var webView: WKWebView = {
            let cfg = WKWebViewConfiguration()
            cfg.userContentController.add(self, name: "saveVideo")
            cfg.userContentController.add(self, name: "saveVideoBatch")
            cfg.allowsInlineMediaPlayback = true
            let wv = WKWebView(frame: .zero, configuration: cfg)
            wv.navigationDelegate = self
            wv.allowsBackForwardNavigationGestures = true
            DownloadManager.shared.hostWebView = wv
            wv.load(URLRequest(url: ContentView.startURL))
            return wv
        }()

        func makeUIView(context: Context) -> WKWebView { context.coordinator.webView }
        func updateUIView(_ uiView: WKWebView, context: Context) {}

        // 网页 → 原生
        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            switch message.name {
            case "saveVideo":
                if let b = message.body as? [String: Any], let u = b["url"] as? String {
                    DownloadManager.shared.add(url: u, name: (b["name"] as? String) ?? "video.mp4")
                    notify("已加入下载队列（\(DownloadManager.shared.items.count) 个）")
                }
            case "saveVideoBatch":
                if let json = message.body as? String,
                   let data = json.data(using: .utf8),
                   let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                    DownloadManager.shared.addBatch(arr)
                    notify("已加入下载队列 \(arr.count) 个 —— 可切后台，进度见「下载队列」")
                }
            default: break
            }
        }

        private func notify(_ msg: String) {
            DispatchQueue.main.async { [weak self] in
                self?.webView.evaluateJavaScript(
                    "window.nativeSaveDone && window.nativeSaveDone(null, \(msg.debugDescription))"
                )
            }
        }

        // 白屏诊断：加载失败时显示错误页（只显示一次，避免重定向循环）
        private var showedError = false
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            showedError = false
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            showError(error)
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            showError(error)
        }
        private func showError(_ error: Error) {
            guard !showedError else { return }
            showedError = true
            let msg = (error as NSError).localizedDescription
            var html = "<html><body style='background:#0b1020;color:#eef1ff;padding:28px;font-family:-apple-system;line-height:1.7'>"
            html += "<h2 style='color:#ff8a8a'>加载失败</h2><p>" + msg + "</p>"
            html += "<p>1. 开启手机上的代理/加速器（workers.dev 被墙）</p>"
            html += "<p>2. 设置 → App → VideoLoader → 无线数据 → 选「WLAN与蜂窝网络」</p>"
            html += "<button onclick=\"location.href='" + ContentView.startURL.absoluteString + "'\" style='background:#4f7cff;color:#fff;border:0;border-radius:10px;padding:12px 24px;font-size:15px'>重试</button>"
            html += "</body></html>"
            webView.loadHTMLString(html, baseURL: nil)
        }
    }
}
