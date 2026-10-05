/**
 * CLI 启动：在隐藏窗里跑完 dispatch，经 Rust 打印 stdout 后退出。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  abortedEnvelope,
  cliCommandSwitchesNodes,
  cliExitCode,
  dispatchCli,
  formatCliHuman,
  parseCliArgv,
  type CliEnvelope,
} from "../lib/cli";

const ABORT_POLL_MS = 250;

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

async function exit(code: number): Promise<void> {
  try {
    await invoke("cli_exit", { code });
  } catch {
    // process should already be gone
  }
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
        version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0",
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
      version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0",
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
