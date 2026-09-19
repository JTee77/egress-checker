import type { CheckCard, CheckLevel } from "../egress/types";
import type { NodeScoreResult, NodeStars, ScoreBreakdownItem } from "./types";

function levelToScore(level: CheckLevel): number {
  switch (level) {
    case "pass":
      return 100;
    case "warn":
      return 55;
    case "fail":
      return 0;
    case "running":
      return 0;
    default:
      return 40;
  }
}

function card(cards: CheckCard[], id: string): CheckCard | undefined {
  return cards.find((c) => c.id === id);
}

/** 从抽样带宽结论里粗提取下行 Mbps */
export function parseDownMbps(c: CheckCard | undefined): number | null {
  if (!c) return null;
  const text = `${c.conclusion}\n${c.process ?? ""}`;
  const m =
    text.match(/↓\s*([\d.]+)\s*Mbps/i) ||
    text.match(/下行[^0-9]*([\d.]+)\s*Mbps/i) ||
    text.match(/([\d.]+)\s*Mbps/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function scoreAvailability(cards: CheckCard[]): {
  score: number;
  note: string;
  dead: boolean;
} {
  const reach = card(cards, "reachability");
  if (reach?.level === "fail") {
    return {
      score: 0,
      note: "境外探测都失败了，按不可用处理",
      dead: true,
    };
  }
  if (!reach) return { score: 40, note: "没有连通性结果", dead: false };
  return {
    score: levelToScore(reach.level),
    note: reach.conclusion,
    dead: false,
  };
}

function scoreThroughput(cards: CheckCard[]): { score: number; note: string } {
  const bw = card(cards, "bandwidth");
  if (!bw) return { score: 35, note: "未做带宽抽样" };
  if (bw.level === "fail") return { score: 0, note: bw.conclusion };
  const mbps = parseDownMbps(bw);
  if (mbps == null) {
    return { score: levelToScore(bw.level), note: bw.conclusion };
  }
  if (mbps >= 40) return { score: 100, note: `下行约 ${mbps} Mbps，很充裕` };
  if (mbps >= 15) return { score: 88, note: `下行约 ${mbps} Mbps，够快` };
  if (mbps >= 5) return { score: 72, note: `下行约 ${mbps} Mbps，日常能用` };
  if (mbps >= 1.5) return { score: 50, note: `下行约 ${mbps} Mbps，偏慢` };
  if (mbps >= 0.4) return { score: 28, note: `下行约 ${mbps} Mbps，明显偏慢` };
  return { score: 10, note: `下行约 ${mbps} Mbps，几乎不好用` };
}

export const SERVICE_IDS = [
  "netflix",
  "disney",
  "youtube",
  "app-store",
  "google-play",
  "gemini",
  "chatgpt",
] as const;

function scoreServices(cards: CheckCard[]): { score: number; note: string } {
  const list = SERVICE_IDS.map((id) => card(cards, id)).filter(Boolean) as CheckCard[];
  if (!list.length) return { score: 35, note: "未测服务面" };
  const avg = list.reduce((s, c) => s + levelToScore(c.level), 0) / list.length;
  const passN = list.filter((c) => c.level === "pass").length;
  const failN = list.filter((c) => c.level === "fail").length;
  return {
    score: Math.round(avg),
    note: `${passN} 项较顺、${failN} 项不行（共 ${list.length} 项）`,
  };
}

function scoreExit(cards: CheckCard[]): { score: number; note: string } {
  const exit = card(cards, "exit-ip");
  if (!exit) return { score: 40, note: "未拿到出口信息" };
  if (exit.level === "fail") return { score: 0, note: exit.conclusion };
  const text = `${exit.conclusion} ${exit.process ?? ""}`;
  const hosting = /机房|DCH|hosting/i.test(text);
  const residential = /住宅|ISP|家宽/i.test(text);
  if (exit.level === "pass" && residential) {
    return { score: 95, note: "出口更像住宅线路" };
  }
  if (hosting) return { score: 55, note: "出口更像机房地址，有的网站会更挑剔" };
  return { score: levelToScore(exit.level), note: exit.conclusion };
}

function mapStars(total: number, dead: boolean): NodeStars {
  if (dead || total <= 0) return "unavailable";
  if (total >= 90) return 5;
  if (total >= 75) return 4;
  if (total >= 60) return 3;
  if (total >= 40) return 2;
  return 1;
}

function blurbFor(
  stars: NodeStars,
  thrNote: string,
  availNote: string,
  svcNote: string,
  exitNote: string,
): string {
  if (stars === "unavailable") {
    return "连基本境外访问都失败了，先别指望用它上网。";
  }
  if (stars === 5) return `表现很稳：${thrNote}；服务面也较齐。`;
  if (stars === 4) return `整体不错：${thrNote}。${svcNote}。`;
  if (stars === 3) return `能用，但不算出众：${thrNote}。`;
  if (stars === 2) return `勉强能用：${thrNote}；${exitNote}`;
  return `偏弱：${availNote}；${thrNote}`;
}

function fakeLowLatencyTip(cards: CheckCard[], thrScore: number): string | undefined {
  const lat = card(cards, "latency");
  const mbps = parseDownMbps(card(cards, "bandwidth"));
  if (!lat || lat.level === "fail") return undefined;
  const msMatch = lat.conclusion.match(/(\d+)\s*ms/);
  const ms = msMatch ? Number(msMatch[1]) : null;
  if (ms != null && ms < 120 && (thrScore < 40 || (mbps != null && mbps < 0.8))) {
    return "延迟看起来不高，但实际下载偏慢，有可能是「假低延迟」。选节点时别只看延迟数字。";
  }
  return undefined;
}

/**
 * 按检测卡片给节点打星（不跨次比较）。
 * 权重：可用性 25% · 吞吐 30% · 服务 30% · 出口质量 15%。
 * 延迟不进主权重。
 */
export function scoreNodeFromCards(
  nodeName: string,
  cards: CheckCard[],
  ranAt = new Date().toISOString(),
): NodeScoreResult {
  const avail = scoreAvailability(cards);
  if (avail.dead) {
    const breakdown: ScoreBreakdownItem[] = [
      { key: "availability", label: "可用性", weight: 0.25, score: 0, note: avail.note },
      { key: "throughput", label: "吞吐抽样", weight: 0.3, score: 0, note: "未测或不可用" },
      { key: "services", label: "服务面", weight: 0.3, score: 0, note: "未测或不可用" },
      { key: "exit", label: "出口质量", weight: 0.15, score: 0, note: "未测或不可用" },
    ];
    return {
      nodeName,
      stars: "unavailable",
      totalScore: 0,
      blurb: "连基本境外访问都失败了，先别指望用它上网。",
      breakdown,
      cards,
      ranAt,
    };
  }

  const thr = scoreThroughput(cards);
  const svc = scoreServices(cards);
  const exit = scoreExit(cards);
  const total = Math.round(
    avail.score * 0.25 + thr.score * 0.3 + svc.score * 0.3 + exit.score * 0.15,
  );
  const stars = mapStars(total, false);

  return {
    nodeName,
    stars,
    totalScore: total,
    blurb: blurbFor(stars, thr.note, avail.note, svc.note, exit.note),
    breakdown: [
      { key: "availability", label: "可用性", weight: 0.25, score: avail.score, note: avail.note },
      { key: "throughput", label: "吞吐抽样", weight: 0.3, score: thr.score, note: thr.note },
      { key: "services", label: "服务面", weight: 0.3, score: svc.score, note: svc.note },
      { key: "exit", label: "出口质量", weight: 0.15, score: exit.score, note: exit.note },
    ],
    fakeLowLatencyTip: fakeLowLatencyTip(cards, thr.score),
    cards,
    ranAt,
  };
}

/** 仅延迟探测失败 → 不可用（用于「测全部」淘汰） */
export function scoreDeadNode(nodeName: string, reason: string): NodeScoreResult {
  return {
    nodeName,
    stars: "unavailable",
    totalScore: 0,
    blurb: reason || "延迟探测失败，按不可用处理。",
    breakdown: [
      { key: "availability", label: "可用性", weight: 0.25, score: 0, note: reason },
      { key: "throughput", label: "吞吐抽样", weight: 0.3, score: 0, note: "未深测" },
      { key: "services", label: "服务面", weight: 0.3, score: 0, note: "未深测" },
      { key: "exit", label: "出口质量", weight: 0.15, score: 0, note: "未深测" },
    ],
    cards: [],
    ranAt: new Date().toISOString(),
  };
}

export function formatStars(stars: NodeStars): string {
  if (stars === "unavailable") return "不可用";
  return "★".repeat(stars) + "☆".repeat(5 - stars);
}
