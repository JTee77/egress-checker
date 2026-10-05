# Egress Checker — 产品说明（v0.1.15）

## 定位
**Egress Checker** 是 macOS（Apple Silicon）桌面应用，诊断代理**出口质量**——不只是「能不能打开国外网站」。

一句话：**看看你的代理会不会漏 DNS、关心的服务能不能用、实际够不够快。**

**不提供**任何节点或 VPN 服务。当前仅支持 Clash Verge / Clash Verge Rev。FlClash 的支持即将上线，充分实测后再正式加入。

许可证：**PolyForm Noncommercial 1.0.0**（禁止商用）。

## 受众
- 已在用 Clash Verge / Clash Verge Rev 的 Mac 用户（FlClash 即将支持，尚未正式加入）
- 需要比「能开 Google」更深的检查
- 普通用户可直接用 GUI；进阶用户可用 CLI 拿 JSON

## 平台
- **仅 macOS Apple Silicon（arm64）**（v1 不做 Intel）
- Windows / 移动端不在当前范围
- 分发：GitHub Releases（`.dmg` / `.app`），不强制上架 App Store

## 架构（两层）
1. **通用出口诊断** — 测当前系统出口（系统代理 / TUN 开启时）
2. **Mihomo 适配** — 本地 `external-controller` / secret / Unix 套接字：节点列表、延迟、切换、深测

文案统一称：**「Mihomo / Clash Meta 兼容客户端」**。

## 明确不做
- Shadowrocket / Surge / Quantumult / 封闭商业 VPN 一键适配
- 提供或售卖节点 / 订阅
- 账号体系、云同步、可识别用户的遥测
- 对无开放 API 的客户端假装「全节点扫遍」
- 宣称「翻墙 / 突破防火墙」

## 当前版本与本轮目标（0.1.16）

**当前版本：0.1.16**（自 0.1.12 起；0.1.15 已发）。

本轮刚开，目标待定。已挂起、发版时可一并合入：[PR #20](https://github.com/JTee77/egress-checker/pull/20) 许可证改为 GPL-3.0。

0.1.15 已发：窄窗排版、使用中识别、FlClash 即将支持、商店只写通/不通、取消记录过期清理等。

图标本版不动。CLI 的 localhost HTTP 服务继续延后，不阻塞本版。

「明确不做」见上文，本版不变。

## 当前产品形态（0.1.12 基线 → 0.1.15）

### 单页 GUI（无侧栏多模式）
- **无**「首页 | 节点 | 设置 | 关于」侧栏多页；工作区是一条渐进流程：选软件 → 获取节点 → 环境检查 / 测节点
- 节点瀑布流卡片；测过后可 **详情 + 再测** 并存
- 主题：浅色 / 深色 / 跟随系统（右上角切换）

### 检测分工（已定）
| 动作 | 实现 | 说明 |
|------|------|------|
| 测单个（含「再测」） | `runNodeDiagnostics` | **完整**深测（延迟、full 带宽、流媒体/商店/AI 等） |
| 测全部 | `runNodeDiagnostics` | **完整**深测（与测单个相同：延迟、full 带宽、流媒体/商店/AI 等） |
| 环境泄漏 | `runEnv` / `runEnvDiagnostics` | DNS / IPv6 / WebRTC / 分流 / 直连旁路；第二入口，不默认每次强跑 |

前端业务调度在 **`src/lib/runner`**（无 React）；GUI 只接线。评分读 **`CheckCard.metrics`**（不再文案反解 Mbps）。

### 轻量门槛
获取节点后先 `runLightGate`：客户端是否连上、海外是否大致通、是否像未走代理直连。不过则口语提示，不进入节点测评。

### CLI（0.1.12 骨架；0.1.15 仍延后 HTTP）
与 GUI **共用** `lib/runner` + `egress` + `score` + `mihomo`。

```text
egress-checker --cli discover --client verge --json
egress-checker --cli gate --client verge
egress-checker --cli check current|node <名>|all …
egress-checker --cli env --client verge
```

stdout 为 **CliEnvelope** JSON（`ok/version/command/ranAt/data|error`）。详见 [docs/CLI.md](./docs/CLI.md)。

> 仍是一次性 CLI（隐藏窗跑完退出）。**localhost HTTP serve 继续延后**，不阻塞 0.1.15。

## 非目标回顾（仍成立）
见上文「明确不做」。深度测速可能耗流量；DNS/WebRTC 在桌面 WebView 下为启发式结论。
