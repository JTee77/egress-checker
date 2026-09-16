# Egress Checker

macOS **Apple Silicon (arm64)** 桌面应用：诊断代理**出口质量**（连通性、DNS 启发式、出口 IP、Gemini / ChatGPT 解锁、节点快速延迟）。

面向已自备 **Mihomo / Clash Meta** 兼容客户端的用户（默认测试目标：**Clash Verge Rev**）。

## 它是什么 / 不是什么

**是：**

- 本地诊断工具：检查当前出口是否泄漏 DNS 迹象、解锁你关心的服务、节点是否真正可用且稳定
- 通过 Clash 兼容 REST API（`external-controller` + `secret`）列出节点、测延迟、切换节点

**不是：**

- **不提供任何代理节点或 VPN 服务**（请自备订阅 / 节点）
- 不是翻墙工具，不声称突破防火墙
- 不支持 Shadowrocket / Surge / 商业封闭 VPN 客户端（v1）
- **仅支持 macOS Apple Silicon**；v1 **不承诺** Intel Mac

许可证：**MIT**

## 启用 Clash Verge Rev / Mihomo API

在 Clash Verge Rev（或其它 Mihomo GUI）中：

1. 打开设置，找到 **外部控制器 / external-controller**
2. 启用并监听本机，例如 `127.0.0.1:9097`（端口以你的配置为准）
3. 设置 **secret**（推荐非空）
4. 确认 **mixed-port**（如 `7897`）已开启，供部分经代理探针使用
5. 保持客户端运行，并按需开启**系统代理**或 **TUN**，以便「首页」一键检测反映代理出口

本应用会尝试读取：

`~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/config.yaml`

并在需要时回退 Unix socket：`/tmp/verge/verge-mihomo.sock`

也可在应用「设置」页手动填写 host / port / secret / mixed-port，或开启 **Mock** 演示模式（无需真实 Clash）。

## 警告（开发必读）

- **开发时只用** `pnpm tauri dev`，并且**只开一个实例**。
- **禁止**直接运行 `src-tauri/target/debug/egress-checker`（或双击该二进制）：没有 Vite 前端时会**白屏**。
- 若出现崩溃 / 白屏：先退出所有 Egress Checker 窗口与进程，再只开一个终端运行 `pnpm tauri dev`。

## 在 Apple Silicon Mac 上开发运行

依赖：

- Node.js **20+**
- Rust（stable，含 `rustc` / `cargo`）
- Xcode Command Line Tools
- **pnpm**（推荐）或 npm

```bash
git clone https://github.com/JTee77/egress-checker.git
cd egress-checker
pnpm install
pnpm tauri dev
```

常用脚本：

| 命令 | 说明 |
|------|------|
| `pnpm install` | 安装前端依赖 |
| `pnpm dev` | 仅 Vite 前端（无原生 API） |
| `pnpm build` | 前端 typecheck + 生产构建 |
| `pnpm typecheck` | 仅 TypeScript 检查 |
| `pnpm tauri dev` | Tauri 开发模式（推荐） |
| `pnpm tauri build` | 打包 Mac `.app` / `.dmg`（需在 Apple Silicon Mac 上） |

> 在非 macOS（如 Linux CI）上，前端 `pnpm build` / `typecheck` 可正常跑通；原生 `tauri build` 面向 Mac 可能失败，属预期。

## 功能概览（v1）

- **首页**：一键出口诊断（连通性、DNS 启发式、WebRTC 占位、出口 IP、Gemini、ChatGPT、延迟采样）
- **节点**：列表 + 地区分组规则 + **快速延迟**（多轮 Google/CF `generate_204`，延迟 / 抖动 / 丢包）；深度 / Top-N / AI 专项为 UI 占位
- **设置**：自动探测或手动 API；Mock 演示开关
- **关于**：免责声明与 MIT

## 免责声明

- 本软件不提供节点、不运营 VPN
- 深度测速（后续版本）可能产生可观流量，请自行注意费用
- DNS / WebRTC 检测在桌面 WebView 环境有诚实限制，结果为启发式，非实验室级证明

## License

MIT — see [LICENSE](./LICENSE).
