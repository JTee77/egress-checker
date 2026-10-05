/**
 * CLI serve：把 loopback HTTP 路由映射到与一次性 CLI 相同的 dispatchCli。
 * 会话级 --client / --mock 来自启动 argv；单次请求只带路径与（check/node 的）JSON body。
 */
import { dispatchCli, type CliDispatchOptions } from "./dispatch";
import { CLI_SERVE_DEFAULT_PORT } from "./parse";
import {
  errEnvelope,
  okEnvelope,
  type CliEnvelope,
  type ParsedCli,
} from "./types";

export { CLI_SERVE_DEFAULT_PORT };

export type ServeJob = {
  id: number;
  /** discover | gate | env | check/current | check/all | check/node */
  route: string;
  body: string;
};

export type ServeStartInfo = {
  host: string;
  port: number;
  token: string;
  baseUrl: string;
};

/** 从启动参数得到 serve 用的端口（未给 → 默认；已给则用解析值）。 */
export function resolveServePort(parsed: Pick<ParsedCli, "port" | "portGiven">): number {
  if (parsed.portGiven && parsed.port !== null) return parsed.port;
  return CLI_SERVE_DEFAULT_PORT;
}

/**
 * 把 HTTP 路由变成一次 ParsedCli（复用启动时的 client/mock）。
 * 未知路由 / check/node 缺 name → 返回 ok:false envelope（由调用方以 HTTP 200 回传，业务错误在 envelope 里）。
 */
export function parsedFromServeJob(
  base: ParsedCli,
  job: Pick<ServeJob, "route" | "body">,
): { parsed: ParsedCli; early?: CliEnvelope } {
  const shared: ParsedCli = {
    ...base,
    cliMode: true,
    parseError: null,
    json: true,
    // serve 会话不把 HTTP 请求再当成 serve 子命令
    command: "help",
    commandToken: null,
    checkTarget: undefined,
  };

  switch (job.route) {
    case "discover":
      return { parsed: { ...shared, command: "discover" } };
    case "gate":
      return { parsed: { ...shared, command: "gate" } };
    case "env":
      return { parsed: { ...shared, command: "env" } };
    case "check/current":
      return {
        parsed: {
          ...shared,
          command: "check",
          checkTarget: { kind: "current" },
        },
      };
    case "check/all":
      return {
        parsed: {
          ...shared,
          command: "check",
          checkTarget: { kind: "all" },
        },
      };
    case "check/node": {
      let name = "";
      try {
        if (!job.body.trim()) {
          // 空 body → 缺 name
        } else {
          const raw = JSON.parse(job.body) as unknown;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return {
              parsed: shared,
              early: errEnvelope(
                "check",
                "invalid_body",
                'POST /v1/check/node 需要 JSON 对象：{"name":"节点名"}',
                version(),
              ),
            };
          }
          const n = (raw as { name?: unknown }).name;
          if (n === undefined) {
            // 合法 JSON 但没 name 字段 → node_name_required
          } else if (typeof n !== "string") {
            return {
              parsed: shared,
              early: errEnvelope(
                "check",
                "invalid_body",
                'POST /v1/check/node 的 name 必须是字符串',
                version(),
              ),
            };
          } else {
            name = n.trim();
          }
        }
      } catch {
        return {
          parsed: shared,
          early: errEnvelope(
            "check",
            "invalid_body",
            'POST /v1/check/node 的 body 不是合法 JSON。需要 {"name":"节点名"}',
            version(),
          ),
        };
      }
      if (!name) {
        return {
          parsed: shared,
          early: errEnvelope(
            "check",
            "node_name_required",
            'POST /v1/check/node 需要 JSON：{"name":"节点名"}',
            version(),
          ),
        };
      }
      return {
        parsed: {
          ...shared,
          command: "check",
          checkTarget: { kind: "node", name },
        },
      };
    }
    default:
      return {
        parsed: shared,
        early: errEnvelope(
          "serve",
          "unknown_route",
          `未知内部路由：${job.route}`,
          version(),
        ),
      };
  }
}

function version(): string {
  try {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 处理一次 serve 请求（不含 /health，health 在 Rust）。 */
export async function dispatchServeJob(
  base: ParsedCli,
  job: ServeJob,
  opts: CliDispatchOptions = {},
): Promise<CliEnvelope> {
  const { parsed, early } = parsedFromServeJob(base, job);
  if (early) return early;
  return dispatchCli(parsed, opts);
}

/** stdout 就绪横幅（CliEnvelope）。token 会出现在 data 里——仅本机 loopback。 */
export function serveReadyEnvelope(
  info: ServeStartInfo,
  appVersion: string,
): CliEnvelope {
  return okEnvelope(
    "serve",
    {
      host: info.host,
      port: info.port,
      token: info.token,
      baseUrl: info.baseUrl,
      bind: "127.0.0.1",
      auth: ["Authorization: Bearer <token>", "X-Egress-Token: <token>"],
      routes: [
        "GET /health",
        "POST /v1/discover",
        "POST /v1/gate",
        "POST /v1/env",
        "POST /v1/check/current",
        "POST /v1/check/all",
        "POST /v1/check/node",
      ],
      note: "请求串行处理（同一时间只跑一个 WebView 任务）。Ctrl+C 停止。",
    },
    appVersion,
  );
}
