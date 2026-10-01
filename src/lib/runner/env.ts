/**
 * 环境泄漏检查：无 React，HomePage 只负责把结果塞进 state。
 */
import { ENV_CARD_IDS, runEnvDiagnostics } from "../egress";
import { ENV_PLACEHOLDERS, asRunning } from "./placeholders";
import type { RunEnvContext, RunnerHooks } from "./types";

export async function runEnv(
  ctx: RunEnvContext,
  hooks: RunnerHooks,
): Promise<boolean> {
  hooks.onEnvCards?.(asRunning(ENV_PLACEHOLDERS));
  try {
    const cards = await runEnvDiagnostics(hooks.onUpsertEnvCard, {
      mixedPort: ctx.mixedPort,
      mihomoConfig: ctx.connection.config,
      exitIp: ctx.exitIp ?? null,
    });
    const cardsById = new Map(cards.map((card) => [card.id, card]));
    hooks.onEnvCards?.(
      ENV_CARD_IDS.map((id) => cardsById.get(id)).filter(
        (card): card is (typeof cards)[number] => card !== undefined,
      ),
    );
    return true;
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
    return false;
  }
}
