import { describe, it, expect, beforeEach, vi } from "vitest";

// 用可手动 flush 的 deferred mock 锁住 ipv6 探针的「并行而非串行」编排：
// v0.1.9 直连超时修复把 directV4/directV6（及两条 v6 候选 URL）从串行 await 改为
// Promise.all 并发。若哪天有人改回串行，"所有探针在任何结果 resolve 前就已全部发出"
// 这条断言会立刻红。（verdict 判定本身已由 leakMatrix.test.ts 覆盖，此处只锁编排。）
const { fetchTextViaProxy } = vi.hoisted(() => ({
  fetchTextViaProxy: vi.fn(),
}));
vi.mock("../fetchVia", () => ({ fetchTextViaProxy }));

import { checkIpv6Leak } from "./ipv6";

type ProbeResult = {
  ok: boolean;
  status: number;
  text: string;
  via: "rust" | "browser";
};

const V4 = "1.2.3.4";
const V6A = "2001:db8::aaaa";
const V6B = "2001:db8::bbbb";

function text(url: string): string {
  if (url === "https://api.ipify.org") return V4;
  if (url === "https://api64.ipify.org") return V6A;
  if (url === "https://ipv6.icanhazip.com") return V6B;
  return "";
}

function okResult(url: string): ProbeResult {
  return { ok: true, status: 200, text: text(url), via: "rust" };
}

let calls: { url: string; mixedPort: number | null }[];
let pending: { url: string; resolve: (r: ProbeResult) => void }[];

beforeEach(() => {
  calls = [];
  pending = [];
  fetchTextViaProxy.mockReset();
});

describe("checkIpv6Leak 探针编排（v0.1.9 并行化）", () => {
  it("直连模式：3 条探针在任何结果返回前全部并发发出，且都是直连（mixedPort 为空）", async () => {
    fetchTextViaProxy.mockImplementation((url: string, opts: { mixedPort?: number | null }) => {
      calls.push({ url, mixedPort: opts?.mixedPort ?? null });
      return new Promise<ProbeResult>((resolve) => {
        pending.push({ url, resolve });
      });
    });

    const cardPromise = checkIpv6Leak(null);
    // 让微任务把同步派发跑完，但在 flush 前不应有任何探针结果被返回。
    await Promise.resolve();

    // 编排：直连组 = v4(1) + v6(2 候选) 全并发，一次发出。
    expect(calls.map((c) => c.url).sort()).toEqual(
      [
        "https://api.ipify.org",
        "https://api64.ipify.org",
        "https://ipv6.icanhazip.com",
      ].sort(),
    );
    // 全部并发发出（串行写法此刻只会发出 1 条）。
    expect(calls.length).toBe(3);
    // 直连模式：全部走真直连，不带代理口。
    expect(calls.every((c) => c.mixedPort == null)).toBe(true);
    // 尚未有任何结果被 resolve → 若为串行，第二条探针此刻根本不会被调用。
    expect(pending.length).toBe(3);

    for (const p of pending) p.resolve(okResult(p.url));
    const card = await cardPromise;
    expect(card.id).toBe("ipv6-leak");
  });

  it("直连模式：第一条 v6 端点失败时取第二条合法 IPv6", async () => {
    fetchTextViaProxy.mockImplementation((url: string) => {
      if (url === "https://api64.ipify.org") {
        return Promise.resolve<ProbeResult>({ ok: false, status: 0, text: "", via: "rust" });
      }
      return Promise.resolve<ProbeResult>(okResult(url));
    });

    const card = await checkIpv6Leak(null);
    expect(card.process).toContain(`IPv6 直连 ${V6B}`);
    expect(card.process).toContain(`IPv4 直连 ${V4}`);
  });

  it("代理模式：额外对 mixed-port 各发一条探针（回归：expectProxy 分支生效）", async () => {
    fetchTextViaProxy.mockImplementation(
      (url: string, opts: { mixedPort?: number | null }) => {
        const body = text(url);
        // 代理口回不同出口，便于区分（不影响本用例的断言）。
        const result: ProbeResult = {
          ok: true,
          status: 200,
          text: opts?.mixedPort ? body + "9" : body,
          via: "rust",
        };
        return Promise.resolve(result);
      },
    );

    await checkIpv6Leak(7897);
    const proxyCalls = fetchTextViaProxy.mock.calls.filter(
      (c) => (c[1] as { mixedPort?: number | null })?.mixedPort === 7897,
    );
    // 代理组：v4(1) + v6(2) 共 3 条经 mixed-port。
    expect(proxyCalls.length).toBe(3);
    const directCalls = fetchTextViaProxy.mock.calls.filter(
      (c) => (c[1] as { mixedPort?: number | null })?.mixedPort == null,
    );
    expect(directCalls.length).toBe(3);
  });
});
