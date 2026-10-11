# VideoLoader iOS 原生 App（B 线方案）

纯 SwiftUI + WKWebView 壳，套住现有 Web App。**App 内点「存到相册」= 直接写入系统相册**（不走快捷指令、不受 Safari 限制）。

## 原理

- App 用 `WKWebView` 加载你的线上地址（`https://videoloader.7hvn4hvz8h.workers.dev`）
- 网页检测到自己跑在 App 里（`window.webkit.messageHandlers.saveVideo` 存在）时，「存到相册」按钮会把视频地址发给原生层
- 原生层：`URLSession` 下载 → `PHPhotoLibrary`（add-only 权限）写入相册 → 弹窗告知结果
- 批量模式同理：列表里每个视频逐个交给原生层排队处理
- 网页里有 `window.nativeSaveDone(ok, msg)` 回调，保存结果回显到页面状态栏

## 构建（需要 Xcode，一次性）

1. **装 Xcode**：App Store 搜 Xcode 安装（约 12GB）。装完**打开一次**，同意许可、装好 iOS 组件
2. **登录 Apple ID**：Xcode → Settings → Accounts → 左下 **+** → 登录你的 Apple ID（免费即可）
3. **生成工程**（本目录下执行）：
   ```bash
   /tmp/xcodegen-app/xcodegen/bin/xcodegen generate
   ```
   （如已清理，从 https://github.com/yonaskolb/XcodeGen/releases 重新下载）
4. **打开工程**：`open VideoLoader.xcodeproj`
5. **配置签名**：左侧选 VideoLoader 项目 → **Signing & Capabilities** → Team 选你的 **Personal Team**（免费账号）
6. **插上 iPhone**：顶部设备选择器选你的手机 → 点 **▶ Run**
   - 首次需要在 iPhone 上：设置 → 通用 → VPN与设备管理 → 信任你的开发者证书
7. 完成。App 里的视频从此**一键进相册**

> 免费账号签名 **7 天过期**，过期后重新插线 Run 一次即可（或改用 AltStore/SideStore 自动续签，见下）。

## 免续签（可选）：AltStore

1. Mac 装 [AltServer](https://altstore.io)（菜单栏常驻）
2. iPhone 和 Mac 在同一 Wi-Fi，iPhone 装 **AltStore** App
3. 把本项目构建出的 .ipa 用 AltStore 安装 → **每 7 天自动后台续签**，无需插线

> 免费账号最多同时 3 个自签 App。

## 打包 .ipa（给 AltStore 用）

```bash
xcodebuild -project VideoLoader.xcodeproj -scheme VideoLoader -configuration Release -archivePath /tmp/vl.xcarchive archive
xcodebuild -exportArchive -archivePath /tmp/vl.xcarchive -exportPath /tmp/vlipa -allowProvisioningUpdates
# /tmp/vlipa/VideoLoader.ipa
```

## 注意

- 正式上架 App Store 需 ¥99/年开发者账号，且**下载类 App 有审核风险**；自己用 TestFlight 内测不需要审核
- 免费签名 App 的数据隔离有随机化，但 `PHPhotoLibrary` add-only 权限不受影响
- App 内嵌的是线上地址：Web App 更新功能时 **App 无需重新构建**
