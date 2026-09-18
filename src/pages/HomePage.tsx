import { useState } from "react";
import { CheckCardView } from "../components/CheckCardView";
import { runEgressDiagnostics, type CheckCard, type EgressReport } from "../lib/egress";
import {
  CLIENT_OPTIONS,
  clientLabel,
  normalizeClientId,
  type ClientId,
  type ConnectionState,
  type ControllerConfig,
} from "../lib/mihomo";

const PLACEHOLDERS: CheckCard[] = [
  { id: "reachability", title: "连通性", level: "unknown", conclusion: "尚未检测" },
  { id: "dns-leak", title: "DNS 解析器", level: "unknown", conclusion: "尚未检测" },
  { id: "ipv6-leak", title: "IPv6 泄漏", level: "unknown", conclusion: "尚未检测" },
  { id: "webrtc", title: "WebRTC", level: "unknown", conclusion: "尚未检测" },
  { id: "exit-ip", title: "出口 IP", level: "unknown", conclusion: "尚未检测" },
  { id: "gemini", title: "Gemini（换节点对照）", level: "unknown", conclusion: "尚未检测" },
  { id: "chatgpt", title: "ChatGPT（换节点对照）", level: "unknown", conclusion: "尚未检测" },
  { id: "latency", title: "延迟采样", level: "unknown", conclusion: "尚未检测" },
  { id: "bandwidth", title: "抽样带宽", level: "unknown", conclusion: "尚未检测" },
  { id: "split-routing", title: "分流抽检", level: "unknown", conclusion: "尚未检测" },
  { id: "bare-egress", title: "裸奔粗检", level: "unknown", conclusion: "尚未检测" },
  { id: "netflix", title: "Netflix", level: "unknown", conclusion: "尚未检测" },
  { id: "disney", title: "Disney+", level: "unknown", conclusion: "尚未检测" },
  { id: "youtube", title: "YouTube", level: "unknown", conclusion: "尚未检测" },
  { id: "app-store", title: "App Store", level: "unknown", conclusion: "尚未检测" },
  { id: "google-play", title: "Google Play", level: "unknown", conclusion: "尚未检测" },
];

export function HomePage({
  connection,
  busy,
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
  const [cards, setCards] = useState<CheckCard[]>(PLACEHOLDERS);
  const [report, setReport] = useState<EgressReport | null>(null);
  const [running, setRunning] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  const cfg = connection.config;
  const [host, setHost] = useState(manual.host ?? cfg?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(manual.port ?? cfg?.port ?? 9097));
  const [secret, setSecret] = useState(manual.secret ?? cfg?.secret ?? "");
  const [mixedPort, setMixedPort] = useState(
    String(manual.mixedPort ?? cfg?.mixedPort ?? 7897),
  );

  const clientUnset = !clientId;

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

  const run = async () => {
    setRunning(true);
    setCards(PLACEHOLDERS.map((c) => ({ ...c, level: "running", conclusion: "检测中…" })));
    try {
      const r = await runEgressDiagnostics(
        (card) => {
          setCards((prev) => {
            const idx = prev.findIndex((p) => p.id === card.id);
            if (idx === -1) return [...prev, card];
            const next = [...prev];
            next[idx] = card;
            return next;
          });
        },
        {
          mixedPort: connection.config?.mixedPort ?? null,
          mihomoConfig: connection.config ?? null,
        },
      );
      setReport(r);
      setCards(r.cards);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failCards: CheckCard[] = PLACEHOLDERS.map((c) => ({
        ...c,
        level: "fail",
        conclusion: "本轮检测失败",
        process: msg,
        suggestion: "请确认代理软件已打开并已连接，然后重新检测。",
      }));
      setCards(failCards);
      setReport({
        ranAt: new Date().toISOString(),
        cards: failCards,
        exitIp: {
          ip: null,
          country: null,
          countryCode: null,
          org: null,
          isp: null,
          hosting: null,
          ipTypeLabel: "--",
        },
        gemini: {
          supported: false,
          level: "unknown",
          region: null,
          status: "未完成",
        },
        chatgpt: {
          supported: false,
          level: "unknown",
          region: null,
          status: "未完成",
        },
        latencyMs: null,
        note: `检测过程出错，界面未崩溃。详情：${msg}`,
      });
    } finally {
      setRunning(false);
    }
  };

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
            onClick={() => void onRefresh?.()}
          >
            {busy ? "刷新中…" : "刷新连接"}
          </button>
          <button className="btn btn-primary btn-sm" type="button" disabled={running} onClick={() => void run()}>
            {running ? "检测中…" : "开始检测"}
          </button>
        </div>
      </div>

      {!report ? (
        <div className="note note-compact">
          <span className="note-line">
            {clientUnset
              ? "打开你的代理软件并连上节点 → 在这里选同名软件 → 点「刷新连接」，再「开始检测」。"
              : connection.status === "unreachable" || connection.status === "unauthorized"
                ? "连不上时：确认软件已打开并已连上节点，再点「刷新连接」。仍不行可展开下方「高级」核对。"
                : "先「刷新连接」，再「开始检测」。一般不用改高级选项。"}
          </span>
        </div>
      ) : (
        <div className="home-done-meta muted" title={report.note}>
          检测完成 · {new Date(report.ranAt).toLocaleString()}
        </div>
      )}

      <div className="card-grid card-grid-home">
        {cards.map((c) => (
          <CheckCardView key={c.id} card={c} />
        ))}
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
              <strong>Egress Checker v0.1.3</strong>
            </p>
            <p>
              用于诊断代理<strong>出口质量</strong>（连通性 / DNS / IP / AI 与流媒体粗检
              等），面向已自备 Mihomo / Clash Meta 兼容客户端的用户。默认适配 Clash Verge
              Rev。
            </p>
            <p className="muted">产品边界：</p>
            <ul>
              <li>不提供、不销售任何代理节点或 VPN 服务</li>
              <li>不声称突破防火墙或「翻墙」</li>
              <li>不支持 Shadowrocket / Surge / 商业封闭客户端</li>
              <li>仅支持 macOS Apple Silicon（arm64）</li>
              <li>结果用于换节点对照，不是完整安全鉴定报告</li>
            </ul>
            <p className="muted">
              v0.1.3：单一主界面；高级与说明默认折叠；检测超时更稳，卡片不会长时间停在「检测中」。
            </p>
            <p className="muted">MIT License · 高级里的密钥仅保存在本机，不会上传。</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
