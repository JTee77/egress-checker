//! 基础探测层：浏览器/Rust 代理取文本、可达性判定、失败重试、超时截止与并发池。
import { fetchTextViaProxy, canBrowserFallback } from "../fetchVia";
import type { CheckCard, CheckLevel, UnlockResult } from "../types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const PROBE_TIMEOUT_MS = 6000;
async function fetchTextBrowser(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }> {
  const { timeoutMs = 5000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Prefer mixed-port via Rust; fall back to browser fetch if mixedPort missing or proxy fetch fails. */
/**
 * Probe a URL, preferring the mixed-port path. `unverified` marks the case where
 * we could NOT reach the target through a proxy AND refused to fall back to a
 * direct browser fetch (production) *because no proxy port was available* — that
 * is genuinely "未验证", not a node failure. When a proxy port WAS given but the
 * proxy itself could not connect, `unverified` stays false so the honest "fail"
 * still surfaces (a node that can't route is not a neutral node).
 */
async function probeText(
  url: string,
  opts: {
    mixedPort?: number | null;
    timeoutMs?: number;
    userAgent?: string;
    method?: string;
  } = {},
): Promise<{ ok: boolean; status: number; text: string; unverified: boolean }> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const mixedPort = opts.mixedPort ?? null;
  const hadProxy = mixedPort != null && mixedPort > 0;

  if (hadProxy) {
    const viaProxy = await fetchTextViaProxy(url, {
      mixedPort,
      timeoutMs,
      userAgent: opts.userAgent,
    });
    const success =
      viaProxy.status === 204 ||
      viaProxy.status === 200 ||
      (viaProxy.status >= 200 && viaProxy.status < 400) ||
      viaProxy.ok;
    if (success || viaProxy.status !== 0) {
      return {
        ok: success,
        status: viaProxy.status,
        text: viaProxy.text,
        unverified: false,
      };
    }
  }

  // Proxy path unavailable. In a production Tauri build we must NOT silently
  // direct-fetch (would measure the real egress and fabricate a pass). Refuse
  // the fallback and let callers render it honestly.
  if (!canBrowserFallback()) {
    return { ok: false, status: 0, text: "", unverified: !hadProxy };
  }

  // Secondary: browser fetch (dev build / plain web preview only)
  const viaBrowser = await fetchTextBrowser(url, {
    method: opts.method ?? "GET",
    timeoutMs,
    headers: opts.userAgent ? { "User-Agent": opts.userAgent } : undefined,
  });
  return { ...viaBrowser, unverified: false };
}

function isReachableStatus(status: number, ok: boolean): boolean {
  return status === 204 || status === 200 || (ok && status >= 200 && status < 400);
}

export type ReachabilityOptions = {
  /** light：只探一个点 + 更短超时，供「测全部」批量深测 */
  light?: boolean;
};

export async function checkReachability(
  mixedPort?: number | null,
  opts?: ReachabilityOptions,
): Promise<CheckCard> {
  const light = !!opts?.light;
  const targets = light
    ? ["https://cp.cloudflare.com/generate_204"]
    : [
        "https://www.google.com/generate_204",
        "https://cp.cloudflare.com/generate_204",
      ];
  const timeoutMs = light ? 3500 : PROBE_TIMEOUT_MS;
  // Sequential probes to avoid slamming the Rust spawn_blocking pool.
  const results: {
    url: string;
    ok: boolean;
    status: number;
    text: string;
    ms: number;
    unverified: boolean;
  }[] = [];
  for (const url of targets) {
    const t0 = performance.now();
    const r = await probeText(url, {
      mixedPort,
      timeoutMs,
      method: "GET",
    });
    results.push({ url, ...r, ms: Math.round(performance.now() - t0) });
  }
  // No proxy port was available and we refused the direct-fallback: we simply
  // could not test this node's egress. Show a neutral 未验证 card (never a fake
  // green, never a harsh "dead node"), and scoring excludes it from the average.
  if (results.length > 0 && results.every((r) => r.unverified)) {
    return {
      id: "reachability",
      title: "连通性",
      level: "unknown",
      unverified: true,
      conclusion: "未验证：未取到可用代理口，已拒绝直连兜底",
      process: results.map((r) => `${r.url} → 未经代理测试`).join("\n"),
      suggestion: "请先连接并刷新代理节点（拿到 mixed-port）后再测。",
    };
  }
  const ok = results.filter((r) => isReachableStatus(r.status, r.ok));
  if (ok.length === 0) {
    return {
      id: "reachability",
      title: "连通性",
      level: "fail",
      conclusion: "无法经代理访问境外 HTTPS 探测点",
      process: results.map((r) => `${r.url} → HTTP ${r.status || "超时"}`).join("\n"),
      suggestion: "请确认代理软件已打开、已连上节点，并开启系统代理或 TUN，然后重试。",
    };
  }
  const level: CheckLevel = ok.length === results.length ? "pass" : "warn";
  return {
    id: "reachability",
    title: "连通性",
    level,
    conclusion: `${ok.length}/${results.length} 个境外探测点能通（约 ${ok[0].ms} ms）`,
    process: results
      .map((r) => `${r.url}: ${r.status || "超时"} (${r.ms}ms)`)
      .join("\n"),
    suggestion: undefined,
  };
}
/** 可用（含「可用，…偏弱」）不重试；不可用 / 超时未响应 / 未能判定 再试一次。 */
function serviceNeedsRetry(card: CheckCard): boolean {
  const c = (card.conclusion ?? "").trim();
  if (/^可用/.test(c)) return false;
  if (/不可用|超时未响应|未能判定|这次没测成|这次没测出来|未测成/.test(c)) return true;
  if (card.level === "unknown") return true;
  return false;
}

/** 失败/未成功类结论自动再探一次；用户可见结论取最后一次有意义结果。 */
export async function withFailRetry(
  fn: () => Promise<CheckCard>,
): Promise<CheckCard> {
  const first = await fn();
  if (!serviceNeedsRetry(first)) return first;
  const second = await fn();
  return {
    ...second,
    process: [
      first.process ? `第 1 次：\n${first.process}` : "第 1 次：（无过程）",
      second.process ? `第 2 次：\n${second.process}` : "第 2 次：（无过程）",
    ].join("\n"),
  };
}

/** UnlockResult：可用不重试；不可用 / 超时未响应 / 未能判定 再试一次。 */
function unlockNeedsRetry(result: UnlockResult): boolean {
  const c = (result.status ?? "").trim();
  if (/^可用/.test(c)) return false;
  if (/不可用|超时未响应|未能判定|这次没测成|这次没测出来|未测成|未完成/.test(c)) return true;
  if (result.level === "unknown") return true;
  return false;
}

export async function withFailRetryUnlock(
  fn: () => Promise<UnlockResult>,
): Promise<UnlockResult> {
  const first = await fn();
  if (!unlockNeedsRetry(first)) return first;
  const second = await fn();
  const note = "第 2 次复测";
  return {
    ...second,
    probed: [...(first.probed ?? []), note, ...(second.probed ?? [])],
    lines: [
      ...(first.lines ?? []).map((l) => `第 1 次：${l}`),
      ...(second.lines ?? []).map((l) => `第 2 次：${l}`),
    ],
  };
}
function timeoutCard(
  id: string,
  title: string,
): CheckCard {
  return {
    id,
    title,
    level: "unknown",
    conclusion: "超时未响应",
    process: "探测超时或卡住，已按截止时间结束本项。",
    suggestion: undefined,
  };
}

async function withCardDeadline(
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
      suggestion: undefined,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

export {
  UA,
  PROBE_TIMEOUT_MS,
  probeText,
  isReachableStatus,
  timeoutCard,
  withCardDeadline,
  mapPool,
};
