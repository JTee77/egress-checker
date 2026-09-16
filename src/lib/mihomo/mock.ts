import type { DelayResult, ProxyInfo, ProxyNode } from "./types";
import { detectRegion } from "./regions";

const MOCK_NAMES: { name: string; type: string }[] = [
  { name: "🇭🇰 香港 01 | Hysteria2", type: "Hysteria2" },
  { name: "🇯🇵 东京 Premium", type: "VLESS" },
  { name: "🇸🇬 Singapore IEPL", type: "Trojan" },
  { name: "🇺🇸 洛杉矶 家宽", type: "Shadowsocks" },
  { name: "🇹🇼 台北 游戏专线", type: "VMess" },
  { name: "🇩🇪 Frankfurt", type: "WireGuard" },
  { name: "剩余流量：999GB", type: "Trojan" },
  { name: "官网 example.com", type: "VLESS" },
  { name: "到期提醒", type: "Direct" },
];

export function mockProxiesRaw(): Record<string, ProxyInfo> {
  const proxies: Record<string, ProxyInfo> = {
    GLOBAL: {
      name: "GLOBAL",
      type: "Selector",
      now: MOCK_NAMES[0].name,
      all: MOCK_NAMES.map((n) => n.name),
    },
    Proxy: {
      name: "Proxy",
      type: "Selector",
      now: MOCK_NAMES[0].name,
      all: MOCK_NAMES.filter((n) => n.type !== "Direct").map((n) => n.name),
    },
    DIRECT: { name: "DIRECT", type: "Direct" },
    REJECT: { name: "REJECT", type: "Reject" },
  };
  for (const n of MOCK_NAMES) {
    proxies[n.name] = { name: n.name, type: n.type };
  }
  return proxies;
}

export function mockNodes(): ProxyNode[] {
  return MOCK_NAMES.filter(
    (n) =>
      !["剩余", "到期", "官网"].some((k) => n.name.includes(k)) &&
      !["Selector", "Direct", "Reject"].includes(n.type),
  ).map((n) => ({
    name: n.name,
    type: n.type,
    region: detectRegion(n.name),
    raw: { name: n.name, type: n.type },
  }));
}

export function mockQuickResults(nodes: ProxyNode[]): DelayResult[] {
  return nodes.map((n, i) => {
    const avg = 40 + i * 25 + Math.floor(Math.random() * 40);
    const jitter = 5 + (i % 4) * 8;
    const loss = i === nodes.length - 1 ? 33 : 0;
    return {
      name: n.name,
      region: n.region,
      proto: n.type,
      avgDelay: avg,
      jitter,
      lossRate: loss,
      alive: loss < 100,
    };
  });
}
