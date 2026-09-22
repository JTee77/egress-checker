import { describe, expect, it } from "vitest";
import { nodeCapabilityChips } from "./capabilityChips";
import type { NodeCapabilities } from "./types";

const caps = (c: NodeCapabilities) => nodeCapabilityChips(c);

describe("nodeCapabilityChips", () => {
  it("空能力 → 无标签", () => {
    expect(caps({})).toEqual([]);
  });

  it("只认显式 true：false / undefined 一律不显示", () => {
    expect(caps({ udp: false, xudp: undefined, uot: true })).toEqual(["UoT"]);
  });

  it("udp 不被假设为常开：没有 udp 的节点就不显示 UDP", () => {
    // 用户核心担忧：换订阅后部分节点没有 UDP。
    expect(caps({ udp: false, xudp: true })).toEqual(["XUDP"]);
    expect(caps({ xudp: true })).toEqual(["XUDP"]); // udp 缺席
  });

  it("六个标志全开时按固定顺序渲染", () => {
    const all = caps({
      udp: true,
      xudp: true,
      uot: true,
      tfo: true,
      smux: true,
      mptcp: true,
    });
    expect(all).toEqual(["UDP", "XUDP", "UoT", "TFO", "Mux", "MPTCP"]);
  });

  it("单个标志只出对应标签", () => {
    expect(caps({ udp: true })).toEqual(["UDP"]);
    expect(caps({ mptcp: true })).toEqual(["MPTCP"]);
  });
});
