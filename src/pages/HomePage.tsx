import { useState } from "react";
import { CheckCardView } from "../components/CheckCardView";
import { runEgressDiagnostics, type CheckCard, type EgressReport } from "../lib/egress";
import type { ConnectionState } from "../lib/mihomo";

const PLACEHOLDERS: CheckCard[] = [
  { id: "reachability", title: "连通性", level: "unknown", summary: "尚未检测" },
  { id: "dns-leak", title: "DNS / 泄露", level: "unknown", summary: "尚未检测" },
  { id: "webrtc", title: "WebRTC", level: "unknown", summary: "尚未检测" },
  { id: "exit-ip", title: "出口 IP", level: "unknown", summary: "尚未检测" },
  { id: "gemini", title: "Gemini 解锁", level: "unknown", summary: "尚未检测" },
  { id: "chatgpt", title: "ChatGPT 解锁", level: "unknown", summary: "尚未检测" },
  { id: "latency", title: "延迟采样", level: "unknown", summary: "尚未检测" },
];

export function HomePage({ connection }: { connection: ConnectionState }) {
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
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>首页</h1>
          <p>一键诊断当前系统出口质量（DNS / IP / AI 解锁 / 延迟）</p>
        </div>
        <button className="btn btn-primary" type="button" disabled={running} onClick={() => void run()}>
          {running ? "检测中…" : "开始检测"}
        </button>
      </div>

      <div className="status-pill" style={{ marginBottom: 16 }}>
        <span
          className={`dot ${connection.status === "connected" ? "connected" : connection.usingMock ? "mock" : connection.status}`}
        />
        {connection.message}
      </div>

      <div className="card-grid">
        {cards.map((c) => (
          <CheckCardView key={c.id} card={c} />
        ))}
      </div>

      {report ? (
        <div className="note">
          {report.note}
          <div className="muted" style={{ marginTop: 6 }}>
            完成时间：{new Date(report.ranAt).toLocaleString()}
          </div>
        </div>
      ) : (
        <div className="note">
          检测走 Mac 当前出站路径。请先在 Clash Verge Rev 开启系统代理或 TUN，再点击「开始检测」。
        </div>
      )}
    </div>
  );
}
