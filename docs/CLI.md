# Egress Checker CLI（0.1.12）

与图形界面共用 `src/lib/runner`、`egress`、`score`、`mihomo`。通过 **`--cli`** 启动隐藏窗口，在 WebView 内调用同一套 Tauri 能力，结束后把 **一行 JSON（CliEnvelope）** 打到 stdout 并退出。

## 用法

```bash
# 开发（会起 Vite；窗口应被隐藏）
pnpm tauri dev -- --cli help --no-json
pnpm tauri dev -- --cli discover --client verge --json
pnpm tauri dev -- --cli gate --client verge
pnpm tauri dev -- --cli check current --client verge
pnpm tauri dev -- --cli check node "节点名" --client verge
pnpm tauri dev -- --cli check all --client verge
pnpm tauri dev -- --cli env --client verge

# 已编译二进制（debug / release）
./src-tauri/target/debug/egress-checker --cli discover --mock --json
./src-tauri/target/release/egress-checker --cli help --no-json
```

### 命令

| 命令 | 含义 |
|------|------|
| `help` | 说明文本（`--no-json` 时直接打印；默认仍包在 envelope.data.text） |
| `discover` | 发现控制器并探测；返回状态与节点摘要 |
| `gate` | 轻量门槛（`runLightGate`） |
| `check current` | 当前出口 **完整**深测 |
| `check node <名>` | 指定节点完整深测（可临时切换后切回） |
| `check all` | 全部节点 **轻量** DeepLight |
| `env` | 环境泄漏检查 |

### 选项

- `--client, -c`：`verge` \| `clashx_meta` \| `flclash` \| `mihomo_party` \| `nyanpasu`
- `--mock`：不连真实软件，用演示数据跑通管线（适合冒烟）
- `--json` / `--no-json`：默认 JSON；`--no-json` 时 help 打印纯文本，其它命令仍尽量可读

### CliEnvelope

```json
{
  "ok": true,
  "version": "0.1.12",
  "command": "discover",
  "ranAt": "2026-09-27T00:00:00.000Z",
  "data": { }
}
```

失败时 `ok: false`，带 `error: { code, message }`；进程退出码 0/1。

## 已知限制

- 需要 macOS 上的应用二进制（或 `pnpm tauri dev`）；**不是**独立的纯 Node CLI。
- `check all` 会切换节点并耗时/耗流量，请谨慎。
- 尚未提供常驻 `serve` / loopback HTTP；需要时可在后续版本加。
- 密钥不会写入 JSON（discover 只回 host/port/mixedPort/source/sockPath）。
