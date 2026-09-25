import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCardView } from "../components/CheckCardView";
import { NodeCard } from "../components/NodeCard";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ProgressInfo } from "../components/TestProgress";
import {
  mapPool,
  runEnvDiagnostics,
  runNodeDeepLight,
  type CheckCard,
  type EgressReport,
} from "../lib/egress";
import {
  CLIENT_OPTIONS,
  clientLabel,
  findSelectorGroup,
  normalizeClientId,
  probeDelay,
  resolveSelectorSnapshot,
  restoreProxy,
  switchProxy,
  type ClientId,
  type ConnectionState,
  type ControllerConfig,
  type ProxyNode,
  type SelectorSnapshot,
} from "../lib/mihomo";
import {
  starRank,
  runLightGate,
  scoreDeadNode,
  scoreNodeFromCards,
  type GateResult,
  type NodeScoreResult,
} from "../lib/score";

type TestMode = "current" | "all";

const NODE_PLACEHOLDERS: CheckCard[] = [
  { id: "reachability", title: "连通性", level: "unknown", conclusion: "尚未检测" },
  { id: "exit-ip", title: "出口 IP", level: "unknown", conclusion: "尚未检测" },
  { id: "latency", title: "延迟采样", level: "unknown", conclusion: "尚未检测" },
  { id: "bandwidth", title: "抽样带宽", level: "unknown", conclusion: "尚未检测" },
  { id: "gemini", title: "Gemini（换节点对照）", level: "unknown", conclusion: "尚未检测" },
  { id: "chatgpt", title: "ChatGPT（换节点对照）", level: "unknown", conclusion: "尚未检测" },
  { id: "netflix", title: "Netflix", level: "unknown", conclusion: "尚未检测" },
  { id: "disney", title: "Disney+", level: "unknown", conclusion: "尚未检测" },
  { id: "youtube", title: "YouTube Premium", level: "unknown", conclusion: "尚未检测" },
  { id: "app-store", title: "App Store", level: "unknown", conclusion: "尚未检测" },
  { id: "google-play", title: "Google Play", level: "unknown", conclusion: "尚未检测" },
];

const ENV_PLACEHOLDERS: CheckCard[] = [
  { id: "dns-leak", title: "DNS 解析器", level: "unknown", conclusion: "尚未检测" },
  { id: "ipv6-leak", title: "IPv6 泄漏", level: "unknown", conclusion: "尚未检测" },
  { id: "webrtc", title: "WebRTC", level: "unknown", conclusion: "尚未检测" },
  { id: "split-routing", title: "分流检查", level: "unknown", conclusion: "尚未检测" },
  { id: "bare-egress", title: "直连旁路检查", level: "unknown", conclusion: "尚未检测" },
];

const DELAY_URL = "http://www.gstatic.com/generate_204";

function asRunning(list: CheckCard[]): CheckCard[] {
  return list.map((c) => ({ ...c, level: "running" as const, conclusion: "检测中…" }));
}

/** 瀑布流列数：单卡固定 250px + 9px 列距，1–8 列封顶。40 为 .main 左右 padding。 */
function colCountFor(vw: number): number {
  return Math.min(8, Math.max(1, Math.floor((vw - 31) / 259)));
}

export function HomePage({
  connection,
  busy,
  nodes,
  clientId,
  onClientIdChange,
  onRefresh,
  manual,
  forceMock,
  onChangeManual,
  onResetManual,
  onForceMockChange,
  onRefreshAdvanced,
}: {
  connection: ConnectionState;
  busy?: boolean;
  nodes: ProxyNode[];
  clientId: ClientId | null;
  onClientIdChange: (id: ClientId) => void;
  onRefresh?: () => Promise<unknown> | void;
  manual: Partial<ControllerConfig>;
  forceMock: boolean;
  onChangeManual: (patch: Partial<ControllerConfig>) => void;
  onResetManual: () => void;
  onForceMockChange: (v: boolean) => void;
  onRefreshAdvanced: (override?: Partial<ControllerConfig>) => Promise<unknown>;
}) {
  const [nodeCards, setNodeCards] = useState<CheckCard[]>(NODE_PLACEHOLDERS);
  const [envCards, setEnvCards] = useState<CheckCard[]>(ENV_PLACEHOLDERS);
  const [report, setReport] = useState<EgressReport | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState<TestMode>("current");
  const [gate, setGate] = useState<GateResult | null>(null);
  const [nodeScores, setNodeScores] = useState<NodeScoreResult[]>([]);
  const [envOpen, setEnvOpen] = useState(false);
  const [envRunning, setEnvRunning] = useState(false);
  const [allConfirmOpen, setAllConfirmOpen] = useState(false);
  const [switchHint, setSwitchHint] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const abortAllRef = useRef(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [testingNode, setTestingNode] = useState<string | null>(null);
  const [colCount, setColCount] = useState(() =>
    typeof window === "undefined" ? 2 : colCountFor(window.innerWidth),
  );

  const cfg = connection.config;
  const [host, setHost] = useState(manual.host ?? cfg?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(manual.port ?? cfg?.port ?? 9097));
  const [secret, setSecret] = useState(manual.secret ?? cfg?.secret ?? "");
  const [mixedPort, setMixedPort] = useState(
    String(manual.mixedPort ?? cfg?.mixedPort ?? 7897),
  );

  const clientUnset = !clientId;

  const scoreByName = useMemo(() => {
    const m = new Map<string, (typeof nodeScores)[number]>();
    for (const s of nodeScores) m.set(s.nodeName, s);
    return m;
  }, [nodeScores]);

  const orderedNodes = useMemo(() => {
    const current = connection.currentProxy;
    const ordered = [...nodes];
    if (nodeScores.length > 0) {
      // 三桶排序：已测活的在前（按星级/总分），没测的居中（保持订阅顺序，
      // 当前节点优先），不可用的垫底——测全部过程中死节点边测边出分，
      // 不能让它们反而浮到最前面干扰阅读。
      const bucket = (s?: NodeScoreResult) =>
        !s ? 1 : s.stars === "unavailable" ? 2 : 0;
      ordered.sort((a, b) => {
        const sa = scoreByName.get(a.name);
        const sb = scoreByName.get(b.name);
        const ka = bucket(sa);
        const kb = bucket(sb);
        if (ka !== kb) return ka - kb;
        if (sa && sb) {
          const byStar = starRank(sb.stars) - starRank(sa.stars);
          if (byStar !== 0) return byStar;
          return sb.totalScore - sa.totalScore;
        }
        if (a.name === current) return -1;
        if (b.name === current) return 1;
        return 0;
      });
      return ordered;
    }
    if (current) {
      const i = ordered.findIndex((n) => n.name === current);
      if (i > 0) {
        const [row] = ordered.splice(i, 1);
        ordered.unshift(row);
      }
    }
    return ordered;
  }, [nodes, connection.currentProxy, nodeScores, scoreByName]);

  const mixedPortNum = connection.config?.mixedPort ?? null;

  const upsertNodeCard = (card: CheckCard) => {
    setNodeCards((prev) => {
      const idx = prev.findIndex((p) => p.id === card.id);
      if (idx === -1) return [...prev, card];
      const next = [...prev];
      next[idx] = card;
      return next;
    });
  };

  const upsertEnvCard = (card: CheckCard) => {
    setEnvCards((prev) => {
      const idx = prev.findIndex((p) => p.id === card.id);
      if (idx === -1) return [...prev, card];
      const next = [...prev];
      next[idx] = card;
      return next;
    });
  };

  const onSelectClient = (raw: string) => {
    const id = normalizeClientId(raw);
    if (!id) return;
    onClientIdChange(id);
  };

  const applyAdvanced = async () => {
    const patch: Partial<ControllerConfig> = {
      host,
      port: Number(port) || 9097,
      secret,
      mixedPort: Number(mixedPort) || 7897,
      source: "manual",
    };
    onChangeManual(patch);
    await onRefreshAdvanced(patch);
  };

  const autoDetect = async () => {
    onResetManual();
    setHost("127.0.0.1");
    setPort("9097");
    setSecret("");
    setMixedPort("7897");
    await onRefreshAdvanced({ source: "auto" });
  };

  const refreshAndGate = async () => {
    setRefreshing(true);
    try {
      const next = await onRefresh?.();
      const conn =
        next && typeof next === "object" && "status" in (next as object)
          ? (next as ConnectionState)
          : connection;
      const g = await runLightGate(conn);
      setGate(g);
    } finally {
      setRefreshing(false);
    }
  };

  const ensureGate = async (): Promise<GateResult> => {
    setProgress({ text: "测试条件检查中…" });
    const g = await runLightGate(connection);
    setGate(g);
    setProgress(null);
    return g;
  };

  const testAll = async () => {
    abortAllRef.current = false;
    setRunning(true);
    setNodeScores([]);
    setSwitchHint(null);
    setRestoreError(null);

    let originalSnap: SelectorSnapshot | null = null;
    let didSwitch = false;
    const config = connection.config;

    try {
      const g = await ensureGate();
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
        setGate({
          ok: false,
          message:
            "还没有读到节点列表。请先点「获取节点」，确认VPN软件里已经加载了订阅。",
        });
        return;
      }

      const results: NodeScoreResult[] = [];
      const alive: ProxyNode[] = [];
      const canSwitch =
        !!config && !connection.usingMock && !forceMock;
      /** 并发连通性预检：对齐参考脚本 ThreadPool ~10，取 12 */
      const CULL_CONCURRENCY = 12;

      const sortScores = (list: NodeScoreResult[]) =>
        [...list].sort((a, b) => {
          const byStar = starRank(b.stars) - starRank(a.stars);
          if (byStar !== 0) return byStar;
          return b.totalScore - a.totalScore;
        });

      /** Flush one score to the grid immediately (safe under concurrent cull). */
      const upsertScore = (score: NodeScoreResult) => {
        const i = results.findIndex((r) => r.nodeName === score.nodeName);
        if (i >= 0) results[i] = score;
        else results.push(score);
        setNodeScores((prev) => {
          const next = prev.filter((x) => x.nodeName !== score.nodeName);
          next.push(score);
          return sortScores(next);
        });
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

      // 客户端"最近"测失败（10 分钟内）的节点直接跳过预检。客户端的失败
      // 记录可能过期（实测有 2 小时前判死、现在已恢复的节点），所以只信
      // 新鲜记录：过期的失败记录一律仍走预检实测。
      const CLIENT_DEAD_FRESH_MS = 10 * 60 * 1000;
      const clientDead = list.filter((n) => {
        if (n.lastDelay !== 0 || !n.lastDelayAt) return false;
        // mihomo 时间戳可能带 6 位小数秒，Date.parse 只保证 3 位
        const t = Date.parse(n.lastDelayAt.replace(/(\.\d{3})\d+/, "$1"));
        return Number.isFinite(t) && Date.now() - t <= CLIENT_DEAD_FRESH_MS;
      });
      for (const n of clientDead) {
        upsertScore(scoreDeadNode(n.name, "客户端最近测速失败，按不可用处理。"));
      }
      const toCheck = list.filter((n) => !clientDead.includes(n));

      setProgress({ text: `连通性预检 0/${toCheck.length}`, current: 0, total: toCheck.length, testingNode: undefined });
      if (!canSwitch) {
        for (let i = 0; i < toCheck.length; i++) {
          if (abortAllRef.current) break;
          const n = toCheck[i];
          setProgress({
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
          if (abortAllRef.current) {
            return { n, delay: null as number | null, skipped: true };
          }
          const delay = await probeDelay(config!, n.name, DELAY_URL, 5000);
          cullDone += 1;
          setProgress({
            text: `连通性预检 ${cullDone}/${toCheck.length}`,
            current: cullDone,
            total: toCheck.length,
            testingNode: n.name,
          });
          if (delay == null) {
            upsertScore(
              scoreDeadNode(n.name, "延迟探测失败，按不可用处理。"),
            );
          }
          return { n, delay, skipped: false };
        });
        for (const row of cullOut) {
          if (row.skipped) continue;
          if (row.delay == null) continue;
          alive.push(row.n);
        }
      }

      if (canSwitch && !abortAllRef.current && originalSnap?.group && originalSnap.now) {
        for (let i = 0; i < alive.length; i++) {
          if (abortAllRef.current) {
            break;
          }
          const n = alive[i];
          setProgress({
            text: `检测 ${i + 1}/${alive.length}（${n.name}）`,
            current: i + 1,
            total: alive.length,
            testingNode: n.name,
          });
          const group =
            (await findSelectorGroup(config!, n.name)) ?? originalSnap.group;
          if (!group) {
            upsertScore(
              scoreDeadNode(
                n.name,
                "找不到可切换的策略组，没法检测这个节点。",
              ),
            );
            continue;
          }
          const ok = await switchProxy(config!, group, n.name);
          if (!ok) {
            upsertScore(
              scoreDeadNode(n.name, "切换失败，没法检测这个节点。"),
            );
            continue;
          }
          didSwitch = true;
          await new Promise((r) => setTimeout(r, 250));
          if (abortAllRef.current) break;
          setNodeCards(asRunning(NODE_PLACEHOLDERS));
          const r = await runNodeDeepLight(upsertNodeCard, {
            mixedPort: mixedPortNum,
            mihomoConfig: config,
          });
          setReport(r);
          setNodeCards(r.cards);
          upsertScore(scoreNodeFromCards(n.name, r.cards, r.ranAt));
        }
      } else if (canSwitch) {
        // API 在，但读不到原先选中 / 策略组：仍尽量深测当前出口，并说明原因
        setSwitchHint(
          "连上了VPN软件，但读不到当前选中的节点或策略组，没法安全地临时切换。只检测当前节点。",
        );
        setProgress({
          text: "正在检测当前节点（无法安全切换）…",
          testingNode: connection.currentProxy ?? undefined,
        });
        setNodeCards(asRunning(NODE_PLACEHOLDERS));
        const r = await runNodeDeepLight(upsertNodeCard, {
          mixedPort: mixedPortNum,
          mihomoConfig: config,
        });
        setReport(r);
        setNodeCards(r.cards);
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
        // Mock / 无配置：演示轻量深测，不切换
        for (let i = 0; i < alive.length; i++) {
          if (abortAllRef.current) break;
          const n = alive[i];
          setProgress({
            text: `检测 ${i + 1}/${alive.length}（演示）`,
            current: i + 1,
            total: alive.length,
            testingNode: n.name,
          });
          setNodeCards(asRunning(NODE_PLACEHOLDERS));
          const r = await runNodeDeepLight(upsertNodeCard, {
            mixedPort: mixedPortNum,
            mihomoConfig: config,
          });
          setReport(r);
          setNodeCards(r.cards);
          upsertScore(scoreNodeFromCards(n.name, r.cards, r.ranAt));
        }
      }

      const sorted = sortScores(results);
      setNodeScores(sorted);
      setProgress(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProgress(null);
      setGate({ ok: false, message: `测全部节点时出错：${msg}` });
    } finally {
      // 成功 / 中止 / 出错：只要切过，就必须尝试切回；失败要明确报错
      if (didSwitch && config && originalSnap?.now && originalSnap.group) {
        setProgress({ text: `正在切回原先节点：${originalSnap.now}…`, testingNode: undefined });
        const restored = await restoreProxy(config, originalSnap);
        if (!restored) {
          const errMsg = `没法自动切回原先的节点「${originalSnap.now}」。请立刻到VPN软件里手动选回去，否则你可能还停在别的节点上。`;
          setRestoreError(errMsg);
          setSwitchHint(errMsg);
        } else {
          setRestoreError(null);
        }
        setProgress(null);
      } else if (didSwitch && (!originalSnap?.now || !originalSnap.group)) {
        const errMsg =
          "测全部时切换过节点，但应用没有记下原先选中的节点，没法自动切回。请到VPN软件里确认当前节点。";
        setRestoreError(errMsg);
        setSwitchHint(errMsg);
      }
      setRunning(false);
      abortAllRef.current = false;
    }
  };

  const runEnv = async () => {
    setEnvRunning(true);
    setEnvOpen(true);
    setEnvCards(asRunning(ENV_PLACEHOLDERS));
    try {
      const cards = await runEnvDiagnostics(upsertEnvCard, {
        mixedPort: mixedPortNum,
        mihomoConfig: connection.config,
        exitIp: report?.exitIp ?? null,
      });
      setEnvCards(cards);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setEnvCards(
        ENV_PLACEHOLDERS.map((c) => ({
          ...c,
          level: "fail",
          conclusion: "环境检查失败",
          process: msg,
        })),
      );
    } finally {
      setEnvRunning(false);
    }
  };

  const onConfirmAll = () => {
    setAllConfirmOpen(false);
    void testAll();
  };

  const onAbortAll = () => {
    abortAllRef.current = true;
    setProgress({ text: "正在停止…", testingNode: undefined });
  };

  // v0.1.10：版本号进原生标题栏（玻璃窗口下正文不再放介绍卡）。
  useEffect(() => {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void getCurrentWindow()
        .setTitle(`Egress Checker ${__APP_VERSION__}`)
        .catch(() => {});
    }
  }, []);

  // 步骤③完成判定：三种检测路径（环境检查/测全部/测单节点）任一产出过结果
  const envDone =
    envCards.length > 0 &&
    envCards.every(
      (c) => c.level !== "unknown" && c.level !== "running",
    );
  const detectionDone = nodeScores.length > 0 || envDone;

  const toggleExpand = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // 瀑布流列数：Tauri 的 webview 宽度 = 窗口宽度，直接用 window.innerWidth +
  // resize 事件，比 ResizeObserver 可靠 —— 不受"工作区条件渲染、挂载时序"影响。
  useEffect(() => {
    const onResize = () => setColCount(colCountFor(window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const nodeColumns: ProxyNode[][] = useMemo(
    () => {
      const cols: ProxyNode[][] = Array.from({ length: colCount }, () => []);
      orderedNodes.forEach((n, i) => cols[i % colCount].push(n));
      return cols;
    },
    [orderedNodes, colCount],
  );

  // 测全部的行内进度（0–100；无比例时 null）
  const progressPct =
    progress &&
    typeof progress.current === "number" &&
    typeof progress.total === "number" &&
    progress.total > 0
      ? Math.max(
          0,
          Math.min(100, Math.round((progress.current / progress.total) * 100)),
        )
      : null;

  const allExpanded =
    orderedNodes.length > 0 && orderedNodes.every((n) => expanded.has(n.name));

  const toggleExpandAll = () =>
    setExpanded(
      allExpanded ? new Set() : new Set(orderedNodes.map((n) => n.name)),
    );

  // 单独测某个节点：非当前节点时临时切换、测完切回（复用测全部的机制）。
  const testOneNode = async (node: ProxyNode) => {
    if (running) return;
    const config = connection.config;
    let snap: SelectorSnapshot | null = null;
    let didSwitch = false;
    setRunning(true);
    setTestingNode(node.name);
    setRestoreError(null);
    try {
      const g = await ensureGate();
      if (!g.ok) return;
      const isCurrent = node.name === connection.currentProxy;
      if (!isCurrent && config && !connection.usingMock && !forceMock) {
        snap = await resolveSelectorSnapshot(config, connection.currentProxy);
        const group =
          (await findSelectorGroup(config, node.name)) ?? snap?.group;
        if (!group) {
          setSwitchHint("找不到可切换的策略组，没法单独测这个节点。");
          return;
        }
        const ok = await switchProxy(config, group, node.name);
        if (!ok) {
          setSwitchHint("切换失败，没法测这个节点。");
          return;
        }
        didSwitch = true;
        await new Promise((r) => setTimeout(r, 250));
      }
      setProgress({ text: `正在检测 ${node.name}…`, testingNode: node.name });
      setNodeCards(asRunning(NODE_PLACEHOLDERS));
      const r = await runNodeDeepLight(upsertNodeCard, {
        mixedPort: mixedPortNum,
        mihomoConfig: config,
      });
      setNodeCards(r.cards);
      const scored = scoreNodeFromCards(node.name, r.cards, r.ranAt);
      setNodeScores((prev) => {
        const next = prev.filter((x) => x.nodeName !== node.name);
        next.push(scored);
        return next;
      });
      setExpanded((prev) => new Set(prev).add(node.name));
    } catch (err) {
      setSwitchHint(err instanceof Error ? err.message : String(err));
    } finally {
      if (didSwitch && config && snap?.now && snap.group) {
        const restored = await restoreProxy(config, snap);
        if (!restored)
          setRestoreError(
            `没能自动切回原先节点「${snap.now}」，请到VPN软件里手动选回。`,
          );
      }
      setRunning(false);
      setTestingNode(null);
      setProgress(null);
    }
  };

  return (
    <div className="home-page">
      <div className="flow-hint" aria-label="使用步骤">
        <span className={`fh-step ${gate?.ok ? "done" : "cur"}`}>
          <i>{gate?.ok ? "✓" : "1"}</i>打开你的VPN软件并连上一个可用节点
        </span>
        <span className="fh-arrow">→</span>
        <span className={`fh-step ${gate?.ok ? "done" : "todo"}`}>
          <i>2</i>在下方选择你使用的VPN软件 · 获取节点
        </span>
        <span className="fh-arrow">→</span>
        <span
          className={`fh-step ${!gate?.ok ? "todo" : detectionDone ? "done" : "cur"}`}
        >
          <i>{!gate?.ok ? "3" : detectionDone ? "✓" : "3"}</i>进行检测
        </span>
      </div>

      <div className="app-header">
        <div className="home-ops-controls">
          <div className="picker-group">
            <label className="client-picker-label" htmlFor="home-client-select">
              你在用哪款软件？
            </label>
            <select
              id="home-client-select"
              className="client-picker-select"
              value={clientId ?? ""}
              onChange={(e) => onSelectClient(e.target.value)}
              title={
                clientUnset
                  ? "先选软件，再点「获取节点」"
                  : CLIENT_OPTIONS.find((o) => o.id === clientId)?.hint
              }
            >
              <option value="" disabled>
                请选择…
              </option>
              {CLIENT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn btn-primary btn-sm home-ops-refresh action-btn"
            type="button"
            disabled={!!busy || refreshing || running || clientUnset}
            title={clientUnset ? "请先选择软件" : undefined}
            onClick={() => void refreshAndGate()}
          >
            {busy || refreshing ? "获取中…" : "获取节点"}
          </button>
        </div>
        {!refreshing &&
        (connection.status === "connected" && gate?.ok ? (
          <span className="fetch-ok" title={connection.message}>
            <span className="status-ok-mark">✓</span>成功
          </span>
        ) : gate && !gate.ok ? (
          <>
            <span className="fetch-fail">
              <span className="status-fail-mark">✗</span>失败
            </span>
            <span className="fetch-fail-msg" role="status">
              {gate.message}
            </span>
          </>
        ) : null)}
      </div>

      {gate?.ok && orderedNodes.length > 0 ? (
        <>
          <div className="env-section">
            <div className="env-head">
              <div className="env-head-labels">
                <span className="t">环境泄漏检查</span>
                <span className="s">对当前出口体检 · 不需先测节点</span>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm action-btn"
                disabled={envRunning || running}
                onClick={() => void runEnv()}
              >
                {envRunning ? "检查中…" : envOpen ? "重新检查环境" : "开始环境检查"}
              </button>
            </div>
            {envOpen ? (
              <>
                {mixedPortNum == null || mixedPortNum <= 0 ? (
                  <div className="note note-compact" style={{ marginTop: 10 }}>
                    当前未检测到代理，境外探测点不可达，结论不代表 VPN 表现。
                  </div>
                ) : null}
                <div className="card-grid card-grid-home" style={{ marginTop: 10 }}>
                  {envCards.map((c) => (
                    <CheckCardView key={c.id} card={c} />
                  ))}
                </div>
              </>
            ) : null}
          </div>

          <div className="ws-ops">
            <button type="button" className="btn btn-sm" onClick={toggleExpandAll}>
              {allExpanded ? "收起全部详情" : "展开全部详情"}
            </button>
            <div className="ws-ops-right">
              <button
                type="button"
                className="btn btn-primary btn-sm action-btn"
                disabled={running || clientUnset}
                onClick={() => {
                  setMode("all");
                  setRestoreError(null);
                  setAllConfirmOpen(true);
                }}
              >
                {running && mode === "all" ? "测全部中…" : "测全部节点"}
              </button>
              {running && mode === "all" ? (
                <>
                  <div className="ws-progress" role="status" aria-live="polite">
                    <span className="ws-progress-text">{progress?.text}</span>
                    {progressPct != null ? (
                      <span
                        className="ws-progress-bar"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progressPct}
                      >
                        <span
                          className="ws-progress-fill"
                          style={{ width: `${progressPct}%` }}
                        />
                      </span>
                    ) : null}
                  </div>
                  <button type="button" className="btn btn-sm" onClick={onAbortAll}>
                    停止并切回
                  </button>
                </>
              ) : null}
              {switchHint && !restoreError ? (
                <span className="ws-error" role="alert">
                  {switchHint}
                </span>
              ) : null}
            </div>
          </div>

          <div className="node-flow">
            {nodeColumns.map((col, ci) => (
              <div className="flow-col" key={ci}>
                {col.map((n) => (
                  <NodeCard
                    key={n.name}
                    node={n}
                    score={scoreByName.get(n.name)}
                    liveCards={testingNode === n.name ? nodeCards : undefined}
                    isCurrent={n.name === connection.currentProxy}
                    expanded={expanded.has(n.name)}
                    testing={testingNode === n.name}
                    onToggle={() => {
                      if (scoreByName.get(n.name)) {
                        toggleExpand(n.name);
                      }
                    }}
                    onTest={() => void testOneNode(n)}
                  />
                ))}
              </div>
            ))}
          </div>
        </>
      ) : null}

      {allConfirmOpen && mode === "all" ? (
        <div className="confirm-overlay">
          <div
            className="confirm-panel card"
            role="dialog"
            aria-modal="true"
            aria-label="确认测全部"
          >
            <p className="confirm-body">
              点击「确定」后，将逐个检测所有节点（约几分钟），期间会切换出口节点并消耗流量，建议暂时不要进行支付、登录等重要操作。测完会自动切回原节点。
            </p>
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <button
                className="btn btn-primary"
                type="button"
                disabled={clientUnset}
                onClick={onConfirmAll}
              >
                确定
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => setAllConfirmOpen(false)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {restoreError ? (
        <div className="gate-banner gate-banner-block" role="alert">
          <div className="gate-banner-title">没能切回原先节点</div>
          <div className="gate-banner-msg">{restoreError}</div>
        </div>
      ) : null}

      <div className="fold-panel card">
        <button
          type="button"
          className="fold-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          {advancedOpen ? "收起高级" : "高级（一般不用）"}
        </button>
        {advancedOpen ? (
          <div className="fold-body">
            <p className="muted fold-hint">
              当前软件：<strong>{clientLabel(clientId)}</strong>
              {clientId
                ? " — 连接参数会按该软件自动发现，一般不用改。"
                : " — 请先选择你正在用的软件。"}
            </p>
            <div className="form-grid" style={{ marginBottom: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={forceMock}
                  onChange={(e) => onForceMockChange(e.target.checked)}
                />
                <span>
                  <strong>Mock 演示模式</strong>
                  <span className="muted"> — 用假数据预览界面，不连真实软件</span>
                </span>
              </label>
            </div>
            <div className="form-grid">
              <p className="muted fold-hint">
                以下字段仅在自动连接失败、或你清楚自己改过控制口时使用。
              </p>
              <div className="field">
                <label>Host</label>
                <input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  disabled={forceMock}
                />
              </div>
              <div className="field">
                <label>Port（external-controller）</label>
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  disabled={forceMock}
                />
              </div>
              <div className="field">
                <label>Secret（不会写入日志 / 仓库）</label>
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="off"
                  disabled={forceMock}
                />
              </div>
              <div className="field">
                <label>mixed-port（经代理探针）</label>
                <input
                  value={mixedPort}
                  onChange={(e) => setMixedPort(e.target.value)}
                  disabled={forceMock}
                />
              </div>
              <div className="toolbar" style={{ marginBottom: 0 }}>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!!busy || forceMock}
                  onClick={() => void applyAdvanced()}
                >
                  保存并测试连接
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={!!busy || forceMock}
                  onClick={() => void autoDetect()}
                >
                  重新自动发现
                </button>
              </div>
              <p className="muted fold-hint">
                来源：{cfg?.source ?? "—"}
                <br />
                Unix 套接字：{cfg?.sockPath ?? "（无）"}
                <br />
                mixed-port：{cfg?.mixedPort ?? "—"}
                <br />
                当前节点：{connection.currentProxy ?? "—"}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <details className="about-footer">
        <summary>关于 Egress Checker</summary>
        <div className="a-body">
          仓库：
          <a
            href="https://github.com/JTee77/egress-checker"
            target="_blank"
            rel="noreferrer"
          >
            github.com/JTee77/egress-checker
          </a>
          <br />
          致谢：Clash Verge / mihomo 社区。
          <br />
          请我喝杯咖啡 ☕（占位：链接或二维码待定）
        </div>
      </details>
    </div>
  );
}
