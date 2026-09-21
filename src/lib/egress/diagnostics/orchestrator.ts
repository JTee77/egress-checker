//! 编排器：并发跑全部检测项、按截止兜底、聚合成 EgressReport。
import {
  checkReachability,
  withFailRetryUnlock,
  withCardDeadline,
  timeoutCard,
  mapPool,
} from "./probe";
import { fetchExitIp, exitIpCard } from "./exitIp";
import { checkDnsResolvers } from "./dns";
import { checkIpv6Leak } from "./ipv6";
import { checkWebRtcLeak } from "./webrtc";
import { probeGeminiUnlock, probeChatgptUnlock, unlockCard } from "./aiUnlock";
import { sampleLatency, sampleBandwidth } from "./performance";
import { checkSplitRouting, checkBareEgress } from "./routing";
import {
  checkNetflixUnlock,
  checkDisneyUnlock,
  checkYoutubeUnlock,
  checkAppStoreUnlock,
  checkGooglePlayUnlock,
} from "./streamingUnlock";
import type { CheckCard, EgressReport, ExitIpInfo, UnlockResult } from "../types";
import type { ControllerConfig } from "../../mihomo/types";

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
