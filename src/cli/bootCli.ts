/**
 * CLI 启动：在隐藏窗里跑完 dispatch，经 Rust 打印 stdout 后退出。
 * `serve`：启动 loopback HTTP，请求经 Rust 转发到本 WebView 的 dispatch，Ctrl+C 停止。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  abortedEnvelope,
  cliCommandSwitchesNodes,
  cliExitCode,
  dispatchCli,
  dispatchServeJob,
  formatCliHuman,
  parseCliArgv,
  resolveCliClient,
  resolveServePort,
  serveReadyEnvelope,
  type CliEnvelope,
  type ParsedCli,
  type ServeJob,
  type ServeStartInfo,
} from "../lib/cli";

const ABORT_POLL_MS = 250;
const SERVE_POLL_MS = 250;

/**
 * 轮询 Rust 的中断标志（Ctrl+C / SIGTERM / SIGHUP 由 Rust 捕获）。
 * 用轮询而不是事件：只依赖自家命令，不需要额外 capability。
 */
function watchAbort(): {
  isAborted: () => boolean;
  aborted: Promise<void>;
  stop: () => void;
} {
  let flag = false;
  let resolve!: () => void;
  const aborted = new Promise<void>((r) => {
    resolve = r;
  });
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    invoke<boolean>("cli_abort_requested")
      .then((hit) => {
        if (hit && !flag) {
          flag = true;
          resolve();
        }
      })
      .catch((err) => {
        // 前后端同版本发布，失败说明接线坏了：停止轮询并记下（Rust 看门狗仍会兜底退出）。
        console.error("cli_abort_requested failed", err);
        stop();
      });
  }, ABORT_POLL_MS);
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  return { isAborted: () => flag, aborted, stop };
}

async function emit(line: string): Promise<void> {
  await invoke("cli_stdout", { line });
}

async function emitErr(line: string): Promise<void> {
  await invoke("cli_stderr", { line });
}

async function exit(code: number): Promise<void> {
  try {
    await invoke("cli_exit", { code });
  } catch {
    // process should already be gone
  }
}

function appVersion(): string {
  try {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0";
  } catch {
    return "0";
  }
}

/**
 * 常驻 serve：Rust 绑 127.0.0.1 + token；本 WebView 串行处理 POST /v1/*。
 */
async function bootServe(parsed: ParsedCli): Promise<void> {
  const ver = appVersion();
  const client = resolveCliClient(parsed);
  if (!client.ok) {
    const env = {
      ok: false as const,
      version: ver,
      command: "serve",
      ranAt: new Date().toISOString(),
      error: client.error,
    };
    await emit(JSON.stringify(env));
    await exit(1);
    return;
  }

  const port = resolveServePort(parsed);
  let info: ServeStartInfo;
  try {
    info = await invoke<ServeStartInfo>("cli_serve_start", { port });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emit(
      JSON.stringify({
        ok: false,
        version: ver,
        command: "serve",
        ranAt: new Date().toISOString(),
        error: { code: "serve_bind_failed", message },
      }),
    );
    await exit(1);
    return;
  }

  // 人类文案 → stderr；JSON 就绪横幅 → stdout（含 token，仅本机）
  const human =
    `serve 已就绪：${info.baseUrl}  （只监听 127.0.0.1）\n` +
    `token: ${info.token}\n` +
    `每个请求需带：Authorization: Bearer ${info.token}\n` +
    `或：X-Egress-Token: ${info.token}\n` +
    `路由：GET /health；POST /v1/discover|gate|env|check/current|check/all|check/node\n` +
    `请求串行处理。Ctrl+C 停止监听并退出。`;
  await emitErr(human);
  await emit(JSON.stringify(serveReadyEnvelope(info, ver)));

  const abort = watchAbort();
  try {
    while (!abort.isAborted()) {
      let job: ServeJob | null = null;
      try {
        job = await invoke<ServeJob | null>("cli_serve_poll", {
          timeoutMs: SERVE_POLL_MS,
        });
      } catch (err) {
        console.error("cli_serve_poll failed", err);
        break;
      }
      if (!job) continue;

      // 进行中的 check node/all：收到中断时仍交给 dispatch 的 shouldAbort，以便切回。
      let envelope: CliEnvelope;
      try {
        envelope = await dispatchServeJob(parsed, job, {
          shouldAbort: abort.isAborted,
        });
      } catch (err) {
        envelope = {
          ok: false,
          version: ver,
          command: "serve",
          ranAt: new Date().toISOString(),
          error: {
            code: "serve_handler_error",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
      try {
        await invoke("cli_serve_respond", {
          id: job.id,
          status: 200,
          body: JSON.stringify(envelope),
        });
      } catch (err) {
        console.error("cli_serve_respond failed", err);
      }
    }
  } finally {
    abort.stop();
    try {
      await invoke("cli_serve_stop");
    } catch (err) {
      console.error("cli_serve_stop failed", err);
    }
  }

  await emitErr("serve 已停止。");
  // 正常 Ctrl+C 停服视为成功退出
  await exit(0);
}

export async function bootCli(): Promise<void> {
  document.documentElement.style.background = "#0f1419";
  document.body.style.margin = "0";
  document.body.innerHTML =
    '<div style="font-family:-apple-system,sans-serif;color:#9aa4b2;padding:24px;font-size:13px">CLI 运行中…</div>';

  let argv: string[] = [];
  try {
    argv = await invoke<string[]>("get_cli_argv");
  } catch (err) {
    await emit(
      JSON.stringify({
        ok: false,
        version: appVersion(),
        command: "boot",
        ranAt: new Date().toISOString(),
        error: {
          code: "argv_unavailable",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    );
    await exit(1);
    return;
  }

  const parsed = parseCliArgv(argv);

  if (!parsed.parseError && parsed.command === "serve") {
    await bootServe(parsed);
    return;
  }

  const abort = watchAbort();
  let envelope: CliEnvelope;
  try {
    const run = dispatchCli(parsed, { shouldAbort: abort.isAborted });
    if (cliCommandSwitchesNodes(parsed)) {
      // 可能切换过节点：必须等 runner 停下并切回，不能提前退出。
      envelope = await run;
    } else {
      // 不切换节点：收到中断就立即结束。
      envelope = await Promise.race([
        run,
        abort.aborted.then(() => abortedEnvelope(parsed)),
      ]);
    }
  } catch (err) {
    envelope = {
      ok: false,
      version: appVersion(),
      command: parsed.command,
      ranAt: new Date().toISOString(),
      error: {
        code: "boot_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    abort.stop();
  }

  // 默认一行 JSON；--no-json 输出人类摘要（help 为纯文本）。
  await emit(parsed.json ? JSON.stringify(envelope) : formatCliHuman(envelope));
  await exit(cliExitCode(envelope));
}

/** 是否应由 CLI 路径接管（Tauri 下询问 Rust）。 */
export async function shouldBootCli(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
    return false;
  }
  try {
    return await invoke<boolean>("is_cli_mode");
  } catch {
    return false;
  }
}
