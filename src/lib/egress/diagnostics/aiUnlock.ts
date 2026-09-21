//! AI 服务解锁粗检（Gemini / ChatGPT）与 UnlockResult→卡片构造。
import { fetchTextViaProxy } from "../fetchVia";
import { UA } from "./probe";
import type { CheckCard, CheckLevel, UnlockResult } from "../types";

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

export { unlockCard };
