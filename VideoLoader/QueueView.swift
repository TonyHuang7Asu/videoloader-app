import Foundation
import SwiftUI

// 原生下载队列界面：汇总 + 进度条 + 实时速度 + 失败重试
struct QueueView: View {
    @ObservedObject var dm = DownloadManager.shared

    private var running: Int { dm.items.filter { ["等待", "下载中", "保存中"].contains($0.state) }.count }
    private var done: Int { dm.items.filter { $0.state == "完成" }.count }
    private var failed: Int { dm.items.filter { $0.state == "失败" }.count }

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
                        Section {
                            HStack(spacing: 14) {
                                chip("进行中 \(running)", .blue)
                                chip("完成 \(done)", .green)
                                chip("失败 \(failed)", failed > 0 ? .red : .gray)
                                Spacer()
                            }
                            if failed > 0 {
                                Button("重试全部失败项（\(failed)）") { dm.retryAllFailed() }
                                    .buttonStyle(.borderedProminent)
                                    .frame(maxWidth: .infinity)
                            }
                        }

                        Section {
                            ForEach(dm.items) { it in
                                row(it)
                                    .swipeActions {
                                        if it.state == "失败" {
                                            Button("重试") { dm.retry(id: it.id) }.tint(.orange)
                                        }
                                        if it.state == "下载中" || it.state == "等待" || it.state == "保存中" {
                                            Button("取消") { dm.remove(id: it.id) }.tint(.gray)
                                        }
                                        Button("删除", role: .destructive) { dm.remove(id: it.id) }
                                    }
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
                        .disabled(done == 0)
                }
            }
        }
    }

    private func chip(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.caption).bold()
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(Capsule().fill(color.opacity(0.16)))
            .foregroundColor(color)
    }

    @ViewBuilder
    private func row(_ it: DownloadItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(it.name).font(.subheadline).lineLimit(1)
                Spacer()
                Text(it.state).font(.caption).foregroundColor(color(it.state))
            }
            if it.state == "下载中" {
                ProgressView(value: it.progress)
                Text(String(format: "%.1fMB / %.1fMB · %.2f MB/s",
                            Double(it.downloaded) / 1048576,
                            Double(it.total) / 1048576,
                            it.speed / 1048576))
                    .font(.caption2).foregroundColor(.gray)
            }
            if let err = it.error {
                Text(err).font(.caption2).foregroundColor(.red)
            }
        }
        .padding(.vertical, 2)
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
