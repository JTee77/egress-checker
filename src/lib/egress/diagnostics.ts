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
import { fetchTextViaProxy } from "./fetchVia";

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
      summary: "无法访问境外 HTTPS 探测点",
      detail: results.map((r) => `${r.url} → HTTP ${r.status || "超时"}`).join("\n"),
      tip: "请确认 Clash Verge Rev 已连接，且系统代理 / TUN 已开启；并检查设置中的 mixed-port。",
    };
  }
  const level: CheckLevel = ok.length === results.length ? "pass" : "warn";
  return {
    id: "reachability",
    title: "连通性",
    level,
    summary: `${ok.length}/${results.length} 探测点可达（约 ${ok[0].ms} ms）`,
    detail: results
      .map((r) => `${r.url}: ${r.status || "超时"} (${r.ms}ms)`)
      .join("\n"),
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
      summary: "无法获取出口 IP",
      tip: "检查网络或临时关闭拦截局域网流量的规则。",
    };
  }
  const level: CheckLevel = info.hosting ? "warn" : "pass";
  return {
    id: "exit-ip",
    title: "出口 IP",
    level,
    summary: `${info.ip} · ${info.countryCode ?? "?"} · ${info.ipTypeLabel}`,
    detail: `组织 ${info.org ?? "--"} · ISP ${info.isp ?? "--"} · 国家 ${info.country ?? "--"}`,
    tip: info.hosting
      ? "机房 IP 可能导致部分 AI / 流媒体风控；可尝试住宅/家宽节点。"
      : undefined,
  };
}

/**
 * Best-effort DNS leak approach for Tauri webview:
 * compare exit country vs public resolver hint pages is limited in browser;
 * we report exit geo + note that WebRTC local IP leak is v1 partial.
 */
export async function checkDnsLeakApproach(
  exit: ExitIpInfo,
  mixedPort?: number | null,
): Promise<CheckCard> {
  // Cloudflare trace through current egress (prefer mixed-port)
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

  const webrtcNote =
    "旁注：WebRTC 是否暴露本地 IP，本版只能粗谈，完整检测还在后续。";

  if (!exit.ip && !loc) {
    return {
      id: "dns-leak",
      title: "DNS 粗检（启发式）",
      level: "unknown",
      summary: "本轮粗检没跑出来",
      detail:
        "本项不是 BrowserLeaks 那种「完整解析器列表」检测，只是对照出口国家与 Cloudflare 路径提示。\n真·系统 DNS 解析器列表会放到后续版本。\n\n" +
        webrtcNote,
      tip: "若在意运营商 DNS：可暂把 Wi-Fi DNS 设为 1.1.1.1 / 8.8.8.8，并确认流量走隧道。",
    };
  }

  const exitCc = exit.countryCode?.toUpperCase() ?? null;
  const mismatch =
    exitCc && loc && exitCc !== loc.toUpperCase() && loc.toUpperCase() !== "XX";

  return {
    id: "dns-leak",
    title: "DNS 粗检（启发式）",
    level: mismatch ? "warn" : "pass",
    summary: mismatch
      ? `粗看不太一致：出口 ${exitCc}，Cloudflare 提示 ${loc}`
      : `粗看大致一致：出口 ${exitCc ?? "?"}，Cloudflare 提示 ${loc ?? "?"}`,
    detail: `测了什么：Cloudflare trace（loc/colo）。没测：系统 DNS 列表、完整泄漏证明。\n出口国家 ${exitCc ?? "--"} · loc ${loc ?? "--"} · colo ${colo ?? "--"}\n${webrtcNote}`,
    tip: "换节点时用来快速对照「路子像不像」；不要把它当成专业 DNS 泄漏报告。",
  };
}

export function webrtcCard(): CheckCard {
  return {
    id: "webrtc",
    title: "WebRTC",
    level: "warn",
    summary: "浏览器环境限制 — v1 占位",
    detail:
      "嵌入式 WebView 限制 RTCPeerConnection / ICE 候选收集；完整泄露扫描后续加强。勿把「未知」当成「无泄露」。",
    tip: "可临时禁用 WebRTC 或仅走代理；浏览器可到 chrome://webrtc-internals 复核。",
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

  const detailParts = [
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
    summary: result.status,
    detail: detailParts.join("\n"),
    tip: "主要用 Mac 桌面版时，桌面项会写「未单独检测」——以官方客户端实际体验为准。",
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
        summary: "采样失败",
        detail: `目标: ${url} → HTTP ${r.status || "超时"}`,
        tip: "请确认 mixed-port 与系统代理 / TUN 可用。",
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
      summary: `${ms} ms（轻量 HTTPS）`,
      detail: `目标: ${url}`,
    },
  };
}

export async function runEgressDiagnostics(
  onCard?: (card: CheckCard) => void,
  options?: { mixedPort?: number | null },
): Promise<EgressReport> {
  const mixedPort = options?.mixedPort ?? null;
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
  const dns = push(await checkDnsLeakApproach(exit, mixedPort));
  const rtc = push(webrtcCard());
  const gemini = await probeGeminiUnlock(mixedPort);
  const gemCard = push(unlockCard("gemini", "Gemini（换节点对照）", gemini));
  const chatgpt = await probeChatgptUnlock(mixedPort);
  const gptCard = push(unlockCard("chatgpt", "ChatGPT（换节点对照）", chatgpt));
  const { ms, card: latCard } = await sampleLatency(mixedPort);
  push(latCard);

  return {
    ranAt: new Date().toISOString(),
    cards: [reach, dns, rtc, exitCard, gemCard, gptCard, latCard],
    exitIp: exit,
    gemini,
    chatgpt,
    latencyMs: ms,
    note,
  };
}
