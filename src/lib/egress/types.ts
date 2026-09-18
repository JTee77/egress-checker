export type CheckLevel = "pass" | "warn" | "fail" | "unknown" | "running";

export interface CheckCard {
  id: string;
  title: string;
  level: CheckLevel;
  /** Always-visible plain-Chinese one-sentence result */
  conclusion: string;
  /** Technical detail (URLs, HTTP codes, timings…); collapsed by default in UI */
  process?: string;
  /** Always-visible next-step / honesty-boundary tip */
  suggestion?: string;
  /** @deprecated Prefer `conclusion`. Kept for migration / older callers. */
  summary?: string;
  /** @deprecated Prefer `process`. */
  detail?: string;
  /** @deprecated Prefer `suggestion`. */
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
  /** Short headline for the card conclusion (plain Chinese, no jargon) */
  status: string;
  /** One-line breakdowns shown in process */
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
