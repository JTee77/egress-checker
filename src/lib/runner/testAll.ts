/**
 * 测全部节点：完整深测（runNodeDiagnostics），与测单个相同探针全集。
 * 含连通性预检、临时切换、切回；无 React。
 */
import { mapPool, runNodeDiagnostics } from "../egress";
import {
  findSelectorGroup,
  probeDelay,
  resolveSelectorSnapshot,
  restoreProxy,
  switchProxy,
  type ProxyNode,
  type SelectorSnapshot,
} from "../mihomo";
import {
  scoreDeadNode,
  scoreNodeFromCards,
  starRank,
  type GateResult,
  type NodeScoreResult,
} from "../score";
import { DELAY_URL, NODE_PLACEHOLDERS, asRunning } from "./placeholders";
import type { RunnerHooks, TestAllContext } from "./types";

const CULL_CONCURRENCY = 12;
const CLIENT_DEAD_FRESH_MS = 10 * 60 * 1000;

function sortScores(list: NodeScoreResult[]): NodeScoreResult[] {
  return [...list].sort((a, b) => {
    const byStar = starRank(b.stars) - starRank(a.stars);
    if (byStar !== 0) return byStar;
    return b.totalScore - a.totalScore;
  });
}

export async function testAll(
  ctx: TestAllContext,
  hooks: RunnerHooks,
): Promise<void> {
  const { connection, nodes, forceMock, mixedPort, ensureGate, shouldAbort } =
    ctx;

  hooks.onScores?.([]);
  hooks.onHint?.(null);
  hooks.onRestoreError?.(null);

  let originalSnap: SelectorSnapshot | null = null;
  let didSwitch = false;
  const config = connection.config;

  try {
    const g = await ensureGate();
    hooks.onGate?.(g);
    if (!g.ok) return;

    const list: ProxyNode[] = nodes.length
      ? nodes
      : connection.currentProxy
        ? [
            {
              name: connection.currentProxy,
              type: "Unknown",
              region: "未知",
              raw: { name: connection.currentProxy, type: "Unknown" },
            },
          ]
        : [];

    if (!list.length) {
      const fail: GateResult = {
        ok: false,
        message:
          "还没有读到节点列表。请先点「获取节点」，确认VPN软件里已经加载了订阅。",
      };
      hooks.onGate?.(fail);
      return;
    }

    const results: NodeScoreResult[] = [];
    const alive: ProxyNode[] = [];
    const canSwitch = !!config && !connection.usingMock && !forceMock;

    const upsertScore = (score: NodeScoreResult) => {
      const i = results.findIndex((r) => r.nodeName === score.nodeName);
      if (i >= 0) results[i] = score;
      else results.push(score);
      hooks.onUpsertScore?.(score);
    };

    if (canSwitch) {
      originalSnap = await resolveSelectorSnapshot(
        config,
        connection.currentProxy,
      );
      if (!originalSnap?.now && connection.currentProxy) {
        const group =
          (await findSelectorGroup(config, connection.currentProxy)) ??
          originalSnap?.group;
        if (group) {
          originalSnap = { group, now: connection.currentProxy };
        }
      }
    }

    const clientDead = list.filter((n) => {
      if (n.lastDelay !== 0 || !n.lastDelayAt) return false;
      const t = Date.parse(n.lastDelayAt.replace(/(\.\d{3})\d+/, "$1"));
      return Number.isFinite(t) && Date.now() - t <= CLIENT_DEAD_FRESH_MS;
    });
    for (const n of clientDead) {
      upsertScore(scoreDeadNode(n.name, "客户端最近测速失败，按不可用处理。"));
    }
    const toCheck = list.filter((n) => !clientDead.includes(n));

    hooks.onProgress({
      text: `连通性预检 0/${toCheck.length}`,
      current: 0,
      total: toCheck.length,
      testingNode: undefined,
    });

    if (!canSwitch) {
      for (let i = 0; i < toCheck.length; i++) {
        if (shouldAbort()) break;
        const n = toCheck[i]!;
        hooks.onProgress({
          text: `连通性预检 ${i + 1}/${toCheck.length}`,
          current: i + 1,
          total: toCheck.length,
          testingNode: n.name,
        });
        if (i === toCheck.length - 1 && toCheck.length > 1) {
          upsertScore(
            scoreDeadNode(n.name, "演示：延迟探测失败，按不可用处理。"),
          );
        } else {
          alive.push(n);
        }
      }
    } else {
      let cullDone = 0;
      const cullOut = await mapPool(toCheck, CULL_CONCURRENCY, async (n) => {
        if (shouldAbort()) {
          return { n, delay: null as number | null, skipped: true };
        }
        const delay = await probeDelay(config!, n.name, DELAY_URL, 5000);
        cullDone += 1;
        hooks.onProgress({
          text: `连通性预检 ${cullDone}/${toCheck.length}`,
          current: cullDone,
          total: toCheck.length,
          testingNode: n.name,
        });
        if (delay == null) {
          upsertScore(scoreDeadNode(n.name, "延迟探测失败，按不可用处理。"));
        }
        return { n, delay, skipped: false };
      });
      for (const row of cullOut) {
        if (row.skipped) continue;
        if (row.delay == null) continue;
        alive.push(row.n);
      }
    }

    if (canSwitch && !shouldAbort() && originalSnap?.group && originalSnap.now) {
      for (let i = 0; i < alive.length; i++) {
        if (shouldAbort()) break;
        const n = alive[i]!;
        hooks.onProgress({
          text: `检测 ${i + 1}/${alive.length}（${n.name}）`,
          current: i + 1,
          total: alive.length,
          testingNode: n.name,
        });
        const group =
          (await findSelectorGroup(config!, n.name)) ?? originalSnap.group;
        if (!group) {
          upsertScore(
            scoreDeadNode(n.name, "找不到可切换的策略组，没法检测这个节点。"),
          );
          continue;
        }
        const ok = await switchProxy(config!, group, n.name);
        if (!ok) {
          upsertScore(scoreDeadNode(n.name, "切换失败，没法检测这个节点。"));
          continue;
        }
        didSwitch = true;
        await new Promise((r) => setTimeout(r, 250));
        if (shouldAbort()) break;
        hooks.onNodeCards(asRunning(NODE_PLACEHOLDERS));
        const r = await runNodeDiagnostics(hooks.onUpsertNodeCard, {
          mixedPort,
          mihomoConfig: config,
        });
        hooks.onReport?.(r);
        hooks.onNodeCards(r.cards);
        upsertScore(scoreNodeFromCards(n.name, r.cards, r.ranAt));
      }
    } else if (canSwitch) {
      hooks.onHint?.(
        "连上了VPN软件，但读不到当前选中的节点或策略组，没法安全地临时切换。只检测当前节点。",
      );
      hooks.onProgress({
        text: "正在检测当前节点（无法安全切换）…",
        testingNode: connection.currentProxy ?? undefined,
      });
      hooks.onNodeCards(asRunning(NODE_PLACEHOLDERS));
      const r = await runNodeDiagnostics(hooks.onUpsertNodeCard, {
        mixedPort,
        mihomoConfig: config,
      });
      hooks.onReport?.(r);
      hooks.onNodeCards(r.cards);
      const currentName = connection.currentProxy ?? "当前节点";
      upsertScore(scoreNodeFromCards(currentName, r.cards, r.ranAt));
      for (const n of alive) {
        if (n.name === currentName) continue;
        upsertScore(
          scoreDeadNode(
            n.name,
            "没法切换到该节点做检测（读不到策略组或当前选中）。",
          ),
        );
      }
    } else {
      for (let i = 0; i < alive.length; i++) {
        if (shouldAbort()) break;
        const n = alive[i]!;
        hooks.onProgress({
          text: `检测 ${i + 1}/${alive.length}（演示）`,
          current: i + 1,
          total: alive.length,
          testingNode: n.name,
        });
        hooks.onNodeCards(asRunning(NODE_PLACEHOLDERS));
        const r = await runNodeDiagnostics(hooks.onUpsertNodeCard, {
          mixedPort,
          mihomoConfig: config,
        });
        hooks.onReport?.(r);
        hooks.onNodeCards(r.cards);
        upsertScore(scoreNodeFromCards(n.name, r.cards, r.ranAt));
      }
    }

    hooks.onScores?.(sortScores(results));
    hooks.onProgress(null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    hooks.onProgress(null);
    hooks.onGate?.({ ok: false, message: `测全部节点时出错：${msg}` });
  } finally {
    if (didSwitch && config && originalSnap?.now && originalSnap.group) {
      hooks.onProgress({
        text: `正在切回原先节点：${originalSnap.now}…`,
        testingNode: undefined,
      });
      const restored = await restoreProxy(config, originalSnap);
      if (!restored) {
        const errMsg = `没法自动切回原先的节点「${originalSnap.now}」。请立刻到VPN软件里手动选回去，否则你可能还停在别的节点上。`;
        hooks.onRestoreError?.(errMsg);
        hooks.onHint?.(errMsg);
      } else {
        hooks.onRestoreError?.(null);
      }
      hooks.onProgress(null);
    } else if (didSwitch && (!originalSnap?.now || !originalSnap.group)) {
      const errMsg =
        "测全部时切换过节点，但应用没有记下原先选中的节点，没法自动切回。请到VPN软件里确认当前节点。";
      hooks.onRestoreError?.(errMsg);
      hooks.onHint?.(errMsg);
    }
  }
}
