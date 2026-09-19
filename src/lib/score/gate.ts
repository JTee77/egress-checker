import { checkBareEgress, checkReachability } from "../egress/diagnostics";
import type { ConnectionState } from "../mihomo/types";
import type { GateResult } from "./types";

/**
 * 轻量自动门槛：客户端是否连上、隧道是否大致工作、是否明显未走代理直连。
 * 失败则口语阻断，不进入节点测评。
 */
export async function runLightGate(connection: ConnectionState): Promise<GateResult> {
  if (!connection.usingMock) {
    if (connection.status === "unknown") {
      return {
        ok: false,
        message: "还没检查连接。请先选择你在用的软件，再点「刷新连接」。",
      };
    }
    if (connection.status === "unreachable") {
      return {
        ok: false,
        message:
          "这边连不上你的代理软件。请确认软件已打开、节点已连接，然后点「刷新连接」。",
        process: connection.message,
      };
    }
    if (connection.status === "unauthorized") {
      return {
        ok: false,
        message: "代理软件拒绝了连接。请展开「高级」，核对密钥后再刷新。",
        process: connection.proxiesError ?? connection.message,
      };
    }
    if (connection.status !== "connected" && connection.status !== "mock") {
      return {
        ok: false,
        message: "当前还没准备好测节点。请先刷新连接，确认状态为已连上。",
        process: connection.message,
      };
    }
  }

  const mixedPort = connection.config?.mixedPort ?? null;
  const reach = await checkReachability(mixedPort);
  if (reach.level === "fail") {
    return {
      ok: false,
      message:
        "代理软件看起来已连上，但访问海外站点的探测都失败了。请确认节点真的能用，或先在客户端里换一个节点后再来。",
      process: reach.process,
    };
  }

  const bare = await checkBareEgress(mixedPort);
  if (bare.level === "warn" && /可能未走代理直连|代理路径失败但直连/.test(bare.conclusion)) {
    return {
      ok: false,
      message:
        "现在更像「代理没生效、流量可能未走代理」。请到代理软件里打开系统代理或 TUN，确认连上后再测节点。",
      process: bare.process,
    };
  }

  return {
    ok: true,
    message: "测试条件满足：客户端在线，访问海外站点大致正常，未见明显未走代理直连。可以开始测节点。",
    process: [reach.conclusion, bare.conclusion].join("\n"),
  };
}
