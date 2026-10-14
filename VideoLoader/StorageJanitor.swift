import Combine
import Foundation
import WebKit

/// 本地存储治理。
///
/// 背景：第一版 App（以及 v6.0）把下载好的视频整份搬进 `tmp` 再写相册，
/// **写完从不删除**。每下一个视频就在设备上永久留一份等大的拷贝。
/// 而 iOS 只在「App 未运行且系统缺空间」时才机会性清理 `tmp`，App 升级又原样保留容器，
/// 所以这堆垃圾会一直躺着 —— 这就是「App 占用巨大」的真正原因。
///
/// v6.1 起写入路径已经做到「用完即删」，但那只能防新增，**回收不了存量**。
/// 这里负责：① 统计占用 ② 回收历史残留 ③ 清 WebKit 磁盘缓存。
final class StorageJanitor: ObservableObject {
    static let shared = StorageJanitor()

    struct Report {
        var tempBytes: Int64 = 0
        var tempCount: Int = 0
        var cachesBytes: Int64 = 0
        var documentsBytes: Int64 = 0
        var reclaimedBytes: Int64 = 0
        var reclaimedCount: Int = 0
        var cachesFreed: Int64 = 0
        var reclaimedWeb = false

        var isEmpty: Bool { tempBytes == 0 && cachesBytes == 0 }
    }

    enum Mode {
        case startup      // 冷启动全量：门槛 5 分钟，清 WebKit 缓存，一个进程只跑一次
        case foreground   // 进前台轻扫：门槛 1 小时，不动 WebKit 缓存
        case manual       // 用户点「立即清理」：门槛 60 秒，清 WebKit 缓存

        var minAge: TimeInterval {
            switch self {
            case .startup: return 300
            case .foreground: return 3600
            case .manual: return 60
            }
        }
    }

    @Published private(set) var report = Report()
    @Published private(set) var lastMessage: String?
    @Published private(set) var busy = false

    /// DownloadManager 正在写的文件路径。清扫时永不触碰，避免和下载抢文件。
    private var activePaths = Set<String>()
    private let pathLock = NSLock()
    private var didStartupSweep = false

    private static let mediaExts: Set<String> = ["mp4", "mov", "m4v", "webm"]

    private init() {}

    // MARK: - 活跃路径登记

    func registerActive(_ path: String) {
        pathLock.lock(); activePaths.insert(path); pathLock.unlock()
    }

    func unregisterActive(_ path: String) {
        pathLock.lock(); activePaths.remove(path); pathLock.unlock()
    }

    private func isActive(_ path: String) -> Bool {
        pathLock.lock(); defer { pathLock.unlock() }
        return activePaths.contains(path)
    }

    // MARK: - 对外入口

    func run(_ mode: Mode) {
        if mode == .startup {
            pathLock.lock()
            let already = didStartupSweep
            didStartupSweep = true
            pathLock.unlock()
            if already { return }
        }
        DispatchQueue.main.async { self.busy = true }

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            var rep = Report()

            let fm = FileManager.default
            let tmp = fm.temporaryDirectory
            let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]

            rep.cachesBytes = Self.directoryStats(caches).bytes
            let cachesBefore = rep.cachesBytes
            rep.documentsBytes = Self.directoryStats(docs).bytes

            // ---- 回收 tmp 里属于我们的残留 ----
            let now = Date()
            let keys: Set<URLResourceKey> = [.contentModificationDateKey, .isRegularFileKey, .totalFileAllocatedSizeKey, .fileSizeKey]
            if let entries = try? fm.contentsOfDirectory(at: tmp, includingPropertiesForKeys: Array(keys), options: []) {
                for f in entries {
                    guard Self.looksLikeOurs(f.lastPathComponent) else { continue }
                    if self.isActive(f.path) { continue }
                    guard let v = try? f.resourceValues(forKeys: keys), v.isRegularFile == true else { continue }
                    let age = now.timeIntervalSince(v.contentModificationDate ?? now)
                    guard age >= mode.minAge else { continue }
                    let size = Int64(v.totalFileAllocatedSize ?? v.fileSize ?? 0)
                    if (try? fm.removeItem(at: f)) != nil {
                        rep.reclaimedBytes += size
                        rep.reclaimedCount += 1
                    }
                }
            }

            // ---- 清 WebKit 缓存（只清 cache 类型，不碰 localStorage）----
            if mode != .foreground {
                rep.reclaimedWeb = Self.clearWebKitCache()
            }

            // ---- 清理后重新统计 ----
            let after = Self.directoryStats(tmp)
            rep.tempBytes = after.bytes
            rep.tempCount = after.count
            rep.cachesBytes = Self.directoryStats(caches).bytes
            if rep.reclaimedWeb {
                rep.cachesFreed = max(0, cachesBefore - rep.cachesBytes)
            }

            let msg = Self.describe(rep, mode: mode)
            DispatchQueue.main.async {
                self.report = rep
                self.lastMessage = msg
                self.busy = false
            }
        }
    }

    // MARK: - 判定与统计

    /// 是否像是我们产生的临时文件。
    /// - `vl-<uuid>.mp4`：v6.1+ 的暂存命名
    /// - `<UUID>_任意名.mp4`：第一版 / v6.0 的命名（UUID + 下划线 + 原文件名）
    private static func looksLikeOurs(_ name: String) -> Bool {
        if name.hasPrefix("vl-") { return true }
        let ext = (name as NSString).pathExtension.lowercased()
        guard mediaExts.contains(ext) else { return false }
        guard name.count > 37 else { return false }
        let head = String(name.prefix(37))
        guard head.hasSuffix("_") else { return false }
        return UUID(uuidString: String(head.dropLast())) != nil
    }

    static func directoryStats(_ url: URL) -> (bytes: Int64, count: Int) {
        var bytes: Int64 = 0
        var count = 0
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .totalFileAllocatedSizeKey, .fileAllocatedSizeKey, .fileSizeKey]
        guard let en = FileManager.default.enumerator(at: url, includingPropertiesForKeys: Array(keys),
                                                     options: [], errorHandler: { _, _ in true }) else {
            return (0, 0)
        }
        for case let f as URL in en {
            guard let v = try? f.resourceValues(forKeys: keys), v.isRegularFile == true else { continue }
            bytes += Int64(v.totalFileAllocatedSize ?? v.fileAllocatedSize ?? v.fileSize ?? 0)
            count += 1
        }
        return (bytes, count)
    }

    /// 只删缓存类型。**绝不能碰 localStorage / IndexedDB** —— 网页的下载历史和待下载列表存在那里，
    /// 用 `.nonPersistent()` data store 或清全部网站数据都会把用户记录抹掉。
    private static func clearWebKitCache() -> Bool {
        let types: Set<String> = [
            WKWebsiteDataTypeDiskCache,
            WKWebsiteDataTypeMemoryCache,
            WKWebsiteDataTypeOfflineWebApplicationCache,
        ]
        var done = false
        let sem = DispatchSemaphore(value: 0)
        WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast) {
            done = true
            sem.signal()
        }
        // 本方法只在后台队列调用，主线程不阻塞，因此 completion 能正常回调
        _ = sem.wait(timeout: .now() + 5)
        URLCache.shared.removeAllCachedResponses()
        return done
    }

    // MARK: - 文案

    static func bytesText(_ b: Int64) -> String {
        if b < 1024 { return "\(b) B" }
        let kb = Double(b) / 1024
        if kb < 1024 { return String(format: "%.0f KB", kb) }
        let mb = kb / 1024
        if mb < 1024 { return String(format: "%.1f MB", mb) }
        return String(format: "%.2f GB", mb / 1024)
    }

    private static func describe(_ r: Report, mode: Mode) -> String {
        if r.reclaimedCount > 0 || r.cachesFreed > 0 {
            var parts: [String] = []
            if r.reclaimedCount > 0 {
                parts.append("回收 \(bytesText(r.reclaimedBytes)) 残留临时文件（\(r.reclaimedCount) 个）")
            }
            if r.cachesFreed > 0 { parts.append("清掉网页缓存 \(bytesText(r.cachesFreed))") }
            else if r.reclaimedWeb { parts.append("已清网页缓存") }
            return "🧹 " + parts.joined(separator: "，")
        }
        if r.tempBytes == 0 && r.cachesBytes == 0 { return "✅ 本地已无残留" }
        return "本次没有可回收的残留（临时文件 \(bytesText(r.tempBytes))，网页缓存 \(bytesText(r.cachesBytes))）"
    }
}
