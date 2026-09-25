import { describe, expect, it } from "vitest";
import { resolveCurrentProxy } from "./currentProxy";
import type { ProxyInfo } from "./types";

const leaf = (name: string, type: string): ProxyInfo => ({ name, type });
const group = (name: string, now: string, all: string[]): ProxyInfo => ({
  name,
  type: "Selector",
  now,
  all,
});

describe("resolveCurrentProxy", () => {
  it("规则模式：GLOBAL 停在 DIRECT 时改取「节点选择」真实叶子", () => {
    const proxies: Record<string, ProxyInfo> = {
      GLOBAL: group("GLOBAL", "DIRECT", ["DIRECT", "HK17"]),
      节点选择: group("节点选择", "HK17", ["HK17", "SG2"]),
      NETFLIX: group("NETFLIX", "SG2", ["HK17", "SG2"]),
      HK17: leaf("HK17", "Hysteria2"),
      SG2: leaf("SG2", "Vmess"),
      DIRECT: leaf("DIRECT", "Direct"),
      REJECT: leaf("REJECT", "Reject"),
    };
    expect(resolveCurrentProxy(proxies)).toBe("HK17");
  });

  it("全局模式：GLOBAL 指向真实叶子时优先取它", () => {
    const proxies: Record<string, ProxyInfo> = {
      GLOBAL: group("GLOBAL", "jp-2", ["jp-2", "hk-1"]),
      节点选择: group("节点选择", "hk-1", ["jp-2", "hk-1"]),
      "jp-2": leaf("jp-2", "Shadowsocks"),
      "hk-1": leaf("hk-1", "Vmess"),
      DIRECT: leaf("DIRECT", "Direct"),
    };
    expect(resolveCurrentProxy(proxies)).toBe("jp-2");
  });

  it("无主组名且多子组并列 → null（诚实显示 —，不瞎猜）", () => {
    const proxies: Record<string, ProxyInfo> = {
      人工智能: group("人工智能", "us-1", ["us-1"]),
      NETFLIX: group("NETFLIX", "sg-9", ["sg-9"]),
      "us-1": leaf("us-1", "Vmess"),
      "sg-9": leaf("sg-9", "Trojan"),
      DIRECT: leaf("DIRECT", "Direct"),
    };
    expect(resolveCurrentProxy(proxies)).toBeNull();
  });

  it("纯直连模式（只有 GLOBAL→DIRECT）→ null", () => {
    const proxies: Record<string, ProxyInfo> = {
      GLOBAL: group("GLOBAL", "DIRECT", ["DIRECT"]),
      DIRECT: leaf("DIRECT", "Direct"),
    };
    expect(resolveCurrentProxy(proxies)).toBeNull();
  });

  it("唯一非主组且其 now 为真实叶子 → 采纳该叶子", () => {
    const proxies: Record<string, ProxyInfo> = {
      小鸡: group("小鸡", "hk-9", ["hk-9"]),
      "hk-9": leaf("hk-9", "Hysteria2"),
      DIRECT: leaf("DIRECT", "Direct"),
    };
    expect(resolveCurrentProxy(proxies)).toBe("hk-9");
  });

  it("组 now 指向另一个组（嵌套）时不认作叶子", () => {
    const proxies: Record<string, ProxyInfo> = {
      Proxy: group("Proxy", "内层", ["内层"]),
      内层: group("内层", "hk-1", ["hk-1"]),
      "hk-1": leaf("hk-1", "Vmess"),
      DIRECT: leaf("DIRECT", "Direct"),
    };
    // Proxy.now=内层 is a Selector → not a leaf; falls through to distinct scan
    // which finds 内层's leaf hk-1 as the only distinct real-leaf now.
    expect(resolveCurrentProxy(proxies)).toBe("hk-1");
  });
});
