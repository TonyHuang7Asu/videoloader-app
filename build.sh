#!/bin/bash
# 一键生成工程 + 打开 Xcode
set -e
cd "$(dirname "$0")"
./tools/xcodegen/bin/xcodegen generate 2>/dev/null || xcodegen generate
open VideoLoader.xcodeproj
echo "Xcode 已打开：选你的 iPhone → 选 Team → 按 ▶ 运行"
