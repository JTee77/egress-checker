/**
 * CLI 启动：在隐藏窗里跑完 dispatch，经 Rust 打印 stdout 后退出。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  dispatchCli,
  formatCliHuman,
  parseCliArgv,
  type CliEnvelope,
} from "../lib/cli";

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
  let envelope: CliEnvelope;
  try {
    envelope = await dispatchCli(parsed);
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
  }

  if (parsed.json || parsed.command !== "help") {
    // help + --no-json → human text; otherwise JSON line
    if (!parsed.json && parsed.command === "help") {
      await emit(formatCliHuman(envelope));
    } else if (!parsed.json) {
      await emit(formatCliHuman(envelope));
    } else {
      await emit(JSON.stringify(envelope));
    }
  } else {
    await emit(formatCliHuman(envelope));
  }

  await exit(envelope.ok ? 0 : 1);
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
