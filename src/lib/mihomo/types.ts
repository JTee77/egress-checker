/** Mihomo / Clash Meta API types */

export interface ControllerConfig {
  host: string;
  port: number;
  secret: string;
  mixedPort: number;
  source: string;
  sockPath?: string | null;
}

export interface ProxyInfo {
  name: string;
  type: string;
  udp?: boolean;
  history?: { time: string; delay: number }[];
  all?: string[];
  now?: string;
}

export interface ProxyNode {
  name: string;
  type: string;
  region: string;
  raw: ProxyInfo;
}

export type ConnectionStatus =
  | "unknown"
  | "connected"
  | "unreachable"
  | "unauthorized"
  | "mock";

export interface ConnectionState {
  status: ConnectionStatus;
  message: string;
  config: ControllerConfig | null;
  currentProxy: string | null;
  usingMock: boolean;
  /** Proxies fetch / filter error when connected but nodes empty or failed */
  proxiesError?: string | null;
}

export interface DelayResult {
  name: string;
  region: string;
  proto: string;
  avgDelay: number;
  jitter: number;
  lossRate: number;
  alive: boolean;
}

export type NodeTestMode = "quick" | "deep" | "topN" | "aiOnly";

export interface NodeTestPlan {
  mode: NodeTestMode;
  label: string;
  description: string;
  implemented: boolean;
}

export const NODE_TEST_PLANS: NodeTestPlan[] = [
  {
    mode: "quick",
    label: "快速延迟",
    description: "多轮 Google/CF generate_204 延迟、抖动、丢包（低流量）",
    implemented: true,
  },
  {
    mode: "deep",
    label: "深度测速",
    description: "全节点下载带宽 + TTFB + AI/IP（高流量，v1 占位）",
    implemented: false,
  },
  {
    mode: "topN",
    label: "优选 Top-N",
    description: "筛选低延迟节点后测真实带宽与解锁（v1 占位）",
    implemented: false,
  },
  {
    mode: "aiOnly",
    label: "AI 专项",
    description: "批量 Gemini / ChatGPT / IP 类型（v1 占位）",
    implemented: false,
  },
];

export const IGNORE_PROXY_TYPES = new Set([
  "Selector",
  "URLTest",
  "Fallback",
  "LoadBalance",
  "Relay",
  "Direct",
  "Reject",
  "Compatible",
  "Pass",
]);

export const JUNK_NAME_KEYWORDS = ["剩余", "到期", "官网"];
