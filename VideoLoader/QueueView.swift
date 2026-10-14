import Foundation
import SwiftUI

// 原生下载队列界面：进度条 + 实时速度 + 失败重试
struct QueueView: View {
    @ObservedObject var dm = DownloadManager.shared

    var body: some View {
        NavigationView {
            Group {
                if dm.items.isEmpty {
                    Text("队列为空。从网页点「存到相册」后会出现在这里。")
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.center)
                        .padding()
                } else {
                    List {
                        let failed = dm.items.filter { $0.state == "失败" }.count
                        if failed > 0 {
                            Button("重试全部失败项（\(failed)）") { dm.retryAllFailed() }
                                .buttonStyle(.borderedProminent)
                                .frame(maxWidth: .infinity)
                        }
                        ForEach(dm.items) { it in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(it.name).font(.subheadline).lineLimit(1)
                                    Spacer()
                                    Text(it.state).font(.caption).foregroundColor(color(it.state))
                                }
                                if it.state == "下载中" {
                                    ProgressView(value: it.progress)
                                    Text(String(format: "%.1fMB / %.1fMB · %.2f MB/s",
                                                Double(it.downloaded)/1048576,
                                                Double(it.total)/1048576,
                                                it.speed/1048576))
                                        .font(.caption2).foregroundColor(.gray)
                                }
                                if let err = it.error {
                                    Text(err).font(.caption2).foregroundColor(.red)
                                }
                            }
                            .swipeActions {
                                if it.state == "失败" {
                                    Button("重试") { dm.retry(id: it.id) }.tint(.orange)
                                }
                                Button("删除", role: .destructive) { dm.remove(id: it.id) }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("下载队列")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("清空完成") { dm.clearFinished() }
                }
            }
        }
    }

    private func color(_ state: String) -> Color {
        switch state {
        case "完成": return .green
        case "失败": return .red
        case "下载中", "保存中": return .blue
        default: return .gray
        }
    }
}
