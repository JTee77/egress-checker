import { useMemo, useRef, useState } from "react";
import { CheckCardView } from "../components/CheckCardView";
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
  formatStars,
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
  { id: "split-routing", title: "分流抽检", level: "unknown", conclusion: "尚未检测" },
  { id: "bare-egress", title: "裸奔粗检", level: "unknown", conclusion: "尚未检测" },
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
  const [progress, setProgress] = useState<string | null>(null);
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
  const [aboutOpen, setAboutOpen] = useState(false);
  const [expandedScore, setExpandedScore] = useState<string | null>(null);

  const cfg = connection.config;
  const [host, setHost] = useState(manual.host ?? cfg?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(manual.port ?? cfg?.port ?? 9097));
  const [secret, setSecret] = useState(manual.secret ?? cfg?.secret ?? "");
  const [mixedPort, setMixedPort] = useState(
    String(manual.mixedPort ?? cfg?.mixedPort ?? 7897),
  );

  const clientUnset = !clientId;
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
    const next = await onRefresh?.();
    const conn =
      next && typeof next === "object" && "status" in (next as object)
        ? (next as ConnectionState)
        : connection;
    const g = await runLightGate(conn);
    setGate(g);
    setGateDetailOpen(!g.ok);
  };

  const ensureGate = async (): Promise<GateResult> => {
    setProgress("测试条件检查中…");
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
      setProgress("正在深测当前出口…");
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
      setVpnScore(scoreVpn(scored, envCards, r.ranAt));
      setProgress(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNodeCards(
        NODE_PLACEHOLDERS.map((c) => ({
          ...c,
          level: "fail",
          conclusion: "本轮检测失败",
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

      setProgress(`剔死 0/${list.length}`);
      if (!canSwitch) {
        for (let i = 0; i < list.length; i++) {
          if (abortAllRef.current) break;
          const n = list[i];
          setProgress(`剔死 ${i + 1}/${list.length}`);
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
          setProgress(`剔死 ${cullDone}/${list.length}`);
          return { n, delay, skipped: false };
        });
        for (const row of cullOut) {
          if (row.skipped) continue;
          if (row.delay == null) {
            results.push(
              scoreDeadNode(row.n.name, "这轮延迟探测失败，按不可用处理。"),
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
          setProgress(`深测 ${i + 1}/${alive.length}（${n.name}）`);
          const group =
            (await findSelectorGroup(config!, n.name)) ?? originalSnap.group;
          if (!group) {
            results.push(
              scoreDeadNode(
                n.name,
                "找不到可切换的策略组，这轮没法深测这个节点。",
              ),
            );
            continue;
          }
          const ok = await switchProxy(config!, group, n.name);
          if (!ok) {
            results.push(
              scoreDeadNode(n.name, "切换失败，这轮没法深测这个节点。"),
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
          "连上了代理软件，但读不到当前选中的节点或策略组，没法安全地临时切换。这轮只深测当前出口。",
        );
        setProgress("深测当前出口（无法安全切换）…");
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
              "这轮没法切换到该节点做深测（读不到策略组或当前选中）。",
            ),
          );
        }
      } else {
        // Mock / 无配置：演示轻量深测，不切换
        for (let i = 0; i < alive.length; i++) {
          if (abortAllRef.current) break;
          const n = alive[i];
          setProgress(`深测 ${i + 1}/${alive.length}（演示）`);
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
        const aDead = a.stars === "unavailable" ? 1 : 0;
        const bDead = b.stars === "unavailable" ? 1 : 0;
        if (aDead !== bDead) return aDead - bDead;
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
        setProgress(`正在切回原先节点：${originalSnap.now}…`);
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
    const scored = nodeScores.find((s) => s.nodeName === name);
    if (scored) setVpnScore(scoreVpn(scored, envCards));
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
      if (selectedNodeName) {
        const scored = nodeScores.find((s) => s.nodeName === selectedNodeName);
        if (scored) setVpnScore(scoreVpn(scored, cards));
      }
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
    setProgress("正在停止…");
  };

  const selectedScore = useMemo(
    () => nodeScores.find((s) => s.nodeName === selectedNodeName) ?? null,
    [nodeScores, selectedNodeName],
  );

  return (
    <div className="home-page">
      <div className="client-picker">
        <label className="client-picker-label" htmlFor="home-client-select">
          你在用哪款软件？
        </label>
        <select
          id="home-client-select"
          className="client-picker-select"
          value={clientId ?? ""}
          onChange={(e) => onSelectClient(e.target.value)}
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
        <span className="client-picker-hint muted">
          {clientUnset
            ? "先选软件，再点刷新"
            : CLIENT_OPTIONS.find((o) => o.id === clientId)?.hint}
        </span>
      </div>

      <div className="home-chrome">
        <div className="home-chrome-left">
          <h1>Egress Checker</h1>
          <div className="status-pill status-pill-dense" title={connection.message}>
            <span
              className={`dot ${connection.status === "connected" ? "connected" : connection.usingMock ? "mock" : connection.status}`}
            />
            <span className="status-pill-text">{connection.message}</span>
          </div>
        </div>
        <div className="toolbar home-chrome-actions">
          <button
            className="btn btn-sm"
            type="button"
            disabled={!!busy || running || clientUnset}
            title={clientUnset ? "请先选择软件" : undefined}
            onClick={() => void refreshAndGate()}
          >
            {busy ? "刷新中…" : "刷新连接"}
          </button>
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
      ) : (
        <div className="note note-compact">
          <span className="note-line">
            {clientUnset
              ? "打开你的代理软件并连上节点 → 在这里选同名软件 → 点「刷新连接」，再测节点。"
              : "先「刷新连接」。测试条件满足后，再点「测当前节点」或「测全部节点」。"}
          </span>
        </div>
      )}

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
            「测全部」会先并发剔死，再对存活节点做轻量深测（几分钟量级）。应用会临时切换你当前选中的节点，出口会跟着变；测完（或你中途停止）后会自动切回原来的节点。
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
              ? (progress ?? "检测中…")
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

      {progress ? <div className="progress-line muted">{progress}</div> : null}
      {restoreError ? (
        <div className="gate-banner gate-banner-block" role="alert">
          <div className="gate-banner-title">没能切回原先节点</div>
          <div className="gate-banner-msg">{restoreError}</div>
        </div>
      ) : null}
      {switchHint && !restoreError ? (
        <div className="note note-compact">{switchHint}</div>
      ) : null}

      {vpnScore ? (
        <div className="vpn-score-card card">
          <div className="vpn-score-head">
            <span className="vpn-tier">{vpnScore.tier}</span>
            <span className="muted">整份 VPN · {vpnScore.totalScore} 分</span>
          </div>
          <div className="vpn-reason">{vpnScore.reason}</div>
          <div className="muted" style={{ marginTop: 6 }}>
            基于节点：{vpnScore.selectedNodeName}
          </div>
        </div>
      ) : null}

      {nodeScores.length > 0 ? (
        <div className="node-score-list">
          <h2 className="section-title">节点星级（本轮）</h2>
          <p className="muted section-hint">
            点选一个节点，用于计算上方的整份 VPN 总评。不会因此改动你在代理软件里的选择。
          </p>
          {nodeScores.map((s) => {
            const selected = selectedNodeName === s.nodeName;
            const open = expandedScore === s.nodeName;
            return (
              <div
                key={s.nodeName}
                className={`node-score-row card ${selected ? "selected" : ""}`}
              >
                <button
                  type="button"
                  className="node-score-main"
                  onClick={() => onPickNode(s.nodeName)}
                >
                  <span className="node-score-stars">{formatStars(s.stars)}</span>
                  <span className="node-score-name">{s.nodeName}</span>
                  <span className="node-score-blurb">{s.blurb}</span>
                </button>
                <button
                  type="button"
                  className="card-process-toggle"
                  aria-expanded={open}
                  onClick={() =>
                    setExpandedScore((v) => (v === s.nodeName ? null : s.nodeName))
                  }
                >
                  {open ? "收起构成" : "查看构成"}
                </button>
                {open ? (
                  <div className="score-breakdown">
                    {s.breakdown.map((b) => (
                      <div key={b.key} className="score-breakdown-row">
                        <strong>
                          {b.label}（{Math.round(b.weight * 100)}%）
                        </strong>
                        ：{b.score} 分 — {b.note}
                      </div>
                    ))}
                    {s.fakeLowLatencyTip ? (
                      <div className="score-tip">{s.fakeLowLatencyTip}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {(selectedScore && selectedScore.cards.length > 0) ||
      (running && mode === "current") ? (
        <>
          <h2 className="section-title">当前深测卡片</h2>
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
              DNS / IPv6 / WebRTC / 分流 / 裸奔细节（不默认每次强跑）
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

      <div className="fold-panel card">
        <button
          type="button"
          className="fold-toggle"
          aria-expanded={aboutOpen}
          onClick={() => setAboutOpen((v) => !v)}
        >
          {aboutOpen ? "收起说明" : "说明"}
        </button>
        {aboutOpen ? (
          <div className="fold-body about-block">
            <p>
              <strong>Egress Checker v0.1.4</strong>
            </p>
            <p>
              用于降低 VPN / 代理使用难度：先确认测试条件，再给节点打星、给整份 VPN
              四档总评。面向已自备 Mihomo / Clash Meta 兼容客户端的用户。
            </p>
            <p className="muted">产品边界：</p>
            <ul>
              <li>不提供、不销售任何代理节点或 VPN 服务</li>
              <li>不声称突破防火墙或「翻墙」</li>
              <li>不支持 Shadowrocket / Surge / 商业封闭客户端</li>
              <li>仅支持 macOS Apple Silicon（arm64）</li>
              <li>结果用于换节点对照，不是完整安全鉴定报告</li>
              <li>除「测全部」经你确认外，不会偷偷切换你的代理节点；测完会强制切回</li>
            </ul>
            <p className="muted">
              v0.1.4：确认测试条件 → 测当前 / 测全部节点星级 → 点选节点得 VPN
              总评；环境检查改为「怀疑漏了再查」。
            </p>
            <p className="muted">MIT License · 高级里的密钥仅保存在本机，不会上传。</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
