import { useState } from "react";
import { CheckCardView } from "../components/CheckCardView";
import { runEgressDiagnostics, type CheckCard, type EgressReport } from "../lib/egress";
import {
  CLIENT_OPTIONS,
  normalizeClientId,
  type ClientId,
  type ConnectionState,
} from "../lib/mihomo";

const PLACEHOLDERS: CheckCard[] = [
  { id: "reachability", title: "连通性", level: "unknown", summary: "尚未检测" },
  { id: "dns-leak", title: "DNS 解析器", level: "unknown", summary: "尚未检测" },
  { id: "ipv6-leak", title: "IPv6 泄漏", level: "unknown", summary: "尚未检测" },
  { id: "webrtc", title: "WebRTC", level: "unknown", summary: "尚未检测" },
  { id: "exit-ip", title: "出口 IP", level: "unknown", summary: "尚未检测" },
  { id: "gemini", title: "Gemini（换节点对照）", level: "unknown", summary: "尚未检测" },
  { id: "chatgpt", title: "ChatGPT（换节点对照）", level: "unknown", summary: "尚未检测" },
  { id: "latency", title: "延迟采样", level: "unknown", summary: "尚未检测" },
  { id: "bandwidth", title: "抽样带宽", level: "unknown", summary: "尚未检测" },
  { id: "split-routing", title: "分流抽检", level: "unknown", summary: "尚未检测" },
  { id: "bare-egress", title: "裸奔粗检", level: "unknown", summary: "尚未检测" },
  { id: "streaming", title: "流媒体抽检", level: "unknown", summary: "尚未检测" },
  { id: "store", title: "商店抽检", level: "unknown", summary: "尚未检测" },
];

export function HomePage({
  connection,
  busy,
  clientId,
  onClientIdChange,
  onRefresh,
}: {
  connection: ConnectionState;
  busy?: boolean;
  clientId: ClientId | null;
  onClientIdChange: (id: ClientId) => void;
  onRefresh?: () => Promise<unknown> | void;
}) {
  const [cards, setCards] = useState<CheckCard[]>(PLACEHOLDERS);
  const [report, setReport] = useState<EgressReport | null>(null);
  const [running, setRunning] = useState(false);

  const clientUnset = !clientId;

  const onSelectClient = (raw: string) => {
    const id = normalizeClientId(raw);
    if (!id) return;
    onClientIdChange(id);
  };

  const run = async () => {
    setRunning(true);
    setCards(PLACEHOLDERS.map((c) => ({ ...c, level: "running", summary: "检测中…" })));
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
        summary: "本轮检测失败",
        detail: msg,
        tip: "请确认代理软件已打开并已连接，然后重新检测。",
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
          <h1>首页</h1>
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
              : "先「刷新连接」，再「开始检测」。一般不用改设置。"}
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
    </div>
  );
}
