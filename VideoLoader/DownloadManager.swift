import Combine
import Foundation
import Photos
import WebKit

// 单条下载记录（持久化，跨启动保留）
struct DownloadItem: Codable, Identifiable {
    var id: String = UUID().uuidString
    var url: String = ""
    var name: String = "video.mp4"
    var state: String = "等待"          // 等待 / 下载中 / 保存中 / 完成 / 失败
    var progress: Double = 0            // 0-1
    var downloaded: Int64 = 0
    var total: Int64 = 0
    var speed: Double = 0               // bytes/s
    var error: String? = nil
    var addedAt: Date = Date()
    var doneAt: Date? = nil
}

final class DownloadManager: NSObject, ObservableObject {
    static let shared = DownloadManager()
    static let sessionIdentifier = "com.vlapp.downloads"
    static let maxConcurrent = 2

    @Published var items: [DownloadItem] = []
    var backgroundCompletionHandler: (() -> Void)?
    var hostWebView: WKWebView?

    private var session: URLSession!
    private var resumeData: [String: Data] = [:]
    private var speedMarks: [String: (bytes: Int64, time: Date)] = [:]
    private var savingIDs = Set<String>()   // 正在写相册（此时系统任务已结束，不应被当作孤儿重启）
    private var lastWrite = Date.distantPast

    private var persistPath: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("downloads.json")
    }

    override init() {
        super.init()
        let cfg = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        cfg.timeoutIntervalForRequest = 60 * 15
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        load()
    }

    // ---------- 队列操作 ----------
    func add(url: String, name: String) {
        if items.contains(where: { $0.url == url && $0.state != "失败" && $0.state != "完成" }) { return }
        var it = DownloadItem()
        it.url = url
        it.name = name
        items.append(it)
        persist(force: true)
        kick()
    }

    func addBatch(_ list: [[String: Any]]) {
        for d in list {
            guard let u = d["url"] as? String else { continue }
            add(url: u, name: (d["name"] as? String) ?? "video.mp4")
        }
    }

    func retry(id: String) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        items[idx].state = "等待"
        items[idx].error = nil
        items[idx].progress = 0
        items[idx].downloaded = 0
        items[idx].total = 0
        persist(force: true)
        kick()
    }

    func retryAllFailed() {
        for i in items.indices where items[i].state == "失败" {
            items[i].state = "等待"
            items[i].error = nil
            items[i].progress = 0
            items[i].downloaded = 0
            items[i].total = 0
        }
        persist(force: true)
        kick()
    }

    func remove(id: String) {
        items.removeAll { $0.id == id }
        persist(force: true)
    }

    func clearFinished() {
        items.removeAll { $0.state == "完成" }
        persist(force: true)
    }

    /// 回到前台：只把「系统里已经没有对应任务」的孤儿放回队列，避免重复下载
    func reviveStalled() {
        session.getAllTasks { [weak self] tasks in
            guard let self = self else { return }
            let live = Set(tasks.compactMap { $0.taskDescription })
            DispatchQueue.main.async {
                var changed = false
                for i in self.items.indices {
                    let st = self.items[i].state
                    guard st == "下载中" || st == "保存中" else { continue }
                    if self.savingIDs.contains(self.items[i].id) { continue }
                    if live.contains(self.items[i].id) { continue }
                    self.items[i].state = "等待"
                    self.items[i].speed = 0
                    changed = true
                }
                if changed { self.persist(force: true) }
                self.kick()
            }
        }
    }

    private func kick() {
        DispatchQueue.main.async { self.objectWillChange.send() }
        let active = items.filter { $0.state == "下载中" || $0.state == "保存中" }.count
        guard active < Self.maxConcurrent,
              let idx = items.firstIndex(where: { $0.state == "等待" }) else { persist(); return }
        items[idx].state = "下载中"
        let id = items[idx].id
        let urlStr = items[idx].url
        persist(force: true)
        guard let url = URL(string: urlStr) else {
            update(id) { $0.state = "失败"; $0.error = "地址无效" }
            return
        }
        let task: URLSessionDownloadTask
        if let rd = resumeData[id], !rd.isEmpty {
            task = session.downloadTask(withResumeData: rd)
            resumeData[id] = nil
        } else {
            task = session.downloadTask(with: url)
        }
        task.taskDescription = id
        task.resume()
    }

    // ---------- 持久化 ----------
    // 进度回调非常密集，落盘按 0.5s 节流；force=true 用于状态切换等关键节点
    private func persist(force: Bool = false) {
        let now = Date()
        if force || now.timeIntervalSince(lastWrite) >= 0.5 {
            lastWrite = now
            if let data = try? JSONEncoder().encode(items) {
                try? data.write(to: persistPath)
            }
        }
        DispatchQueue.main.async { self.objectWillChange.send() }
    }

    private func load() {
        if let data = try? Data(contentsOf: persistPath),
           let list = try? JSONDecoder().decode([DownloadItem].self, from: data) {
            items = list
        }
    }

    private func update(_ id: String, mutate: (inout DownloadItem) -> Void) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        mutate(&items[idx])
        persist(force: true)
    }

    private func notifyWeb(ok: Bool, msg: String) {
        DispatchQueue.main.async { [weak self] in
            guard let wv = self?.hostWebView else { return }
            wv.evaluateJavaScript(
                "window.nativeSaveDone && window.nativeSaveDone(\(ok ? "true" : "false"), \(msg.debugDescription))"
            )
        }
    }
}

// ---------- URLSession 下载代理 ----------
extension DownloadManager: URLSessionDownloadDelegate {

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        guard let id = downloadTask.taskDescription else { return }
        let now = Date()
        var speed: Double = 0
        if let mark = speedMarks[id] {
            let dt = now.timeIntervalSince(mark.time)
            if dt > 0.5 {
                speed = Double(totalBytesWritten - mark.bytes) / dt
                speedMarks[id] = (totalBytesWritten, now)
            }
        } else {
            speedMarks[id] = (totalBytesWritten, now)
        }
        let prog = totalBytesExpectedToWrite > 0
            ? Double(totalBytesWritten) / Double(totalBytesExpectedToWrite) : 0
        DispatchQueue.main.async { [weak self] in
            self?.update(id) {
                $0.downloaded = totalBytesWritten
                $0.total = totalBytesExpectedToWrite
                $0.progress = prog
                if speed > 0 { $0.speed = speed }
            }
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription else { return }
        let name = items.first(where: { $0.id == id })?.name ?? "video.mp4"
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + "_" + name)
        try? FileManager.default.moveItem(at: location, to: dest)

        DispatchQueue.main.async { [weak self] in
            self?.update(id) { $0.state = "保存中"; $0.progress = 1; $0.speed = 0 }
        }
        savingIDs.insert(id)
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { [weak self] st in
            guard st == .authorized || st == .limited else {
                self?.savingIDs.remove(id)
                self?.finish(id: id, ok: false, err: "没有相册权限（设置 → 隐私与安全性 → 照片）")
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: dest)
            }) { [weak self] ok, _ in
                self?.savingIDs.remove(id)
                self?.finish(id: id, ok: ok, err: ok ? nil : "相册写入失败")
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, let id = task.taskDescription else { return }
        let ns = error as NSError
        if let rd = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
            resumeData[id] = rd
        }
        savingIDs.remove(id)
        finish(id: id, ok: false, err: ns.localizedDescription, keepResume: true)
    }

    private func finish(id: String, ok: Bool, err: String?, keepResume: Bool = false) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.update(id) {
                $0.state = ok ? "完成" : "失败"
                $0.error = ok ? nil : err
                $0.speed = 0
                if ok { $0.doneAt = Date() }
            }
            if !keepResume { self.resumeData[id] = nil }
            self.persist(force: true)
            let nm = self.items.first(where: { $0.id == id })?.name ?? ""
            self.notifyWeb(ok: ok, msg: (ok ? "已存入相册：" : "失败：") + nm)
            self.kick()
        }
    }
}

// ---------- 后台会话回联 ----------
extension DownloadManager {
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { self.backgroundCompletionHandler?() }
    }
}