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
