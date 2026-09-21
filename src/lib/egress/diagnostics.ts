/**
 * Universal egress diagnostics.
 * Prefer Rust mixed-port proxy fetch (same path as Gemini/IP) so probes follow
 * Clash Verge Rev even when the Tauri WebView does not use system proxy/TUN.
 */

import type {
  CheckCard,
  CheckLevel,
  EgressReport,
  ExitIpInfo,
  UnlockResult,
} from "./types";
import { fetchTextViaProxy, listDnsResolvers, timedTransferViaProxy, dnsWhoami, canBrowserFallback } from "./fetchVia";
import { classifyIpv6Leak, classifyWebRtc, candidateScope } from "./leakMatrix";
import type { WebRtcCandidateType } from "./leakMatrix";
import { getRulesSummary } from "../mihomo/client";
import type { ControllerConfig } from "../mihomo/types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const PROBE_TIMEOUT_MS = 6000;

async function fetchTextBrowser(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }> {
  const { timeoutMs = 5000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Prefer mixed-port via Rust; fall back to browser fetch if mixedPort missing or proxy fetch fails. */
/**
 * Probe a URL, preferring the mixed-port path. `unverified` marks the case where
 * we could NOT reach the target through a proxy AND refused to fall back to a
 * direct browser fetch (production) *because no proxy port was available* — that
 * is genuinely "未验证", not a node failure. When a proxy port WAS given but the
 * proxy itself could not connect, `unverified` stays false so the honest "fail"
 * still surfaces (a node that can't route is not a neutral node).
 */
async function probeText(
  url: string,
  opts: {
    mixedPort?: number | null;
    timeoutMs?: number;
    userAgent?: string;
    method?: string;
  } = {},
): Promise<{ ok: boolean; status: number; text: string; unverified: boolean }> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const mixedPort = opts.mixedPort ?? null;
  const hadProxy = mixedPort != null && mixedPort > 0;

  if (hadProxy) {
    const viaProxy = await fetchTextViaProxy(url, {
      mixedPort,
      timeoutMs,
      userAgent: opts.userAgent,
    });
    const success =
      viaProxy.status === 204 ||
      viaProxy.status === 200 ||
      (viaProxy.status >= 200 && viaProxy.status < 400) ||
      viaProxy.ok;
    if (success || viaProxy.status !== 0) {
      return {
        ok: success,
        status: viaProxy.status,
        text: viaProxy.text,
        unverified: false,
      };
    }
  }

  // Proxy path unavailable. In a production Tauri build we must NOT silently
  // direct-fetch (would measure the real egress and fabricate a pass). Refuse
  // the fallback and let callers render it honestly.
  if (!canBrowserFallback()) {
    return { ok: false, status: 0, text: "", unverified: !hadProxy };
  }

  // Secondary: browser fetch (dev build / plain web preview only)
  const viaBrowser = await fetchTextBrowser(url, {
    method: opts.method ?? "GET",
    timeoutMs,
    headers: opts.userAgent ? { "User-Agent": opts.userAgent } : undefined,
  });
  return { ...viaBrowser, unverified: false };
}

function isReachableStatus(status: number, ok: boolean): boolean {
  return status === 204 || status === 200 || (ok && status >= 200 && status < 400);
}

export type ReachabilityOptions = {
  /** light：只探一个点 + 更短超时，供「测全部」批量深测 */
  light?: boolean;
};

export async function checkReachability(
  mixedPort?: number | null,
  opts?: ReachabilityOptions,
): Promise<CheckCard> {
  const light = !!opts?.light;
  const targets = light
    ? ["https://cp.cloudflare.com/generate_204"]
    : [
        "https://www.google.com/generate_204",
        "https://cp.cloudflare.com/generate_204",
      ];
  const timeoutMs = light ? 3500 : PROBE_TIMEOUT_MS;
  // Sequential probes to avoid slamming the Rust spawn_blocking pool.
  const results: {
    url: string;
    ok: boolean;
    status: number;
    text: string;
    ms: number;
    unverified: boolean;
  }[] = [];
  for (const url of targets) {
    const t0 = performance.now();
    const r = await probeText(url, {
      mixedPort,
      timeoutMs,
      method: "GET",
    });
    results.push({ url, ...r, ms: Math.round(performance.now() - t0) });
  }
  // No proxy port was available and we refused the direct-fallback: we simply
  // could not test this node's egress. Show a neutral 未验证 card (never a fake
  // green, never a harsh "dead node"), and scoring excludes it from the average.
  if (results.length > 0 && results.every((r) => r.unverified)) {
    return {
      id: "reachability",
      title: "连通性",
      level: "unknown",
      unverified: true,
      conclusion: "未验证：未取到可用代理口，已拒绝直连兜底",
      process: results.map((r) => `${r.url} → 未经代理测试`).join("\n"),
      suggestion: "请先连接并刷新代理节点（拿到 mixed-port）后再测。",
    };
  }
  const ok = results.filter((r) => isReachableStatus(r.status, r.ok));
  if (ok.length === 0) {
    return {
      id: "reachability",
      title: "连通性",
      level: "fail",
      conclusion: "无法经代理访问境外 HTTPS 探测点",
      process: results.map((r) => `${r.url} → HTTP ${r.status || "超时"}`).join("\n"),
      suggestion: "请确认代理软件已打开、已连上节点，并开启系统代理或 TUN，然后重试。",
    };
  }
  const level: CheckLevel = ok.length === results.length ? "pass" : "warn";
  return {
    id: "reachability",
    title: "连通性",
    level,
    conclusion: `${ok.length}/${results.length} 个境外探测点能通（约 ${ok[0].ms} ms）`,
    process: results
      .map((r) => `${r.url}: ${r.status || "超时"} (${r.ms}ms)`)
      .join("\n"),
    suggestion: undefined,
  };
}

/** 统一的「获取失败」空结果（三次重复的字面量收敛为一个本地 helper）。 */
function emptyExitIp(): ExitIpInfo {
  return {
    ip: null,
    country: null,
    countryCode: null,
    org: null,
    isp: null,
    hosting: null,
    ipTypeLabel: "--",
  };
}

/**
 * 由组织名/ISP 关键词推断是否机房（datacenter）IP。
 * TLS IP 源（ipwho.is / ip.sb）不像 ip-api 那样提供 hosting 布尔字段，只能推断。
 */
export function inferHosting(...fields: (string | null | undefined)[]): boolean {
  const blob = fields.filter(Boolean).join(" ").toLowerCase();
  if (!blob) return false;
  const keywords = [
    "hosting",
    "cloud",
    "datacenter",
    "data center",
    "colo",
    "vps",
    "dedicated",
    "server",
    "ovh",
    "hetzner",
    "digitalocean",
    "linode",
    "vultr",
    "leaseweb",
    "amazon",
    "aws",
    "azure",
    "oracle",
    "alibaba",
    "tencent",
    "m247",
    "datacamp",
    "packethub",
    "xtom",
    "ipxo",
    "choopa",
    "contabo",
  ];
  return keywords.some((k) => blob.includes(k));
}

/** 单个源解析出的映射字段（null 表示该源失败，尝试下一个）。 */
type ExitIpSourceFields = {
  ip: string;
  country: string | null;
  countryCode: string | null;
  org: string | null;
  isp: string | null;
};

/**
 * TLS-only 出口 IP 源（ip-api 免费层无 HTTPS，明文 HTTP 不适合泄漏检查工具）。
 * 顺序尝试，先成功者胜出。
 */
const EXIT_IP_SOURCES: {
  url: string;
  parse: (data: unknown) => ExitIpSourceFields | null;
}[] = [
  {
    url: "https://ipwho.is/",
    parse: (data) => {
      const d = data as {
        success?: boolean;
        ip?: string;
        country?: string;
        country_code?: string;
        connection?: { org?: string; isp?: string };
      };
      if (d.success !== true || !d.ip) return null;
      return {
        ip: d.ip,
        country: d.country ?? null,
        countryCode: d.country_code ?? null,
        org: d.connection?.org ?? null,
        isp: d.connection?.isp ?? null,
      };
    },
  },
  {
    url: "https://api.ip.sb/geoip",
    parse: (data) => {
      const d = data as {
        ip?: string;
        country?: string;
        country_code?: string;
        organization?: string;
        isp?: string;
      };
      // 无 success 标志；有 ip 即视为成功
      if (!d.ip) return null;
      return {
        ip: d.ip,
        country: d.country ?? null,
        countryCode: d.country_code ?? null,
        org: d.organization ?? null,
        isp: d.isp ?? null,
      };
    },
  },
];

export async function fetchExitIp(
  mixedPort?: number | null,
): Promise<ExitIpInfo> {
  // 顺序尝试（house convention：避免同时打满 Rust spawn_blocking 池）
  for (const source of EXIT_IP_SOURCES) {
    const r = await fetchTextViaProxy(source.url, {
      mixedPort: mixedPort ?? null,
      timeoutMs: 4000,
    });
    if (!r.ok || !r.text) continue;
    try {
      const data = JSON.parse(r.text) as unknown;
      const fields = source.parse(data);
      if (!fields) continue;
      const hosting = inferHosting(fields.org, fields.isp);
      return {
        ip: fields.ip,
        country: fields.country,
        countryCode: fields.countryCode,
        org: fields.org ?? fields.isp ?? null,
        isp: fields.isp ?? null,
        hosting,
        hostingInferred: true,
        ipTypeLabel: hosting ? "疑似机房(DCH)" : "住宅(ISP)",
      };
    } catch {
      // 解析失败 → 尝试下一个源
    }
  }
  return emptyExitIp();
}

export function exitIpCard(info: ExitIpInfo): CheckCard {
  if (!info.ip) {
    return {
      id: "exit-ip",
      title: "出口 IP",
      level: "fail",
      conclusion: "无法获取出口 IP",
      suggestion: "检查网络或临时关闭拦截局域网流量的规则。",
    };
  }
  const level: CheckLevel = info.hosting ? "warn" : "pass";
  const processLines = [
    `组织 ${info.org ?? "--"} · ISP ${info.isp ?? "--"} · 国家 ${info.country ?? "--"}`,
  ];
  if (info.hostingInferred) {
    processLines.push("机房判定：由组织名关键词推断（当前 IP 源未提供该字段）");
  }
  return {
    id: "exit-ip",
    title: "出口 IP",
    level,
    conclusion: `${info.ip} · ${info.countryCode ?? "?"} · ${info.ipTypeLabel}`,
    process: processLines.join("\n"),
    suggestion: info.hosting
      ? "机房 IP 可能导致部分 AI / 流媒体风控；可尝试住宅/家宽节点。"
      : undefined,
  };
}

/**
 * A1: DNS 泄漏（确定性改造）。
 * 旧版只列 scutil 配置的 resolver，几乎永远判 pass。新版用 `dig TXT whoami` 实测
 * DNS 查询真正从哪个公网 IP 出去（以及被哪个递归解析器服务），再与代理出口 IP 比对：
 * 同出口 → 未泄漏；不同 → DNS 绕过了代理、疑似暴露真实地址。scutil 列表与 Cloudflare
 * 启发式降级为过程细节。
 */
export async function checkDnsResolvers(
  exit: ExitIpInfo,
  mixedPort?: number | null,
): Promise<CheckCard> {
  const [dns, whoami] = await Promise.all([
    listDnsResolvers(),
    dnsWhoami({ timeoutMs: 4500 }),
  ]);
  const resolvers = dns.resolvers ?? [];

  // Secondary heuristic (not leak proof): exit country vs Cloudflare loc
  const cf = await probeText("https://www.cloudflare.com/cdn-cgi/trace", {
    mixedPort,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  let loc: string | null = null;
  let colo: string | null = null;
  if (cf.text) {
    for (const line of cf.text.split("\n")) {
      if (line.startsWith("loc=")) loc = line.slice(4).trim();
      if (line.startsWith("colo=")) colo = line.slice(5).trim();
    }
  }
  const exitCc = exit.countryCode?.toUpperCase() ?? null;
  const mismatch =
    exitCc && loc && exitCc !== loc.toUpperCase() && loc.toUpperCase() !== "XX";
  const heuristicLine = mismatch
    ? `启发式粗看（非泄漏鉴定）：出口 ${exitCc} 与 Cloudflare loc=${loc} 不太一致`
    : `启发式粗看（非泄漏鉴定）：出口 ${exitCc ?? "?"}，Cloudflare loc=${loc ?? "?"} · colo=${colo ?? "--"}`;

  const exitIp = exit.ip ?? null;
  const qIp = whoami.clientIp ?? null;

  let level: CheckLevel;
  let conclusion: string;
  let suggestion: string | undefined;

  if (!whoami.ok || !qIp) {
    level = "unknown";
    conclusion = `未能实测 DNS 出口（${whoami.error ?? "dig 无有效返回"}）`;
    suggestion = "确认本机可用 `dig`（macOS/Linux 自带），稍后重试。";
  } else if (!exitIp) {
    level = "warn";
    conclusion = `DNS 查询从 ${qIp} 出去，但缺少代理出口 IP 可对照，无法判定是否泄漏`;
    suggestion = "先完成「出口 IP」检查（或连上代理）后再测 DNS。";
  } else if (qIp === exitIp) {
    level = "pass";
    conclusion = `DNS 查询与代理流量同出口（${qIp}）—— 未泄漏真实地址`;
  } else {
    level = "fail";
    conclusion = `DNS 从 ${qIp} 出去，而代理出口是 ${exitIp} —— 两者不符，疑似 DNS 泄漏真实地址`;
    suggestion =
      "把系统/Wi-Fi DNS 改到隧道可达的 1.1.1.1 / 8.8.8.8，或在客户端开启 DNS 劫持（fake-ip / TUN DNS）后重测。";
  }

  const proc = [
    `实测：DNS 出口 IP=${qIp ?? "无"} · 递归解析器 ns=${whoami.resolverNs ?? "无"}${
      whoami.ecs ? ` · ECS=${whoami.ecs}` : ""
    }（via ${whoami.via}）`,
    `代理出口 IP=${exitIp ?? "无"}`,
    `配置解析器：${resolvers.join(", ") || "(无)"}（source ${dns.source}）`,
    dns.error ? `note: ${dns.error}` : "",
    dns.rawHint ? `raw_hint:\n${dns.rawHint}` : "",
    heuristicLine,
    "边界：whoami 反映「查询实际从哪出去」，比读配置更接近真相；ECS 若暴露你的 /24 仍属信息泄露。不是 BrowserLeaks 级全量证明。",
  ].filter(Boolean);

  return {
    id: "dns-leak",
    title: "DNS 解析器",
    level,
    conclusion,
    process: proc.join("\n"),
    suggestion,
  };
}

/** @deprecated use checkDnsResolvers — kept name alias for older call sites */
export async function checkDnsLeakApproach(
  exit: ExitIpInfo,
  mixedPort?: number | null,
): Promise<CheckCard> {
  return checkDnsResolvers(exit, mixedPort);
}

function isIpv6Literal(s: string): boolean {
  const t = s.trim();
  // Reject IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return false;
  return t.includes(":");
}

function extractIpBody(text: string): string | null {
  const t = text.trim().split(/\s+/)[0] ?? "";
  if (!t) return null;
  // strip quotes
  return t.replace(/^["']|["']$/g, "");
}

/**
 * A2: IPv6 leak — 交叉验证矩阵（确定性改造）。
 * 单看 (直连v6, 代理v6) 分不清"真旁路"与"TUN 全局接管"，因此同时采 IPv4：
 * 若走代理后 IPv4 出口改变，证明直连/代理是两条真不同的路，此时 v6 才谈得上旁路；
 * IPv4 两路同源则说明被统一隧道接管，v6 同址是健康。判定下沉到纯函数 classifyIpv6Leak。
 */
export async function checkIpv6Leak(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const timeoutMs = 4500;
  const expectProxy = mixedPort != null && mixedPort > 0;

  async function probeV6(port: number | null): Promise<string | null> {
    for (const url of ["https://api64.ipify.org", "https://ipv6.icanhazip.com"]) {
      const r = await fetchTextViaProxy(url, { mixedPort: port, timeoutMs });
      const ip = extractIpBody(r.text);
      if (r.ok && ip && isIpv6Literal(ip)) return ip;
    }
    return null;
  }

  async function probeV4(port: number | null): Promise<string | null> {
    const r = await fetchTextViaProxy("https://api.ipify.org", {
      mixedPort: port,
      timeoutMs,
    });
    const ip = extractIpBody(r.text);
    return r.ok && ip && !isIpv6Literal(ip) ? ip : null;
  }

  const directV4 = await probeV4(null);
  const directV6 = await probeV6(null);
  const proxiedV4 = expectProxy ? await probeV4(mixedPort!) : null;
  const proxiedV6 = expectProxy ? await probeV6(mixedPort!) : null;

  const verdict = classifyIpv6Leak({
    proxyConfigured: expectProxy,
    directV4,
    proxiedV4,
    directV6,
    proxiedV6,
  });

  const lines: string[] = [
    `IPv4 直连 ${directV4 ?? "无"} · 代理 ${proxiedV4 ?? (expectProxy ? "无" : "未测")}`,
    `IPv6 直连 ${directV6 ?? "无"} · 代理 ${proxiedV6 ?? (expectProxy ? "无" : "未测")}`,
    ...verdict.rationale,
    "边界：短超时；部分节点无 IPv6；探测走 mixed-port 与直连分别采样。不能证明内核全部 IPv6 路径。",
  ];

  return {
    id: "ipv6-leak",
    title: "IPv6 泄漏",
    level: verdict.level,
    conclusion: verdict.conclusion,
    process: lines.join("\n"),
    suggestion: verdict.suggestion,
  };
}

type IceCand = {
  type: string;
  address: string;
  protocol: string;
  raw: string;
  scope: "private" | "public" | "unknown";
};

/**
 * A3: Browser STUN gather — 用已知代理出口比对候选（确定性改造）。
 * 真正的泄漏信号是"公网候选 ≠ 代理出口"，据此把三类明确分开而非统统 warn。
 */
export async function checkWebRtcLeak(
  exit?: ExitIpInfo | null,
): Promise<CheckCard> {
  const RTCPeer =
    typeof window !== "undefined"
      ? (window as unknown as { RTCPeerConnection?: typeof RTCPeerConnection })
          .RTCPeerConnection
      : undefined;

  const proxyExitIps = [exit?.ip].filter((x): x is string => !!x);

  if (!RTCPeer) {
    const v = classifyWebRtc({ apiAvailable: false, gatherFailed: false, candidates: [] });
    return {
      id: "webrtc",
      title: "WebRTC",
      level: v.level,
      conclusion: v.conclusion,
      process:
        "嵌入式 WebView 可能禁用 WebRTC。这不等于「无泄漏」，只是本环境测不了。\n测了什么：无（API 缺失）。\n没测：完整 BrowserLeaks / 系统级 WebRTC 策略。",
      suggestion: v.suggestion,
    };
  }

  const candidates: IceCand[] = [];
  let failMsg: string | null = null;

  try {
    const pc = new RTCPeer({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    const gatherDone = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 2800);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const c = ev.candidate;
        const candStr = c.candidate || "";
        // candidate: foundation component protocol priority ip port typ type …
        const parts = candStr.split(" ");
        const typIdx = parts.indexOf("typ");
        const typ = typIdx >= 0 ? parts[typIdx + 1] ?? "unknown" : "unknown";
        const address = (c as RTCIceCandidate & { address?: string }).address
          || (parts.length > 4 ? parts[4] : "")
          || "";
        const protocol = (c as RTCIceCandidate & { protocol?: string }).protocol
          || (parts.length > 2 ? parts[2] : "")
          || "";
        if (!address) return;
        const scope = candidateScope(address);
        candidates.push({
          type: typ,
          address,
          protocol,
          raw: candStr,
          scope,
        });
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      };
    });

    pc.createDataChannel("egress-check");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await gatherDone;
    pc.close();
  } catch (e) {
    failMsg = e instanceof Error ? e.message : String(e);
  }

  const uniq = new Map<string, IceCand>();
  for (const c of candidates) {
    const key = `${c.type}|${c.address}|${c.protocol}`;
    if (!uniq.has(key)) uniq.set(key, c);
  }
  const list = [...uniq.values()];

  const verdict = classifyWebRtc({
    apiAvailable: true,
    gatherFailed: !!failMsg,
    proxyExitIps,
    candidates: list.map((c) => ({
      type: normalizeIceType(c.type),
      address: c.address,
      scope: c.scope,
    })),
  });

  const detailLines = [
    ...list.map((c) => `${c.type} ${c.scope} ${c.protocol} ${c.address}`),
    `代理出口 IP：${proxyExitIps.join(", ") || "无（先做环境检查/出口 IP 才能精确比对）"}`,
    failMsg ? `收集报错：${failMsg}` : "",
    "测了什么：浏览器 RTCPeerConnection + Google STUN，约 2.8s 收集，公网候选与代理出口比对。",
    "没测：完整泄漏矩阵、mdns 隐藏策略细节、非 WebView 进程。",
    "边界：有候选≠一定泄漏到目标站点；无候选≠一定安全。",
  ].filter(Boolean);

  return {
    id: "webrtc",
    title: "WebRTC",
    level: verdict.level,
    conclusion: verdict.conclusion,
    process: detailLines.join("\n"),
    suggestion: verdict.suggestion,
  };
}

/** 归一 ICE 候选类型到 leakMatrix 的联合；未知一律 unknown。 */
function normalizeIceType(t: string): WebRtcCandidateType {
  const k = t.toLowerCase();
  if (k === "host" || k === "srflx" || k === "prflx" || k === "relay") return k;
  return "unknown";
}

/** Sync placeholder kept for type imports; prefer checkWebRtcLeak(). */
export function webrtcCard(): CheckCard {
  return {
    id: "webrtc",
    title: "WebRTC",
    level: "unknown",
    conclusion: "请调用异步 checkWebRtcLeak()",
  };
}

export async function probeGeminiUnlock(
  mixedPort?: number | null,
): Promise<UnlockResult> {
  const r = await fetchTextViaProxy("https://gemini.google.com/app", {
    mixedPort: mixedPort ?? null,
    userAgent: UA,
    timeoutMs: 5000,
  });
  const out = r.text;
  const blocked = [
    "isn't currently supported in your country",
    "not supported in your country",
    "is not supported in this region",
    "不支持你所在的地区",
  ].some((kw) => out.includes(kw));

  let detectedCountry: string | null = null;
  const idx = out.indexOf('"vXmutd"');
  if (idx !== -1) {
    const chunk = out.slice(idx, idx + 60);
    const m = chunk.match(/\\"([A-Z]{2})\\"/);
    if (m && m[1] !== "ZZ") detectedCountry = m[1];
  }
  if (!detectedCountry) {
    const m3 = out.match(/,2,1,200,"([A-Z]{3})"/);
    if (m3 && !["CHN", "HKG"].includes(m3[1])) detectedCountry = m3[1];
  }

  const probed = [
    "gemini.google.com/app（看是否地区拦截、内容是否正常返回）",
  ];
  const notProbed: string[] = [];

  if (blocked) {
    return {
      supported: false,
      level: "blocked",
      region: "BLOCKED",
      status: "不可用（地区限制）",
      lines: ["不可用"],
      probed,
      notProbed,
    };
  }
  if (out.length > 50000) {
    return {
      supported: true,
      level: "full",
      region: detectedCountry ?? "OK",
      status: detectedCountry ? `可用（${detectedCountry}）` : "可用",
      lines: ["可用"],
      probed,
      notProbed,
    };
  }
  if (!r.ok && !out) {
    return {
      supported: false,
      level: "unknown",
      region: null,
      status: "超时未响应",
      lines: ["超时未响应"],
      probed,
      notProbed,
    };
  }
  return {
    supported: false,
    level: "blocked",
    region: null,
    status: "不可用",
    lines: ["不可用"],
    probed,
    notProbed,
  };
}


export async function probeChatgptUnlock(
  mixedPort?: number | null,
): Promise<UnlockResult> {
  let loc: string | null = null;
  const trace = await fetchTextViaProxy("https://chatgpt.com/cdn-cgi/trace", {
    mixedPort: mixedPort ?? null,
    userAgent: "Mozilla/5.0",
    timeoutMs: 3000,
  });
  for (const line of trace.text.split("\n")) {
    if (line.startsWith("loc=")) {
      loc = line.split("=")[1]?.trim() ?? null;
      break;
    }
  }

  let webOk = false;
  const web = await fetchTextViaProxy(
    "https://api.openai.com/compliance/cookie_requirements",
    {
      mixedPort: mixedPort ?? null,
      userAgent: UA,
      timeoutMs: 3500,
    },
  );
  if (web.text && !web.text.includes("unsupported_country")) {
    if (web.status === 200 || (web.status !== 403 && web.status !== 0)) {
      webOk = true;
    }
  }
  // CORS may block body in browser — treat opaque network success carefully
  if (!web.ok && web.status === 0) {
    // likely CORS; try chatgpt.com homepage as soft signal
    const home = await fetchTextViaProxy("https://chatgpt.com/", {
      mixedPort: mixedPort ?? null,
      userAgent: UA,
      timeoutMs: 4000,
    });
    if (home.ok || home.status === 200 || home.text.length > 1000) {
      webOk = !home.text.includes("unsupported_country");
    }
  }

  const locTag = loc ?? "未知地区";
  const probed = [
    "chatgpt.com/cdn-cgi/trace、OpenAI compliance 接口（必要时再看 chatgpt.com 首页）",
  ];
  const notProbed: string[] = [];

  if (!webOk) {
    return {
      supported: false,
      level: "blocked",
      region: loc,
      status: loc ? `不可用（${locTag}）` : "不可用",
      lines: ["不可用"],
      probed,
      notProbed,
    };
  }
  return {
    supported: true,
    level: "full",
    region: loc,
    status: loc ? `可用（${locTag}）` : "可用",
    lines: ["可用"],
    probed,
    notProbed,
  };
}

function unlockCard(
  id: string,
  title: string,
  result: UnlockResult,
): CheckCard {
  let level: CheckLevel = "fail";
  if (result.supported) {
    level = "pass";
    if (result.level === "web_only" || result.level === "app_only") level = "warn";
    if (result.level === "full") level = "pass";
  } else if (result.level === "unknown") {
    level = "unknown";
  }

  const lines = (result.lines ?? []).join("；");
  const probed = (result.probed ?? []).join("；");
  const notProbed = (result.notProbed ?? []).join("；");

  const processParts = [
    lines ? `结果对照：${lines}` : "",
    probed ? `测了什么：${probed}` : "",
    notProbed ? `没测什么：${notProbed}` : "",
    result.region ? `出口提示地区：${result.region}` : "",
    "换节点时一次对照用，不能替代你自己打开网站。",
  ].filter(Boolean);

  const suggestion: string | undefined = undefined;

  return {
    id,
    title,
    level,
    conclusion: result.status,
    process: processParts.join("\n"),
    suggestion,
  };
}

function medianNumber(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  }
  return sorted[mid]!;
}

/** 同 URL 连续采样 3 次，取成功值中位数；全失败才判失败。 */
export async function sampleLatency(
  mixedPort?: number | null,
): Promise<{ ms: number | null; card: CheckCard }> {
  const url = "https://www.gstatic.com/generate_204";
  const attemptLines: string[] = [];
  const successMs: number[] = [];

  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = await probeText(url, {
      mixedPort,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const reachable = isReachableStatus(r.status, r.ok);
    const elapsed = Math.round(performance.now() - t0);
    if (reachable) {
      successMs.push(elapsed);
      attemptLines.push(`第 ${i + 1} 次：${elapsed} ms（HTTP ${r.status}）`);
    } else {
      attemptLines.push(
        `第 ${i + 1} 次：失败（HTTP ${r.status || "超时"} · ${elapsed} ms）`,
      );
    }
  }

  if (successMs.length === 0) {
    return {
      ms: null,
      card: {
        id: "latency",
        title: "延迟采样",
        level: "fail",
        conclusion: "采样失败",
        process: [`目标: ${url}`, ...attemptLines].join("\n"),
        suggestion: "请确认代理软件已连接，并开启系统代理或 TUN，然后重试。",
      },
    };
  }

  const ms = medianNumber(successMs);
  const level: CheckLevel = ms < 200 ? "pass" : ms < 500 ? "warn" : "fail";
  return {
    ms,
    card: {
      id: "latency",
      title: "延迟采样",
      level,
      conclusion: `大约 ${ms} ms（${successMs.length}/3 次中位）`,
      process: [
        `目标: ${url}`,
        ...attemptLines,
        `采用成功值中位数 ${ms} ms。`,
        "边界：同 URL 连续抽样，不是面板延迟。",
      ].join("\n"),
      suggestion: undefined,
    },
  };
}


type SampleProbe = {
  label: string;
  host: string;
  url: string;
  kind: "cn" | "foreign";
  ok: boolean;
  status: number;
  ms: number;
  via: string;
};

async function probeSampleHost(
  label: string,
  host: string,
  url: string,
  kind: "cn" | "foreign",
  mixedPort: number | null,
  timeoutMs: number,
): Promise<SampleProbe> {
  const t0 = performance.now();
  const r = await fetchTextViaProxy(url, {
    mixedPort,
    timeoutMs,
    userAgent: UA,
  });
  const ms = Math.round(performance.now() - t0);
  const ok =
    r.status === 204 ||
    r.status === 200 ||
    (r.status >= 200 && r.status < 400) ||
    (r.ok && r.status !== 0);
  return {
    label,
    host,
    url,
    kind,
    ok,
    status: r.status,
    ms,
    via: r.via + (mixedPort != null && mixedPort > 0 ? `+mixed:${mixedPort}` : "+direct"),
  };
}

/**
 * B5: 分流抽检 — domestic tend DIRECT / foreign via proxy (sample, not full audit).
 */
export async function checkSplitRouting(
  mixedPort?: number | null,
  mihomoConfig?: ControllerConfig | null,
): Promise<CheckCard> {
  const port = mixedPort ?? null;
  const expectProxy = port != null && port > 0;
  const timeoutMs = 4000;

  const cnTargets: { label: string; host: string; url: string }[] = [
    { label: "百度", host: "www.baidu.com", url: "https://www.baidu.com/" },
    { label: "腾讯", host: "www.qq.com", url: "https://www.qq.com/" },
  ];
  const foreignTargets: { label: string; host: string; url: string }[] = [
    {
      label: "Google 204",
      host: "www.google.com",
      url: "https://www.google.com/generate_204",
    },
    {
      label: "YouTube",
      host: "www.youtube.com",
      url: "https://www.youtube.com/",
    },
  ];

  const cnViaMixed: SampleProbe[] = [];
  const foreignViaMixed: SampleProbe[] = [];
  const cnDirect: SampleProbe[] = [];

  if (expectProxy) {
    for (const t of cnTargets) {
      cnViaMixed.push(
        await probeSampleHost(t.label, t.host, t.url, "cn", port, timeoutMs),
      );
    }
    for (const t of foreignTargets) {
      foreignViaMixed.push(
        await probeSampleHost(t.label, t.host, t.url, "foreign", port, timeoutMs),
      );
    }
  }

  // Direct CN baseline (true no-proxy) for rough DIRECT tendency
  for (const t of cnTargets) {
    cnDirect.push(
      await probeSampleHost(t.label, t.host, t.url, "cn", null, timeoutMs),
    );
  }

  let rulesLine = "规则库：未查询（无 Mihomo 配置或不适用）";
  if (mihomoConfig) {
    const rules = await getRulesSummary(mihomoConfig);
    if (rules.error) {
      rulesLine = `规则库：${rules.error}`;
    } else {
      rulesLine = `规则库抽样：共 ${rules.total} 条 · DIRECT ${rules.directCount} · REJECT ${rules.rejectCount} · 其它 ${rules.otherCount} · 含 CN/国内线索 ${rules.cnHintCount}`;
      if (rules.samples.length) {
        rulesLine += `\n  例：${rules.samples.slice(0, 4).join("； ")}`;
      }
    }
  }

  const fmt = (p: SampleProbe) =>
    `${p.label}(${p.host}) → ${p.ok ? "可达" : "失败"} HTTP ${p.status || "超时"} · ${p.ms}ms · ${p.via}`;

  const cnOk = cnViaMixed.filter((p) => p.ok).length;
  const foreignOk = foreignViaMixed.filter((p) => p.ok).length;
  const cnDirectOk = cnDirect.filter((p) => p.ok).length;

  // Latency heuristic: CN via mixed ≈ CN direct → likely DIRECT for those samples
  let latencyHint = "延迟对照：跳过（无 mixed-port 对照）";
  if (expectProxy && cnViaMixed.length && cnDirect.length) {
    const mixedAvg =
      cnViaMixed.reduce((s, p) => s + p.ms, 0) / Math.max(1, cnViaMixed.length);
    const directAvg =
      cnDirect.reduce((s, p) => s + p.ms, 0) / Math.max(1, cnDirect.length);
    const ratio = directAvg > 0 ? mixedAvg / directAvg : 0;
    if (cnOk > 0 && cnDirectOk > 0 && ratio > 0 && ratio < 2.2) {
      latencyHint = `延迟对照：国内经 mixed 均 ${Math.round(mixedAvg)}ms ≈ 直连 ${Math.round(directAvg)}ms（比值 ${ratio.toFixed(2)}）— 更像走 DIRECT`;
    } else if (cnOk > 0 && cnDirectOk > 0 && ratio >= 2.2) {
      latencyHint = `延迟对照：国内经 mixed 均 ${Math.round(mixedAvg)}ms 明显高于直连 ${Math.round(directAvg)}ms（比值 ${ratio.toFixed(2)}）— 可能被代理绕行`;
    } else {
      latencyHint = `延迟对照：国内 mixed 均 ${Math.round(mixedAvg)}ms · 直连 ${Math.round(directAvg)}ms（样本不足或失败，仅供参考）`;
    }
  }

  const process = [
    expectProxy
      ? `经 mixed-port(${port}) 国内：${cnOk}/${cnViaMixed.length} 可达`
      : "未配置 mixed-port，跳过「经代理」国内/境外对照",
    expectProxy
      ? `经 mixed-port(${port}) 境外：${foreignOk}/${foreignViaMixed.length} 可达`
      : "",
    `直连国内基线：${cnDirectOk}/${cnDirect.length} 可达`,
    latencyHint,
    rulesLine,
    "—— 样本明细 ——",
    ...(expectProxy ? cnViaMixed.map((p) => `国内·代理 ${fmt(p)}`) : []),
    ...(expectProxy ? foreignViaMixed.map((p) => `境外·代理 ${fmt(p)}`) : []),
    ...cnDirect.map((p) => `国内·直连 ${fmt(p)}`),
    "测了什么：少量国内/境外域名 HTTPS 抽样 + 可选 /rules 计数。",
    "没测：完整规则表逐条匹配、GEOIP 数据库正确性、UDP/QUIC、所有订阅域名。",
    "边界：这是「分流检查」不是完整规则审计；结果随节点与规则集变化。",
  ]
    .filter(Boolean)
    .join("\n");

  if (!expectProxy) {
    return {
      id: "split-routing",
      title: "分流检查",
      level: cnDirectOk > 0 ? "unknown" : "fail",
      conclusion: cnDirectOk > 0
        ? "仅完成直连国内基线；尚未连上代理口，无法判断分流"
        : "国内直连基线失败，且尚未连上代理口",
      process,
      suggestion: "请先点「刷新连接」确保已连上软件，再重测分流。",
    };
  }

  let level: CheckLevel;
  let conclusion: string;
  if (cnOk === 0 && foreignOk === 0) {
    level = "fail";
    conclusion = "经代理的国内与境外样本均失败";
  } else if (cnOk === cnViaMixed.length && foreignOk === foreignViaMixed.length) {
    level = "pass";
    conclusion = `抽样大致正常：国内 ${cnOk}/${cnViaMixed.length} · 境外 ${foreignOk}/${foreignViaMixed.length} 经代理可达`;
  } else if (cnOk > 0 && foreignOk === 0) {
    level = "warn";
    conclusion = `国内可达但境外经代理失败（${foreignOk}/${foreignViaMixed.length}）— 代理路径或规则可能异常`;
  } else if (cnOk === 0 && foreignOk > 0) {
    level = "warn";
    conclusion = `境外可达但国内经代理失败 — 国内站或 DIRECT 规则可能异常`;
  } else {
    level = "warn";
    conclusion = `部分可达：国内 ${cnOk}/${cnViaMixed.length} · 境外 ${foreignOk}/${foreignViaMixed.length}`;
  }

  return {
    id: "split-routing",
    title: "分流检查",
    level,
    conclusion,
    process,
    suggestion: undefined,
  };
}

/**
 * B6: 直连旁路粗检 — mixed-port fail + direct foreign OK → 可能未走代理直连.
 */
export async function checkBareEgress(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const port = mixedPort ?? null;
  const expectProxy = port != null && port > 0;
  const timeoutMs = 4000;
  const targets = [
    {
      label: "Google 204",
      url: "https://www.google.com/generate_204",
    },
    {
      label: "Cloudflare 204",
      url: "https://cp.cloudflare.com/generate_204",
    },
  ];

  async function one(
    url: string,
    label: string,
    mp: number | null,
  ): Promise<{ label: string; url: string; ok: boolean; status: number; ms: number; path: string }> {
    const t0 = performance.now();
    const r = await fetchTextViaProxy(url, {
      mixedPort: mp,
      timeoutMs,
    });
    const ms = Math.round(performance.now() - t0);
    const ok = isReachableStatus(r.status, r.ok) || (r.status >= 200 && r.status < 400);
    return {
      label,
      url,
      ok,
      status: r.status,
      ms,
      path: mp != null && mp > 0 ? `mixed-port(${mp})` : "直连(无代理)",
    };
  }

  const viaMixed = [];
  const viaDirect = [];
  for (const t of targets) {
    if (expectProxy) {
      viaMixed.push(await one(t.url, t.label, port));
      if (viaMixed[viaMixed.length - 1].ok) break;
    }
  }
  for (const t of targets) {
    viaDirect.push(await one(t.url, t.label, null));
    if (viaDirect[viaDirect.length - 1].ok) break;
  }

  const mixedOk = viaMixed.some((p) => p.ok);
  const directOk = viaDirect.some((p) => p.ok);

  const lines = [
    expectProxy
      ? `经代理：${mixedOk ? "可达" : "失败"}（探测 ${viaMixed.length} 次）`
      : "未配置 mixed-port，无法做「代理应在线」对照",
    `直连境外：${directOk ? "可达" : "失败"}（探测 ${viaDirect.length} 次）`,
    ...viaMixed.map(
      (p) => `代理 ${p.label} → ${p.ok ? "OK" : "失败"} HTTP ${p.status || "超时"} · ${p.ms}ms · ${p.path}`,
    ),
    ...viaDirect.map(
      (p) => `直连 ${p.label} → ${p.ok ? "OK" : "失败"} HTTP ${p.status || "超时"} · ${p.ms}ms · ${p.path}`,
    ),
    "测了什么：同一境外 HTTPS 探测点，分别走 mixed-port 与 Rust 真直连（不走系统代理）。",
    "没测：TUN 是否真正接管、系统代理开关、各 App 是否各自走代理、防火墙状态。",
    "边界：本应用无法单独从进程内完整获知 Clash TUN 内核状态；「未走代理直连」仅为抽样告警。",
  ];

  if (!expectProxy) {
    return {
      id: "bare-egress",
      title: "直连旁路检查",
      level: "unknown",
      conclusion: directOk
        ? "直连境外可达；尚未连上代理口，无法判断是否存在未走代理直连"
        : "直连境外不可达；尚未连上代理口",
      process: lines.join("\n"),
      suggestion: "请先点「刷新连接」确保已连上软件，再重测。",
    };
  }

  let level: CheckLevel;
  let conclusion: string;
  if (!mixedOk && directOk) {
    level = "warn";
    conclusion = "可能未走代理直连：代理路径失败但直连境外仍通";
  } else if (!mixedOk && !directOk) {
    level = "unknown";
    conclusion = "代理与直连境外均失败 — 可能离线或探测点不可达";
  } else if (mixedOk && !directOk) {
    level = "pass";
    conclusion = "代理路径可达，直连境外失败 — 未见「代理挂了仍直出」";
  } else {
    // both OK
    level = "pass";
    conclusion = "代理路径可达（直连境外亦通，属环境常见情况）";
  }

  return {
    id: "bare-egress",
    title: "直连旁路检查",
    level,
    conclusion,
    process: lines.join("\n"),
    suggestion: "若提示可能未走代理直连：检查代理软件是否断连，以及系统代理 / TUN 是否关掉。",
  };
}

/** A4: sample up/down Mbps through current egress (mixed-port preferred). */
const BW_DOWN_BYTES_FULL = 524288;
const BW_DOWN_BYTES_LIGHT = 131072;
const BW_UP_BYTES_FULL = 512 * 1024;
const BW_UP_BYTES_LIGHT = 64 * 1024;
const BW_TIMEOUT_FULL_MS = 12000;
const BW_TIMEOUT_LIGHT_MS = 6000;

function bwDownUrl(bytes: number): string {
  return `https://speed.cloudflare.com/__down?bytes=${bytes}`;
}

const BW_UP_URL = "https://speed.cloudflare.com/__up";

export type BandwidthSampleOptions = {
  /**
   * full：「测当前」— 成功后再做一次轻量复核；差异大则标不稳定。
   * light：「测全部」— 仅失败/超时时再试一次，成功不复核。
   */
  mode?: "full" | "light";
  /** @deprecated 请用 mode:"light"；保留兼容旧调用 */
  light?: boolean;
};

function bytesToMbps(bytes: number, elapsedMs: number): number | null {
  if (bytes <= 0 || elapsedMs <= 0) return null;
  return (bytes * 8) / (elapsedMs / 1000) / 1_000_000;
}

function fmtMbps(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "--";
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

type BandwidthShot = {
  downMbps: number | null;
  upMbps: number | null;
  downPartial: boolean;
  downOk: boolean;
  level: CheckLevel;
  conclusion: string;
  process: string;
  downErr: string | null;
  upErr: string | null;
  /** No proxy port available AND direct fallback refused → speed untestable. */
  unverified: boolean;
};

async function sampleBandwidthOnce(
  mixedPort: number | null | undefined,
  light: boolean,
): Promise<BandwidthShot> {
  const downBytes = light ? BW_DOWN_BYTES_LIGHT : BW_DOWN_BYTES_FULL;
  const upBytes = light ? BW_UP_BYTES_LIGHT : BW_UP_BYTES_FULL;
  const timeoutMs = light ? BW_TIMEOUT_LIGHT_MS : BW_TIMEOUT_FULL_MS;
  const downUrl = bwDownUrl(downBytes);

  const down = await timedTransferViaProxy({
    url: downUrl,
    mixedPort: mixedPort ?? null,
    method: "GET",
    timeoutMs,
  });
  const up = await timedTransferViaProxy({
    url: BW_UP_URL,
    mixedPort: mixedPort ?? null,
    method: "POST",
    uploadBytes: upBytes,
    timeoutMs,
  });

  const downMbps =
    down.bytes > 0 && down.elapsedMs > 0
      ? bytesToMbps(down.bytes, down.elapsedMs)
      : null;
  const upMbps = up.ok ? bytesToMbps(up.bytes, up.elapsedMs) : null;
  const downPartial = !!down.error && down.bytes > 0 && downMbps != null;

  const downErr =
    down.error ||
    (!down.ok && !downPartial
      ? down.status
        ? `HTTP ${down.status}`
        : "超时或不可达"
      : null);
  const upErr =
    up.error ||
    (!up.ok ? (up.status ? `HTTP ${up.status}` : "超时或不可达") : null);

  const conclusionParts: string[] = [];
  if (downMbps != null)
    conclusionParts.push(
      `↓ ${fmtMbps(downMbps)} Mbps${downPartial ? "（部分）" : ""}`,
    );
  else conclusionParts.push(`↓ 失败`);
  if (upMbps != null) conclusionParts.push(`↑ ${fmtMbps(upMbps)} Mbps`);
  else conclusionParts.push(`↑ 失败`);

  let level: CheckLevel;
  if (downMbps != null && upMbps != null && !downPartial && down.ok) level = "pass";
  else if (downMbps != null || upMbps != null) level = "warn";
  else level = "fail";

  const portNote =
    mixedPort != null && mixedPort > 0
      ? `经 mixed-port(${mixedPort})`
      : "未配置 mixed-port（可能走直连）";

  // Throughput can only be honestly reported when it was measured *through* a
  // proxy. With no proxy port and the direct-fallback refused (production), we
  // simply cannot vouch for the node's speed → neutral 未验证, not "fail".
  const hadProxy = mixedPort != null && mixedPort > 0;
  const unverified = !hadProxy && !canBrowserFallback();

  const kib = (n: number) => `${Math.round(n / 1024)}KiB`;
  const process = [
    `下载：GET ${downUrl}`,
    `  期望约 ${downBytes} B · 实际 ${down.bytes} B · ${down.elapsedMs} ms · via ${down.via}` +
      (downMbps != null ? ` · ${fmtMbps(downMbps)} Mbps` : "") +
      (downErr ? ` · ${downErr}` : ""),
    `上传：POST ${BW_UP_URL}（Content-Type: application/octet-stream，${upBytes} B 零填充）`,
    `  发送 ${up.bytes} B · ${up.elapsedMs} ms · via ${up.via}` +
      (upMbps != null ? ` · ${fmtMbps(upMbps)} Mbps` : "") +
      (upErr ? ` · ${upErr}` : ""),
    `路径：${portNote}；超时 ${timeoutMs} ms${light ? "（轻量抽样）" : ""}。`,
    "说明：抽样带宽 ≠ 全网测速 / 不等于节点面板延迟。",
    `端点：Cloudflare Speed（__down ${kib(downBytes)} / __up ${kib(upBytes)}）。请求 Accept-Encoding: identity，按字节流计数（避免经代理 gzip 解码失败）。未用 httpbin。`,
  ].join("\n");

  let finalLevel: CheckLevel = level;
  let conclusion =
    level === "fail"
      ? `抽样失败（↓ ${downErr ?? "失败"} · ↑ ${upErr ?? "失败"}）`
      : conclusionParts.join(" · ");
  if (unverified) {
    finalLevel = "unknown";
    conclusion = "未验证：未取到代理口，未能经代理测速";
  }

  return {
    downMbps,
    upMbps,
    downPartial,
    downOk: down.ok,
    level: finalLevel,
    conclusion,
    process,
    downErr,
    upErr,
    unverified,
  };
}

function relativeDiff(a: number, b: number): number {
  const mid = (Math.abs(a) + Math.abs(b)) / 2;
  if (mid <= 0) return 1;
  return Math.abs(a - b) / mid;
}

function meanMbps(a: number | null, b: number | null): number | null {
  if (a != null && b != null) return (a + b) / 2;
  return a ?? b;
}

export async function sampleBandwidth(
  mixedPort?: number | null,
  opts?: BandwidthSampleOptions,
): Promise<CheckCard> {
  const mode: "full" | "light" =
    opts?.mode ?? (opts?.light ? "light" : "full");
  const lightPrimary = mode === "light";

  const first = await sampleBandwidthOnce(mixedPort, lightPrimary);

  // No proxy port and direct-fallback refused → we could not measure throughput
  // at all. Return a neutral 未验证 card and skip retries (a retry can't help).
  if (first.unverified) {
    return {
      id: "bandwidth",
      title: "抽样带宽",
      level: "unknown",
      unverified: true,
      conclusion: first.conclusion,
      process: first.process,
      suggestion: "请先连接并刷新代理节点（拿到 mixed-port）后再测速。",
    };
  }

  if (mode === "light") {
    if (first.level !== "fail") {
      return {
        id: "bandwidth",
        title: "抽样带宽",
        level: first.level,
        conclusion: first.conclusion,
        process: first.process,
        suggestion: undefined,
      };
    }
    const second = await sampleBandwidthOnce(mixedPort, true);
    return {
      id: "bandwidth",
      title: "抽样带宽",
      level: second.level,
      conclusion: second.conclusion,
      process: [`第 1 次（失败）：\n${first.process}`, `第 2 次：\n${second.process}`].join(
        "\n",
      ),
      suggestion:
        second.level === "fail" ? "请确认代理软件已连上后再测。" : undefined,
    };
  }

  // full：「测当前」— 成功后再轻量复核；失败则直接返回
  if (first.level === "fail") {
    return {
      id: "bandwidth",
      title: "抽样带宽",
      level: first.level,
      conclusion: first.conclusion,
      process: first.process,
      suggestion: "请确认代理软件已连上后再测。",
    };
  }

  const confirm = await sampleBandwidthOnce(mixedPort, true);
  const process = [
    `第 1 次（主抽样）：\n${first.process}`,
    `第 2 次（轻量复核）：\n${confirm.process}`,
  ].join("\n");

  const downA = first.downMbps;
  const downB = confirm.downMbps;
  const upA = first.upMbps;
  const upB = confirm.upMbps;

  let unstable = false;
  if (downA != null && downB != null && relativeDiff(downA, downB) > 0.4) {
    unstable = true;
  } else if (
    downA == null &&
    upA != null &&
    upB != null &&
    relativeDiff(upA, upB) > 0.4
  ) {
    unstable = true;
  }

  const downMbps = meanMbps(downA, downB);
  const upMbps = meanMbps(upA, upB);

  const conclusionParts: string[] = [];
  if (downMbps != null) conclusionParts.push(`↓ ${fmtMbps(downMbps)} Mbps`);
  else conclusionParts.push(`↓ 失败`);
  if (upMbps != null) conclusionParts.push(`↑ ${fmtMbps(upMbps)} Mbps`);
  else conclusionParts.push(`↑ 失败`);

  let level: CheckLevel;
  if (downMbps != null && upMbps != null) level = unstable ? "warn" : "pass";
  else if (downMbps != null || upMbps != null) level = "warn";
  else level = "fail";

  let conclusion = conclusionParts.join(" · ");
  if (unstable) {
    conclusion = `${conclusion}（不稳定）`;
    if (level === "pass") level = "warn";
  }

  return {
    id: "bandwidth",
    title: "抽样带宽",
    level,
    conclusion,
    process,
    suggestion: level === "fail" ? "请确认代理软件已连上后再测。" : undefined,
  };
}



type ProbeLine = {
  name: string;
  level: CheckLevel;
  conclusion: string;
  process: string;
};

function extractNetflixRegion(text: string): string | null {
  const patterns = [
    /"currentCountry"\s*:\s*"([A-Z]{2})"/i,
    /"country"\s*:\s*"([A-Z]{2})"/i,
    /netflix\.com\/([a-z]{2})(?:-[a-z]{2})?\/title\//i,
    /og:url[^>]+netflix\.com\/([a-z]{2})(?:-[a-z]{2})?\//i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].toUpperCase();
  }
  return null;
}

async function probeNetflixLine(
  mixedPort?: number | null,
): Promise<ProbeLine> {
  // Common Clash unlock title used for region redirect hints
  const url = "https://www.netflix.com/title/80018499";
  const timeoutMs = 4000;
  const t0 = performance.now();
  const r = await probeText(url, {
    mixedPort,
    timeoutMs,
    userAgent: UA,
  });
  const ms = Math.round(performance.now() - t0);
  const body = r.text ?? "";
  const lower = body.toLowerCase();

  if (!r.status && !body) {
    return {
      name: "Netflix",
      level: "unknown",
      conclusion: "超时未响应",
      process: `${url} → 超时/无响应（${ms}ms）。短超时抽样检查；失败≠节点一定不可用。`,
    };
  }

  const blocked =
    /nsez-403|nsez_403|not available in your country|proxy.*detected|vpn.*detected/i.test(
      body,
    ) || r.status === 403;
  if (blocked) {
    return {
      name: "Netflix",
      level: "fail",
      conclusion: "不可用（地区限制）",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n信号：NSEZ-403 / 403 / 地区拦截文案。\n边界：本次检查不等于会员权益/片库/画质。`,
    };
  }

  const originalsOnly =
    (lower.includes("oh no!") || lower.includes("page-404") || r.status === 404) &&
    body.length > 200;
  const region = extractNetflixRegion(body);
  const reachable =
    isReachableStatus(r.status, r.ok) ||
    (r.status >= 200 && r.status < 500 && body.length > 500);

  if (originalsOnly && !region) {
    return {
      name: "Netflix",
      level: "warn",
      conclusion: "可用，片库信号偏弱",
      process: `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B\n信号：Oh no! / page-404 / 404。\n边界：本次检查不等于完整片库解锁。`,
    };
  }

  if (reachable) {
    return {
      name: "Netflix",
      level: region ? "pass" : "warn",
      conclusion: region ? `可用（${region}）` : "可用",
      process: [
        `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B`,
        region
          ? `地区线索：${region}`
          : "地区线索未解析（跟随重定向后仅看状态/正文）。",
        "测了什么：title/80018499 经 mixed-port（跟随重定向后看状态与正文线索）。",
        "没测：完整片库、账号登录、4K/HDR、CDN 线路质量。",
      ].join("\n"),
    };
  }

  return {
    name: "Netflix",
    level: "unknown",
    conclusion: "未能判定",
    process: `${url} → HTTP ${r.status || "超时"} · ${ms}ms · body≈${body.length}B。探针偏抖时标 unknown。`,
  };
}

async function probeDisneyLine(
  mixedPort?: number | null,
): Promise<ProbeLine> {
  const url = "https://www.disneyplus.com/";
  const timeoutMs = 4000;
  const t0 = performance.now();
  const r = await probeText(url, {
    mixedPort,
    timeoutMs,
    userAgent: UA,
  });
  const ms = Math.round(performance.now() - t0);
  const body = r.text ?? "";
  const lower = body.toLowerCase();

  if (!r.status && !body) {
    return {
      name: "Disney+",
      level: "unknown",
      conclusion: "超时未响应",
      process: `${url} → 超时/无响应（${ms}ms）。未跑 bamgrid 多步注册（本版只做一次页面请求检查）。`,
    };
  }

  const geoBlock =
    lower.includes("not available in your") ||
    lower.includes("isn't available in your") ||
    lower.includes("unavailable in your region") ||
    lower.includes("disney+ is not available") ||
    (lower.includes("preview") && lower.includes("unavailable")) ||
    r.status === 403;

  const region =
    body.match(/"region"\s*:\s*"([A-Z]{2})"/i)?.[1]?.toUpperCase() ??
    body.match(/"countryCode"\s*:\s*"([A-Z]{2})"/i)?.[1]?.toUpperCase() ??
    body.match(/disneyplus\.com\/([a-z]{2})(?:-[a-z]{2})?\//i)?.[1]?.toUpperCase() ??
    null;

  if (geoBlock) {
    return {
      name: "Disney+",
      level: "fail",
      conclusion: "不可用（地区限制）",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n信号：unavailable / not available / 403。\n边界：本次检查不等于会员登录与片库。`,
    };
  }

  const reachable =
    isReachableStatus(r.status, r.ok) ||
    (r.status >= 200 && r.status < 400 && body.length > 400);

  if (reachable) {
    return {
      name: "Disney+",
      level: "pass",
      conclusion: region ? `可用（${region}）` : "可用",
      process: [
        `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B`,
        region ? `地区线索：${region}` : "未从 HTML 解析到稳定地区码（仍可能可用）。",
        "测了什么：disneyplus.com 首页 GET。",
        "没测：bamgrid device/token GraphQL 完整解锁链、App、画质。",
      ].join("\n"),
    };
  }

  return {
    name: "Disney+",
    level: "unknown",
    conclusion: "未能判定",
    process: `${url} → HTTP ${r.status || "超时"} · ${ms}ms · body≈${body.length}B`,
  };
}

async function probeYoutubeLine(
  mixedPort?: number | null,
): Promise<ProbeLine> {
  const url = "https://www.youtube.com/premium";
  const timeoutMs = 4000;
  const t0 = performance.now();
  const r = await probeText(url, {
    mixedPort,
    timeoutMs,
    userAgent: UA,
  });
  const ms = Math.round(performance.now() - t0);
  const body = r.text ?? "";
  const lower = body.toLowerCase();

  if (!r.status && !body) {
    return {
      name: "YouTube",
      level: "unknown",
      conclusion: "超时未响应",
      process: `${url} → 超时/无响应（${ms}ms）`,
    };
  }

  const notAvail =
    lower.includes("youtube premium is not available in your country") ||
    lower.includes("not available in your country");

  const country =
    body.match(/id="country-code"[^>]*>([^<]+)</i)?.[1]?.trim() ??
    body.match(/"GL"\s*:\s*"([A-Z]{2})"/)?.[1] ??
    body.match(/"countryCode"\s*:\s*"([A-Z]{2})"/i)?.[1] ??
    null;

  const premiumSignal =
    lower.includes("ad-free") ||
    lower.includes("youtube premium") ||
    lower.includes("premium");

  if (notAvail) {
    return {
      name: "YouTube",
      level: "fail",
      conclusion: country
        ? `不可用（地区限制 · ${country}）`
        : "不可用（地区限制）",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n信号：not available in your country。\n边界：本次检查不等于 Premium 订阅/全家共享/画质。`,
    };
  }

  const reachable =
    isReachableStatus(r.status, r.ok) ||
    (r.status >= 200 && r.status < 400 && body.length > 800);

  if (reachable && premiumSignal) {
    return {
      name: "YouTube",
      level: "pass",
      conclusion: country ? `可用（${country}）` : "可用",
      process: [
        `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B`,
        country ? `country-code / GL：${country}` : "未解析到 country-code（页仍可达）。",
        "测了什么：youtube.com/premium 文案与粗国家码。",
        "没测：登录后权益、Premium 扣款、Music、Kids。",
      ].join("\n"),
    };
  }

  if (reachable) {
    return {
      name: "YouTube",
      level: "warn",
      conclusion: "可用，会员信号偏弱",
      process: `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B。可能被改版/重定向稀释信号。`,
    };
  }

  return {
    name: "YouTube",
    level: "unknown",
    conclusion: "未能判定",
    process: `${url} → HTTP ${r.status || "超时"} · ${ms}ms · body≈${body.length}B`,
  };
}

function extractAppleStorefront(text: string): string | null {
  const m1 = text.match(/apps\.apple\.com\/([a-z]{2})\//i);
  if (m1?.[1] && m1[1].toLowerCase() !== "app") return m1[1].toUpperCase();
  const m2 = text.match(/itunes\.apple\.com\/([a-z]{2})\//i);
  if (m2?.[1]) return m2[1].toUpperCase();
  const m3 = text.match(/storefront[^0-9]*([0-9]{5,6})/i);
  if (m3?.[1]) return `sf:${m3[1]}`;
  return null;
}

async function probeAppleStoreLine(
  mixedPort?: number | null,
): Promise<ProbeLine> {
  const url = "https://apps.apple.com/";
  const timeoutMs = 4000;
  const t0 = performance.now();
  const r = await probeText(url, {
    mixedPort,
    timeoutMs,
    userAgent: UA,
  });
  const ms = Math.round(performance.now() - t0);
  const body = r.text ?? "";
  const lower = body.toLowerCase();

  if (!r.status && !body) {
    return {
      name: "App Store",
      level: "unknown",
      conclusion: "超时未响应",
      process: `${url} → 超时/无响应（${ms}ms）`,
    };
  }

  const wall =
    lower.includes("not available in your country") ||
    lower.includes("unavailable in your region") ||
    r.status === 403;

  const sf = extractAppleStorefront(body);
  const reachable =
    isReachableStatus(r.status, r.ok) ||
    (r.status >= 200 && r.status < 400 && body.length > 300);

  if (wall) {
    return {
      name: "App Store",
      level: "fail",
      conclusion: "不可用（地区限制）",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n边界：不是下载、支付、上架审核。`,
    };
  }

  if (reachable) {
    return {
      name: "App Store",
      level: "pass",
      conclusion: sf ? `可用（${sf}）` : "可用",
      process: [
        `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B`,
        sf
          ? `storefront / 国家路径线索：${sf}`
          : "未解析到 /xx/ storefront 路径（跟随重定向后仍可能已是默认区）。",
        "测了什么：apps.apple.com 是否可达、是否有粗地区路径。",
        "没测：App 下载、内购支付、开发者上架审核、账号区。",
      ].join("\n"),
    };
  }

  return {
    name: "App Store",
    level: "unknown",
    conclusion: "未能判定",
    process: `${url} → HTTP ${r.status || "超时"} · ${ms}ms · body≈${body.length}B`,
  };
}

async function probeGooglePlayLine(
  mixedPort?: number | null,
): Promise<ProbeLine> {
  const url = "https://play.google.com/store/games";
  const timeoutMs = 4000;
  const t0 = performance.now();
  const r = await probeText(url, {
    mixedPort,
    timeoutMs,
    userAgent: UA,
  });
  const ms = Math.round(performance.now() - t0);
  const body = r.text ?? "";
  const lower = body.toLowerCase();

  if (!r.status && !body) {
    return {
      name: "Google Play",
      level: "unknown",
      conclusion: "超时未响应",
      process: `${url} → 超时/无响应（${ms}ms）`,
    };
  }

  const wall =
    lower.includes("isn't available in your country") ||
    lower.includes("not available in your country") ||
    lower.includes("this item isn't available") ||
    r.status === 403;

  const gl =
    body.match(/[?&]gl=([a-z]{2})\b/i)?.[1]?.toUpperCase() ??
    body.match(/"gl"\s*:\s*"([A-Z]{2})"/)?.[1] ??
    null;

  const reachable =
    isReachableStatus(r.status, r.ok) ||
    (r.status >= 200 && r.status < 400 && body.length > 400);

  if (wall) {
    return {
      name: "Google Play",
      level: "fail",
      conclusion: "不可用（地区限制）",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n边界：不是下载、支付、上架审核。`,
    };
  }

  if (reachable) {
    return {
      name: "Google Play",
      level: "pass",
      conclusion: gl ? `可用（${gl}）` : "可用",
      process: [
        `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B`,
        gl ? `gl 线索：${gl}` : "未解析到 gl 参数（页仍可达）。",
        "测了什么：play.google.com 是否可达。",
        "没测：APK 下载、付款、Play 账号区、上架审核。",
      ].join("\n"),
    };
  }

  return {
    name: "Google Play",
    level: "unknown",
    conclusion: "未能判定",
    process: `${url} → HTTP ${r.status || "超时"} · ${ms}ms · body≈${body.length}B`,
  };
}

function mixedPortPathNote(mixedPort?: number | null): string {
  return mixedPort != null && mixedPort > 0
    ? `路径：优先经 mixed-port(${mixedPort})。`
    : "路径：未配置 mixed-port（可能走窗口直连，结果勿当代理出口）。";
}

function serviceCardFromLine(
  id: string,
  title: string,
  line: ProbeLine,
  suggestion: string,
  mixedPort?: number | null,
): CheckCard {
  // Empty tip → no card suggestion; otherwise only show on non-pass.
  const tip =
    !suggestion
      ? undefined
      : line.level === "pass"
        ? undefined
        : suggestion;
  return {
    id,
    title,
    level: line.level,
    conclusion: line.conclusion,
    process: [line.process, mixedPortPathNote(mixedPort)].join("\n"),
    suggestion: tip,
  };
}

/** Streaming cards: no canned「换节点」suggestion. */
const STREAM_TIP = "";
/** Store cards: no canned「换节点」suggestion. */
const STORE_TIP = "";

/** 可用（含「可用，…偏弱」）不重试；不可用 / 超时未响应 / 未能判定 再试一次。 */
function serviceNeedsRetry(card: CheckCard): boolean {
  const c = (card.conclusion ?? "").trim();
  if (/^可用/.test(c)) return false;
  if (/不可用|超时未响应|未能判定|这次没测成|这次没测出来|未测成/.test(c)) return true;
  if (card.level === "unknown") return true;
  return false;
}

/** 失败/未成功类结论自动再探一次；用户可见结论取最后一次有意义结果。 */
export async function withFailRetry(
  fn: () => Promise<CheckCard>,
): Promise<CheckCard> {
  const first = await fn();
  if (!serviceNeedsRetry(first)) return first;
  const second = await fn();
  return {
    ...second,
    process: [
      first.process ? `第 1 次：\n${first.process}` : "第 1 次：（无过程）",
      second.process ? `第 2 次：\n${second.process}` : "第 2 次：（无过程）",
    ].join("\n"),
  };
}

/** UnlockResult：可用不重试；不可用 / 超时未响应 / 未能判定 再试一次。 */
function unlockNeedsRetry(result: UnlockResult): boolean {
  const c = (result.status ?? "").trim();
  if (/^可用/.test(c)) return false;
  if (/不可用|超时未响应|未能判定|这次没测成|这次没测出来|未测成|未完成/.test(c)) return true;
  if (result.level === "unknown") return true;
  return false;
}

export async function withFailRetryUnlock(
  fn: () => Promise<UnlockResult>,
): Promise<UnlockResult> {
  const first = await fn();
  if (!unlockNeedsRetry(first)) return first;
  const second = await fn();
  const note = "第 2 次复测";
  return {
    ...second,
    probed: [...(first.probed ?? []), note, ...(second.probed ?? [])],
    lines: [
      ...(first.lines ?? []).map((l) => `第 1 次：${l}`),
      ...(second.lines ?? []).map((l) => `第 2 次：${l}`),
    ],
  };
}

/** Netflix 单独卡：粗可达与地区线索。 */
export async function checkNetflixUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  return withFailRetry(async () => {
    const line = await probeNetflixLine(mixedPort);
    return serviceCardFromLine("netflix", "Netflix", line, STREAM_TIP, mixedPort);
  });
}

/** Disney+ 单独卡：首页粗可达与地区线索。 */
export async function checkDisneyUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  return withFailRetry(async () => {
    const line = await probeDisneyLine(mixedPort);
    return serviceCardFromLine("disney", "Disney+", line, STREAM_TIP, mixedPort);
  });
}

/** YouTube Premium 单独卡（探测 Premium 页）：粗可达与地区线索。 */
export async function checkYoutubeUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  return withFailRetry(async () => {
    const line = await probeYoutubeLine(mixedPort);
    return serviceCardFromLine("youtube", "YouTube Premium", line, STREAM_TIP, mixedPort);
  });
}

/** App Store 单独卡：粗可达与地区路径线索。 */
export async function checkAppStoreUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  return withFailRetry(async () => {
    const line = await probeAppleStoreLine(mixedPort);
    return serviceCardFromLine(
      "app-store",
      "App Store",
      line,
      STORE_TIP,
      mixedPort,
    );
  });
}

/** Google Play 单独卡：粗可达与地区线索。 */
export async function checkGooglePlayUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  return withFailRetry(async () => {
    const line = await probeGooglePlayLine(mixedPort);
    return serviceCardFromLine(
      "google-play",
      "Google Play",
      line,
      STORE_TIP,
      mixedPort,
    );
  });
}


function timeoutCard(
  id: string,
  title: string,
): CheckCard {
  return {
    id,
    title,
    level: "unknown",
    conclusion: "超时未响应",
    process: "探测超时或卡住，已按截止时间结束本项。",
    suggestion: undefined,
  };
}

async function withCardDeadline(
  title: string,
  id: string,
  work: () => Promise<CheckCard>,
  deadlineMs: number,
): Promise<CheckCard> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<CheckCard>((resolve) => {
        timer = setTimeout(() => resolve(timeoutCard(id, title)), deadlineMs);
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id,
      title,
      level: "unknown",
      conclusion: "未能判定",
      process: msg,
      suggestion: undefined,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function runEgressDiagnostics(
  onCard?: (card: CheckCard) => void,
  options?: {
    mixedPort?: number | null;
    mihomoConfig?: ControllerConfig | null;
  },
): Promise<EgressReport> {
  const mixedPort = options?.mixedPort ?? null;
  const mihomoConfig = options?.mihomoConfig ?? null;
  const note =
    mixedPort != null && mixedPort > 0
      ? "探针优先经代理口发出。结果用来换节点时对照线路，不是替代你自己打开网站。请确保代理软件已连接。"
      : "部分探针可能走窗口直连。建议先「刷新连接」并开启系统代理或 TUN。结果用于换节点对照。";

  const push = (c: CheckCard) => {
    onCard?.(c);
    return c;
  };

  // Fast path first so the UI starts settling quickly.
  const reach = push(
    await withCardDeadline("连通性", "reachability", () => checkReachability(mixedPort), 14000),
  );

  let exit = await Promise.race([
    fetchExitIp(mixedPort),
    new Promise<ExitIpInfo>((resolve) =>
      setTimeout(
        () =>
          resolve({
            ip: null,
            country: null,
            countryCode: null,
            org: null,
            isp: null,
            hosting: null,
            ipTypeLabel: "--",
          }),
        5000,
      ),
    ),
  ]);
  const exitCard = push(exitIpCard(exit));

  type Job = {
    id: string;
    title: string;
    deadlineMs: number;
    run: () => Promise<CheckCard>;
    after?: (card: CheckCard) => void;
  };

  let gemini: UnlockResult = {
    supported: false,
    level: "unknown",
    region: null,
    status: "未完成",
  };
  let chatgpt: UnlockResult = {
    supported: false,
    level: "unknown",
    region: null,
    status: "未完成",
  };
  let latencyMs: number | null = null;

  const jobs: Job[] = [
    {
      id: "dns-leak",
      title: "DNS 解析器",
      deadlineMs: 12000,
      run: () => checkDnsResolvers(exit, mixedPort),
    },
    {
      id: "ipv6-leak",
      title: "IPv6 泄漏",
      deadlineMs: 12000,
      run: () => checkIpv6Leak(mixedPort),
    },
    {
      id: "webrtc",
      title: "WebRTC",
      deadlineMs: 6000,
      run: () => checkWebRtcLeak(),
    },
    {
      id: "gemini",
      title: "Gemini（换节点对照）",
      deadlineMs: 16000,
      run: async () => {
        gemini = await withFailRetryUnlock(() => probeGeminiUnlock(mixedPort));
        return unlockCard("gemini", "Gemini（换节点对照）", gemini);
      },
    },
    {
      id: "chatgpt",
      title: "ChatGPT（换节点对照）",
      deadlineMs: 22000,
      run: async () => {
        chatgpt = await withFailRetryUnlock(() => probeChatgptUnlock(mixedPort));
        return unlockCard("chatgpt", "ChatGPT（换节点对照）", chatgpt);
      },
    },
    {
      id: "latency",
      title: "延迟采样",
      deadlineMs: 22000,
      run: async () => {
        const { ms, card } = await sampleLatency(mixedPort);
        latencyMs = ms;
        return card;
      },
    },
    {
      id: "bandwidth",
      title: "抽样带宽",
      deadlineMs: 42000,
      run: () => sampleBandwidth(mixedPort, { mode: "full" }),
    },
    {
      id: "split-routing",
      title: "分流检查",
      deadlineMs: 22000,
      run: () => checkSplitRouting(mixedPort, mihomoConfig),
    },
    {
      id: "bare-egress",
      title: "直连旁路检查",
      deadlineMs: 14000,
      run: () => checkBareEgress(mixedPort),
    },
    {
      id: "netflix",
      title: "Netflix",
      deadlineMs: 16000,
      run: () => checkNetflixUnlock(mixedPort),
    },
    {
      id: "disney",
      title: "Disney+",
      deadlineMs: 16000,
      run: () => checkDisneyUnlock(mixedPort),
    },
    {
      id: "youtube",
      title: "YouTube Premium",
      deadlineMs: 16000,
      run: () => checkYoutubeUnlock(mixedPort),
    },
    {
      id: "app-store",
      title: "App Store",
      deadlineMs: 16000,
      run: () => checkAppStoreUnlock(mixedPort),
    },
    {
      id: "google-play",
      title: "Google Play",
      deadlineMs: 16000,
      run: () => checkGooglePlayUnlock(mixedPort),
    },
  ];

  const settled = await mapPool(jobs, 3, async (job) => {
    const card = await withCardDeadline(job.title, job.id, job.run, job.deadlineMs);
    return push(card);
  });

  const byId = new Map(settled.map((c) => [c.id, c]));
  const order = [
    "reachability",
    "dns-leak",
    "ipv6-leak",
    "webrtc",
    "exit-ip",
    "gemini",
    "chatgpt",
    "latency",
    "bandwidth",
    "split-routing",
    "bare-egress",
    "netflix",
    "disney",
    "youtube",
    "app-store",
    "google-play",
  ];
  const cards = order.map((id) => {
    if (id === "reachability") return reach;
    if (id === "exit-ip") return exitCard;
    return byId.get(id) ?? timeoutCard(id, id);
  });

  return {
    ranAt: new Date().toISOString(),
    cards,
    exitIp: exit,
    gemini,
    chatgpt,
    latencyMs,
    note,
  };
}
