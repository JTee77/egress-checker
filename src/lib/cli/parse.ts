import type { CheckTarget, CliCommandName, ParsedCli } from "./types";
export type { ParsedCli } from "./types";

const COMMANDS = new Set<CliCommandName>([
  "help",
  "discover",
  "gate",
  "check",
  "env",
]);

function isCommand(s: string): s is CliCommandName {
  return COMMANDS.has(s as CliCommandName);
}

function dropBinaryName(argv: string[]): string[] {
  const tokens = [...argv];
  if (!tokens[0]) return tokens;
  const head = tokens[0]!;
  if (isCommand(head)) return tokens;
  const looksBinary =
    /[/\\]/.test(head) ||
    head.endsWith(".exe") ||
    head === "node" ||
    head === "bin" ||
    head.includes("egress-checker") ||
    head.startsWith("egress");
  // Always drop a non-command first token (binary name / junk).
  if (looksBinary || !head.startsWith("-")) {
    tokens.shift();
  }
  return tokens;
}

/**
 * 解析进程 argv（可含二进制名）。
 * 支持：
 *   … --cli discover --client verge --json
 *   … --cli check node "香港 01"
 *   … --cli check current|all
 *   … --cli help
 * 也接受首个非 flag 即为子命令（仍建议带 --cli，便于 GUI 区分）。
 */
export function parseCliArgv(argv: string[]): ParsedCli {
  const tokens = dropBinaryName(argv);

  let cliMode = false;
  const raw = [...argv];
  const positional: string[] = [];
  let clientId: string | null = null;
  let mock = false;
  let json = true; // CLI 默认 JSON；--no-json 关闭
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "--cli") {
      cliMode = true;
      i += 1;
      continue;
    }
    if (t === "--mock") {
      mock = true;
      i += 1;
      continue;
    }
    if (t === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (t === "--no-json") {
      json = false;
      i += 1;
      continue;
    }
    if (t === "--client" || t === "-c") {
      clientId = tokens[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (t.startsWith("--client=")) {
      clientId = t.slice("--client=".length) || null;
      i += 1;
      continue;
    }
    if (t === "--help" || t === "-h") {
      positional.push("help");
      i += 1;
      continue;
    }
    if (t.startsWith("-")) {
      i += 1;
      continue;
    }
    positional.push(t);
    i += 1;
  }

  let command: CliCommandName = "help";
  let checkTarget: CheckTarget | undefined;

  if (positional.length === 0) {
    if (cliMode) command = "help";
  } else if (isCommand(positional[0]!)) {
    cliMode = true;
    command = positional[0]!;
    if (command === "check") {
      const sub = positional[1];
      if (!sub || sub === "current") {
        checkTarget = { kind: "current" };
      } else if (sub === "all") {
        checkTarget = { kind: "all" };
      } else if (sub === "node") {
        const name = positional.slice(2).join(" ").trim();
        checkTarget = { kind: "node", name };
      } else {
        checkTarget = { kind: "node", name: positional.slice(1).join(" ") };
      }
    }
  }

  return {
    cliMode,
    command,
    checkTarget,
    clientId,
    mock,
    json,
    raw,
  };
}

export const CLI_HELP_TEXT = `Egress Checker CLI（与 GUI 共用 runner / egress / score）

用法：
  egress-checker --cli <command> [options]

命令：
  help                         显示本说明
  discover                     发现控制器并探测连接
  gate                         轻量门槛（连通 / 是否像未走代理）
  check current                测当前出口（完整深测）
  check node <名称>            测指定节点（完整深测，可临时切换）
  check all                    测全部节点（完整深测，与测单个相同探针集）
  env                          环境泄漏检查

选项：
  --client, -c <id>            verge | clashx_meta | flclash | mihomo_party | nyanpasu
  --mock                       不连真实软件，用演示数据跑通管线
  --json                       stdout 输出 CliEnvelope JSON（默认）
  --no-json                    人类可读摘要（仍建议脚本用 JSON）
  --help, -h                   同 help

示例：
  egress-checker --cli discover --client verge --json
  egress-checker --cli gate --client verge
  egress-checker --cli check current --client verge
  egress-checker --cli check node "香港" --client verge
  egress-checker --cli check all --mock
  egress-checker --cli env --client verge

说明：CLI 走隐藏窗 + WebView 调用与 GUI 相同的 Tauri 能力；需在 macOS 上运行本应用二进制（或 pnpm tauri dev -- --cli …）。
`;
