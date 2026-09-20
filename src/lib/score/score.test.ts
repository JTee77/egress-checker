import { describe, it, expect } from "vitest";
import type { CheckCard, CheckLevel } from "../egress/types";
import {
  parseDownMbps,
  starRank,
  formatStars,
  scoreNodeFromCards,
  scoreDeadNode,
  SERVICE_IDS,
} from "./nodeScore";
import { qualifiesPerfect, scoreVpn } from "./vpnScore";
import type { NodeScoreResult, ScoreBreakdownItem } from "./types";

/** 最小 CheckCard 夹具（title 用 id 占位，够用）。 */
function card(
  id: string,
  level: CheckLevel,
  conclusion: string,
  process?: string,
): CheckCard {
  return process
    ? { id, title: id, level, conclusion, process }
    : { id, title: id, level, conclusion };
}

/** 一组「几乎全绿」的节点卡片，用于锁定高分/完美路径的算术。 */
function greenNodeCards(): CheckCard[] {
  const svc = SERVICE_IDS.map((id) => card(id, "pass", "可访问"));
  return [
    card("reachability", "pass", "4/4 境外探测点能通（约 30 ms）"),
    card("bandwidth", "pass", "带宽抽样 ↓ 60 Mbps"),
    ...svc,
    card("exit-ip", "pass", "1.2.3.4 · US · 住宅线路"),
  ];
}

describe("parseDownMbps", () => {
  it("无卡片返回 null", () => {
    expect(parseDownMbps(undefined)).toBeNull();
  });
  it("优先匹配 ↓ 前缀", () => {
    expect(parseDownMbps(card("bandwidth", "pass", "实测 ↓ 42.5 Mbps"))).toBe(42.5);
    expect(parseDownMbps(card("bandwidth", "pass", "↓12.3Mbps"))).toBe(12.3);
  });
  it("退化到「下行」中文标签", () => {
    expect(parseDownMbps(card("bandwidth", "pass", "下行速度 18 Mbps 稳定"))).toBe(18);
  });
  it("再退化到裸 Mbps", () => {
    expect(parseDownMbps(card("bandwidth", "pass", "带宽 5 Mbps"))).toBe(5);
  });
  it("读 process 字段", () => {
    expect(
      parseDownMbps(card("bandwidth", "pass", "抽样完成", "峰值 ↓ 33 Mbps")),
    ).toBe(33);
  });
  it("无数字返回 null", () => {
    expect(parseDownMbps(card("bandwidth", "warn", "抽样失败"))).toBeNull();
  });
});

describe("starRank / formatStars", () => {
  it("unavailable 排最后（-1），其余等于自身", () => {
    expect(starRank("unavailable")).toBe(-1);
    expect(starRank(5)).toBe(5);
    expect(starRank(3.5)).toBe(3.5);
    expect(starRank(1)).toBe(1);
  });
  it("文本标签", () => {
    expect(formatStars("unavailable")).toBe("不可用");
    expect(formatStars(4.5)).toBe("4.5 星");
  });
});

describe("scoreNodeFromCards", () => {
  it("reachability 失败 → 不可用，totalScore 0", () => {
    const r = scoreNodeFromCards(
      "死节点",
      [card("reachability", "fail", "无法访问境外 HTTPS 探测点")],
      "2026-01-01T00:00:00.000Z",
    );
    expect(r.stars).toBe("unavailable");
    expect(r.totalScore).toBe(0);
    expect(r.blurb).toContain("连海外站点都打不开");
    expect(r.breakdown.every((b) => b.score === 0)).toBe(true);
  });

  // 手工核对算术：avail 100 · thr 100 · svc 100 · exit 95
  // total = round(100*.25 + 100*.3 + 100*.3 + 95*.15) = round(99.25) = 99 → 5 星
  it("全绿节点 → 5 星，总分 99（出口住宅封顶 95 拉低满分）", () => {
    const r = scoreNodeFromCards("全优", greenNodeCards());
    expect(r.stars).toBe(5);
    expect(r.totalScore).toBe(99);
    expect(r.breakdown.find((b) => b.key === "exit")?.score).toBe(95);
  });

  // 机房出口：level pass 但命中「机房」关键词 → exit 55，不是住宅的 95
  // total = round(100*.25 + 100*.3 + 100*.3 + 55*.15) = round(93.25) = 93 → 5 星（>=92）
  it("机房出口降分但仍 5 星", () => {
    const cards = greenNodeCards().map((c) =>
      c.id === "exit-ip" ? card("exit-ip", "pass", "1.2.3.4 · US · 机房 IP") : c,
    );
    const r = scoreNodeFromCards("机房", cards);
    expect(r.breakdown.find((b) => b.key === "exit")?.score).toBe(55);
    expect(r.totalScore).toBe(93);
    expect(r.stars).toBe(5);
  });

  // 慢速：bandwidth ↓ 2 Mbps → mbps>=1.5 → thr 50；其余绿
  // total = round(100*.25 + 50*.3 + 100*.3 + 95*.15) = round(25+15+30+14.25)=round(84.25)=84 → 4 星(>=78)
  it("吞吐偏慢把星级从 5 拉到 4", () => {
    const cards = greenNodeCards().map((c) =>
      c.id === "bandwidth" ? card("bandwidth", "pass", "带宽抽样 ↓ 2 Mbps") : c,
    );
    const r = scoreNodeFromCards("慢", cards);
    expect(r.totalScore).toBe(84);
    expect(r.stars).toBe(4);
  });
});

describe("scoreDeadNode", () => {
  it("直接判不可用，blurb 用传入原因", () => {
    const r = scoreDeadNode("X", "延迟探测失败");
    expect(r.stars).toBe("unavailable");
    expect(r.totalScore).toBe(0);
    expect(r.blurb).toBe("延迟探测失败");
    expect(r.cards).toEqual([]);
  });
});

function perfectNode(): NodeScoreResult {
  return scoreNodeFromCards("完美节点", greenNodeCards());
}

function greenEnvCards(): CheckCard[] {
  return [
    card("bare-egress", "pass", "直连境外不通，流量确经代理"),
    card("dns-leak", "pass", "递归解析器为公共 DNS 1.1.1.1"),
    card("split-routing", "pass", "国内直连、国外走代理，分流干净"),
  ];
}

describe("qualifiesPerfect", () => {
  const highBreakdown: ScoreBreakdownItem[] = [
    { key: "tunnel", label: "t", weight: 0.35, score: 100, note: "" },
    { key: "dns", label: "d", weight: 0.25, score: 100, note: "" },
    { key: "split", label: "s", weight: 0.15, score: 100, note: "" },
    { key: "node", label: "n", weight: 0.25, score: 100, note: "" },
  ];

  it("全条件满足 → true", () => {
    const node = perfectNode();
    expect(qualifiesPerfect(node, greenEnvCards(), highBreakdown, node.totalScore)).toBe(
      true,
    );
  });

  it("任一服务面非 pass → false", () => {
    const cards = greenNodeCards().map((c) =>
      c.id === "gemini" ? card("gemini", "warn", "受限") : c,
    );
    const node = scoreNodeFromCards("n", cards);
    expect(
      qualifiesPerfect(node, greenEnvCards(), highBreakdown, node.totalScore),
    ).toBe(false);
  });

  it("DNS 文案含「运营商」→ false（即使 level=pass）", () => {
    const env = greenEnvCards().map((c) =>
      c.id === "dns-leak"
        ? card("dns-leak", "pass", "解析器仍像运营商 DNS")
        : c,
    );
    const node = perfectNode();
    expect(qualifiesPerfect(node, env, highBreakdown, node.totalScore)).toBe(false);
  });
});

describe("scoreVpn", () => {
  it("全绿 + 完美节点 → 总评「完美」，总分 100", () => {
    const r = scoreVpn(perfectNode(), greenEnvCards());
    expect(r.tier).toBe("完美");
    expect(r.totalScore).toBe(100);
  });

  // DNS warn 且文案含「运营商」→ dnsAdjusted=min(55,45)=45
  // total = round(100*.35 + 45*.25 + 100*.15 + 100*.25) = round(86.25) = 86 → 很好
  it("DNS 疑似运营商 → 掉到「很好」，无法完美", () => {
    const env = greenEnvCards().map((c) =>
      c.id === "dns-leak" ? card("dns-leak", "warn", "解析仍走运营商") : c,
    );
    const r = scoreVpn(perfectNode(), env);
    expect(r.totalScore).toBe(86);
    expect(r.tier).toBe("很好");
  });

  it("所选节点不可用 → node 分项 0，总评明显走低", () => {
    const dead = scoreDeadNode("死", "探测失败");
    const r = scoreVpn(dead, greenEnvCards());
    const nodeItem = r.breakdown.find((b) => b.key === "node");
    expect(nodeItem?.score).toBe(0);
    // 死节点无 reachability 卡→tunnel 基数 40，被 bare-egress pass 抬到 75
    // total = round(75*.35 + dns100*.25 + split100*.15 + node0*.25) = round(66.25) = 66 → 能用(>=60)
    expect(r.totalScore).toBe(66);
    expect(r.tier).toBe("能用");
  });
});
