//! 流媒体 / 应用商店解锁粗检：Netflix / Disney+ / YouTube Premium / TikTok / Spotify / Prime Video / App Store / Google Play。
import { probeText, isReachableStatus, withFailRetry, UA } from "./probe";
import type { CheckCard, CheckLevel } from "../types";

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


async function probeTikTokLine(
  mixedPort?: number | null,
): Promise<ProbeLine> {
  // Clash Verge Rev media_unlock_checker/tiktok.rs：cdn-cgi/trace 优先，失败再看首页。
  const timeoutMs = 4000;
  const primary = "https://www.tiktok.com/cdn-cgi/trace";
  const fallback = "https://www.tiktok.com/";

  const t0 = performance.now();
  let url = primary;
  let r = await probeText(url, { mixedPort, timeoutMs, userAgent: UA });
  let body = r.text ?? "";
  let region = extractTikTokRegion(body);
  let statusKind = classifyTikTokStatus(r.status, body);

  if (statusKind === "failed" || !region) {
    const r2 = await probeText(fallback, { mixedPort, timeoutMs, userAgent: UA });
    const body2 = r2.text ?? "";
    const region2 = extractTikTokRegion(body2);
    const kind2 = classifyTikTokStatus(r2.status, body2);
    // Verge：若主探不是 No，可用回退状态覆盖 Failed；region 取或。
    if (statusKind !== "no") {
      statusKind = kind2;
      r = r2;
      body = body2;
      url = fallback;
    }
    region = region ?? region2;
  }

  const ms = Math.round(performance.now() - t0);

  if (!r.status && !body) {
    return {
      name: "TikTok",
      level: "unknown",
      conclusion: "超时未响应",
      process: `${url} → 超时/无响应（${ms}ms）。短超时抽样；失败≠节点一定不可用。`,
    };
  }

  if (statusKind === "no") {
    return {
      name: "TikTok",
      level: "fail",
      conclusion: region
        ? `不可用（地区限制 · ${region}）`
        : "不可用（地区限制）",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n信号：403/451 或 access denied / not available / tiktok is not available。\n边界：本次检查不等于登录、创作、直播。`,
    };
  }

  if (statusKind === "yes") {
    return {
      name: "TikTok",
      level: region ? "pass" : "warn",
      conclusion: region ? `可用（${region}）` : "可用",
      process: [
        `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B`,
        region ? `地区线索：${region}` : "未解析到 region / loc（页仍可达）。",
        "测了什么：tiktok.com/cdn-cgi/trace（必要时首页 GET）；对齐 Verge 状态规则。",
        "没测：App 登录、For You 推荐、直播、创作发布。",
      ].join("\n"),
    };
  }

  return {
    name: "TikTok",
    level: "unknown",
    conclusion: "未能判定",
    process: `${url} → HTTP ${r.status || "超时"} · ${ms}ms · body≈${body.length}B。非 2xx 或信号不足时标 unknown。`,
  };
}

/** Verge：403/451→No；非 2xx→Failed；文案拦截→No；否则 Yes。 */
export function classifyTikTokStatus(
  status: number,
  body: string,
): "yes" | "no" | "failed" {
  if (status === 403 || status === 451) return "no";
  if (status !== 0 && (status < 200 || status >= 300)) return "failed";
  const lower = body.toLowerCase();
  if (
    lower.includes("access denied") ||
    lower.includes("not available in your region") ||
    lower.includes("tiktok is not available")
  ) {
    return "no";
  }
  if (!status && !body) return "failed";
  return "yes";
}

/** Verge `"region"\s*:\s*"…"`；trace 常见 loc=XX 作补充。 */
export function extractTikTokRegion(body: string): string | null {
  const m = body.match(/"region"\s*:\s*"([a-zA-Z-]+)"/);
  if (m?.[1]) {
    const code = m[1].split("-")[0]?.toUpperCase() ?? "";
    if (/^[A-Z]{2}$/.test(code)) return code;
  }
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("loc=")) {
      const code = line.slice(4).trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1") return code;
    }
  }
  return null;
}

async function probeSpotifyLine(
  mixedPort?: number | null,
): Promise<ProbeLine> {
  // Clash Verge Rev spotify.rs：country-selector JSON（GET）；桌面侧拿不到最终 URL，地区靠 body。
  const url =
    "https://www.spotify.com/api/content/v1/country-selector?platform=web&format=json";
  const timeoutMs = 4000;
  const t0 = performance.now();
  const r = await probeText(url, { mixedPort, timeoutMs, userAgent: UA });
  const ms = Math.round(performance.now() - t0);
  const body = r.text ?? "";
  const lower = body.toLowerCase();

  if (!r.status && !body) {
    return {
      name: "Spotify",
      level: "unknown",
      conclusion: "超时未响应",
      process: `${url} → 超时/无响应（${ms}ms）。`,
    };
  }

  if (r.status === 403 || r.status === 451) {
    return {
      name: "Spotify",
      level: "fail",
      conclusion: "不可用（地区限制）",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n信号：403/451。\n边界：不等于 Premium 订阅/播歌解码。`,
    };
  }

  if (r.status !== 0 && (r.status < 200 || r.status >= 300)) {
    return {
      name: "Spotify",
      level: "unknown",
      conclusion: "未能判定",
      process: `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B。非 2xx（Verge Failed）。`,
    };
  }

  if (lower.includes("not available in your country")) {
    return {
      name: "Spotify",
      level: "fail",
      conclusion: "不可用（地区限制）",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n信号：not available in your country。`,
    };
  }

  const region = extractSpotifyRegion(body);
  const reachable =
    isReachableStatus(r.status, r.ok) ||
    (r.status >= 200 && r.status < 300 && body.length > 2);

  if (reachable) {
    return {
      name: "Spotify",
      level: region ? "pass" : "warn",
      conclusion: region ? `可用（${region}）` : "可用",
      process: [
        `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B`,
        region
          ? `地区线索：${region}（countryCode；桌面 GET 无最终 URL 路径）`
          : "未解析到 countryCode（接口仍 2xx；启发式偏弱时标 warn）。",
        "测了什么：spotify country-selector JSON（对齐 Verge GET）。",
        "没测：注册 POST 状态码链、Premium、播歌、播客版权。",
      ].join("\n"),
    };
  }

  return {
    name: "Spotify",
    level: "unknown",
    conclusion: "未能判定",
    process: `${url} → HTTP ${r.status || "超时"} · ${ms}ms · body≈${body.length}B`,
  };
}

export function extractSpotifyRegion(body: string): string | null {
  const patterns = [
    /"countryCode"\s*:\s*"([A-Za-z]{2})"/,
    /"country"\s*:\s*"([A-Za-z]{2})"/,
    /"selectedCountry"\s*:\s*"([A-Za-z]{2})"/,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m?.[1]) return m[1].toUpperCase();
  }
  return null;
}

async function probePrimeVideoLine(
  mixedPort?: number | null,
): Promise<ProbeLine> {
  // Clash Verge Rev / MediaUnlockTest：primevideo.com 看 isServiceRestricted 与 currentTerritory。
  const url = "https://www.primevideo.com";
  const timeoutMs = 4000;
  const t0 = performance.now();
  const r = await probeText(url, { mixedPort, timeoutMs, userAgent: UA });
  const ms = Math.round(performance.now() - t0);
  const body = r.text ?? "";

  if (!r.status && !body) {
    return {
      name: "Prime Video",
      level: "unknown",
      conclusion: "超时未响应",
      process: `${url} → 超时/无响应（${ms}ms）。`,
    };
  }

  if (body.includes("isServiceRestricted")) {
    return {
      name: "Prime Video",
      level: "fail",
      conclusion: "不可用（地区限制）",
      process: `${url} → HTTP ${r.status} · ${ms}ms\n信号：isServiceRestricted。\n边界：不等于会员片库/4K。`,
    };
  }

  const region = extractPrimeVideoRegion(body);
  if (region) {
    return {
      name: "Prime Video",
      level: "pass",
      conclusion: `可用（${region}）`,
      process: [
        `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B`,
        `地区线索：currentTerritory=${region}`,
        "测了什么：primevideo.com 首页 HTML 线索（对齐 Verge / MediaUnlockTest）。",
        "没测：登录、片库、Channels、下载。",
      ].join("\n"),
    };
  }

  // Verge：无 territory → Failed (PAGE ERROR)。桌面 WebView/截断时可能弱信号。
  if (body.length > 400 && (isReachableStatus(r.status, r.ok) || (r.status >= 200 && r.status < 400))) {
    return {
      name: "Prime Video",
      level: "warn",
      conclusion: "可用，地区信号偏弱",
      process: `${url} → HTTP ${r.status} · ${ms}ms · body≈${body.length}B。未解析到 currentTerritory（页可达但启发式弱；诚实标 warn）。`,
    };
  }

  return {
    name: "Prime Video",
    level: "unknown",
    conclusion: "未能判定",
    process: `${url} → HTTP ${r.status || "超时"} · ${ms}ms · body≈${body.length}B。无 currentTerritory（Verge 视为 PAGE ERROR）。`,
  };
}

export function extractPrimeVideoRegion(body: string): string | null {
  const m = body.match(/"currentTerritory"\s*:\s*"([A-Za-z]{2})"/);
  return m?.[1] ? m[1].toUpperCase() : null;
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
    metrics: {
      unlockSupported: line.level === "pass" || line.level === "warn",
      unlockLevel: line.level,
    },
  };
}

/** Streaming cards: no canned「换节点」suggestion. */
const STREAM_TIP = "";
/** Store cards: no canned「换节点」suggestion. */
const STORE_TIP = "";
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

/** TikTok 单独卡：cdn-cgi/trace + 首页粗检（对齐 Verge）。 */
export async function checkTikTokUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  return withFailRetry(async () => {
    const line = await probeTikTokLine(mixedPort);
    return serviceCardFromLine("tiktok", "TikTok", line, STREAM_TIP, mixedPort);
  });
}

/** Spotify 单独卡：country-selector JSON（对齐 Verge GET）。 */
export async function checkSpotifyUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  return withFailRetry(async () => {
    const line = await probeSpotifyLine(mixedPort);
    return serviceCardFromLine("spotify", "Spotify", line, STREAM_TIP, mixedPort);
  });
}

/** Prime Video 单独卡：首页 isServiceRestricted / currentTerritory。 */
export async function checkPrimeVideoUnlock(
  mixedPort?: number | null,
): Promise<CheckCard> {
  return withFailRetry(async () => {
    const line = await probePrimeVideoLine(mixedPort);
    return serviceCardFromLine(
      "prime-video",
      "Prime Video",
      line,
      STREAM_TIP,
      mixedPort,
    );
  });
}
