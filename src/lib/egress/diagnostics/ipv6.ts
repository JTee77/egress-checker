//! IPv6 泄漏检测：直连/代理各采 v4+v6，交叉验证判定真旁路 vs 统一接管。
import { fetchTextViaProxy } from "../fetchVia";
import { classifyIpv6Leak } from "../leakMatrix";
import type { CheckCard } from "../types";

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
/** v4 出口采样（api.ipify.org），供 IPv6 卡与"真实归属参照"共用。 */
export async function probeV4Via(
  port: number | null,
  timeoutMs: number,
): Promise<string | null> {
  const r = await fetchTextViaProxy("https://api.ipify.org", {
    mixedPort: port,
    timeoutMs,
  });
  const ip = extractIpBody(r.text);
  return r.ok && ip && !isIpv6Literal(ip) ? ip : null;
}

/** 不走代理的直连 v4 出口（非 TUN 时即真实 ISP 出口，作归属判定参照）。 */
export function probeDirectV4(timeoutMs = 4500): Promise<string | null> {
  return probeV4Via(null, timeoutMs);
}

export async function checkIpv6Leak(
  mixedPort?: number | null,
): Promise<CheckCard> {
  const timeoutMs = 4500;
  // 直连模式下两个 v6 端点在国内大概率双双超时；把直连 v6 单独收紧到 3000ms，
  // 配合下面 directV4/directV6 并行，把该卡最坏耗时从「串行叠加 ~13.5s」压到 <5s，
  // 不再撞 envRun 的 12s deadline（v0.1.8 观测到的 IPv6 卡"超时未响应"根因即此处串行）。
  const v6DirectTimeoutMs = 3000;
  const expectProxy = mixedPort != null && mixedPort > 0;

  async function probeV6(
    port: number | null,
    timeout: number,
  ): Promise<string | null> {
    // 两个候选端点并发采，取任一合法 v6；最坏耗时 = 单端点超时，而非两者相加。
    const urls = ["https://api64.ipify.org", "https://ipv6.icanhazip.com"];
    const results = await Promise.all(
      urls.map((url) =>
        fetchTextViaProxy(url, { mixedPort: port, timeoutMs: timeout }),
      ),
    );
    for (const r of results) {
      const ip = extractIpBody(r.text);
      if (r.ok && ip && isIpv6Literal(ip)) return ip;
    }
    return null;
  }

  async function probeV4(
    port: number | null,
    timeout: number,
  ): Promise<string | null> {
    return probeV4Via(port, timeout);
  }

  // 直连两路并行；代理两路并行；直连组先于代理组，保持与 v0.1.8 相同的在飞并发上界
  // （≤3），不新增 spawn_blocking 池压力。
  const [directV4, directV6] = await Promise.all([
    probeV4(null, timeoutMs),
    probeV6(null, v6DirectTimeoutMs),
  ]);
  let proxiedV4: string | null = null;
  let proxiedV6: string | null = null;
  if (expectProxy) {
    [proxiedV4, proxiedV6] = await Promise.all([
      probeV4(mixedPort!, timeoutMs),
      probeV6(mixedPort!, timeoutMs),
    ]);
  }

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
