import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCardView } from "../components/CheckCardView";
import { StarRating } from "../components/StarRating";
import {
  TestProgress,
  type ProgressInfo,
} from "../components/TestProgress";
import {
  mapPool,
  runEnvDiagnostics,
  runNodeDeepLight,
  runNodeDiagnostics,
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
  scoreVpn,
  type GateResult,
  type NodeScoreResult,
  type VpnScoreResult,
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
  const [gateDetailOpen, setGateDetailOpen] = useState(false);
  const [nodeScores, setNodeScores] = useState<NodeScoreResult[]>([]);
  const [selectedNodeName, setSelectedNodeName] = useState<string | null>(null);
  const [vpnScore, setVpnScore] = useState<VpnScoreResult | null>(null);
  const [envOpen, setEnvOpen] = useState(false);
  const [envRunning, setEnvRunning] = useState(false);
  const [allConfirmOpen, setAllConfirmOpen] = useState(false);
  const [switchHint, setSwitchHint] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const abortAllRef = useRef(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

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
      ordered.sort((a, b) => {
        const sa = scoreByName.get(a.name);
        const sb = scoreByName.get(b.name);
        const aHas = sa ? 1 : 0;
        const bHas = sb ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas;
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

  const envReady = useMemo(
    () =>
      envCards.length > 0 &&
      envCards.every(
        (c) =>
          c.conclusion !== "尚未检测" &&
          c.conclusion !== "检测中…" &&
          c.level !== "running",
      ),
    [envCards],
  );

  useEffect(() => {
    if (!envReady || !selectedNodeName) {
      setVpnScore(null);
      return;
    }
    const scored = nodeScores.find((s) => s.nodeName === selectedNodeName);
    if (scored) setVpnScore(scoreVpn(scored, envCards));
    else setVpnScore(null);
  }, [envReady, selectedNodeName, nodeScores, envCards]);

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
      setGateDetailOpen(!g.ok);
    } finally {
      setRefreshing(false);
    }
  };

  const ensureGate = async (): Promise<GateResult> => {
    setProgress({ text: "测试条件检查中…" });
    const g = await runLightGate(connection);
    setGate(g);
    setGateDetailOpen(!g.ok);
    setProgress(null);
    return g;
  };

  const testCurrent = async () => {
    setRunning(true);
    setNodeScores([]);
    setVpnScore(null);
    setSelectedNodeName(null);
    setSwitchHint(null);
    try {
      const g = await ensureGate();
      if (!g.ok) return;

      setNodeCards(asRunning(NODE_PLACEHOLDERS));
      setProgress({ text: "正在检测当前节点…" });
      const r = await runNodeDiagnostics(upsertNodeCard, {
        mixedPort: mixedPortNum,
        mihomoConfig: connection.config,
      });
      setReport(r);
      setNodeCards(r.cards);
      const name = connection.currentProxy ?? "当前节点";
      const scored = scoreNodeFromCards(name, r.cards, r.ranAt);
      setNodeScores([scored]);
      setSelectedNodeName(name);
      setProgress(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNodeCards(
        NODE_PLACEHOLDERS.map((c) => ({
          ...c,
          level: "fail",
          conclusion: "检测失败",
          process: msg,
          suggestion: "请确认代理软件已打开并已连接，然后重新检测。",
        })),
      );
      setProgress(null);
    } finally {
      setRunning(false);
    }
  };

  const testAll = async () => {
    abortAllRef.current = false;
    setRunning(true);
    setNodeScores([]);
    setVpnScore(null);
    setSelectedNodeName(null);
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
            "还没有读到节点列表。请先点「刷新连接」，确认代理软件里已经加载了订阅。",
        });
        setGateDetailOpen(true);
        return;
      }

      const results: NodeScoreResult[] = [];
      const alive: ProxyNode[] = [];
      const canSwitch =
        !!config && !connection.usingMock && !forceMock;
      /** 并发剔死：对齐参考脚本 ThreadPool ~10，取 12 */
      const CULL_CONCURRENCY = 12;

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

      setProgress({ text: `连通性预检 0/${list.length}`, current: 0, total: list.length, testingNode: undefined });
      if (!canSwitch) {
        for (let i = 0; i < list.length; i++) {
          if (abortAllRef.current) break;
          const n = list[i];
          setProgress({
            text: `连通性预检 ${i + 1}/${list.length}`,
            current: i + 1,
            total: list.length,
            testingNode: n.name,
          });
          if (i === list.length - 1 && list.length > 1) {
            results.push(
              scoreDeadNode(n.name, "演示：延迟探测失败，按不可用处理。"),
            );
          } else {
            alive.push(n);
          }
        }
      } else {
        let cullDone = 0;
        const cullOut = await mapPool(list, CULL_CONCURRENCY, async (n) => {
          if (abortAllRef.current) {
            return { n, delay: null as number | null, skipped: true };
          }
          const delay = await probeDelay(config!, n.name, DELAY_URL, 2500);
          cullDone += 1;
          setProgress({
            text: `连通性预检 ${cullDone}/${list.length}`,
            current: cullDone,
            total: list.length,
            testingNode: n.name,
          });
          return { n, delay, skipped: false };
        });
        for (const row of cullOut) {
          if (row.skipped) continue;
          if (row.delay == null) {
            results.push(
              scoreDeadNode(row.n.name, "延迟探测失败，按不可用处理。"),
            );
          } else {
            alive.push(row.n);
          }
        }
      }

      if (abortAllRef.current) {
        setSwitchHint("已停止。");
      } else if (canSwitch && originalSnap?.group && originalSnap.now) {
        setSwitchHint(
          `测全部会临时切换节点。原先选中：${originalSnap.now}。测完后会自动切回去。`,
        );
        for (let i = 0; i < alive.length; i++) {
          if (abortAllRef.current) {
            setSwitchHint("已停止，正在切回原先节点…");
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
            results.push(
              scoreDeadNode(
                n.name,
                "找不到可切换的策略组，没法检测这个节点。",
              ),
            );
            continue;
          }
          const ok = await switchProxy(config!, group, n.name);
          if (!ok) {
            results.push(
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
          results.push(scoreNodeFromCards(n.name, r.cards, r.ranAt));
        }
      } else if (canSwitch) {
        // API 在，但读不到原先选中 / 策略组：仍尽量深测当前出口，并说明原因
        setSwitchHint(
          "连上了代理软件，但读不到当前选中的节点或策略组，没法安全地临时切换。只检测当前节点。",
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
        results.push(scoreNodeFromCards(currentName, r.cards, r.ranAt));
        for (const n of alive) {
          if (n.name === currentName) continue;
          results.push(
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
          results.push(scoreNodeFromCards(n.name, r.cards, r.ranAt));
        }
      }

      results.sort((a, b) => {
        const byStar = starRank(b.stars) - starRank(a.stars);
        if (byStar !== 0) return byStar;
        return b.totalScore - a.totalScore;
      });
      setNodeScores(results);
      setProgress(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProgress(null);
      setGate({ ok: false, message: `测全部节点时出错：${msg}` });
      setGateDetailOpen(true);
    } finally {
      // 成功 / 中止 / 出错：只要切过，就必须尝试切回；失败要明确报错
      if (didSwitch && config && originalSnap?.now && originalSnap.group) {
        setProgress({ text: `正在切回原先节点：${originalSnap.now}…`, testingNode: undefined });
        const restored = await restoreProxy(config, originalSnap);
        if (!restored) {
          const errMsg = `没法自动切回原先的节点「${originalSnap.now}」。请立刻到代理软件里手动选回去，否则你可能还停在别的节点上。`;
          setRestoreError(errMsg);
          setSwitchHint(errMsg);
        } else {
          setRestoreError(null);
          setSwitchHint(`已切回原先节点：${originalSnap.now}`);
        }
        setProgress(null);
      } else if (didSwitch && (!originalSnap?.now || !originalSnap.group)) {
        const errMsg =
          "测全部时切换过节点，但应用没有记下原先选中的节点，没法自动切回。请到代理软件里确认当前节点。";
        setRestoreError(errMsg);
        setSwitchHint(errMsg);
      }
      setRunning(false);
      abortAllRef.current = false;
    }
  };

  const onPickNode = (name: string) => {
    setSelectedNodeName(name);
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

  const onPrimary = () => {
    if (mode === "current") {
      setAllConfirmOpen(false);
      void testCurrent();
      return;
    }
    setRestoreError(null);
    setAllConfirmOpen(true);
  };

  const onConfirmAll = () => {
    setAllConfirmOpen(false);
    void testAll();
  };

  const onAbortAll = () => {
    abortAllRef.current = true;
    setProgress({ text: "正在停止…", testingNode: undefined });
  };

  const selectedScore = useMemo(
    () => nodeScores.find((s) => s.nodeName === selectedNodeName) ?? null,
    [nodeScores, selectedNodeName],
  );

  return (
    <div className="home-page">
      <div className="about-block card home-about">
        <p>
          <strong>Egress Checker v0.1.4</strong>
        </p>
        <p>帮你检查代理有没有生效，并给节点打分，方便换节点。</p>
        <p>
          请先打开 Clash Verge 等已支持的客户端并连上，再在本软件里选同名软件、点刷新。
        </p>
        <p>
          本软件不提供节点；「测全部」会临时切换节点，测完会切回。密钥只存在本机。
          仅支持 macOS Apple Silicon。
        </p>
      </div>

      <div className="home-ops">
        <div className="home-ops-controls">
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
                ? "先选软件，再点刷新"
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
          <button
            className="btn btn-sm home-ops-refresh"
            type="button"
            disabled={!!busy || refreshing || running || clientUnset}
            title={clientUnset ? "请先选择软件" : undefined}
            onClick={() => void refreshAndGate()}
          >
            {busy || refreshing ? "刷新中…" : "刷新连接"}
          </button>
        </div>
        <div
          className="status-pill status-pill-dense home-ops-status"
          title={connection.message}
        >
          <span
            className={`dot ${connection.status === "connected" ? "connected" : connection.usingMock ? "mock" : connection.status}`}
          />
          <span className="status-pill-text">{connection.message}</span>
        </div>
      </div>

      {gate && !gate.ok ? (
        <div className="gate-banner gate-banner-block" role="status">
          <div className="gate-banner-title">还不能测节点</div>
          <div className="gate-banner-msg">{gate.message}</div>
          {gate.process ? (
            <>
              <button
                type="button"
                className="card-process-toggle"
                aria-expanded={gateDetailOpen}
                onClick={() => setGateDetailOpen((v) => !v)}
              >
                {gateDetailOpen ? "收起过程" : "查看过程"}
              </button>
              {gateDetailOpen ? <pre className="gate-process">{gate.process}</pre> : null}
            </>
          ) : null}
        </div>
      ) : gate?.ok ? (
        <div className="gate-banner gate-banner-ok" role="status">
          {gate.message}
        </div>
      ) : null}


      {gate?.ok && orderedNodes.length > 0 ? (
        <div className="home-nodes card">
          <div className="home-nodes-summary">
            <span className="home-nodes-summary-text">
              已识别 {orderedNodes.length} 个节点 · 当前：
              <strong className="home-nodes-current-mark">
                {connection.currentProxy ?? "—"}
              </strong>
            </span>
          </div>
          <div className="home-nodes-list" role="list">
            {orderedNodes.map((n) => {
              const isCurrent = n.name === connection.currentProxy;
              const scored = scoreByName.get(n.name);
              const selected = selectedNodeName === n.name;
              const isTesting = progress?.testingNode === n.name;
              const clickable = !!scored;
              return (
                <button
                  key={n.name}
                  type="button"
                  role="listitem"
                  className={`home-nodes-row${isCurrent ? " current" : ""}${selected ? " selected" : ""}${clickable ? " scored" : ""}${isTesting ? " testing" : ""}`}
                  disabled={!clickable}
                  onClick={() => {
                    if (scored) onPickNode(n.name);
                  }}
                >
                  <div className="home-nodes-row-top">
                    <span className="home-nodes-name" title={n.name}>
                      {n.name}
                    </span>
                    {isTesting ? (
                      <span className="home-nodes-badge home-nodes-badge-testing">
                        检测中
                      </span>
                    ) : null}
                    {!isTesting && isCurrent ? (
                      <span className="home-nodes-badge">当前</span>
                    ) : null}
                    {isTesting && isCurrent ? (
                      <span className="home-nodes-badge">当前</span>
                    ) : null}
                  </div>
                  {scored ? (
                    <StarRating stars={scored.stars} size={13} />
                  ) : (
                    <span className="home-nodes-meta">
                      {n.region && n.region !== "未知" ? n.region : n.type}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : refreshing && !clientUnset ? (
        <div className="note note-compact">
          <span className="note-line">正在检查…</span>
        </div>
      ) : null}

      {selectedScore ? (
        <div className="node-score-detail card">
          <div className="node-score-detail-head">
            <strong>{selectedScore.nodeName}</strong>
            <StarRating stars={selectedScore.stars} size={15} />
          </div>
          <div className="score-breakdown">
            {selectedScore.breakdown.map((b) => (
              <div key={b.key} className="score-breakdown-row">
                <strong>
                  {b.label}（{Math.round(b.weight * 100)}%）
                </strong>
                ：{b.score} 分 — {b.note}
              </div>
            ))}
            {selectedScore.fakeLowLatencyTip ? (
              <div className="score-tip">{selectedScore.fakeLowLatencyTip}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mode-toggle" role="group" aria-label="测评方式">
        <button
          type="button"
          className={`mode-btn ${mode === "current" ? "active" : ""}`}
          disabled={running || clientUnset}
          onClick={() => {
            setMode("current");
            setAllConfirmOpen(false);
            setRestoreError(null);
            void testCurrent();
          }}
        >
          测当前节点
        </button>
        <button
          type="button"
          className={`mode-btn ${mode === "all" ? "active" : ""}`}
          disabled={running || clientUnset}
          onClick={() => {
            setMode("all");
            setRestoreError(null);
            setAllConfirmOpen(true);
          }}
        >
          测全部节点
        </button>
      </div>

      {mode === "all" && !running && !allConfirmOpen ? (
        <div className="note note-compact switch-warn" role="status">
          <span className="note-line">
            「测全部」会先并行检查各节点能否连通，筛掉连不上的，再对能连通的节点做简要检测（大约几分钟）。检测时会临时切换你当前选中的节点，上网出口会跟着变；测完或中途停止后会自动切回原来的节点。
          </span>
        </div>
      ) : null}

      {allConfirmOpen && mode === "all" ? (
        <div className="confirm-panel card" role="dialog" aria-labelledby="all-confirm-title">
          <div id="all-confirm-title" className="confirm-title">
            开始前请确认
          </div>
          <p className="confirm-body">
            测全部节点时，应用会在节点之间来回切换，你的上网出口会跟着变。测完或中途停止后，会自动切回你现在选中的节点。若切回失败，界面会明确报错，请你到代理软件里手动改回。
          </p>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <button
              className="btn btn-primary"
              type="button"
              disabled={clientUnset}
              onClick={onConfirmAll}
            >
              开始测全部（会切换节点）
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
      ) : (
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <button
            className="btn btn-primary"
            type="button"
            disabled={running || clientUnset}
            onClick={onPrimary}
          >
            {running
              ? "检测中…"
              : mode === "current"
                ? "再测一次当前节点"
                : "开始测全部（会切换节点）"}
          </button>
          {running && mode === "all" ? (
            <button className="btn" type="button" onClick={onAbortAll}>
              停止并切回
            </button>
          ) : null}
        </div>
      )}

      {progress ? <TestProgress progress={progress} /> : null}
      {restoreError ? (
        <div className="gate-banner gate-banner-block" role="alert">
          <div className="gate-banner-title">没能切回原先节点</div>
          <div className="gate-banner-msg">{restoreError}</div>
        </div>
      ) : null}
      {switchHint && !restoreError ? (
        <div className="note note-compact">{switchHint}</div>
      ) : null}

      {(selectedScore && selectedScore.cards.length > 0) ||
      (running && mode === "current") ? (
        <>
          <h2 className="section-title">当前节点检测结果</h2>
          <div className="card-grid card-grid-home">
            {nodeCards.map((c) => (
              <CheckCardView key={c.id} card={c} />
            ))}
          </div>
        </>
      ) : null}

      <div className="env-entry card">
        <div className="env-entry-head">
          <div>
            <strong>怀疑漏了再查</strong>
            <div className="muted">
              DNS / IPv6 / WebRTC / 分流 / 直连旁路（不默认每次强跑）
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={envRunning || running}
            onClick={() => void runEnv()}
          >
            {envRunning ? "检查中…" : envOpen ? "重新检查环境" : "开始环境检查"}
          </button>
        </div>
        {envOpen ? (
          <div className="card-grid card-grid-home" style={{ marginTop: 12 }}>
            {envCards.map((c) => (
              <CheckCardView key={c.id} card={c} />
            ))}
          </div>
        ) : null}
      </div>

      {envReady && vpnScore ? (
        <div className="vpn-score-card card">
          <div className="vpn-score-head">
            <span className={`vpn-tier${vpnScore.tier === "完美" ? " vpn-tier-perfect" : ""}`}>{vpnScore.tier}</span>
            <span className="muted vpn-score-dep">按环境检查 + 你点选的节点</span>
          </div>
          <div className="vpn-reason">{vpnScore.reason}</div>
          <div className="muted" style={{ marginTop: 6 }}>
            基于节点：{vpnScore.selectedNodeName}
          </div>
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

    </div>
  );
}
