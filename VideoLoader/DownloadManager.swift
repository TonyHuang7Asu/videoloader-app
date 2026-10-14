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
    var total: Int64 = 0                // 实际总字节（来自响应头）
    var size: Int64 = 0                 // 解析阶段就已知的大小，用来在响应头缺失时算进度
    var speed: Double = 0               // bytes/s
    var retries: Int = 0                // 已自动重试次数
    var error: String? = nil
    var addedAt: Date = Date()
    var doneAt: Date? = nil

    // 字段全部走 decodeIfPresent + 默认值：以后加字段不会让旧 downloads.json 解码失败
    // （否则 load() 用的是 try?，会静默清空用户已有的队列）
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        url = (try? c.decode(String.self, forKey: .url)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? "video.mp4"
        state = (try? c.decode(String.self, forKey: .state)) ?? "等待"
        progress = (try? c.decode(Double.self, forKey: .progress)) ?? 0
        downloaded = (try? c.decode(Int64.self, forKey: .downloaded)) ?? 0
        total = (try? c.decode(Int64.self, forKey: .total)) ?? 0
        size = (try? c.decode(Int64.self, forKey: .size)) ?? 0
        speed = (try? c.decode(Double.self, forKey: .speed)) ?? 0
        retries = (try? c.decode(Int.self, forKey: .retries)) ?? 0
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
        addedAt = (try? c.decode(Date.self, forKey: .addedAt)) ?? Date()
        doneAt = (try? c.decodeIfPresent(Date.self, forKey: .doneAt)) ?? nil
    }

    init() {}
}

/// 下载队列。
///
/// 线程约定：`items` / `resumeData` / `speedMarks` / `savingIDs` / `tasks` / `lastTick` / `stallIDs`
/// 全部**只在主线程读写**。URLSession 回调跑在 delegate 队列上，一律先 `DispatchQueue.main.async`
/// 再碰这些状态，因此不需要任何锁。
final class DownloadManager: NSObject, ObservableObject {
    static let shared = DownloadManager()
    static let sessionIdentifier = "com.vlapp.downloads"
    static let maxConcurrent = 2          // 只统计「下载中」，写相册不占带宽也不占名额
    static let maxAutoRetry = 2           // 回来前台/网络抖动导致的失败先自己重试
    static let stallSeconds: TimeInterval = 60

    @Published var items: [DownloadItem] = []
    var backgroundCompletionHandler: (() -> Void)?
    var hostWebView: WKWebView?

    private var session: URLSession!
    private var resumeData: [String: Data] = [:]
    private var speedMarks: [String: (bytes: Int64, time: Date)] = [:]
    private var savingIDs = Set<String>()
    private var tasks: [String: URLSessionDownloadTask] = [:]
    private var lastTick: [String: Date] = [:]
    private var stallIDs = Set<String>()
    private var lastWrite = Date.distantPast
    private var lastPush = Date.distantPast
    private var watchdog: Timer?

    private var persistPath: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("downloads.json")
    }

    override init() {
        super.init()
        let cfg = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        cfg.timeoutIntervalForRequest = 60 * 30
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        load()
        watchdog = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.checkStalls()
        }
    }

    // ---------- 队列操作（全部主线程） ----------

    func add(url: String, name: String, size: Int64 = 0) {
        // 之前失败过的同一条：复活它，别再堆一行重复记录
        if let i = items.firstIndex(where: { $0.url == url && $0.state == "失败" }) {
            items[i].size = size > 0 ? size : items[i].size
            reset(at: i)
            persist(force: true)
            kick()
            pushProgress(force: true)
            return
        }
        if items.contains(where: { $0.url == url && $0.state != "完成" }) { return }
        var it = DownloadItem()
        it.url = url
        it.name = name
        it.size = size
        items.append(it)
        persist(force: true)
        kick()
        pushProgress(force: true)
    }

    func addBatch(_ list: [[String: Any]]) {
        for d in list {
            guard let u = d["url"] as? String else { continue }
            let size = (d["size"] as? NSNumber)?.int64Value ?? 0
            add(url: u, name: (d["name"] as? String) ?? "video.mp4", size: size)
        }
    }

    func retry(id: String) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        reset(at: idx)
        persist(force: true)
        kick()
    }

    func retryAllFailed() {
        for i in items.indices where items[i].state == "失败" { reset(at: i) }
        persist(force: true)
        kick()
        pushProgress(force: true)
    }

    func remove(id: String) {
        // 正在下的条目被删掉时必须真的取消，否则它下完照样会写进相册
        tasks[id]?.cancel()
        tasks[id] = nil
        resumeData[id] = nil
        savingIDs.remove(id)
        speedMarks[id] = nil
        lastTick[id] = nil
        stallIDs.remove(id)
        items.removeAll { $0.id == id }
        persist(force: true)
        kick()
        pushProgress(force: true)
    }

    func clearFinished() {
        for i in items.filter({ $0.state == "完成" }).map({ $0.id }) {
            tasks[i] = nil
            speedMarks[i] = nil
            lastTick[i] = nil
        }
        items.removeAll { $0.state == "完成" }
        persist(force: true)
        pushProgress(force: true)
    }

    /// 回到前台：把「系统里已经没任务、也没在写相册」的孤儿放回队列
    func reviveStalled() {
        session.getAllTasks { [weak self] tasks in
            let live = Set(tasks.compactMap { $0.taskDescription })
            DispatchQueue.main.async {
                guard let self = self else { return }
                var changed = false
                for i in self.items.indices {
                    let st = self.items[i].state
                    guard st == "下载中" || st == "保存中" else { continue }
                    let id = self.items[i].id
                    if self.savingIDs.contains(id) { continue }
                    if live.contains(id) { continue }
                    self.items[i].state = "等待"
                    self.items[i].speed = 0
                    changed = true
                }
                if changed { self.persist(force: true) }
                self.kick()
                self.pushProgress(force: true)
            }
        }
    }

    private func reset(at i: Int) {
        items[i].state = "等待"
        items[i].error = nil
        items[i].progress = 0
        items[i].downloaded = 0
        items[i].speed = 0
        items[i].retries = 0
        items[i].doneAt = nil
    }

    private func kick() {
        objectWillChange.send()
        let active = items.filter { $0.state == "下载中" }.count
        guard active < Self.maxConcurrent,
              let idx = items.firstIndex(where: { $0.state == "等待" }) else { persist(); return }
        items[idx].state = "下载中"
        let id = items[idx].id
        let urlStr = items[idx].url
        lastTick[id] = Date()
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
        tasks[id] = task
        task.resume()
    }

    /// 超过 stallSeconds 没有字节推进的任务：取消（顺带取回续传数据）后交给自动重试
    private func checkStalls() {
        let now = Date()
        for i in items.indices where items[i].state == "下载中" {
            let id = items[i].id
            guard let last = lastTick[id] else { lastTick[id] = now; continue }
            if now.timeIntervalSince(last) > Self.stallSeconds {
                stallIDs.insert(id)
                tasks[id]?.cancel()
            }
        }
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
        objectWillChange.send()
    }

    private func load() {
        guard let data = try? Data(contentsOf: persistPath),
              let list = try? JSONDecoder().decode([DownloadItem].self, from: data) else { return }
        items = list
        // 上次被杀时留下的中间态，启动即重排
        for i in items.indices where items[i].state == "下载中" || items[i].state == "保存中" {
            items[i].state = "等待"
            items[i].speed = 0
        }
    }

    private func update(_ id: String, mutate: (inout DownloadItem) -> Void) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        mutate(&items[idx])
        persist()
        pushProgress()
    }

    private func notifyWeb(ok: Bool, msg: String) {
        guard let wv = hostWebView else { return }
        wv.evaluateJavaScript(
            "window.nativeSaveDone && window.nativeSaveDone(\(ok ? "true" : "false"), \(msg.debugDescription))"
        )
    }

    /// 把队列实时进度推回网页，让用户在网页上就能看到「第几个 / 百分之多少 / 多少 MB/s」
    private func pushProgress(force: Bool = false) {
        guard let wv = hostWebView else { return }
        let now = Date()
        if !force && now.timeIntervalSince(lastPush) < 0.8 { return }
        lastPush = now
        var p: [String: Any] = [
            "t": items.count,
            "d": items.filter { $0.state == "完成" }.count,
            "f": items.filter { $0.state == "失败" }.count,
            "a": items.filter { ["等待", "下载中", "保存中"].contains($0.state) }.count,
        ]
        let cur = items.first { $0.state == "下载中" }
            ?? items.first { $0.state == "保存中" }
            ?? items.first { $0.state == "等待" }
        if let c = cur {
            p["n"] = c.name
            p["p"] = c.progress
            p["s"] = c.speed
            p["dl"] = c.downloaded
            p["sz"] = c.total > 0 ? c.total : c.size
            p["st"] = c.state
        }
        guard let data = try? JSONSerialization.data(withJSONObject: p),
              let json = String(data: data, encoding: .utf8) else { return }
        wv.evaluateJavaScript("window.nativeQueueProgress && window.nativeQueueProgress(\(json))")
    }
}

// ---------- URLSession 下载代理（回调统一转主线程） ----------
extension DownloadManager: URLSessionDownloadDelegate {

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        guard let id = downloadTask.taskDescription else { return }
        // 总大小三个来源依次兜底：回调参数 → 响应头 → 解析阶段已知的 size
        // （Cloudflare 对流式响应会丢掉 content-length，只看回调参数进度永远是 0）
        let http = downloadTask.response as? HTTPURLResponse
        let fromHeader = Int64(http?.value(forHTTPHeaderField: "x-vl-size") ?? "") ?? 0
        let expect = max(http?.expectedContentLength ?? 0, fromHeader)
        let headerTotal = expect > 0 ? expect : totalBytesExpectedToWrite
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let now = Date()
            self.lastTick[id] = now
            var speed: Double = 0
            if let mark = self.speedMarks[id] {
                let dt = now.timeIntervalSince(mark.time)
                if dt > 0.5 {
                    speed = Double(totalBytesWritten - mark.bytes) / dt
                    self.speedMarks[id] = (totalBytesWritten, now)
                }
            } else {
                self.speedMarks[id] = (totalBytesWritten, now)
            }
            self.update(id) {
                let known = headerTotal > 0 ? headerTotal : $0.size
                $0.downloaded = totalBytesWritten
                if known > 0 { $0.total = known }
                $0.progress = known > 0 ? min(1, Double(totalBytesWritten) / Double(known)) : 0
                if speed > 0 { $0.speed = speed }
            }
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription else { return }
        // 系统只保证在这个回调返回前文件还在，所以「搬走」必须同步做完
        let staged = FileManager.default.temporaryDirectory
            .appendingPathComponent("vl-" + UUID().uuidString + ".mp4")
        do {
            try FileManager.default.moveItem(at: location, to: staged)
        } catch {
            finish(id: id, ok: false, err: "文件处理失败：\(error.localizedDescription)")
            return
        }

        // HTTP 错误码不会让下载任务失败，会把错误页当视频存下来 —— 必须先拦掉
        if let http = downloadTask.response as? HTTPURLResponse, http.statusCode >= 400 {
            var msg = "服务器返回 HTTP \(http.statusCode)"
            if let d = try? Data(contentsOf: staged), d.count < 4096,
               let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
               let e = o["error"] as? String { msg = e }
            try? FileManager.default.removeItem(at: staged)
            finish(id: id, ok: false, err: msg)
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                try? FileManager.default.removeItem(at: staged)
                return
            }
            guard self.items.contains(where: { $0.id == id }) else {
                try? FileManager.default.removeItem(at: staged)   // 条目已被删除
                self.kick()
                return
            }
            let name = self.items.first(where: { $0.id == id })?.name ?? "video.mp4"
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString + "_" + name)
            if (try? FileManager.default.moveItem(at: staged, to: dest)) == nil {
                try? FileManager.default.removeItem(at: staged)
                self.finish(id: id, ok: false, err: "文件处理失败")
                return
            }

            self.update(id) { $0.state = "保存中"; $0.progress = 1; $0.speed = 0 }
            self.savingIDs.insert(id)
            // 成败都要删临时文件，否则下 30 个视频会在 tmp 里留几十份拷贝
            let cleanup = { try? FileManager.default.removeItem(at: dest) }
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { [weak self] st in
                guard st == .authorized || st == .limited else {
                    cleanup()
                    DispatchQueue.main.async { self?.savingIDs.remove(id) }
                    self?.finish(id: id, ok: false, err: "没有相册权限（设置 → 隐私与安全性 → 照片）")
                    return
                }
                PHPhotoLibrary.shared().performChanges({
                    PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: dest)
                }) { [weak self] ok, _ in
                    cleanup()
                    DispatchQueue.main.async { self?.savingIDs.remove(id) }
                    self?.finish(id: id, ok: ok, err: ok ? nil : "相册写入失败")
                }
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, let id = task.taskDescription else { return }
        let ns = error as NSError
        let rd = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.tasks[id] = nil
            self.speedMarks[id] = nil
            self.lastTick[id] = nil
            // 条目已被用户删除（主动取消）：什么都不做
            guard self.items.contains(where: { $0.id == id }) else {
                self.stallIDs.remove(id)
                return
            }
            if let rd = rd { self.resumeData[id] = rd }
            self.savingIDs.remove(id)
            let stalled = self.stallIDs.remove(id) != nil
            let msg = stalled
                ? "下载停滞（\(Int(Self.stallSeconds)) 秒无进度）"
                : ns.localizedDescription
            self.finish(id: id, ok: false, err: msg)
        }
    }

    private func finish(id: String, ok: Bool, err: String?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.tasks[id] = nil
            self.speedMarks[id] = nil
            self.lastTick[id] = nil
            guard let idx = self.items.firstIndex(where: { $0.id == id }) else { return }
            let nm = self.items[idx].name

            if ok {
                self.update(id) {
                    $0.state = "完成"
                    $0.error = nil
                    $0.speed = 0
                    $0.progress = 1
                    $0.doneAt = Date()
                }
                self.resumeData[id] = nil
                self.persist(force: true)
                self.notifyWeb(ok: true, msg: "已存入相册：" + nm)
            } else if self.items[idx].retries < Self.maxAutoRetry {
                // 回到前台/切网导致的断流：自己先重试，不要把错误甩给用户
                self.items[idx].retries += 1
                self.items[idx].state = "等待"
                self.items[idx].speed = 0
                self.persist(force: true)
                self.notifyWeb(ok: true, msg: "自动重试 \(self.items[idx].retries)/\(Self.maxAutoRetry)：" + nm)
            } else {
                self.update(id) { $0.state = "失败"; $0.error = err; $0.speed = 0 }
                self.persist(force: true)
                self.notifyWeb(ok: false, msg: nm + "：" + (err ?? "未知错误"))
            }
            self.pushProgress(force: true)
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
