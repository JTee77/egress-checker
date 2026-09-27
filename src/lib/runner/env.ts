/**
 * 环境泄漏检查：无 React，HomePage 只负责把结果塞进 state。
 */
import { runEnvDiagnostics } from "../egress";
import { ENV_PLACEHOLDERS, asRunning } from "./placeholders";
import type { RunEnvContext, RunnerHooks } from "./types";

export async function runEnv(
  ctx: RunEnvContext,
  hooks: RunnerHooks,
): Promise<void> {
  hooks.onEnvCards?.(asRunning(ENV_PLACEHOLDERS));
  try {
    const cards = await runEnvDiagnostics(hooks.onUpsertEnvCard, {
      mixedPort: ctx.mixedPort,
      mihomoConfig: ctx.connection.config,
      exitIp: ctx.exitIp ?? null,
    });
    hooks.onEnvCards?.(cards);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    hooks.onEnvCards?.(
      ENV_PLACEHOLDERS.map((c) => ({
        ...c,
        level: "fail" as const,
        conclusion: "环境检查失败",
        process: msg,
      })),
    );
  }
}
