import type { CheckCard } from "../egress/types";

export const NODE_PLACEHOLDERS: CheckCard[] = [
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

export const ENV_PLACEHOLDERS: CheckCard[] = [
  { id: "dns-leak", title: "DNS 解析器", level: "unknown", conclusion: "尚未检测" },
  { id: "ipv6-leak", title: "IPv6 泄漏", level: "unknown", conclusion: "尚未检测" },
  { id: "webrtc", title: "WebRTC", level: "unknown", conclusion: "尚未检测" },
  { id: "split-routing", title: "分流检查", level: "unknown", conclusion: "尚未检测" },
  { id: "bare-egress", title: "直连旁路检查", level: "unknown", conclusion: "尚未检测" },
];

export const DELAY_URL = "http://www.gstatic.com/generate_204";

export function asRunning(list: CheckCard[]): CheckCard[] {
  return list.map((c) => ({ ...c, level: "running" as const, conclusion: "检测中…" }));
}
