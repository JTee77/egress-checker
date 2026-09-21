//! 性能探测：延迟多次抽样取中位、上下行带宽抽样（含 full/light 复核与不稳定标注）。
import { timedTransferViaProxy, canBrowserFallback } from "../fetchVia";
import { probeText, isReachableStatus, PROBE_TIMEOUT_MS } from "./probe";
import type { CheckCard, CheckLevel } from "../types";

function medianNumber(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  }
  return sorted[mid]!;
}

/** 同 URL 连续采样 3 次，取成功值中位数；全失败才判失败。 */
export async function sampleLatency(
  mixedPort?: number | null,
): Promise<{ ms: number | null; card: CheckCard }> {
  const url = "https://www.gstatic.com/generate_204";
  const attemptLines: string[] = [];
  const successMs: number[] = [];

  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = await probeText(url, {
      mixedPort,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const reachable = isReachableStatus(r.status, r.ok);
    const elapsed = Math.round(performance.now() - t0);
    if (reachable) {
      successMs.push(elapsed);
      attemptLines.push(`第 ${i + 1} 次：${elapsed} ms（HTTP ${r.status}）`);
    } else {
      attemptLines.push(
        `第 ${i + 1} 次：失败（HTTP ${r.status || "超时"} · ${elapsed} ms）`,
      );
    }
  }

  if (successMs.length === 0) {
    return {
      ms: null,
      card: {
        id: "latency",
        title: "延迟采样",
        level: "fail",
        conclusion: "采样失败",
        process: [`目标: ${url}`, ...attemptLines].join("\n"),
        suggestion: "请确认代理软件已连接，并开启系统代理或 TUN，然后重试。",
      },
    };
  }

  const ms = medianNumber(successMs);
  const level: CheckLevel = ms < 200 ? "pass" : ms < 500 ? "warn" : "fail";
  return {
    ms,
    card: {
      id: "latency",
      title: "延迟采样",
      level,
      conclusion: `大约 ${ms} ms（${successMs.length}/3 次中位）`,
      process: [
        `目标: ${url}`,
        ...attemptLines,
        `采用成功值中位数 ${ms} ms。`,
        "边界：同 URL 连续抽样，不是面板延迟。",
      ].join("\n"),
      suggestion: undefined,
    },
  };
}
/** A4: sample up/down Mbps through current egress (mixed-port preferred). */
const BW_DOWN_BYTES_FULL = 524288;
const BW_DOWN_BYTES_LIGHT = 131072;
const BW_UP_BYTES_FULL = 512 * 1024;
const BW_UP_BYTES_LIGHT = 64 * 1024;
const BW_TIMEOUT_FULL_MS = 12000;
const BW_TIMEOUT_LIGHT_MS = 6000;

function bwDownUrl(bytes: number): string {
  return `https://speed.cloudflare.com/__down?bytes=${bytes}`;
}

const BW_UP_URL = "https://speed.cloudflare.com/__up";

export type BandwidthSampleOptions = {
  /**
   * full：「测当前」— 成功后再做一次轻量复核；差异大则标不稳定。
   * light：「测全部」— 仅失败/超时时再试一次，成功不复核。
   */
  mode?: "full" | "light";
  /** @deprecated 请用 mode:"light"；保留兼容旧调用 */
  light?: boolean;
};

function bytesToMbps(bytes: number, elapsedMs: number): number | null {
  if (bytes <= 0 || elapsedMs <= 0) return null;
  return (bytes * 8) / (elapsedMs / 1000) / 1_000_000;
}

function fmtMbps(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "--";
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

type BandwidthShot = {
  downMbps: number | null;
  upMbps: number | null;
  downPartial: boolean;
  downOk: boolean;
  level: CheckLevel;
  conclusion: string;
  process: string;
  downErr: string | null;
  upErr: string | null;
  /** No proxy port available AND direct fallback refused → speed untestable. */
  unverified: boolean;
};

async function sampleBandwidthOnce(
  mixedPort: number | null | undefined,
  light: boolean,
): Promise<BandwidthShot> {
  const downBytes = light ? BW_DOWN_BYTES_LIGHT : BW_DOWN_BYTES_FULL;
  const upBytes = light ? BW_UP_BYTES_LIGHT : BW_UP_BYTES_FULL;
  const timeoutMs = light ? BW_TIMEOUT_LIGHT_MS : BW_TIMEOUT_FULL_MS;
  const downUrl = bwDownUrl(downBytes);

  const down = await timedTransferViaProxy({
    url: downUrl,
    mixedPort: mixedPort ?? null,
    method: "GET",
    timeoutMs,
  });
  const up = await timedTransferViaProxy({
    url: BW_UP_URL,
    mixedPort: mixedPort ?? null,
    method: "POST",
    uploadBytes: upBytes,
    timeoutMs,
  });

  const downMbps =
    down.bytes > 0 && down.elapsedMs > 0
      ? bytesToMbps(down.bytes, down.elapsedMs)
      : null;
  const upMbps = up.ok ? bytesToMbps(up.bytes, up.elapsedMs) : null;
  const downPartial = !!down.error && down.bytes > 0 && downMbps != null;

  const downErr =
    down.error ||
    (!down.ok && !downPartial
      ? down.status
        ? `HTTP ${down.status}`
        : "超时或不可达"
      : null);
  const upErr =
    up.error ||
    (!up.ok ? (up.status ? `HTTP ${up.status}` : "超时或不可达") : null);

  const conclusionParts: string[] = [];
  if (downMbps != null)
    conclusionParts.push(
      `↓ ${fmtMbps(downMbps)} Mbps${downPartial ? "（部分）" : ""}`,
    );
  else conclusionParts.push(`↓ 失败`);
  if (upMbps != null) conclusionParts.push(`↑ ${fmtMbps(upMbps)} Mbps`);
  else conclusionParts.push(`↑ 失败`);

  let level: CheckLevel;
  if (downMbps != null && upMbps != null && !downPartial && down.ok) level = "pass";
  else if (downMbps != null || upMbps != null) level = "warn";
  else level = "fail";

  const portNote =
    mixedPort != null && mixedPort > 0
      ? `经 mixed-port(${mixedPort})`
      : "未配置 mixed-port（可能走直连）";

  // Throughput can only be honestly reported when it was measured *through* a
  // proxy. With no proxy port and the direct-fallback refused (production), we
  // simply cannot vouch for the node's speed → neutral 未验证, not "fail".
  const hadProxy = mixedPort != null && mixedPort > 0;
  const unverified = !hadProxy && !canBrowserFallback();

  const kib = (n: number) => `${Math.round(n / 1024)}KiB`;
  const process = [
    `下载：GET ${downUrl}`,
    `  期望约 ${downBytes} B · 实际 ${down.bytes} B · ${down.elapsedMs} ms · via ${down.via}` +
      (downMbps != null ? ` · ${fmtMbps(downMbps)} Mbps` : "") +
      (downErr ? ` · ${downErr}` : ""),
    `上传：POST ${BW_UP_URL}（Content-Type: application/octet-stream，${upBytes} B 零填充）`,
    `  发送 ${up.bytes} B · ${up.elapsedMs} ms · via ${up.via}` +
      (upMbps != null ? ` · ${fmtMbps(upMbps)} Mbps` : "") +
      (upErr ? ` · ${upErr}` : ""),
    `路径：${portNote}；超时 ${timeoutMs} ms${light ? "（轻量抽样）" : ""}。`,
    "说明：抽样带宽 ≠ 全网测速 / 不等于节点面板延迟。",
    `端点：Cloudflare Speed（__down ${kib(downBytes)} / __up ${kib(upBytes)}）。请求 Accept-Encoding: identity，按字节流计数（避免经代理 gzip 解码失败）。未用 httpbin。`,
  ].join("\n");

  let finalLevel: CheckLevel = level;
  let conclusion =
    level === "fail"
      ? `抽样失败（↓ ${downErr ?? "失败"} · ↑ ${upErr ?? "失败"}）`
      : conclusionParts.join(" · ");
  if (unverified) {
    finalLevel = "unknown";
    conclusion = "未验证：未取到代理口，未能经代理测速";
  }

  return {
    downMbps,
    upMbps,
    downPartial,
    downOk: down.ok,
    level: finalLevel,
    conclusion,
    process,
    downErr,
    upErr,
    unverified,
  };
}

function relativeDiff(a: number, b: number): number {
  const mid = (Math.abs(a) + Math.abs(b)) / 2;
  if (mid <= 0) return 1;
  return Math.abs(a - b) / mid;
}

function meanMbps(a: number | null, b: number | null): number | null {
  if (a != null && b != null) return (a + b) / 2;
  return a ?? b;
}

export async function sampleBandwidth(
  mixedPort?: number | null,
  opts?: BandwidthSampleOptions,
): Promise<CheckCard> {
  const mode: "full" | "light" =
    opts?.mode ?? (opts?.light ? "light" : "full");
  const lightPrimary = mode === "light";

  const first = await sampleBandwidthOnce(mixedPort, lightPrimary);

  // No proxy port and direct-fallback refused → we could not measure throughput
  // at all. Return a neutral 未验证 card and skip retries (a retry can't help).
  if (first.unverified) {
    return {
      id: "bandwidth",
      title: "抽样带宽",
      level: "unknown",
      unverified: true,
      conclusion: first.conclusion,
      process: first.process,
      suggestion: "请先连接并刷新代理节点（拿到 mixed-port）后再测速。",
    };
  }

  if (mode === "light") {
    if (first.level !== "fail") {
      return {
        id: "bandwidth",
        title: "抽样带宽",
        level: first.level,
        conclusion: first.conclusion,
        process: first.process,
        suggestion: undefined,
      };
    }
    const second = await sampleBandwidthOnce(mixedPort, true);
    return {
      id: "bandwidth",
      title: "抽样带宽",
      level: second.level,
      conclusion: second.conclusion,
      process: [`第 1 次（失败）：\n${first.process}`, `第 2 次：\n${second.process}`].join(
        "\n",
      ),
      suggestion:
        second.level === "fail" ? "请确认代理软件已连上后再测。" : undefined,
    };
  }

  // full：「测当前」— 成功后再轻量复核；失败则直接返回
  if (first.level === "fail") {
    return {
      id: "bandwidth",
      title: "抽样带宽",
      level: first.level,
      conclusion: first.conclusion,
      process: first.process,
      suggestion: "请确认代理软件已连上后再测。",
    };
  }

  const confirm = await sampleBandwidthOnce(mixedPort, true);
  const process = [
    `第 1 次（主抽样）：\n${first.process}`,
    `第 2 次（轻量复核）：\n${confirm.process}`,
  ].join("\n");

  const downA = first.downMbps;
  const downB = confirm.downMbps;
  const upA = first.upMbps;
  const upB = confirm.upMbps;

  let unstable = false;
  if (downA != null && downB != null && relativeDiff(downA, downB) > 0.4) {
    unstable = true;
  } else if (
    downA == null &&
    upA != null &&
    upB != null &&
    relativeDiff(upA, upB) > 0.4
  ) {
    unstable = true;
  }

  const downMbps = meanMbps(downA, downB);
  const upMbps = meanMbps(upA, upB);

  const conclusionParts: string[] = [];
  if (downMbps != null) conclusionParts.push(`↓ ${fmtMbps(downMbps)} Mbps`);
  else conclusionParts.push(`↓ 失败`);
  if (upMbps != null) conclusionParts.push(`↑ ${fmtMbps(upMbps)} Mbps`);
  else conclusionParts.push(`↑ 失败`);

  let level: CheckLevel;
  if (downMbps != null && upMbps != null) level = unstable ? "warn" : "pass";
  else if (downMbps != null || upMbps != null) level = "warn";
  else level = "fail";

  let conclusion = conclusionParts.join(" · ");
  if (unstable) {
    conclusion = `${conclusion}（不稳定）`;
    if (level === "pass") level = "warn";
  }

  return {
    id: "bandwidth",
    title: "抽样带宽",
    level,
    conclusion,
    process,
    suggestion: level === "fail" ? "请确认代理软件已连上后再测。" : undefined,
  };
}
