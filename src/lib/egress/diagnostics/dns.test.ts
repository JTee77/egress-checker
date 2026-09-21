import { describe, it, expect, beforeEach, vi } from "vitest";

// 锁住 v0.1.9 DNS 卡超时修复的两点契约：
//  (1) 主判定（pass/warn/fail/unknown）只由 whoami 出口 vs 代理出口比对决定，
//      Cloudflare loc 这个次要启发式无论缺席/命中都不参与 verdict；
//  (2) Cloudflare 启发式不再串行 await 在 whoami 之后（deferred 证明：whoami 还悬着时
//      probeText 已并发发出）。这是把 DNS 卡从"顶满 6s 逼近 12s deadline"救回来的关键。
const { listDnsResolvers, dnsWhoami, probeText } = vi.hoisted(() => ({
  listDnsResolvers: vi.fn(),
  dnsWhoami: vi.fn(),
  probeText: vi.fn(),
}));
vi.mock("../fetchVia", () => ({ listDnsResolvers, dnsWhoami }));
vi.mock("./probe", () => ({ probeText }));

import { checkDnsResolvers } from "./dns";
import type { ExitIpInfo } from "../types";

function exitInfo(ip: string | null, cc: string | null = "US"): ExitIpInfo {
  return {
    ip,
    country: "United States",
    countryCode: cc,
    org: "Example ISP",
    isp: "Example ISP",
    hosting: false,
    ipTypeLabel: "住宅(ISP)",
  };
}

const cfEmpty = { ok: false, status: 0, text: "", unverified: true };

beforeEach(() => {
  listDnsResolvers.mockReset();
  dnsWhoami.mockReset();
  probeText.mockReset();
  listDnsResolvers.mockResolvedValue({ resolvers: ["1.1.1.1"], source: "scutil" });
  probeText.mockResolvedValue(cfEmpty);
});

describe("checkDnsResolvers 判定与启发式解耦（v0.1.9）", () => {
  it("whoami 出口 == 代理出口 → pass，且 Cloudflare 缺席不改判", async () => {
    dnsWhoami.mockResolvedValue({ ok: true, clientIp: "9.9.9.9", via: "system", raw: "" });
    const card = await checkDnsResolvers(exitInfo("9.9.9.9"), null);
    expect(card.level).toBe("pass");
    expect(card.conclusion).toContain("未泄漏");
    expect(card.process).toContain("Cloudflare loc 未取到");
  });

  it("whoami 出口 != 代理出口 → fail，即便 Cloudflare loc 与出口国家不一致也不改判逻辑", async () => {
    dnsWhoami.mockResolvedValue({ ok: true, clientIp: "8.8.8.8", via: "system", raw: "" });
    probeText.mockResolvedValue({
      ok: true,
      status: 200,
      text: "loc=CN\ncolo=SIN\n",
      unverified: false,
    });
    const card = await checkDnsResolvers(exitInfo("9.9.9.9", "US"), 7897);
    // verdict 只认 whoami vs 代理出口比对
    expect(card.level).toBe("fail");
    expect(card.conclusion).toContain("疑似 DNS 泄漏");
    // 启发式行确实呈现了 loc 不一致（但只是参考文案）
    expect(card.process).toContain("不太一致");
  });

  it("whoami 未取到 → unknown，与 Cloudflare 结果无关", async () => {
    dnsWhoami.mockResolvedValue({ ok: false, via: "system", raw: "", error: "UDP 超时" });
    const card = await checkDnsResolvers(exitInfo("9.9.9.9"), null);
    expect(card.level).toBe("unknown");
    expect(card.conclusion).toContain("未能实测");
  });

  it("缺代理出口 IP 无法对照 → warn", async () => {
    dnsWhoami.mockResolvedValue({ ok: true, clientIp: "8.8.8.8", via: "system", raw: "" });
    const card = await checkDnsResolvers(exitInfo(null), null);
    expect(card.level).toBe("warn");
    expect(card.conclusion).toContain("缺少代理出口 IP");
  });

  it("超时修复点：Cloudflare 探针与 whoami 并发，不再串行等 whoami", async () => {
    let flushWhoami: (v: unknown) => void = () => {};
    dnsWhoami.mockImplementation(
      () =>
        new Promise((resolve) => {
          flushWhoami = resolve;
        }),
    );
    probeText.mockResolvedValue(cfEmpty);

    const cardPromise = checkDnsResolvers(exitInfo("9.9.9.9"), null);
    await Promise.resolve();

    // whoami 尚未 resolve（仍是悬空 promise）时，Cloudflare 启发式应已并发发出。
    // 旧写法这里会先 await whoami 再 await cf，cf 此刻调用数为 0。
    expect(probeText).toHaveBeenCalled();

    flushWhoami({ ok: true, clientIp: "9.9.9.9", via: "system", raw: "" });
    const card = await cardPromise;
    expect(card.level).toBe("pass");
  });
});
