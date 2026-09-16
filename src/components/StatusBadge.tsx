import type { CheckLevel } from "../lib/egress/types";

const LABELS: Record<CheckLevel, string> = {
  pass: "通过",
  warn: "警告",
  fail: "失败",
  unknown: "未知",
  running: "检测中",
};

export function StatusBadge({ level }: { level: CheckLevel }) {
  return <span className={`badge ${level}`}>{LABELS[level]}</span>;
}
