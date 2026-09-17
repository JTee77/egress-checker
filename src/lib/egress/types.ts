export type CheckLevel = "pass" | "warn" | "fail" | "unknown" | "running";

export interface CheckCard {
  id: string;
  title: string;
  level: CheckLevel;
  summary: string;
  detail?: string;
  tip?: string;
}

export interface ExitIpInfo {
  ip: string | null;
  country: string | null;
  countryCode: string | null;
  org: string | null;
  isp: string | null;
  hosting: boolean | null;
  ipTypeLabel: string;
}

export interface UnlockResult {
  supported: boolean;
  /** Internal machine level: full | web_only | app_only | blocked | unknown */
  level?: string;
  region: string | null;
  /** Short headline for the card summary (plain Chinese, no jargon) */
  status: string;
  /** One-line breakdowns shown in detail */
  lines?: string[];
  /** What we probed */
  probed?: string[];
  /** What we explicitly did not probe */
  notProbed?: string[];
}

export interface EgressReport {
  ranAt: string;
  cards: CheckCard[];
  exitIp: ExitIpInfo | null;
  gemini: UnlockResult | null;
  chatgpt: UnlockResult | null;
  latencyMs: number | null;
  note: string;
}
