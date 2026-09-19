/**
 * 节点向检测：连通性、出口、延迟/带宽抽样、流媒体与 AI 粗检。
 * 不跑 DNS / IPv6 / WebRTC / 分流 / 直连旁路等环境项。
 */
import type { ControllerConfig } from "../mihomo/types";
import {
  checkAppStoreUnlock,
  checkDisneyUnlock,
  checkGooglePlayUnlock,
  checkNetflixUnlock,
  checkReachability,
  checkYoutubeUnlock,
  exitIpCard,
  fetchExitIp,
  probeChatgptUnlock,
  probeGeminiUnlock,
  sampleBandwidth,
  sampleLatency,
  withFailRetryUnlock,
} from "./diagnostics";
import type { CheckCard, EgressReport, UnlockResult } from "./types";

export const NODE_CARD_IDS = [
  "reachability",
  "exit-ip",
  "latency",
  "bandwidth",
  "gemini",
  "chatgpt",
  "netflix",
  "disney",
  "youtube",
  "app-store",
  "google-play",
] as const;

function unlockCard(
  id: string,
  title: string,
  result: UnlockResult,
): CheckCard {
  let level: CheckCard["level"] = "fail";
  if (result.supported) {
    level = result.level === "full" ? "pass" : "warn";
  } else if (result.level === "unknown") {
    level = "unknown";
  }
  const processParts = [
    result.lines?.length ? `结果对照：${result.lines.join("；")}` : "",
    result.probed?.length ? `测了什么：${result.probed.join("；")}` : "",
    result.notProbed?.length ? `没测什么：${result.notProbed.join("；")}` : "",
    result.region ? `出口提示地区：${result.region}` : "",
    "换节点时一次对照用，不能替代你自己打开网站。",
  ].filter(Boolean);
  return {
    id,
    title,
    level,
    conclusion: result.status,
    process: processParts.join("\n"),
  };
}

function timeoutCard(id: string, title: string): CheckCard {
  return {
    id,
    title,
    level: "unknown",
    conclusion: "这次没测出来",
    process: "探测超时或卡住，已按截止时间结束本项。",
  };
}

async function withDeadline(
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
      conclusion: "这次没测出来",
      process: msg,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length || 1) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export type NodeRunOptions = {
  mixedPort?: number | null;
  mihomoConfig?: ControllerConfig | null;
};

/** 针对「当前出口」的节点向深测（不切换节点）。 */
export async function runNodeDiagnostics(
  onCard?: (card: CheckCard) => void,
  options?: NodeRunOptions,
): Promise<EgressReport> {
  const mixedPort = options?.mixedPort ?? null;
  const note =
    mixedPort != null && mixedPort > 0
      ? "只测当前出口相关项（连通、出口、带宽与服务粗检）。环境项请用「怀疑漏了再查」。"
      : "未配置代理口时，部分探针可能走窗口直连。建议先刷新连接。";

  const push = (c: CheckCard) => {
    onCard?.(c);
    return c;
  };

  const reach = push(
    await withDeadline("连通性", "reachability", () => checkReachability(mixedPort), 14000),
  );

  let exit = await Promise.race([
    fetchExitIp(mixedPort),
    new Promise<Awaited<ReturnType<typeof fetchExitIp>>>((resolve) =>
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
  const exitCardResult = push(exitIpCard(exit));

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

  type Job = {
    id: string;
    title: string;
    deadlineMs: number;
    run: () => Promise<CheckCard>;
  };

  const jobs: Job[] = [
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
        const { ms, card: c } = await sampleLatency(mixedPort);
        latencyMs = ms;
        return c;
      },
    },
    {
      id: "bandwidth",
      title: "抽样带宽",
      deadlineMs: 42000,
      run: () => sampleBandwidth(mixedPort, { mode: "full" }),
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
    const c = await withDeadline(job.title, job.id, job.run, job.deadlineMs);
    return push(c);
  });

  const byId = new Map(settled.map((c) => [c.id, c]));
  const cards = NODE_CARD_IDS.map((id) => {
    if (id === "reachability") return reach;
    if (id === "exit-ip") return exitCardResult;
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

/** 「测全部」用的轻量深测包：仍产出可用性 / 吞吐 / 服务面 / 出口卡片，供星级权重。 */
export async function runNodeDeepLight(
  onCard?: (card: CheckCard) => void,
  options?: NodeRunOptions,
): Promise<EgressReport> {
  const mixedPort = options?.mixedPort ?? null;
  const note =
    mixedPort != null && mixedPort > 0
      ? "测全部为轻量深测（短连通、出口、小带宽抽样与关键服务）。环境项请用「怀疑漏了再查」。"
      : "未配置代理口时，部分探针可能走窗口直连。建议先刷新连接。";

  const push = (c: CheckCard) => {
    onCard?.(c);
    return c;
  };

  const reach = push(
    await withDeadline(
      "连通性",
      "reachability",
      () => checkReachability(mixedPort, { light: true }),
      5000,
    ),
  );

  let exit = await Promise.race([
    fetchExitIp(mixedPort),
    new Promise<Awaited<ReturnType<typeof fetchExitIp>>>((resolve) =>
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
        3500,
      ),
    ),
  ]);
  const exitCardResult = push(exitIpCard(exit));

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

  type Job = {
    id: string;
    title: string;
    deadlineMs: number;
    run: () => Promise<CheckCard>;
  };

  // 关键服务 4 项并行 + 轻量带宽；跳过 disney / app-store / google-play / 完整延迟采样
  const jobs: Job[] = [
    {
      id: "bandwidth",
      title: "抽样带宽",
      deadlineMs: 20000,
      run: () => sampleBandwidth(mixedPort, { mode: "light" }),
    },
    {
      id: "netflix",
      title: "Netflix",
      deadlineMs: 10000,
      run: () => checkNetflixUnlock(mixedPort),
    },
    {
      id: "youtube",
      title: "YouTube Premium",
      deadlineMs: 10000,
      run: () => checkYoutubeUnlock(mixedPort),
    },
    {
      id: "chatgpt",
      title: "ChatGPT（换节点对照）",
      deadlineMs: 12000,
      run: async () => {
        chatgpt = await withFailRetryUnlock(() => probeChatgptUnlock(mixedPort));
        return unlockCard("chatgpt", "ChatGPT（换节点对照）", chatgpt);
      },
    },
    {
      id: "gemini",
      title: "Gemini（换节点对照）",
      deadlineMs: 10000,
      run: async () => {
        gemini = await withFailRetryUnlock(() => probeGeminiUnlock(mixedPort));
        return unlockCard("gemini", "Gemini（换节点对照）", gemini);
      },
    },
  ];

  const settled = await mapPool(jobs, 4, async (job) => {
    const c = await withDeadline(job.title, job.id, job.run, job.deadlineMs);
    return push(c);
  });

  const byId = new Map(settled.map((c) => [c.id, c]));
  // 只返回实际测过的卡片，避免「未测」unknown 稀释服务面星级权重
  const cards: CheckCard[] = [
    reach,
    exitCardResult,
    byId.get("bandwidth") ?? timeoutCard("bandwidth", "抽样带宽"),
    byId.get("netflix") ?? timeoutCard("netflix", "Netflix"),
    byId.get("youtube") ?? timeoutCard("youtube", "YouTube Premium"),
    byId.get("chatgpt") ?? timeoutCard("chatgpt", "ChatGPT（换节点对照）"),
    byId.get("gemini") ?? timeoutCard("gemini", "Gemini（换节点对照）"),
  ];

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
