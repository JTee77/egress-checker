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
          <p>看当前出口好不好用：连通、IP、换节点时的 AI 对照、延迟。不是替代你自己打开网站。</p>
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
          先开 Clash Verge Rev 的系统代理或 TUN，再点「开始检测」。AI 卡片用来换节点时对照，不是「必须测完才能上网」。
        </div>
      )}
    </div>
  );
}
