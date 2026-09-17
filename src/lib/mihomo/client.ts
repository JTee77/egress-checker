/**
 * Mihomo REST client.
 * Prefer Tauri Rust HTTP (reqwest) to 127.0.0.1 to avoid WebView CORS;
 * fall back to unix socket invoke, then browser fetch (dev only).
 * Never log secret values.
 * Never auto-fallback to mock nodes — Mock is Settings toggle only.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  IGNORE_PROXY_TYPES,
  JUNK_NAME_KEYWORDS,
  type ConnectionState,
  type ControllerConfig,
  type ProxyInfo,
  type ProxyNode,
} from "./types";
import { detectRegion } from "./regions";
import { mockProxiesRaw } from "./mock";

const isTauri = () =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

async function discoverViaRust(): Promise<ControllerConfig | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<ControllerConfig>("discover_mihomo");
  } catch {
    return null;
  }
}

export function defaultConfig(): ControllerConfig {
  return {
    host: "127.0.0.1",
    port: 9097,
    secret: "",
    mixedPort: 7897,
    source: "manual-default",
    sockPath: "/tmp/verge/verge-mihomo.sock",
  };
}

type HttpResult = { status: number; json: unknown; raw: string };

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

async function rustHttp(
  config: ControllerConfig,
  method: string,
  path: string,
  body?: string,
  timeoutMs = 3000,
): Promise<HttpResult | null> {
  if (!isTauri()) return null;
  try {
    const res = await invoke<{ status: number; body: string }>("mihomo_http", {
      req: {
        host: config.host,
        port: config.port,
        method,
        path,
        body: body ?? null,
        secret: config.secret,
        timeoutMs,
      },
    });
    let json: unknown = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, raw: res.body };
  } catch {
    return null;
  }
}

async function unixHttp(
  config: ControllerConfig,
  method: string,
  path: string,
  body?: string,
  timeoutMs = 3000,
): Promise<HttpResult | null> {
  if (!isTauri()) return null;
  try {
    const res = await invoke<{ status: number; body: string }>("mihomo_unix_http", {
      req: {
        method,
        path,
        body: body ?? null,
        secret: config.secret,
        sockPath: config.sockPath ?? null,
        timeoutMs,
      },
    });
    let json: unknown = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, raw: res.body };
  } catch {
    return null;
  }
}

async function browserFetch(
  config: ControllerConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 3000,
): Promise<HttpResult | null> {
  const url = `http://${config.host}:${config.port}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.secret) {
    headers.Authorization = `Bearer ${config.secret}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const raw = await res.text();
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, raw };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prefer first successful 2xx across TCP → unix socket → browser.
 * Do not return a failed TCP response as final if unix/browser might work.
 */
async function httpApi(
  config: ControllerConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 3000,
): Promise<HttpResult | null> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

  const viaRust = await rustHttp(config, method, path, bodyStr, timeoutMs);
  if (viaRust && is2xx(viaRust.status)) return viaRust;

  const viaSock = await unixHttp(config, method, path, bodyStr, timeoutMs);
  if (viaSock && is2xx(viaSock.status)) return viaSock;

  const viaBrowser = await browserFetch(config, method, path, body, timeoutMs);
  if (viaBrowser && is2xx(viaBrowser.status)) return viaBrowser;

  // No 2xx: prefer any non-null response (sock > tcp > browser) so callers see 401 etc.
  return viaSock ?? viaRust ?? viaBrowser;
}

function isJunkName(name: string): boolean {
  if (name.startsWith("PASS") || name.startsWith("REJECT")) return true;
  return JUNK_NAME_KEYWORDS.some((k) => name.includes(k));
}

function toNode(name: string, p: ProxyInfo): ProxyNode {
  return {
    name,
    type: p.type,
    region: detectRegion(name),
    raw: p,
  };
}

export function filterNodes(
  proxies: Record<string, ProxyInfo>,
): { nodes: ProxyNode[]; currentProxy: string | null } {
  const currentProxy =
    proxies.Proxy?.now ?? proxies.GLOBAL?.now ?? proxies.proxy?.now ?? null;
  const nodes: ProxyNode[] = [];
  for (const [name, p] of Object.entries(proxies)) {
    if (IGNORE_PROXY_TYPES.has(p.type)) continue;
    if (isJunkName(name)) continue;
    nodes.push(toNode(name, p));
  }
  return { nodes, currentProxy };
}

/**
 * When flat filter yields empty, resolve leaf names from Selector `all` arrays
 * that exist as keys in the proxies map (common Clash profile shape).
 */
export function resolveNodesFromGroups(
  proxies: Record<string, ProxyInfo>,
): { nodes: ProxyNode[]; currentProxy: string | null } {
  const currentProxy =
    proxies.Proxy?.now ?? proxies.GLOBAL?.now ?? proxies.proxy?.now ?? null;

  const leafNames = new Set<string>();
  const preferGroups = ["Proxy", "GLOBAL", "proxy"];

  const considerAll = (all: string[] | undefined) => {
    if (!all) return;
    for (const name of all) {
      const p = proxies[name];
      if (!p) continue;
      if (IGNORE_PROXY_TYPES.has(p.type)) continue;
      if (isJunkName(name)) continue;
      leafNames.add(name);
    }
  };

  for (const g of preferGroups) {
    considerAll(proxies[g]?.all);
  }
  for (const [, p] of Object.entries(proxies)) {
    if (p.type === "Selector" || p.type === "URLTest" || p.type === "Fallback") {
      considerAll(p.all);
    }
  }

  const nodes = [...leafNames].map((name) => toNode(name, proxies[name]));
  return { nodes, currentProxy };
}

export async function discoverAndProbe(
  manual?: Partial<ControllerConfig>,
): Promise<ConnectionState> {
  let config = defaultConfig();
  const discovered = await discoverViaRust();
  if (discovered) {
    config = { ...config, ...discovered };
  }
  if (manual && Object.keys(manual).length > 0) {
    const isManual =
      manual.source === "manual" ||
      manual.host !== undefined ||
      manual.port !== undefined ||
      manual.secret !== undefined ||
      manual.mixedPort !== undefined;
    config = {
      ...config,
      ...manual,
      source: isManual && manual.source !== "auto" ? (manual.source ?? "manual") : config.source,
    };
  }

  const sockLabel = config.sockPath ?? "/tmp/verge/verge-mihomo.sock";

  // Prefer brief TCP probe; on failure try Unix (Verge often has sock only).
  const viaTcp = await rustHttp(config, "GET", "/version", undefined, 1500);
  if (viaTcp && (viaTcp.status === 401 || viaTcp.status === 403)) {
    return {
      status: "unauthorized",
      message: "Secret 不正确或未配置",
      config,
      currentProxy: null,
      usingMock: false,
      proxiesError: "API 返回未授权（401/403），请到设置检查 Secret",
    };
  }
  if (viaTcp && is2xx(viaTcp.status)) {
    return {
      status: "connected",
      message: `已连接 ${config.host}:${config.port}（${config.source}）`,
      config,
      currentProxy: null,
      usingMock: false,
      proxiesError: null,
    };
  }

  const viaSock = await unixHttp(config, "GET", "/version", undefined, 2000);
  if (viaSock && (viaSock.status === 401 || viaSock.status === 403)) {
    return {
      status: "unauthorized",
      message: "Secret 不正确或未配置",
      config,
      currentProxy: null,
      usingMock: false,
      proxiesError: "API 返回未授权（401/403），请到设置检查 Secret",
    };
  }
  if (viaSock && is2xx(viaSock.status)) {
    return {
      status: "connected",
      message: `已连接 Unix 套接字 ${sockLabel}（${config.source}）`,
      config,
      currentProxy: null,
      usingMock: false,
      proxiesError: null,
    };
  }

  // Dev / non-Tauri browser fallback
  const viaBrowser = await browserFetch(config, "GET", "/version", undefined, 2000);
  if (viaBrowser && (viaBrowser.status === 401 || viaBrowser.status === 403)) {
    return {
      status: "unauthorized",
      message: "Secret 不正确或未配置",
      config,
      currentProxy: null,
      usingMock: false,
      proxiesError: "API 返回未授权（401/403），请到设置检查 Secret",
    };
  }
  if (viaBrowser && is2xx(viaBrowser.status)) {
    return {
      status: "connected",
      message: `已连接 ${config.host}:${config.port}（${config.source}）`,
      config,
      currentProxy: null,
      usingMock: false,
      proxiesError: null,
    };
  }

  if (viaSock || viaTcp || viaBrowser) {
    const status = (viaSock ?? viaTcp ?? viaBrowser)!.status;
    return {
      status: "unreachable",
      message: `API 返回 HTTP ${status}`,
      config,
      currentProxy: null,
      usingMock: false,
      proxiesError: null,
    };
  }

  return {
    status: "unreachable",
    message:
      "无法连接 Mihomo API（TCP 与 Unix 均失败），请检查 Clash Verge Rev 是否运行",
    config,
    currentProxy: null,
    usingMock: false,
    proxiesError: null,
  };
}

export type GetProxiesResult = {
  nodes: ProxyNode[];
  currentProxy: string | null;
  usingMock: false;
  error: string | null;
  unauthorized: boolean;
};

async function getProxiesViaSlimCommand(
  config: ControllerConfig,
): Promise<GetProxiesResult | null> {
  if (!isTauri()) return null;
  try {
    const res = await invoke<{
      nodes: { name: string; type: string }[];
      currentProxy: string | null;
      status: number;
      error: string | null;
      unauthorized: boolean;
      transport?: string | null;
    }>("mihomo_list_nodes", {
      req: {
        host: config.host,
        port: config.port,
        secret: config.secret,
        timeoutMs: 18000,
        sockPath: config.sockPath ?? "/tmp/verge/verge-mihomo.sock",
      },
    });
    const nodes: ProxyNode[] = (res.nodes ?? []).map((n) =>
      toNode(n.name, { name: n.name, type: n.type }),
    );
    return {
      nodes,
      currentProxy: res.currentProxy ?? null,
      usingMock: false,
      error: res.error ?? (nodes.length === 0 ? "节点列表为空" : null),
      unauthorized: !!res.unauthorized,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e ?? "");
    return {
      nodes: [],
      currentProxy: null,
      usingMock: false,
      error: detail
        ? `mihomo_list_nodes 失败: ${detail}`
        : "mihomo_list_nodes 调用失败",
      unauthorized: false,
    };
  }
}

export async function getProxies(config: ControllerConfig): Promise<GetProxiesResult> {
  const empty = (
    error: string,
    unauthorized = false,
  ): GetProxiesResult => ({
    nodes: [],
    currentProxy: null,
    usingMock: false,
    error,
    unauthorized,
  });

  // Prefer slim Rust command — strips history arrays and caps body size.
  const slim = await getProxiesViaSlimCommand(config);
  if (slim) return slim;

  // Fallback: full /proxies via TCP/unix/browser (dev / non-Tauri).
  const res = await httpApi(config, "GET", "/proxies", undefined, 18000);
  if (!res) {
    return empty("无法拉取 /proxies（超时或网络失败），请到设置检查连接后刷新");
  }
  if (res.status === 401 || res.status === 403) {
    return empty(
      "拉取节点未授权（401/403），请到设置检查 Secret / 刷新",
      true,
    );
  }
  if (!is2xx(res.status) || !res.json) {
    if (is2xx(res.status) && !res.json) {
      return empty(
        `拉取 /proxies 失败（HTTP ${res.status}）：响应不是合法 JSON（可能解压/分块失败），raw ${res.raw.length} 字节`,
      );
    }
    return empty(
      `拉取 /proxies 失败（HTTP ${res.status}），请到设置检查 Secret / 刷新`,
    );
  }

  const obj = res.json as { proxies?: Record<string, ProxyInfo> };
  const proxies = obj.proxies ?? {};
  let filtered = filterNodes(proxies);
  if (filtered.nodes.length === 0) {
    filtered = resolveNodesFromGroups(proxies);
  }
  if (filtered.nodes.length === 0) {
    return {
      nodes: [],
      currentProxy: filtered.currentProxy,
      usingMock: false,
      error:
        "已连接但未解析到可用节点，请到设置检查 Secret / 刷新，或确认订阅已加载",
      unauthorized: false,
    };
  }
  return {
    nodes: filtered.nodes,
    currentProxy: filtered.currentProxy,
    usingMock: false,
    error: null,
    unauthorized: false,
  };
}

export async function probeDelay(
  config: ControllerConfig,
  nodeName: string,
  url: string,
  timeout = 2500,
): Promise<number | null> {
  const enc = encodeURIComponent(nodeName);
  const path = `/proxies/${enc}/delay?timeout=${timeout}&url=${encodeURIComponent(url)}`;
  const res = await httpApi(config, "GET", path, undefined, timeout + 800);
  if (!res || res.status !== 200 || !res.json) return null;
  const delay = (res.json as { delay?: number }).delay;
  return delay && delay > 0 ? delay : null;
}

export async function switchProxy(
  config: ControllerConfig,
  group: string,
  name: string,
): Promise<boolean> {
  const enc = encodeURIComponent(group);
  const res = await httpApi(config, "PUT", `/proxies/${enc}`, { name });
  return !!res && is2xx(res.status);
}

export async function closeConnections(config: ControllerConfig): Promise<boolean> {
  const res = await httpApi(config, "DELETE", "/connections");
  return !!res && is2xx(res.status);
}

export async function getVersion(config: ControllerConfig): Promise<string | null> {
  const res = await httpApi(config, "GET", "/version");
  if (!res || res.status !== 200) return null;
  const v = res.json as { version?: string; meta?: boolean };
  return v?.version ?? "ok";
}

/** Expose mock raw for tests / debug */
export { mockProxiesRaw };
