import { useState } from "react";
import { CheckCardView } from "../components/CheckCardView";
import { runEgressDiagnostics, type CheckCard, type EgressReport } from "../lib/egress";
import type { ConnectionState } from "../lib/mihomo";

const PLACEHOLDERS: CheckCard[] = [
  { id: "reachability", title: "连通性", level: "unknown", summary: "尚未检测" },
  { id: "dns-leak", title: "DNS 粗检（启发式）", level: "unknown", summary: "尚未检测" },
  { id: "webrtc", title: "WebRTC", level: "unknown", summary: "尚未检测" },
  { id: "exit-ip", title: "出口 IP", level: "unknown", summary: "尚未检测" },
  { id: "gemini", title: "Gemini（换节点对照）", level: "unknown", summary: "尚未检测" },
  { id: "chatgpt", title: "ChatGPT（换节点对照）", level: "unknown", summary: "尚未检测" },
  { id: "latency", title: "延迟采样", level: "unknown", summary: "尚未检测" },
];

export function HomePage({
  connection,
  busy,
  onRefresh,
}: {
  connection: ConnectionState;
  busy?: boolean;
  onRefresh?: () => Promise<unknown> | void;
}) {
  const [cards, setCards] = useState<CheckCard[]>(PLACEHOLDERS);
  const [report, setReport] = useState<EgressReport | null>(null);
  const [running, setRunning] = useState(false);

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
        { mixedPort: connection.config?.mixedPort ?? null },
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
        tip: "请确认 Clash Verge Rev 已连接；若刚崩溃过，退出全部窗口后只开一个 pnpm tauri dev 再试。",
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
            disabled={!!busy || running}
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
          <span className="note-line">先「刷新连接」，再「开始检测」。AI 卡片只作换节点对照。</span>
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
