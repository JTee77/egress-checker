/**
 * 测单个节点：完整深测（runNodeDiagnostics）。
 * 非当前节点时临时切换、测完切回。无 React。
 */
import { runNodeDiagnostics } from "../egress";
import {
  findSelectorGroup,
  resolveSelectorSnapshot,
  restoreProxy,
  switchProxy,
  type SelectorSnapshot,
} from "../mihomo";
import { scoreNodeFromCards } from "../score";
import { NODE_PLACEHOLDERS, asRunning } from "./placeholders";
import type { RunnerHooks, TestOneContext } from "./types";

export async function testOne(
  ctx: TestOneContext,
  hooks: RunnerHooks,
): Promise<void> {
  const { node, connection, forceMock, mixedPort, ensureGate } = ctx;
  const config = connection.config;
  let snap: SelectorSnapshot | null = null;
  let didSwitch = false;

  hooks.onRestoreError?.(null);

  try {
    const g = await ensureGate();
    hooks.onGate?.(g);
    if (!g.ok) return;

    const isCurrent = node.name === connection.currentProxy;
    if (!isCurrent && config && !connection.usingMock && !forceMock) {
      snap = await resolveSelectorSnapshot(config, connection.currentProxy);
      const group =
        (await findSelectorGroup(config, node.name)) ?? snap?.group;
      if (!group) {
        hooks.onHint?.("找不到可切换的策略组，没法单独测这个节点。");
        return;
      }
      const ok = await switchProxy(config, group, node.name);
      if (!ok) {
        hooks.onHint?.("切换失败，没法测这个节点。");
        return;
      }
      didSwitch = true;
      await new Promise((r) => setTimeout(r, 250));
    }

    hooks.onProgress({ text: `正在检测 ${node.name}…`, testingNode: node.name });
    hooks.onNodeCards(asRunning(NODE_PLACEHOLDERS));

    const r = await runNodeDiagnostics(hooks.onUpsertNodeCard, {
      mixedPort,
      mihomoConfig: config,
    });
    hooks.onReport?.(r);
    hooks.onNodeCards(r.cards);
    const scored = scoreNodeFromCards(node.name, r.cards, r.ranAt);
    hooks.onUpsertScore?.(scored);
  } catch (err) {
    hooks.onHint?.(err instanceof Error ? err.message : String(err));
  } finally {
    if (didSwitch && config && snap?.now && snap.group) {
      const restored = await restoreProxy(config, snap);
      if (!restored) {
        hooks.onRestoreError?.(
          `没能自动切回原先节点「${snap.now}」，请到VPN软件里手动选回。`,
        );
      }
    }
    hooks.onProgress(null);
  }
}
