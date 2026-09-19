/**
 * 环境向检测：DNS / IPv6 / WebRTC / 分流 / 直连旁路。
 * 作为第二入口「环境泄漏检查」，不默认每次强跑。
 */
import type { ControllerConfig } from "../mihomo/types";
import {
  checkBareEgress,
  checkDnsLeakApproach,
  checkDnsResolvers,
  checkIpv6Leak,
  checkSplitRouting,
  checkWebRtcLeak,
  fetchExitIp,
} from "./diagnostics";
import type { CheckCard, ExitIpInfo } from "./types";

export const ENV_CARD_IDS = [
  "dns-leak",
  "ipv6-leak",
  "webrtc",
  "split-routing",
  "bare-egress",
] as const;

function timeoutCard(id: string, title: string): CheckCard {
  return {
    id,
    title,
    level: "unknown",
    conclusion: "超时未响应",
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
      conclusion: "未能判定",
      process: msg,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type EnvRunOptions = {
  mixedPort?: number | null;
  mihomoConfig?: ControllerConfig | null;
  /** 若已有出口信息可传入，避免重复拉取 */
  exitIp?: ExitIpInfo | null;
};

export async function runEnvDiagnostics(
  onCard?: (card: CheckCard) => void,
  options?: EnvRunOptions,
): Promise<CheckCard[]> {
  const mixedPort = options?.mixedPort ?? null;
  const mihomoConfig = options?.mihomoConfig ?? null;
  const push = (c: CheckCard) => {
    onCard?.(c);
    return c;
  };

  let exit = options?.exitIp ?? null;
  if (!exit) {
    exit = await Promise.race([
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
  }

  const jobs: {
    id: string;
    title: string;
    deadlineMs: number;
    run: () => Promise<CheckCard>;
  }[] = [
    {
      id: "dns-leak",
      title: "DNS 解析器",
      deadlineMs: 12000,
      run: async () => {
        // 优先系统解析器；失败时仍给出启发式对照
        try {
          return await checkDnsResolvers(exit!, mixedPort);
        } catch {
          return checkDnsLeakApproach(exit!, mixedPort);
        }
      },
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
  ];

  const cards: CheckCard[] = [];
  for (const job of jobs) {
    const c = await withDeadline(job.title, job.id, job.run, job.deadlineMs);
    cards.push(push(c));
  }
  return cards;
}
