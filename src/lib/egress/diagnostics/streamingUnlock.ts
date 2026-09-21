//! 流媒体 / 应用商店解锁粗检：Netflix / Disney+ / YouTube Premium / App Store / Google Play。
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
