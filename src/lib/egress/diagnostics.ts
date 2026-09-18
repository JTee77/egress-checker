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
import { fetchTextViaProxy, listDnsResolvers, timedTransferViaProxy } from "./fetchVia";
import { getRulesSummary } from "../mihomo/client";
import type { ControllerConfig } from "../mihomo/types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const PROBE_TIMEOUT_MS = 9000;

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
async function probeText(
  url: string,
  opts: {
    mixedPort?: number | null;
    timeoutMs?: number;
    userAgent?: string;
    method?: string;
  } = {},
): Promise<{ ok: boolean; status: number; text: string }> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const mixedPort = opts.mixedPort ?? null;

  if (mixedPort != null && mixedPort > 0) {
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
      };
    }
  }

  // Secondary: browser fetch (may not follow system proxy in Tauri WebView)
  return fetchTextBrowser(url, {
    method: opts.method ?? "GET",
    timeoutMs,
    headers: opts.userAgent ? { "User-Agent": opts.userAgent } : undefined,
  });
}

function isReachableStatus(status: number, ok: boolean): boolean {
  return status === 204 || status === 200 || (ok && status >= 200 && status < 400);
}

export async function checkReachability(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const targets = [
    "https://www.google.com/generate_204",
    "https://cp.cloudflare.com/generate_204",
  ];
  // Sequential probes to avoid slamming the Rust spawn_blocking pool.
  const results: { url: string; ok: boolean; status: number; text: string; ms: number }[] = [];
  for (const url of targets) {
    const t0 = performance.now();
    const r = await probeText(url, {
      mixedPort,
      timeoutMs: PROBE_TIMEOUT_MS,
      method: "GET",
    });
    results.push({ url, ...r, ms: Math.round(performance.now() - t0) });
  }
  const ok = results.filter((r) => isReachableStatus(r.status, r.ok));
  if (ok.length === 0) {
    return {
      id: "reachability",
      title: "连通性",
      level: "fail",
      conclusion: "无法访问境外 HTTPS 探测点",
      process: results.map((r) => `${r.url} → HTTP ${r.status || "超时"}`).join("\n"),
      suggestion: "请确认 Clash Verge Rev 已连接，且系统代理 / TUN 已开启；并检查设置中的 mixed-port。",
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
    suggestion: "能通只说明代理路径大致可用，不代表所有网站都正常。",
  };
}

export async function fetchExitIp(
  mixedPort?: number | null,
): Promise<ExitIpInfo> {
  // ip-api.com fields aligned with Python reference
  const r = await fetchTextViaProxy(
    "http://ip-api.com/json?fields=status,message,country,countryCode,isp,org,as,hosting,query",
    { mixedPort: mixedPort ?? null, timeoutMs: 4000 },
  );
  if (!r.ok || !r.text) {
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
  try {
    const data = JSON.parse(r.text) as {
      status?: string;
      query?: string;
      country?: string;
      countryCode?: string;
      isp?: string;
      org?: string;
      hosting?: boolean;
    };
    if (data.status !== "success") {
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
    const hosting = !!data.hosting;
    return {
      ip: data.query ?? null,
      country: data.country ?? null,
      countryCode: data.countryCode ?? null,
      org: data.org ?? data.isp ?? null,
      isp: data.isp ?? null,
      hosting,
      ipTypeLabel: hosting ? "机房(DCH)" : "住宅(ISP)",
    };
  } catch {
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
  return {
    id: "exit-ip",
    title: "出口 IP",
    level,
    conclusion: `${info.ip} · ${info.countryCode ?? "?"} · ${info.ipTypeLabel}`,
    process: `组织 ${info.org ?? "--"} · ISP ${info.isp ?? "--"} · 国家 ${info.country ?? "--"}`,
    suggestion: info.hosting
      ? "机房 IP 可能导致部分 AI / 流媒体风控；可尝试住宅/家宽节点。"
      : undefined,
  };
}

/**
 * A1: True DNS resolvers via macOS `scutil --dns` (Rust).
 * Keep Cloudflare country-match heuristic as secondary detail only.
 */
export async function checkDnsResolvers(
  exit: ExitIpInfo,
  mixedPort?: number | null,
): Promise<CheckCard> {
  const dns = await listDnsResolvers();
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

  if (dns.error && resolvers.length === 0) {
    return {
      id: "dns-leak",
      title: "DNS 解析器",
      level: "unknown",
      conclusion: `系统解析器读取失败：${dns.error}`,
      process: [
        `source: ${dns.source}`,
        dns.rawHint ? `raw_hint:\n${dns.rawHint}` : "",
        heuristicLine,
        "边界：本项列出本机 resolver；不等于 BrowserLeaks 级「完整 DNS 泄漏证明」。",
      ]
        .filter(Boolean)
        .join("\n"),
      suggestion: "仅 macOS 支持 scutil --dns。可对照 Wi-Fi DNS / 隧道内 DNS（如 1.1.1.1）。",
    };
  }

  const preview = resolvers.slice(0, 4).join(", ");
  const more = resolvers.length > 4 ? ` 等 ${resolvers.length} 个` : "";
  const conclusion =
    resolvers.length === 0
      ? "系统解析器 0 个（未解析到 nameserver）"
      : `系统解析器 ${resolvers.length} 个：${preview}${more}`;

  return {
    id: "dns-leak",
    title: "DNS 解析器",
    level: resolvers.length > 0 ? "pass" : "warn",
    conclusion,
    process: [
      `resolvers: ${resolvers.join(", ") || "(无)"}`,
      `source: ${dns.source}`,
      dns.error ? `note: ${dns.error}` : "",
      dns.rawHint ? `raw_hint:\n${dns.rawHint}` : "",
      heuristicLine,
      "边界：优先展示隧道/VPN 相关 scoped resolver（若有）；否则全部去重 nameserver。不是完整泄漏鉴定。",
    ]
      .filter(Boolean)
      .join("\n"),
    suggestion: "若解析器仍是运营商 DNS，可把 Wi-Fi DNS 改到隧道可达的 1.1.1.1 / 8.8.8.8，并确认流量走代理。",
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
 * A2: IPv6 leak / reachability — direct vs mixed-port proxied.
 * Not a full OS stack audit; honest about timeouts and dual-stack proxies.
 */
export async function checkIpv6Leak(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const urls = [
    "https://api64.ipify.org",
    "https://ipv6.icanhazip.com",
  ];
  const timeoutMs = 4500;

  async function probeOne(
    url: string,
    port: number | null,
  ): Promise<{ url: string; ip: string | null; ok: boolean; status: number; note: string }> {
    const r = await fetchTextViaProxy(url, {
      mixedPort: port,
      timeoutMs,
    });
    const raw = extractIpBody(r.text);
    if (r.ok && raw && isIpv6Literal(raw)) {
      return { url, ip: raw, ok: true, status: r.status, note: "ipv6" };
    }
    if (r.ok && raw && !isIpv6Literal(raw)) {
      return {
        url,
        ip: raw,
        ok: false,
        status: r.status,
        note: "返回了非 IPv6（可能是 IPv4 / 双栈回落）",
      };
    }
    return {
      url,
      ip: null,
      ok: false,
      status: r.status,
      note: r.status ? `HTTP ${r.status}` : "超时或不可达",
    };
  }

  // Direct: explicitly NO proxy
  const directResults = [];
  for (const url of urls) {
    directResults.push(await probeOne(url, null));
    if (directResults[directResults.length - 1].ok) break;
  }
  const directV6 = directResults.find((x) => x.ok)?.ip ?? null;

  const expectProxy = mixedPort != null && mixedPort > 0;
  let proxiedResults: typeof directResults = [];
  let proxiedV6: string | null = null;
  if (expectProxy) {
    for (const url of urls) {
      proxiedResults.push(await probeOne(url, mixedPort));
      if (proxiedResults[proxiedResults.length - 1].ok) break;
    }
    proxiedV6 = proxiedResults.find((x) => x.ok)?.ip ?? null;
  }

  const lines: string[] = [
    `直连 IPv6: ${directV6 ?? "无 / 不可达"}`,
    expectProxy
      ? `经 mixed-port(${mixedPort}) IPv6: ${proxiedV6 ?? "无 / 不可达"}`
      : "未配置 mixed-port，跳过代理侧 IPv6 对照",
    "探测 URL：" + urls.join(" · "),
    ...directResults.map(
      (r) => `直连 ${r.url} → ${r.ip ?? r.note} (HTTP ${r.status || 0})`,
    ),
    ...proxiedResults.map(
      (r) => `代理 ${r.url} → ${r.ip ?? r.note} (HTTP ${r.status || 0})`,
    ),
    "边界：短超时；部分节点无 IPv6；api64 在仅 IPv4 时可能回落 IPv4（已识别）。不能证明内核/应用全部 IPv6 路径。",
  ];

  if (!directV6 && !proxiedV6) {
    return {
      id: "ipv6-leak",
      title: "IPv6 泄漏",
      level: "pass",
      conclusion: "本机当前探测不到可用 IPv6 出口（直连与代理均无）",
      process: lines.join("\n"),
      suggestion: "无 IPv6 时通常不构成 IPv6 泄漏面；若你刻意开了 IPv6，请检查系统网络与节点是否支持。",
    };
  }

  if (expectProxy && directV6) {
    if (!proxiedV6) {
      return {
        id: "ipv6-leak",
        title: "IPv6 泄漏",
        level: "fail",
        conclusion: `直连能拿到 IPv6（${directV6}），代理侧没有 — 可能绕过代理`,
        process: lines.join("\n"),
        suggestion: "若期望全局走代理：检查 Clash 的 IPv6 / TUN / 系统代理，或暂时关闭系统 IPv6。",
      };
    }
    if (proxiedV6 !== directV6) {
      return {
        id: "ipv6-leak",
        title: "IPv6 泄漏",
        level: "warn",
        conclusion: `直连 ${directV6} 与代理 ${proxiedV6} 不一致 — 存在独立直连 IPv6 面`,
        process: lines.join("\n"),
        suggestion: "代理期望生效时，直连仍能出 IPv6 可能泄漏真实网络身份。可关 IPv6 或强制 TUN。",
      };
    }
    // same address both paths — unusual but report honestly
    return {
      id: "ipv6-leak",
      title: "IPv6 泄漏",
      level: "warn",
      conclusion: `直连与代理看到相同 IPv6（${directV6}）— 请人工确认是否真经代理`,
      process: lines.join("\n"),
      suggestion: "相同地址不一定等于泄漏，也可能是代理出口与本机碰巧一致；请结合出口 IP 卡核对。",
    };
  }

  if (expectProxy && !directV6 && proxiedV6) {
    return {
      id: "ipv6-leak",
      title: "IPv6 泄漏",
      level: "pass",
      conclusion: `仅代理侧有 IPv6（${proxiedV6}），直连无 — 未见直连旁路`,
      process: lines.join("\n"),
      suggestion: "说明当前探测下 IPv6 更像走 mixed-port；仍非内核级证明。",
    };
  }

  // No mixed-port configured but direct IPv6 exists
  return {
    id: "ipv6-leak",
    title: "IPv6 泄漏",
    level: "unknown",
    conclusion: directV6
      ? `直连 IPv6 可达（${directV6}）；未配置 mixed-port，无法对照代理`
      : "IPv6 状态不明",
    process: lines.join("\n"),
    suggestion: "在设置中填写 mixed-port 后再测，才能判断是否存在「直连 IPv6 旁路」。",
  };
}

function isPrivateOrLocalIp(ip: string): boolean {
  const t = ip.trim().toLowerCase();
  if (t === "::1" || t === "0.0.0.0") return true;
  if (t.startsWith("fe80:")) return true; // link-local
  if (t.startsWith("fc") || t.startsWith("fd")) return true; // ULA rough
  const m = t.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

type IceCand = {
  type: string;
  address: string;
  protocol: string;
  raw: string;
  scope: "private" | "public" | "unknown";
};

/**
 * A3: Browser STUN gather — host / srflx / relay. Not full leak proof.
 */
export async function checkWebRtcLeak(): Promise<CheckCard> {
  const RTCPeer =
    typeof window !== "undefined"
      ? (window as unknown as { RTCPeerConnection?: typeof RTCPeerConnection })
          .RTCPeerConnection
      : undefined;

  if (!RTCPeer) {
    return {
      id: "webrtc",
      title: "WebRTC",
      level: "unknown",
      conclusion: "当前 WebView 无 RTCPeerConnection，无法收集 ICE 候选",
      process:
        "嵌入式 WebView 可能禁用 WebRTC。这不等于「无泄漏」，只是本环境测不了。\n测了什么：无（API 缺失）。\n没测：完整 BrowserLeaks / 系统级 WebRTC 策略。",
      suggestion: "可在系统浏览器打开 chrome://webrtc-internals 或 BrowserLeaks 复核；或在代理客户端关闭 WebRTC 泄露防护对照。",
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
        const scope = isPrivateOrLocalIp(address)
          ? "private"
          : address.includes(".") || address.includes(":")
            ? "public"
            : "unknown";
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

  if (failMsg) {
    return {
      id: "webrtc",
      title: "WebRTC",
      level: "warn",
      conclusion: `本次未能收集 WebRTC 候选：${failMsg}`,
      process:
        "WebView 可能限制 WebRTC。失败≠无泄漏。\n边界：仅做短时 STUN 候选收集，不是完整泄漏证明。",
      suggestion: "若持续失败，以系统浏览器复核为准。",
    };
  }

  const uniq = new Map<string, IceCand>();
  for (const c of candidates) {
    const key = `${c.type}|${c.address}|${c.protocol}`;
    if (!uniq.has(key)) uniq.set(key, c);
  }
  const list = [...uniq.values()];
  const host = list.filter((c) => c.type === "host");
  const srflx = list.filter((c) => c.type === "srflx");
  const relay = list.filter((c) => c.type === "relay");
  const publicHost = host.filter((c) => c.scope === "public");
  const publicSrflx = srflx.filter((c) => c.scope === "public");

  const conclusionParts = [
    `候选 ${list.length}`,
    `host ${host.length}`,
    `srflx ${srflx.length}`,
    `relay ${relay.length}`,
  ];

  let level: CheckLevel = "pass";
  let conclusion = `已收集到 WebRTC 候选：${conclusionParts.join(" · ")}`;
  if (list.length === 0) {
    level = "unknown";
    conclusion = "未收集到 ICE 候选（可能被策略拦截或网络限制）";
  } else if (publicHost.length > 0) {
    level = "warn";
    conclusion = `发现公网 host 候选（${publicHost.map((c) => c.address).join(", ")}）— 可能暴露地址`;
  } else if (publicSrflx.length > 0) {
    level = "warn";
    conclusion = `发现 srflx 公网反射地址（${publicSrflx.map((c) => c.address).slice(0, 2).join(", ")}）`;
  }

  const detailLines = [
    ...list.map(
      (c) =>
        `${c.type} ${c.scope} ${c.protocol} ${c.address}`,
    ),
    "测了什么：浏览器 RTCPeerConnection + Google STUN，约 2.8s 收集。",
    "没测：完整泄漏矩阵、mdns 隐藏策略细节、非 WebView 进程。",
    "边界：有候选≠一定泄漏到目标站点；无候选≠一定安全。勿当作完整泄漏证明。",
  ];

  return {
    id: "webrtc",
    title: "WebRTC",
    level,
    conclusion,
    process: detailLines.join("\n"),
    suggestion: "若在意暴露：在浏览器/系统关闭 WebRTC，或仅允许代理路径；并到系统浏览器复核。",
  };
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
    timeoutMs: 6000,
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
    "网页路径：gemini.google.com/app（看页面是否地区拦截、内容是否正常返回）",
  ];
  const notProbed = [
    "Google 官方手机 App",
    "Mac 桌面客户端（本版未单独检测）",
  ];

  if (blocked) {
    return {
      supported: false,
      level: "blocked",
      region: "BLOCKED",
      status: "网页：不可用（地区限制）",
      lines: [
        "网页：不可用",
        "手机 App：未测",
        "Mac 桌面版：本版未单独检测",
      ],
      probed,
      notProbed,
    };
  }
  if (out.length > 50000) {
    const tag = detectedCountry ?? "可用";
    return {
      supported: true,
      level: "full",
      region: detectedCountry ?? "OK",
      status: `网页：可用（${tag}）`,
      lines: [
        "网页：可用",
        "手机 App：未测",
        "Mac 桌面版：本版未单独检测",
      ],
      probed,
      notProbed,
    };
  }
  if (!r.ok && !out) {
    return {
      supported: false,
      level: "unknown",
      region: null,
      status: "网页：这次没测成（超时）",
      lines: [
        "网页：未测成",
        "手机 App：未测",
        "Mac 桌面版：本版未单独检测",
      ],
      probed,
      notProbed,
    };
  }
  return {
    supported: false,
    level: "blocked",
    region: null,
    status: "网页：不可用或打不开",
    lines: [
      "网页：不可用",
      "手机 App：未测",
      "Mac 桌面版：本版未单独检测",
    ],
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

  let appOk = false;
  const app = await fetchTextViaProxy("https://ios.chat.openai.com/", {
    mixedPort: mixedPort ?? null,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
    timeoutMs: 3500,
  });
  if (app.status && app.status !== 403 && app.status !== 0) {
    const body = app.text;
    if (
      !body.includes("Request is not allowed") &&
      !(body.includes("VPN") && body.includes("dc"))
    ) {
      appOk = true;
    }
  } else if (app.ok) {
    appOk = true;
  }

  const locTag = loc ?? "未知地区";
  const probed = [
    "网页相关：chatgpt.com/cdn-cgi/trace、OpenAI compliance 接口（必要时再看 chatgpt.com 首页）",
    "手机 App 相关：ios.chat.openai.com（粗检，不等于你手机上的真实 App 体验）",
  ];
  const notProbed = [
    "Mac 官方桌面版 ChatGPT（本版未单独检测）",
    "你浏览器里已经登录后的完整网页体验",
  ];

  if (!webOk && !appOk) {
    return {
      supported: false,
      level: "blocked",
      region: loc,
      status: `网页：不可用 · 手机 App：可能不行（${locTag}）`,
      lines: [
        "网页：不可用",
        "手机 App：可能不行",
        "Mac 桌面版：本版未单独检测",
      ],
      probed,
      notProbed,
    };
  }
  if (webOk && !appOk) {
    return {
      supported: true,
      level: "web_only",
      region: loc,
      status: `网页：可用 · 手机 App：可能不行（${locTag}）`,
      lines: [
        "网页：可用",
        "手机 App：可能不行",
        "Mac 桌面版：本版未单独检测",
      ],
      probed,
      notProbed,
    };
  }
  if (!webOk && appOk) {
    return {
      supported: true,
      level: "app_only",
      region: loc,
      status: `网页：不可用 · 手机 App：可用（粗检，${locTag}）`,
      lines: [
        "网页：不可用",
        "手机 App：可用（粗检）",
        "Mac 桌面版：本版未单独检测",
      ],
      probed,
      notProbed,
    };
  }
  return {
    supported: true,
    level: "full",
    region: loc,
    status: `网页：可用 · 手机 App：可用（粗检，${locTag}）`,
    lines: [
      "网页：可用",
      "手机 App：可用（粗检）",
      "Mac 桌面版：本版未单独检测",
    ],
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
    "换节点时一次对照用，不能替代你自己打开网站或 App。",
  ].filter(Boolean);

  return {
    id,
    title,
    level,
    conclusion: result.status,
    process: processParts.join("\n"),
    suggestion: "主要用 Mac 桌面版时，桌面项会写「未单独检测」——以官方客户端实际体验为准。",
  };
}

export async function sampleLatency(
  mixedPort?: number | null,
): Promise<{ ms: number | null; card: CheckCard }> {
  const url = "https://www.gstatic.com/generate_204";
  const t0 = performance.now();
  const r = await probeText(url, {
    mixedPort,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const reachable = isReachableStatus(r.status, r.ok);
  const ms = reachable || r.status ? Math.round(performance.now() - t0) : null;
  if (ms == null || !reachable) {
    return {
      ms: null,
      card: {
        id: "latency",
        title: "延迟采样",
        level: "fail",
        conclusion: "采样失败",
        process: `目标: ${url} → HTTP ${r.status || "超时"}`,
        suggestion: "请确认 mixed-port 与系统代理 / TUN 可用。",
      },
    };
  }
  const level: CheckLevel = ms < 200 ? "pass" : ms < 500 ? "warn" : "fail";
  return {
    ms,
    card: {
      id: "latency",
      title: "延迟采样",
      level,
      conclusion: `大约 ${ms} ms（轻量探测）`,
      process: `目标: ${url}`,
      suggestion: "这是单次轻量 HTTPS 抽样，不是面板延迟，也不是网页打开速度。",
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
  const timeoutMs = 5500;

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
    "边界：这是「分流抽检」不是完整规则审计；结果随节点与规则集变化。",
  ]
    .filter(Boolean)
    .join("\n");

  if (!expectProxy) {
    return {
      id: "split-routing",
      title: "分流抽检",
      level: cnDirectOk > 0 ? "unknown" : "fail",
      conclusion: cnDirectOk > 0
        ? "仅完成直连国内基线；未配置 mixed-port，无法判断分流"
        : "国内直连基线失败，且未配置 mixed-port",
      process,
      suggestion: "在设置中填写 mixed-port 并确保 Clash 已连接后重测，才能对照「国内 DIRECT / 境外走代理」。",
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
    title: "分流抽检",
    level,
    conclusion,
    process,
    suggestion: "期望常见配置下国内偏 DIRECT、境外走代理。本卡只抽检少数域名，不能证明整份规则无误。",
  };
}

/**
 * B6: 断线裸奔粗检 — mixed-port fail + direct foreign OK → 可能裸奔.
 */
export async function checkBareEgress(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const port = mixedPort ?? null;
  const expectProxy = port != null && port > 0;
  const timeoutMs = 6000;
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
    "边界：本应用无法单独从进程内完整获知 Clash TUN 内核状态；「裸奔」仅为粗检告警。",
  ];

  if (!expectProxy) {
    return {
      id: "bare-egress",
      title: "裸奔粗检",
      level: "unknown",
      conclusion: directOk
        ? "直连境外可达；未配置 mixed-port，无法判断是否裸奔"
        : "直连境外不可达；未配置 mixed-port",
      process: lines.join("\n"),
      suggestion: "填写 mixed-port 后重测：若代理路径失败而直连境外仍通，会提示「可能裸奔」。",
    };
  }

  let level: CheckLevel;
  let conclusion: string;
  if (!mixedOk && directOk) {
    level = "warn";
    conclusion = "可能裸奔：mixed-port 失败但直连境外仍通";
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
    title: "裸奔粗检",
    level,
    conclusion,
    process: lines.join("\n"),
    suggestion: "若提示可能裸奔：检查 Clash 是否断连、mixed-port/TUN/系统代理是否关掉；本卡不能替代系统级抓包。",
  };
}

/** A4: sample up/down Mbps through current egress (mixed-port preferred). */
const BW_DOWN_URL = "https://speed.cloudflare.com/__down?bytes=524288";
const BW_DOWN_EXPECT = 524288;
const BW_UP_URL = "https://speed.cloudflare.com/__up";
const BW_UP_BYTES = 512 * 1024;
const BW_TIMEOUT_MS = 20000;

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

export async function sampleBandwidth(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const down = await timedTransferViaProxy({
    url: BW_DOWN_URL,
    mixedPort: mixedPort ?? null,
    method: "GET",
    timeoutMs: BW_TIMEOUT_MS,
  });
  const up = await timedTransferViaProxy({
    url: BW_UP_URL,
    mixedPort: mixedPort ?? null,
    method: "POST",
    uploadBytes: BW_UP_BYTES,
    timeoutMs: BW_TIMEOUT_MS,
  });

  const downMbps =
    down.bytes > 0 && down.elapsedMs > 0
      ? bytesToMbps(down.bytes, down.elapsedMs)
      : null;
  const upMbps = up.ok ? bytesToMbps(up.bytes, up.elapsedMs) : null;
  const downPartial =
    !!down.error && down.bytes > 0 && downMbps != null;

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

  const process = [
    `下载：GET ${BW_DOWN_URL}`,
    `  期望约 ${BW_DOWN_EXPECT} B · 实际 ${down.bytes} B · ${down.elapsedMs} ms · via ${down.via}` +
      (downMbps != null ? ` · ${fmtMbps(downMbps)} Mbps` : "") +
      (downErr ? ` · ${downErr}` : ""),
    `上传：POST ${BW_UP_URL}（Content-Type: application/octet-stream，${BW_UP_BYTES} B 零填充）`,
    `  发送 ${up.bytes} B · ${up.elapsedMs} ms · via ${up.via}` +
      (upMbps != null ? ` · ${fmtMbps(upMbps)} Mbps` : "") +
      (upErr ? ` · ${upErr}` : ""),
    `路径：${portNote}；超时 ${BW_TIMEOUT_MS} ms。`,
    "说明：抽样带宽 ≠ 全网测速 / 不等于节点面板延迟。",
    "端点：Cloudflare Speed（__down 512KiB / __up 512KiB）。请求 Accept-Encoding: identity，按字节流计数（避免经代理 gzip 解码失败）。未用 httpbin。",
  ].join("\n");

  const conclusion =
    level === "fail"
      ? `抽样失败（↓ ${downErr ?? "失败"} · ↑ ${upErr ?? "失败"}）`
      : conclusionParts.join(" · ");

  return {
    id: "bandwidth",
    title: "抽样带宽",
    level,
    conclusion,
    process,
    suggestion: "结果随节点与负载波动较大，仅适合换节点时粗对比；勿当作全网测速或面板延迟。",
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
  const timeoutMs = 5500;
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
      conclusion: "探测超时或不可达",
      process: `${url} → 超时/无响应（${ms}ms）。短超时粗检；失败≠节点一定不可用。`,
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
      conclusion: "当前节点下 Netflix 标题页疑似被墙或地区拦截。",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n信号：NSEZ-403 / 403 / 地区拦截文案。\n边界：粗检 ≠ 会员权益/片库/画质。`,
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
      conclusion: "标题页能打开，但内容异常（可能仅自制剧）。",
      process: `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B\n信号：Oh no! / page-404 / 404。\n边界：粗检 ≠ 完整片库解锁。`,
    };
  }

  if (reachable) {
    return {
      name: "Netflix",
      level: region ? "pass" : "warn",
      conclusion: region
        ? `标题页可达。地区线索：${region}。`
        : "标题页可达。地区线索未解析。",
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
    conclusion: "这次没测清楚（页面响应异常）。",
    process: `${url} → HTTP ${r.status || "超时"} · ${ms}ms · body≈${body.length}B。探针偏抖时标 unknown。`,
  };
}

async function probeDisneyLine(
  mixedPort?: number | null,
): Promise<ProbeLine> {
  const url = "https://www.disneyplus.com/";
  const timeoutMs = 5500;
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
      conclusion: "探测超时或不可达",
      process: `${url} → 超时/无响应（${ms}ms）。未跑 bamgrid 多步注册（本版仅 GET 粗检）。`,
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
      conclusion: "当前节点下 Disney+ 疑似不可用或被地区限制。",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n信号：unavailable / not available / 403。\n边界：粗检 ≠ 会员登录与片库。`,
    };
  }

  const reachable =
    isReachableStatus(r.status, r.ok) ||
    (r.status >= 200 && r.status < 400 && body.length > 400);

  if (reachable) {
    return {
      name: "Disney+",
      level: "pass",
      conclusion: region
        ? `首页可达。地区线索：${region}。`
        : `首页可达（HTTP ${r.status}）。`,
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
    conclusion: "这次没测清楚（页面响应异常）。",
    process: `${url} → HTTP ${r.status || "超时"} · ${ms}ms · body≈${body.length}B`,
  };
}

async function probeYoutubeLine(
  mixedPort?: number | null,
): Promise<ProbeLine> {
  const url = "https://www.youtube.com/premium";
  const timeoutMs = 5500;
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
      conclusion: "探测超时或不可达",
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
      conclusion: `疑似墙：Premium 页提示地区不可用${country ? `（${country}）` : ""}。`,
      process: `${url} → HTTP ${r.status} · ${ms}ms\n信号：not available in your country。\n边界：粗检 ≠ Premium 订阅/全家共享/画质。`,
    };
  }

  const reachable =
    isReachableStatus(r.status, r.ok) ||
    (r.status >= 200 && r.status < 400 && body.length > 800);

  if (reachable && premiumSignal) {
    return {
      name: "YouTube",
      level: "pass",
      conclusion: country
        ? `Premium 页可达。地区线索：${country}。`
        : "Premium 页可达（粗检）。",
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
      conclusion: "页面能打开，但 Premium 相关信号偏弱。",
      process: `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B。可能被改版/重定向稀释信号。`,
    };
  }

  return {
    name: "YouTube",
    level: "unknown",
    conclusion: "这次没测清楚（页面响应异常）。",
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
  const timeoutMs = 5000;
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
      conclusion: "探测超时或不可达",
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
      conclusion: "当前节点下商店页疑似不可用或被地区限制。",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n边界：不是下载、支付、上架审核。`,
    };
  }

  if (reachable) {
    return {
      name: "App Store",
      level: "pass",
      conclusion: sf
        ? `网页店面可达。地区线索：${sf}。`
        : `网页店面可达（HTTP ${r.status}）。`,
      process: [
        `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B`,
        sf
          ? `storefront / 国家路径线索：${sf}`
          : "未解析到 /xx/ storefront 路径（跟随重定向后仍可能已是默认区）。",
        "测了什么：apps.apple.com 网页是否打开、是否有粗地区路径。",
        "没测：App 下载、内购支付、开发者上架审核、账号区。",
      ].join("\n"),
    };
  }

  return {
    name: "App Store",
    level: "unknown",
    conclusion: "这次没测清楚（页面响应异常）。",
    process: `${url} → HTTP ${r.status || "超时"} · ${ms}ms · body≈${body.length}B`,
  };
}

async function probeGooglePlayLine(
  mixedPort?: number | null,
): Promise<ProbeLine> {
  const url = "https://play.google.com/store/games";
  const timeoutMs = 5000;
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
      conclusion: "探测超时或不可达",
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
      conclusion: "当前节点下商店页疑似不可用或被地区限制。",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n边界：不是下载、支付、上架审核。`,
    };
  }

  if (reachable) {
    return {
      name: "Google Play",
      level: "pass",
      conclusion: gl
        ? `网页商店可达。地区线索：${gl}。`
        : `网页商店可达（HTTP ${r.status}）。`,
      process: [
        `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B`,
        gl ? `gl 线索：${gl}` : "未解析到 gl 参数（页仍可达）。",
        "测了什么：play.google.com 网页是否打开。",
        "没测：APK 下载、付款、Play 账号区、上架审核。",
      ].join("\n"),
    };
  }

  return {
    name: "Google Play",
    level: "unknown",
    conclusion: "这次没测清楚（页面响应异常）。",
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
  return {
    id,
    title,
    level: line.level,
    conclusion: line.conclusion,
    process: [line.process, mixedPortPathNote(mixedPort)].join("\n"),
    suggestion,
  };
}

const STREAM_TIP =
  "粗检 ≠ 会员权益 / 片库 / 画质 / 账号可用性。换节点对照用。";
const STORE_TIP =
  "粗检 ≠ 下载、支付、上架审核。换节点对照用。";

/** Netflix 单独卡：标题页粗可达与地区线索。 */
export async function checkNetflixUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const line = await probeNetflixLine(mixedPort);
  return serviceCardFromLine("netflix", "Netflix", line, STREAM_TIP, mixedPort);
}

/** Disney+ 单独卡：首页粗可达与地区线索。 */
export async function checkDisneyUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const line = await probeDisneyLine(mixedPort);
  return serviceCardFromLine("disney", "Disney+", line, STREAM_TIP, mixedPort);
}

/** YouTube 单独卡（探测仍用 Premium 页）：粗可达与地区线索。 */
export async function checkYoutubeUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const line = await probeYoutubeLine(mixedPort);
  return serviceCardFromLine("youtube", "YouTube", line, STREAM_TIP, mixedPort);
}

/** App Store 单独卡：网页店面粗可达与地区路径线索。 */
export async function checkAppStoreUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const line = await probeAppleStoreLine(mixedPort);
  return serviceCardFromLine(
    "app-store",
    "App Store",
    line,
    STORE_TIP,
    mixedPort,
  );
}

/** Google Play 单独卡：网页店面粗可达与地区线索。 */
export async function checkGooglePlayUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const line = await probeGooglePlayLine(mixedPort);
  return serviceCardFromLine(
    "google-play",
    "Google Play",
    line,
    STORE_TIP,
    mixedPort,
  );
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
      ? `探针优先经 mixed-port（${mixedPort}）发出。结果用来换节点时对照线路，不是替代你自己打开 chatgpt.com / Gemini。请确保 Clash Verge Rev 已连接。`
      : "未配置 mixed-port 时部分探针可能走窗口直连。建议在设置里填写 mixed-port，并开启系统代理或 TUN。结果用于换节点对照，不是「必须测完才能上网」。";

  const push = (c: CheckCard) => {
    onCard?.(c);
    return c;
  };

  const reach = push(await checkReachability(mixedPort));
  const exit = await fetchExitIp(mixedPort);
  const exitCard = push(exitIpCard(exit));
  const dns = push(await checkDnsResolvers(exit, mixedPort));
  const ipv6 = push(await checkIpv6Leak(mixedPort));
  const rtc = push(await checkWebRtcLeak());
  const gemini = await probeGeminiUnlock(mixedPort);
  const gemCard = push(unlockCard("gemini", "Gemini（换节点对照）", gemini));
  const chatgpt = await probeChatgptUnlock(mixedPort);
  const gptCard = push(unlockCard("chatgpt", "ChatGPT（换节点对照）", chatgpt));
  const { ms, card: latCard } = await sampleLatency(mixedPort);
  push(latCard);
  const bwCard = push(await sampleBandwidth(mixedPort));
  const splitCard = push(await checkSplitRouting(mixedPort, mihomoConfig));
  const bareCard = push(await checkBareEgress(mixedPort));
  const netflixCard = push(await checkNetflixUnlock(mixedPort));
  const disneyCard = push(await checkDisneyUnlock(mixedPort));
  const youtubeCard = push(await checkYoutubeUnlock(mixedPort));
  const appStoreCard = push(await checkAppStoreUnlock(mixedPort));
  const googlePlayCard = push(await checkGooglePlayUnlock(mixedPort));

  return {
    ranAt: new Date().toISOString(),
    cards: [
      reach,
      dns,
      ipv6,
      rtc,
      exitCard,
      gemCard,
      gptCard,
      latCard,
      bwCard,
      splitCard,
      bareCard,
      netflixCard,
      disneyCard,
      youtubeCard,
      appStoreCard,
      googlePlayCard,
    ],
    exitIp: exit,
    gemini,
    chatgpt,
    latencyMs: ms,
    note,
  };
}
