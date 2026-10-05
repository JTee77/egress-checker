# Egress Checker CLI（0.1.16）

与图形界面共用 `src/lib/runner`、`egress`、`score`、`mihomo`。通过 **`--cli`** 启动隐藏窗口，在 WebView 内调用同一套 Tauri 能力。一次性命令结束后把 **一行 JSON（CliEnvelope）** 打到 stdout 并退出；**`serve`** 常驻本机 loopback HTTP，直到 Ctrl+C。

**目前只支持 Clash Verge / Clash Verge Rev（`--client verge`）。** FlClash 即将支持，暂不可用；其它软件不支持。

## 用法

```bash
# 开发（会起 Vite；窗口应被隐藏）
pnpm tauri dev -- --cli help --no-json
pnpm tauri dev -- --cli discover --client verge
pnpm tauri dev -- --cli gate --client verge
pnpm tauri dev -- --cli check current --client verge
pnpm tauri dev -- --cli check node "节点名" --client verge
pnpm tauri dev -- --cli check all --client verge
pnpm tauri dev -- --cli env --client verge
pnpm tauri dev -- --cli serve --mock --port 17890

# 已编译二进制（debug 需要 Vite 在 127.0.0.1:1420；release 自带前端）
./src-tauri/target/debug/egress-checker --cli discover --mock
./src-tauri/target/release/egress-checker --cli help --no-json
```

### 命令

| 命令 | 含义 |
|------|------|
| `help` | 说明文本（`--no-json` 时直接打印；默认包在 `data.text`） |
| `discover` | 发现控制器并探测；返回状态与节点摘要 |
| `gate` | 轻量门槛（`runLightGate`），结果在 `data.gate` |
| `check current` | 当前出口 **完整**深测（不切换节点）。`check` 不带目标等同于它 |
| `check node <名>` | 指定节点完整深测（非当前节点时临时切换，测完切回） |
| `check <名>` | `check node <名>` 的简写（名不是 `current` / `node` / `all` 时） |
| `check all` | 全部节点 **完整**深测（逐个切换，结束切回；与 `check node` 相同探针集） |
| `env` | 环境泄漏检查 |
| `serve` | 本机 **127.0.0.1** HTTP 服务（常驻到 Ctrl+C）。见下方「serve」 |

节点名匹配：先全名精确匹配，再唯一的「包含」匹配；匹配到多个报 `node_ambiguous`，找不到报 `node_not_found`。不会拿不存在的名字去切换。

### 选项

| 选项 | 说明 |
|------|------|
| `--client, -c <id>` / `--client=<id>` | 只接受 `verge`。`flclash` 等任何其它值都报 `client_unsupported`（「当前仅支持 Clash Verge」） |
| `--mock` | 不连真实软件，用演示节点跑通管线；可省略 `--client`（默认 verge）。**给了非法 `--client` 时 `--mock` 也照样报错，不回落** |
| `--port, -p <N>` / `--port=<N>` | **仅 `serve`**：监听端口。默认 **17890**；`0` = 临时端口（就绪横幅打印实际端口）。配其它命令 → `port_only_for_serve` |
| `--json` | 输出一行 CliEnvelope JSON（默认） |
| `--no-json` | 输出人类可读摘要：首行 `✓ <命令> 完成` 或 `✗ <命令> 失败 [code] message`，下面是要点（评分、节点列表、切回报错等）。脚本请用 JSON。`serve` 仍同时打 stderr 人类就绪文案 + stdout JSON 横幅 |
| `--help, -h` | 同 `help`（出现在任何位置都显示帮助） |
| `--` | 之后的词都当位置参数（节点名以 `-` 开头时用） |

解析是**严格**的：未知子命令、未知选项、选项缺值、多余参数都会 `ok:false` + 退出码 1，不会静默变成 `help`。
（不带 `--cli` 且第一个词也不是子命令时，进程按 GUI 启动——这条与 Rust `is_cli_mode` 同规则，两边共用用例 `src/lib/cli/cli-mode-cases.json`。）

> `--mock` 只替换「控制器 / 节点列表」：`gate`、`check`、`env` 的探针仍经本机代理口（默认 mixed-port 7897）真实发请求，`check` 含带宽抽样，会耗一定流量。`--mock` 下 `check node` / `check all` 不切换节点。

## CliEnvelope

```json
{
  "ok": true,
  "version": "0.1.16",
  "command": "discover",
  "ranAt": "2026-10-06T00:00:00.000Z",
  "data": { }
}
```

- 成功：`ok: true`，带 `data`。
- 失败：`ok: false`，带 `error: { code, message }`。部分失败（`restore_failed` / `aborted` / `check_failed` / `gate_failed`）**同时带 `data`**（已测到的结果、`restoreError` 等），便于脚本收尾。
- 未知命令时 `command` 回显用户写的词（如 `"frobnicate"`）。
- 密钥不会写入 JSON（`discover` 只回 host / port / mixedPort / source / sockPath）。

### 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 输出了 envelope，且 `ok: true` |
| `1` | 输出了 envelope，且 `ok: false`（含参数错误、闸门、门槛、检测失败、切回失败、中断） |
| `130` | 强制中断：第二次 Ctrl+C，或第一次中断后 90 秒仍未结束。**不输出 envelope，也不保证切回** |

### 错误码

| code | 何时 | 带 data |
|------|------|---------|
| `unknown_command` | 子命令不认识（`--cli frobnicate`） | 否 |
| `unknown_option` | 选项不认识（`--verbose`、`-x`） | 否 |
| `missing_option_value` | `--client` / `-c` / `--client=` 没给值 | 否 |
| `unexpected_argument` | 子命令带了多余参数（`discover foo`、`check all x`、`help check`） | 否 |
| `node_name_required` | `check node` 没给名字 | 否 |
| `client_required` | 没给 `--client` 且没加 `--mock` | 否 |
| `client_unsupported` | `--client` 不是 `verge`（含 `flclash`；`--mock` 也一样） | 否 |
| `nodes_unavailable` | `check node` 时读不到节点列表 | 否 |
| `node_not_found` | `check node` 找不到该名字 | 否 |
| `node_ambiguous` | `check node` 的名字匹配到多个节点 | 否 |
| `gate_failed` | `check node` / `check all` 的轻量门槛没过（没切换、没深测） | `{ target, clientId, gate }` |
| `check_failed` | 检测没完成（切换失败、找不到策略组、没有节点可测、过程异常） | 对应 check 形状 |
| `restore_failed` | 临时切换后**没能切回原节点**（最高优先级，请立刻到代理软件里手动选回） | 对应 check 形状 |
| `aborted` | 收到 Ctrl+C / SIGTERM / SIGHUP，已停止（`check node`/`all` 已按需切回） | check 形状；其它命令无 |
| `dispatch_error` | 调度过程中抛出的未预期异常 | 否 |
| `boot_error` / `argv_unavailable` | CLI 启动层异常 | 否 |
| `invalid_port` | `--port` 不是 0–65535 整数 | 否 |
| `port_only_for_serve` | `--port` 配了非 serve 命令 | 否 |
| `serve_bind_failed` | serve 无法绑定端口 | 否 |
| `serve_not_oneshot` | 误把 serve 当一次性 dispatch | 否 |
| `invalid_body` | POST /v1/check/node 的 JSON 不合法 | 否 |

同时满足多条时的优先级：`restore_failed` > `aborted` > `check_failed`。

注意：`discover` 连不上软件、`gate` 门槛不过时仍是 `ok: true`——这两个命令本身就是「报告状态」，请看 `data.status` / `data.gate.ok`。

## data 形状

### discover

```jsonc
{
  "clientId": "verge",
  "status": "connected",        // unknown | connected | unreachable | unauthorized | mock
  "message": "…",
  "currentProxy": "香港 01",
  "usingMock": false,
  "config": { "host": "127.0.0.1", "port": 9097, "mixedPort": 7897, "source": "…", "sockPath": null },
  "nodeCount": 80,              // 总数
  "nodesTruncated": true,       // nodeCount > 50
  "nodesError": null,           // 已连上但读节点列表失败时的原因
  "nodes": [ { "name": "…", "type": "…", "region": "…" } ]  // 最多 50 个
}
```

### gate

```jsonc
{ "clientId": "verge", "connectionStatus": "connected", "gate": { "ok": true, "message": "…", "process": "…" } }
```

### env

```jsonc
{ "clientId": "verge", "cards": [ /* CheckCard[] */ ] }
```

### check —— 三种形状（按 `data.target` 区分）

**`target: "current"`**（不切换节点，无门槛前置）

```jsonc
{
  "target": "current",
  "clientId": "verge",
  "nodeName": "香港 01",        // 读不到时为 "当前节点"
  "score": { "stars": 4.5, "totalScore": 86, "blurb": "…" },
  "cards": [ /* CheckCard[] */ ],
  "note": "…"
}
```

**`target: "node"`**

```jsonc
{
  "target": "node",
  "clientId": "verge",
  "nodeName": "香港 01",
  "score": { "stars": 4, "totalScore": 80, "blurb": "…" },   // 没测成为 null
  "cards": [ /* CheckCard[] */ ],
  "hint": null,                 // 过程提示（找不到策略组、切换失败…）
  "restoreError": null,         // 没能切回时的报错；与 hint 分开
  "aborted": false,
  "gate": { "ok": true, "message": "…" }
}
```

**`target: "all"`**

```jsonc
{
  "target": "all",
  "clientId": "verge",
  "count": 12,
  "scores": [ { "nodeName": "…", "stars": 4.5, "totalScore": 86, "blurb": "…" } ],  // 按星级、总分降序
  "hint": null,
  "restoreError": null,
  "aborted": false,             // true 时 scores 只含已测完的节点
  "nodesError": null,
  "gate": { "ok": true, "message": "…" }
}
```

`stars` 取值 `1 | 1.5 | … | 5 | "unavailable"`。`restoreError` 文案与 GUI 红字同一句（`src/lib/runner/restore.ts`）：`没能切回原先节点「X」。`，或没记下原节点时 `没能切回原先节点。`。

## 中断（Ctrl+C）

直接运行二进制时：

1. **第一次** Ctrl+C / SIGTERM / SIGHUP：Rust 捕获信号，只置位；stderr 提示「正在停止」。前端每 250ms 轮询 `cli_abort_requested`：
   - `check all`：与 GUI「停止并切回」同一机制——**当前节点测完后**停止（不打断正在跑的深测），切回原节点，输出 `aborted`（或切回失败时 `restore_failed`）envelope，退出码 1。
   - `check node`：单节点深测本身不可中途打断；测完照常切回，再输出 `aborted` envelope。
   - `discover` / `gate` / `env` / `check current`：不切换节点，立即输出 `aborted` envelope 并退出 1。
2. **看门狗**：第一次信号后 90 秒仍未退出 → 强制退出 130（不保证切回）。
3. **第二次** Ctrl+C：立即退出 130，不切回；stderr 提醒到代理软件里确认当前节点。

已知限制：

- 正在进行的单节点深测（含带宽抽样）不会被中途取消，最坏要等它跑完（通常几十秒）才开始切回。
- SIGKILL（`kill -9`）、断电等无法捕获，不会切回。
- 经 `pnpm tauri dev` 运行时，Ctrl+C 也会发给 pnpm / cargo 等父进程，它们可能先把应用杀掉；需要可靠中断请直接运行编译好的二进制。

## 自检

```bash
pnpm exec vitest run src/lib/cli src/lib/runner   # 单测（参数、闸门、切回、中断、serve 路由、TS/Rust 同步）
pnpm exec vitest run src/lib/tauriInvokeContract.test.ts  # 所有 invoke(...) 参数键 == Rust 命令参数名（如 cli_serve_respond 需 { req }）
(cd src-tauri && cargo test cli_serve -- --nocapture)  # serve：鉴权 / 路由 / 只绑 127.0.0.1
node scripts/simulate-restore-fail.mjs            # 切回文案（直接 import runner 源码；Node ≥ 22.18）
bash scripts/cli-smoke.sh                         # 上面两项
EGRESS_CLI_SMOKE=1 bash scripts/cli-smoke.sh      # 再跑真实二进制：help / 报错退出码 / discover / gate / check current / serve（--mock：/health、POST /v1/discover×2、401）
```

## 已知限制

- 需要 macOS 上的应用二进制（或 `pnpm tauri dev`）；**不是**独立的纯 Node CLI。
- 隐藏窗需关闭 WebView 后台节流才能跑深测（否则 WKWebView 会挂起不在屏幕上的页面，`check` 永远不返回——0.1.15 及以前即如此）。0.1.16 起 CLI 模式下主窗以「隐藏 + 不节流」创建；该开关需 **macOS 14+**，更早的系统上 `check` / `env` 仍可能卡住。GUI 模式不受影响。
- `check all` 会切换节点并耗时/耗流量，请谨慎。
## serve（localhost HTTP）

```bash
egress-checker --cli serve --client verge [--port 17890]
egress-checker --cli serve --mock --port 0          # 临时端口，看就绪横幅
```

- **只绑定 `127.0.0.1`**（绝不 `0.0.0.0`）。默认端口 **17890**；`--port 0` 由内核分配，就绪时打印实际端口。
- **鉴权**：启动时生成一次性随机 token，打印到 **stderr（人类文案）** 与 **stdout（CliEnvelope `command:"serve"` 的 `data.token`）**。之后每个请求必须带：
  - `Authorization: Bearer <token>`，或
  - `X-Egress-Token: <token>`
  - 缺/错 → **401** `{ok:false,error:{code:"unauthorized",…}}`
  - **包括 `GET /health`**：没有匿名健康检查（与其它路由一致，避免本机其它进程探测/枚举）。
- **路由**（业务结果尽量为 HTTP 200 + CliEnvelope JSON；鉴权/路径错误用 401/404/405）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | `{ok:true}`（Rust 直接回，不经 WebView）。**同样需要 token**，无 token → 401 |
| `POST` | `/v1/discover` | 同 `--cli discover` |
| `POST` | `/v1/gate` | 同 `--cli gate` |
| `POST` | `/v1/env` | 同 `--cli env` |
| `POST` | `/v1/check/current` | 同 `--cli check current` |
| `POST` | `/v1/check/all` | 同 `--cli check all` |
| `POST` | `/v1/check/node` | body：`{"name":"节点名"}`，同 `--cli check node` |

- 会话级 `--client` / `--mock` 来自启动 argv（与一次性 CLI 同一闸门：仅 `verge`）。
- **架构**：隐藏窗 + WebView 跑原来的 `dispatchCli`；Rust 用 std TCP 做 loopback HTTP，鉴权通过后把任务丢进通道，前端 `cli_serve_poll` → `dispatchServeJob` → `cli_serve_respond`。**请求串行**（同一时间只处理一个 WebView 任务；并发连接会排队）。
- **Ctrl+C**：停止监听，尽量让进行中的 `check node/all` 切回后结束，然后进程退出 0。再按一次 / 超时仍走一次性 CLI 的 130 看门狗。
- **不是**通用 Web API：无 WebSocket、不为浏览器开 CORS、不提供 GUI。

示例：

```bash
# 终端 A
./egress-checker --cli serve --mock --port 17890
# 记下 token

# 终端 B
TOKEN=…
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:17890/health
curl -s -H "X-Egress-Token: $TOKEN" -X POST http://127.0.0.1:17890/v1/discover
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'   -d '{"name":"香港"}' -X POST http://127.0.0.1:17890/v1/check/node
```
