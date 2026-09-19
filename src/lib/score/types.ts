import type { CheckCard } from "../egress/types";

/** 节点星级：1–5，或不可用 */
export type NodeStars = 1 | 2 | 3 | 4 | 5 | "unavailable";

export type ScoreBreakdownItem = {
  key: string;
  label: string;
  weight: number;
  /** 0–100 分项得分；不可用时可为 0 */
  score: number;
  note: string;
};

export type NodeScoreResult = {
  nodeName: string;
  stars: NodeStars;
  /** 0–100；不可用为 0 */
  totalScore: number;
  blurb: string;
  breakdown: ScoreBreakdownItem[];
  /** 可选：虚假低延迟提示（口语） */
  fakeLowLatencyTip?: string;
  cards: CheckCard[];
  ranAt: string;
};

export type VpnTier = "完美" | "很好" | "能用" | "勉强" | "有问题";

export type VpnScoreResult = {
  tier: VpnTier;
  /** 0–100 */
  totalScore: number;
  reason: string;
  breakdown: ScoreBreakdownItem[];
  selectedNodeName: string;
  ranAt: string;
};

export type GateResult = {
  ok: boolean;
  /** 口语结论 */
  message: string;
  /** 过程细节（可折叠） */
  process?: string;
};
