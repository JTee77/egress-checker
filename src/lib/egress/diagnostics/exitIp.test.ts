import { describe, it, expect, beforeEach, vi } from "vitest";

// 锁住出口 IP 的多源降级 + 「机房判定为关键词推断（非权威）」的语义：
// v0.1.9 只把 geojs.io 追加为第三冗余源（提升 ipwho.is/ip.sb 双双 429 时的容灾），
// hosting 仍走 inferHosting 关键词推断、hostingInferred 恒为 true、UI 标「疑似」。
const { fetchTextViaProxy } = vi.hoisted(() => ({ fetchTextViaProxy: vi.fn() }));
vi.mock("../fetchVia", () => ({ fetchTextViaProxy }));

import { fetchExitIp, inferHosting } from "./exitIp";

const IPWHO = "https://ipwho.is/";
const IPSB = "https://api.ip.sb/geoip";
const GEOJS = "https://get.geojs.io/v1/ip/geo.json";

type Served = Record<string, string | null>;

function serve(map: Served) {
  fetchTextViaProxy.mockImplementation((url: string) => {
    const body = map[url];
    if (body === undefined || body === null) {
      return Promise.resolve({ ok: false, status: 0, text: "", via: "rust" as const });
    }
    return Promise.resolve({ ok: true, status: 200, text: body, via: "rust" as const });
  });
}

function calledUrls(): string[] {
  return fetchTextViaProxy.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  fetchTextViaProxy.mockReset();
});

describe("fetchExitIp 多源降级（v0.1.9 第三冗余源）", () => {
  it("ipwho.is 首选成功即用，不再打后续源", async () => {
    serve({
      [IPWHO]: JSON.stringify({
        success: true,
        ip: "5.6.7.8",
        country: "Germany",
        country_code: "DE",
        connection: { org: "Hetzner Online GmbH", isp: "Hetzner" },
      }),
    });
    const info = await fetchExitIp(null);
    expect(info.ip).toBe("5.6.7.8");
    expect(info.hosting).toBe(true); // Hetzner 命中关键词
    expect(info.hostingInferred).toBe(true); // 明确是推断，不是权威字段
    expect(info.ipTypeLabel).toContain("疑似机房");
    expect(calledUrls()).toEqual([IPWHO]); // 短路，未碰后两源
  });

  it("前两源失败时回落第三源 geojs.io（验证接线与顺序）", async () => {
    serve({
      [GEOJS]: JSON.stringify({
        ip: "5.6.7.9",
        country: "United States",
        country_code: "US",
        organization: "AS7922 Comcast Cable Communications",
      }),
    });
    const info = await fetchExitIp(7897);
    expect(info.ip).toBe("5.6.7.9");
    expect(info.hosting).toBe(false); // Comcast 不含机房关键词
    expect(info.ipTypeLabel).toContain("住宅");
    // 顺序：ipwho → ip.sb → geojs
    expect(calledUrls()).toEqual([IPWHO, IPSB, GEOJS]);
  });

  it("ipwho success:false 视为该源失败，回落下一源", async () => {
    serve({
      [IPWHO]: JSON.stringify({ success: false, ip: "should-be-ignored" }),
      [IPSB]: JSON.stringify({
        ip: "1.1.1.1",
        country: "China",
        country_code: "CN",
        organization: "China Telecom",
      }),
    });
    const info = await fetchExitIp(null);
    expect(info.ip).toBe("1.1.1.1");
    expect(calledUrls()).toEqual([IPWHO, IPSB]);
  });

  it("三源全失败 → 诚实返回空结果（不编造 IP）", async () => {
    serve({});
    const info = await fetchExitIp(null);
    expect(info.ip).toBeNull();
    expect(info.hosting).toBeNull();
    expect(info.ipTypeLabel).toBe("--");
    expect(calledUrls()).toEqual([IPWHO, IPSB, GEOJS]);
  });
});

describe("inferHosting 关键词推断（诚实标注：非权威字段）", () => {
  it("命中机房/云厂商关键词判 hosting", () => {
    expect(inferHosting("Hetzner Online GmbH")).toBe(true);
    expect(inferHosting("AS16509 Amazon.com, Inc.")).toBe(true);
    expect(inferHosting(undefined, "OVH SAS")).toBe(true);
  });

  it("普通家宽运营商不判 hosting", () => {
    expect(inferHosting("Comcast Cable", "Xfinity")).toBe(false);
    expect(inferHosting("China Telecom")).toBe(false);
  });

  it("全空输入 → false（无信息不误判）", () => {
    expect(inferHosting(null, undefined, "")).toBe(false);
  });
});
