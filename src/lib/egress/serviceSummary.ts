import type { CheckCard, CheckLevel } from "./types";

/** 可配置服务分组：名单便于后续加 TikTok / Spotify / Prime 等探针。 */
export type ServiceGroupDef = {
  /** 汇总卡 id，如 svc-streaming */
  id: string;
  title: string;
  /** 成员探测卡 id；仅合成 cards 里已有的项 */
  memberIds: readonly string[];
};

/**
 * 默认分组：流媒体 / AI / 商店（商店不进流媒体）。
 * 扩展时只改此表即可；未实现的 id 在 cards 中不存在时自动跳过。
 */
export const SERVICE_GROUPS: readonly ServiceGroupDef[] = [
  {
    id: "svc-streaming",
    title: "流媒体",
    memberIds: [
      "netflix",
      "disney",
      "youtube",
      "tiktok",
      "spotify",
      "prime-video",
    ],
  },
  {
    id: "svc-ai",
    title: "AI",
    memberIds: ["gemini", "chatgpt"],
  },
  {
    id: "svc-store",
    title: "商店",
    memberIds: ["app-store", "google-play"],
  },
] as const;

const MEMBER_TO_GROUP = new Map<string, ServiceGroupDef>();
for (const g of SERVICE_GROUPS) {
  for (const mid of g.memberIds) MEMBER_TO_GROUP.set(mid, g);
}

export function isServiceSummaryId(id: string): boolean {
  return SERVICE_GROUPS.some((g) => g.id === id);
}

/** 是否「通」：pass / warn（弱信号仍算开）。 */
function isOpen(level: CheckLevel): boolean {
  return level === "pass" || level === "warn";
}

function isClosed(level: CheckLevel): boolean {
  return level === "fail";
}

/** 从 metrics 或 conclusion 抽区码（如 US、sf:143441）。 */
export function extractUnlockRegion(card: CheckCard): string | null {
  const raw = card.metrics?.unlockRegion?.trim();
  if (
    raw &&
    raw !== "BLOCKED" &&
    raw !== "OK" &&
    raw !== "未知地区" &&
    raw.toLowerCase() !== "unknown"
  ) {
    return raw;
  }
  const c = card.conclusion ?? "";
  const m = c.match(/（(?:地区限制 · )?([A-Z]{2,3}|sf:\d+)）/);
  return m?.[1] ?? null;
}

/** 外置详情一行：平台通/不通（可带区码），不含测法。 */
export function formatMemberUnlockLine(card: CheckCard): string {
  const title = card.title || card.id;
  const region = extractUnlockRegion(card);
  if (card.level === "running") return `${title}：检测中`;
  if (isOpen(card.level)) {
    return region ? `${title}：通 · ${region}` : `${title}：通`;
  }
  if (isClosed(card.level)) {
    return region ? `${title}：不通 · ${region}` : `${title}：不通`;
  }
  const c = (card.conclusion ?? "").trim();
  if (!c || c === "尚未检测") return `${title}：未测`;
  return `${title}：未知`;
}

function aggregateLevel(members: CheckCard[]): CheckLevel {
  if (members.some((m) => m.level === "running")) return "running";
  let open = 0;
  let closed = 0;
  let other = 0;
  for (const m of members) {
    if (isOpen(m.level)) open += 1;
    else if (isClosed(m.level)) closed += 1;
    else other += 1;
  }
  if (open > 0 && closed === 0 && other === 0) return "pass";
  if (closed > 0 && open === 0 && other === 0) return "fail";
  if (open === 0 && closed === 0) return "unknown";
  return "warn";
}

function briefForLevel(level: CheckLevel): string {
  switch (level) {
    case "pass":
      return "全通";
    case "warn":
      return "部分";
    case "fail":
      return "全不通";
    case "running":
      return "检测中";
    default:
      return "未测";
  }
}

export function buildServiceSummaryCard(
  group: ServiceGroupDef,
  members: CheckCard[],
): CheckCard {
  const level = aggregateLevel(members);
  const lines = members.map(formatMemberUnlockLine);
  return {
    id: group.id,
    title: group.title,
    level,
    // 外置正文：各平台通/不通；卡内 brief 由 formatCardBrief 读 level
    conclusion: lines.join("\n"),
    // 过程/测法不进汇总外置正文
    process: undefined,
    suggestion: undefined,
    metrics: {
      unlockSupported: level === "pass" || level === "warn",
      unlockLevel: briefForLevel(level),
    },
  };
}

/**
 * 把流媒体 / AI / 商店成员合成汇总卡，其它卡原样保留。
 * 评分仍应读原始单项卡；本函数只用于卡墙展示。
 */
export function summarizeServiceCards(cards: CheckCard[]): CheckCard[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const emitted = new Set<string>();
  const out: CheckCard[] = [];
  let servicesFlushed = false;

  /** 首次碰到服务成员时，按 SERVICE_GROUPS 顺序一次刷出（流媒体 / AI / 商店）。 */
  const flushServiceSummaries = () => {
    if (servicesFlushed) return;
    servicesFlushed = true;
    for (const group of SERVICE_GROUPS) {
      if (emitted.has(group.id)) continue;
      const members = group.memberIds
        .map((id) => byId.get(id))
        .filter((c): c is CheckCard => !!c);
      if (!members.length) continue;
      emitted.add(group.id);
      out.push(buildServiceSummaryCard(group, members));
    }
  };

  for (const card of cards) {
    const group = MEMBER_TO_GROUP.get(card.id);
    if (!group) {
      // 已是汇总卡或非服务项：原样保留（避免二次合成）
      if (isServiceSummaryId(card.id)) {
        if (!emitted.has(card.id)) {
          emitted.add(card.id);
          out.push(card);
        }
        continue;
      }
      out.push(card);
      continue;
    }
    flushServiceSummaries();
  }

  return out;
}
