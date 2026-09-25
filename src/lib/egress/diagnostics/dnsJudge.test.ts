import { describe, it, expect } from "vitest";
import { judgeDnsEgress } from "./dns";

const HK_EXIT = "157.119.102.175";

describe("judgeDnsEgress", () => {
  it("解析出口 == 节点出口 → pass", () => {
    const r = judgeDnsEgress({ qIp: HK_EXIT, exitIp: HK_EXIT });
    expect(r.level).toBe("pass");
  });

  it("v6 解析出口(供应商基础设施 DE) ≠ v4 节点(HK)，但 ≠ 真实归属(CN) → pass（修复误报）", () => {
    const r = judgeDnsEgress({
      qIp: "2a0c:59c0:1:16::1",
      exitIp: HK_EXIT,
      qCountry: "DE",
      realCountry: "CN",
    });
    expect(r.level).toBe("pass");
    expect(r.conclusion).toContain("供应商基础设施");
  });

  it("解析出口归属 == 真实归属(CN) → fail（真泄漏）", () => {
    const r = judgeDnsEgress({
      qIp: "240e::9",
      exitIp: HK_EXIT,
      qCountry: "CN",
      realCountry: "CN",
    });
    expect(r.level).toBe("fail");
    expect(r.suggestion).toContain("fake-ip");
  });

  it("归属要素不全 → warn（不放过也不武断）", () => {
    expect(
      judgeDnsEgress({ qIp: "2a0c:59c0::1", exitIp: HK_EXIT, qCountry: null, realCountry: "CN" })
        .level,
    ).toBe("warn");
    expect(
      judgeDnsEgress({ qIp: "2a0c:59c0::1", exitIp: HK_EXIT, qCountry: "DE", realCountry: null })
        .level,
    ).toBe("warn");
  });
});
