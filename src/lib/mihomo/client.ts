/**
 * Mihomo REST client.
 * Prefer Tauri Rust HTTP (reqwest) to 127.0.0.1 to avoid WebView CORS;
 * fall back to unix socket invoke, then browser fetch (dev only).
 * Never log secret values.
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
import { mockNodes, mockProxiesRaw } from "./mock";

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

async function httpApi(
  config: ControllerConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 3000,
): Promise<HttpResult | null> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

  const viaRust = await rustHttp(config, method, path, bodyStr, timeoutMs);
  if (viaRust) return viaRust;

  const viaSock = await unixHttp(config, method, path, bodyStr, timeoutMs);
  if (viaSock) return viaSock;

  return browserFetch(config, method, path, body, timeoutMs);
}

export function filterNodes(
  proxies: Record<string, ProxyInfo>,
): { nodes: ProxyNode[]; currentProxy: string | null } {
  const currentProxy =
    proxies.Proxy?.now ?? proxies.GLOBAL?.now ?? proxies.proxy?.now ?? null;
  const nodes: ProxyNode[] = [];
  for (const [name, p] of Object.entries(proxies)) {
    if (IGNORE_PROXY_TYPES.has(p.type)) continue;
    if (name.startsWith("PASS") || name.startsWith("REJECT")) continue;
    if (JUNK_NAME_KEYWORDS.some((k) => name.includes(k))) continue;
    nodes.push({
      name,
      type: p.type,
      region: detectRegion(name),
      raw: p,
    });
  }
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

  const res = await httpApi(config, "GET", "/version", undefined, 2000);
  if (!res) {
    return {
      status: "mock",
      message: "无法连接 Mihomo API，已启用演示数据（Mock）",
      config,
      currentProxy: mockNodes()[0]?.name ?? null,
      usingMock: true,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      status: "unauthorized",
      message: "Secret 不正确或未配置",
      config,
      currentProxy: null,
      usingMock: false,
    };
  }
  if (res.status !== 200) {
    return {
      status: "unreachable",
      message: `API 返回 HTTP ${res.status}`,
      config,
      currentProxy: null,
      usingMock: false,
    };
  }

  const proxiesRes = await getProxies(config);
  return {
    status: "connected",
    message: `已连接 ${config.host}:${config.port}（${config.source}）`,
    config,
    currentProxy: proxiesRes.currentProxy,
    usingMock: false,
  };
}

export async function getProxies(config: ControllerConfig): Promise<{
  nodes: ProxyNode[];
  currentProxy: string | null;
  usingMock: boolean;
}> {
  const res = await httpApi(config, "GET", "/proxies");
  if (!res || res.status !== 200 || !res.json) {
    return {
      nodes: mockNodes(),
      currentProxy: mockNodes()[0]?.name ?? null,
      usingMock: true,
    };
  }
  const obj = res.json as { proxies?: Record<string, ProxyInfo> };
  const proxies = obj.proxies ?? {};
  const filtered = filterNodes(proxies);
  return { ...filtered, usingMock: false };
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
  return !!res && res.status >= 200 && res.status < 300;
}

export async function closeConnections(config: ControllerConfig): Promise<boolean> {
  const res = await httpApi(config, "DELETE", "/connections");
  return !!res && res.status >= 200 && res.status < 300;
}

export async function getVersion(config: ControllerConfig): Promise<string | null> {
  const res = await httpApi(config, "GET", "/version");
  if (!res || res.status !== 200) return null;
  const v = res.json as { version?: string; meta?: boolean };
  return v?.version ?? "ok";
}

/** Expose mock raw for tests / debug */
export { mockProxiesRaw };
