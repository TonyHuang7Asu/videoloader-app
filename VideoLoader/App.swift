import SwiftUI
import WebKit
import Photos

@main
struct VideoLoaderApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: UIViewRepresentable {
    static let startURL = URL(string: "https://videoloader.7hvn4hvz8h.workers.dev")!

    func makeUIView(context: Context) -> WKWebView { context.coordinator.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        lazy var webView: WKWebView = {
            let cfg = WKWebViewConfiguration()
            cfg.userContentController.add(self, name: "saveVideo")
            cfg.allowsInlineMediaPlayback = true
            let wv = WKWebView(frame: .zero, configuration: cfg)
            wv.navigationDelegate = self
            wv.allowsBackForwardNavigationGestures = true
            wv.load(URLRequest(url: Self.startURL))
            return wv
        }()

        // 网页 → 原生：window.webkit.messageHandlers.saveVideo.postMessage({url, name})
        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.name == "saveVideo",
                  let body = message.body as? [String: Any],
                  let urlStr = body["url"] as? String else { return }
            let name = (body["name"] as? String) ?? "video.mp4"
            save(urlString: urlStr, name: name)
        }

        private func save(urlString: String, name: String) {
            guard let url = URL(string: urlString) else { notify(ok: false, msg: "地址无效"); return }
            notify(ok: nil, msg: "下载中…")
            let task = URLSession.shared.downloadTask(with: url) { [weak self] local, _, err in
                guard let self else { return }
                guard let local, err == nil else {
                    self.notify(ok: false, msg: "下载失败: \(err?.localizedDescription ?? "?")"); return
                }
                let dest = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString + "_" + name)
                do { try FileManager.default.moveItem(at: local, to: dest) } catch {
                    self.notify(ok: false, msg: "文件处理失败"); return
                }
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { [weak self] st in
                    guard st == .authorized || st == .limited else {
                        self?.notify(ok: false, msg: "没有相册写入权限"); return
                    }
                    PHPhotoLibrary.shared().performChanges({
                        PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: dest)
                    }) { [weak self] ok, _ in
                        self?.notify(ok: ok, msg: ok ? "已存入相册" : "保存失败")
                    }
                }
            }
            task.resume()
        }

        // 原生 → 网页：window.nativeSaveDone(ok, msg)，并弹系统提示
        private func notify(ok: Bool?, msg: String) {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let okJs = ok.map(String.init) ?? "null"
                self.webView.evaluateJavaScript(
                    "window.nativeSaveDone && window.nativeSaveDone(\(okJs), \(msg.debugDescription))"
                )
                if ok != nil {
                    if let top = self.webView.topMostViewController() {
                        let alert = UIAlertController(title: ok == true ? "已存入相册" : "出错了",
                                                      message: msg, preferredStyle: .alert)
                        alert.addAction(UIAlertAction(title: "好", style: .default))
                        top.present(alert, animated: true)
                    }
                }
            }
        }
    }
}

extension UIView {
    func topMostViewController() -> UIViewController? {
        var responder: UIResponder? = self
        while let r = responder {
            if let vc = r as? UIViewController { return vc.topMost() }
            responder = r.next
        }
        return nil
    }
}

extension UIViewController {
    func topMost() -> UIViewController {
        if let nav = self as? UINavigationController { return nav.visibleViewController?.topMost() ?? nav }
        if let tab = self as? UITabBarController { return tab.selectedViewController?.topMost() ?? tab }
        return presentedViewController?.topMost() ?? self
    }
}
