# Egress Checker

macOS **Apple Silicon (arm64)** 桌面应用：诊断代理**出口质量**——连通性、DNS / IPv6 / WebRTC 泄漏、出口 IP、Gemini / ChatGPT / 流媒体解锁、节点打分与快速测速。

面向已自备 **Mihomo / Clash Meta** 兼容客户端的用户（默认目标：**Clash Verge Rev**）。**不提供任何节点或 VPN 服务**，也不是翻墙工具。仅支持 **Apple Silicon**，不承诺 Intel Mac。

许可证：**PolyForm Noncommercial 1.0.0**（禁止商用）。

## 准备：启用 Clash Verge Rev / Mihomo API

1. 在客户端设置里开启 **external-controller**，监听本机（如 `127.0.0.1:9097`）
2. 设置 **secret**（建议非空）
3. 确认 **mixed-port**（如 `7897`）已开启，供经代理的出口探针使用
4. 保持客户端运行，按需开启**系统代理**或 **TUN**

应用会自动读取 `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/config.yaml`。拉取节点时先试 TCP，失败则回退到 Clash Verge 常暴露的 Unix 套接字 `/tmp/verge/verge-mihomo.sock`——所以即使 TCP 端口 refused，只要套接字在、secret 对，仍能列出节点。也可在底部「高级」手动填 host / port / secret / mixed-port，或开 **Mock** 演示模式（无需真实 Clash）。

## 开发

依赖：Node.js 20+、Rust（stable）、Xcode Command Line Tools、pnpm。

```bash
git clone https://github.com/JTee77/egress-checker.git
cd egress-checker && pnpm install && pnpm tauri dev
```

**只用 `pnpm tauri dev`，且只开一个实例。** 别直接跑 `target/debug/egress-checker`（没有前端会白屏）。崩溃 / 白屏 / 进程残留时先 `pkill -f egress-checker && pkill -f vite`，再重开一个 dev。

| 命令 | 说明 |
|------|------|
| `pnpm tauri dev` | 开发模式（推荐） |
| `pnpm test` | 前端单测（vitest） |
| `pnpm typecheck` | TypeScript 检查 |
| `pnpm build` | 前端 typecheck + 生产构建 |
| `pnpm tauri build` | 打包 Mac `.app` / `.dmg`（需 Apple Silicon） |

> 非 macOS（如 Linux CI）上前端 `pnpm build` / `typecheck` 正常；原生 `tauri build` 面向 Mac，可能失败属预期。

## 功能

- **轻量门槛**：刷新连接后先确认客户端连上、隧道大致可用、是否明显未走代理直连；不过则口语提示，不进入节点测评
- **测当前节点**：对当前出口深测，给 1–5 星或「不可用」及短评（可展开构成）
- **测全部节点**：先用延迟淘汰不通节点，再临时切换逐个深测；测完或中止会**强制切回**原节点
- **整份 VPN 总评**：点选一个节点后给「很好 / 能用 / 勉强 / 有问题」及一句话主因
- **环境泄漏检查**：DNS / IPv6 / WebRTC / 分流 / 直连旁路，作为第二入口，不默认每次强跑

## 打包（DMG）

Apple Silicon 上跑 `pnpm tauri build`，产物在 `src-tauri/target/release/bundle/dmg/*.dmg`。默认 **未签名 / 未公证**，首次打开可能需 **右键 → 打开**。

## 免责声明

- 不提供节点、不运营 VPN
- 深度测速可能产生可观流量，请自行注意费用
- DNS / WebRTC 检测在桌面 WebView 环境有诚实限制，结果为启发式，非实验室级证明

## 贡献 & License

欢迎提 Issue / PR，合入由维护者决定，详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

本项目采用 [PolyForm Noncommercial License 1.0.0](./LICENSE)：允许个人学习、研究与非商业使用，**不允许商用**。早期以 MIT 发布的历史 tag 仍按当时许可理解。
