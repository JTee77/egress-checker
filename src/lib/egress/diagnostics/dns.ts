//! DNS 泄漏检测：UDP whoami 实测出口 IP 与代理出口比对（含旧名别名）。
import { listDnsResolvers, dnsWhoami } from "../fetchVia";
import { probeText, PROBE_TIMEOUT_MS } from "./probe";
import type { CheckCard, CheckLevel, ExitIpInfo } from "../types";

/**
 * A1: DNS 泄漏（确定性改造）。
 * 旧版只列 scutil 配置的 resolver，几乎永远判 pass。新版用 UDP 原始 DNS `TXT whoami` 实测
 * DNS 查询真正从哪个公网 IP 出去（以及被哪个递归解析器服务），再与代理出口 IP 比对：
 * 同出口 → 未泄漏；不同 → DNS 绕过了代理、疑似暴露真实地址。scutil 列表与 Cloudflare
 * 启发式降级为过程细节。
 */
export async function checkDnsResolvers(
  exit: ExitIpInfo,
  mixedPort?: number | null,
): Promise<CheckCard> {
  const [dns, whoami] = await Promise.all([
    listDnsResolvers(),
    dnsWhoami({ timeoutMs: 4500 }),
  ]);
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

  const exitIp = exit.ip ?? null;
  const qIp = whoami.clientIp ?? null;

  let level: CheckLevel;
  let conclusion: string;
  let suggestion: string | undefined;

  if (!whoami.ok || !qIp) {
    level = "unknown";
    conclusion = `未能实测 DNS 出口（${whoami.error ?? "DNS 查询无有效返回"}）`;
    suggestion = "检查网络连接是否正常，稍后重试。";
  } else if (!exitIp) {
    level = "warn";
    conclusion = `DNS 查询从 ${qIp} 出去，但缺少代理出口 IP 可对照，无法判定是否泄漏`;
    suggestion = "先完成「出口 IP」检查（或连上代理）后再测 DNS。";
  } else if (qIp === exitIp) {
    level = "pass";
    conclusion = `DNS 查询与代理流量同出口（${qIp}）—— 未泄漏真实地址`;
  } else {
    level = "fail";
    conclusion = `DNS 从 ${qIp} 出去，而代理出口是 ${exitIp} —— 两者不符，疑似 DNS 泄漏真实地址`;
    suggestion =
      "把系统/Wi-Fi DNS 改到隧道可达的 1.1.1.1 / 8.8.8.8，或在客户端开启 DNS 劫持（fake-ip / TUN DNS）后重测。";
  }

  const proc = [
    `实测：DNS 出口 IP=${qIp ?? "无"} · 递归解析器 ns=${whoami.resolverNs ?? "无"}${
      whoami.ecs ? ` · ECS=${whoami.ecs}` : ""
    }（via ${whoami.via}）`,
    `代理出口 IP=${exitIp ?? "无"}`,
    `配置解析器：${resolvers.join(", ") || "(无)"}（source ${dns.source}）`,
    dns.error ? `note: ${dns.error}` : "",
    dns.rawHint ? `raw_hint:\n${dns.rawHint}` : "",
    heuristicLine,
    "边界：whoami 反映「查询实际从哪出去」，比读配置更接近真相；ECS 若暴露你的 /24 仍属信息泄露。不是 BrowserLeaks 级全量证明。",
  ].filter(Boolean);

  return {
    id: "dns-leak",
    title: "DNS 解析器",
    level,
    conclusion,
    process: proc.join("\n"),
    suggestion,
  };
}

/** @deprecated use checkDnsResolvers — kept name alias for older call sites */
export async function checkDnsLeakApproach(
  exit: ExitIpInfo,
  mixedPort?: number | null,
): Promise<CheckCard> {
  return checkDnsResolvers(exit, mixedPort);
}
