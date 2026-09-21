import { invoke } from "@tauri-apps/api/core";

const isTauri = () =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/**
 * Whether a DIRECT browser fetch may be used as a fallback for a probe.
 *
 * In a production Tauri build this MUST be false: a direct fetch bypasses the
 * proxy and measures the machine's real egress, which would fabricate a "pass"
 * (or a bogus bandwidth number) for a node that the proxy could not actually
 * reach. It is only allowed in the plain-browser / web-preview harness (where
 * there is no proxy to bypass) or in an explicit dev build, so we can still run
 * the UI in a browser while developing.
 *
 * Kept pure (takes the two booleans) so it is unit-testable across all four
 * combinations.
 */
export function browserFallbackAllowed(env: {
  isTauri: boolean;
  dev: boolean;
}): boolean {
  if (!env.isTauri) return true; // pure browser / preview: nothing to bypass
  return env.dev; // Tauri dev build → allowed; production Tauri → refused
}

/** Runtime view of {@link browserFallbackAllowed} against the current env. */
export const canBrowserFallback = () =>
  browserFallbackAllowed({ isTauri: isTauri(), dev: import.meta.env.DEV });

export async function fetchTextViaProxy(
  url: string,
  opts: {
    mixedPort?: number | null;
    userAgent?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: boolean; status: number; text: string; via: "rust" | "browser" }> {
  if (isTauri()) {
    try {
      const res = await invoke<{ status: number; body: string }>("egress_proxy_fetch", {
        req: {
          url,
          mixedPort: opts.mixedPort ?? null,
          userAgent: opts.userAgent ?? null,
          timeoutMs: opts.timeoutMs ?? 5000,
        },
      });
      return {
        ok: res.status >= 200 && res.status < 400,
        status: res.status,
        text: res.body,
        via: "rust",
      };
    } catch {
      /* fall through */
    }
  }

  // Browser fallback is dev-only: in a production Tauri build a direct browser
  // fetch would bypass the proxy (leaking the real IP) — must not happen
  // silently. See {@link browserFallbackAllowed}.
  if (!canBrowserFallback()) {
    return { ok: false, status: 0, text: "", via: "browser" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const headers: Record<string, string> = {};
    if (opts.userAgent) headers["User-Agent"] = opts.userAgent;
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, via: "browser" };
  } catch {
    return { ok: false, status: 0, text: "", via: "browser" };
  } finally {
    clearTimeout(timer);
  }
}

export type DnsResolversPayload = {
  resolvers: string[];
  source: string;
  rawHint?: string;
  error?: string;
};

/** macOS: invoke Rust `scutil --dns` listing. Non-Tauri → empty + error. */
export async function listDnsResolvers(): Promise<DnsResolversPayload> {
  if (!isTauri()) {
    return {
      resolvers: [],
      source: "browser",
      error: "非 Tauri 环境，无法读取系统 DNS（需 macOS 上的 scutil）。",
    };
  }
  try {
    const res = await invoke<{
      resolvers: string[];
      source: string;
      rawHint?: string;
      error?: string;
    }>("egress_list_dns_resolvers");
    return {
      resolvers: res.resolvers ?? [],
      source: res.source ?? "scutil",
      rawHint: res.rawHint,
      error: res.error,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      resolvers: [],
      source: "invoke-error",
      error: `调用 egress_list_dns_resolvers 失败: ${msg}`,
    };
  }
}

export type DnsWhoamiPayload = {
  ok: boolean;
  clientIp?: string | null;
  resolverNs?: string | null;
  ecs?: string | null;
  via: string;
  raw: string;
  error?: string;
};

/**
 * Ground-truth DNS egress probe via Rust `dig TXT whoami.ds.akahelp.net`.
 * `resolver` forces the query through a specific recursive resolver (e.g.
 * "8.8.8.8"); omit to use the system default path. Returns who the query
 * actually left from (clientIp) and which resolver served it (resolverNs).
 */
export async function dnsWhoami(
  opts: { resolver?: string | null; timeoutMs?: number } = {},
): Promise<DnsWhoamiPayload> {
  if (!isTauri()) {
    return {
      ok: false,
      via: "browser",
      raw: "",
      error: "非 Tauri 环境，无法执行 dig 实测。",
    };
  }
  try {
    const res = await invoke<DnsWhoamiPayload>("egress_dns_whoami", {
      req: {
        resolver: opts.resolver ?? null,
        timeoutMs: opts.timeoutMs ?? 4000,
      },
    });
    return {
      ok: !!res.ok,
      clientIp: res.clientIp ?? null,
      resolverNs: res.resolverNs ?? null,
      ecs: res.ecs ?? null,
      via: res.via ?? "system",
      raw: res.raw ?? "",
      error: res.error,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      via: "invoke-error",
      raw: "",
      error: `调用 egress_dns_whoami 失败: ${msg}`,
    };
  }
}

export type TimedTransferResult = {
  ok: boolean;
  status: number;
  bytes: number;
  elapsedMs: number;
  error?: string;
  via: "rust" | "browser";
};

/**
 * Timed GET/POST through mixed-port (Rust preferred). Body is discarded on the
 * Rust side so Mbps reflects proxy path, not IPC of multi-MB payloads.
 */
export async function timedTransferViaProxy(opts: {
  url: string;
  mixedPort?: number | null;
  method?: "GET" | "POST";
  uploadBytes?: number;
  timeoutMs?: number;
}): Promise<TimedTransferResult> {
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? 12000;
  const uploadBytes = opts.uploadBytes ?? 0;

  if (isTauri()) {
    try {
      const res = await invoke<{
        ok: boolean;
        status: number;
        bytes: number;
        elapsedMs: number;
        error?: string | null;
      }>("egress_proxy_timed_transfer", {
        req: {
          url: opts.url,
          mixedPort: opts.mixedPort ?? null,
          method,
          uploadBytes: method === "POST" ? uploadBytes : null,
          timeoutMs,
        },
      });
      return {
        ok: !!res.ok,
        status: res.status ?? 0,
        bytes: res.bytes ?? 0,
        elapsedMs: res.elapsedMs ?? 0,
        error: res.error ?? undefined,
        via: "rust",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // In a production Tauri build we must NOT silently measure speed with a
      // direct browser fetch — that reports the machine's real bandwidth as if
      // it were the node's. Report an honest, not-ok "unverified" transfer.
      if (!canBrowserFallback()) {
        return {
          ok: false,
          status: 0,
          bytes: 0,
          elapsedMs: 0,
          error: `测速未能经代理完成（已拒绝直连兜底）：${msg}`,
          via: "browser",
        };
      }
      // Fall through to browser; keep invoke error if browser also fails.
      const browser = await timedTransferBrowser({
        url: opts.url,
        method,
        uploadBytes,
        timeoutMs,
      });
      if (!browser.ok && !browser.error) {
        browser.error = `Rust 调用失败后浏览器回退仍失败：${msg}`;
      }
      return browser;
    }
  }

  return timedTransferBrowser({
    url: opts.url,
    method,
    uploadBytes,
    timeoutMs,
  });
}

async function timedTransferBrowser(opts: {
  url: string;
  method: "GET" | "POST";
  uploadBytes: number;
  timeoutMs: number;
}): Promise<TimedTransferResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const t0 = performance.now();
  try {
    let res: Response;
    if (opts.method === "POST") {
      const body = new Uint8Array(opts.uploadBytes);
      res = await fetch(opts.url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
        signal: controller.signal,
      });
      // Drain response so timing includes full round-trip.
      await res.arrayBuffer().catch(() => null);
      const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
      const ok = res.ok || (res.status >= 200 && res.status < 400);
      return {
        ok,
        status: res.status,
        bytes: opts.uploadBytes,
        elapsedMs,
        error: ok ? undefined : `HTTP ${res.status}`,
        via: "browser",
      };
    }

    res = await fetch(opts.url, { signal: controller.signal });
    const buf = await res.arrayBuffer();
    const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
    const ok = (res.ok || (res.status >= 200 && res.status < 400)) && buf.byteLength > 0;
    return {
      ok,
      status: res.status,
      bytes: buf.byteLength,
      elapsedMs,
      error: ok ? undefined : res.status ? `HTTP ${res.status}` : "超时或不可达",
      via: "browser",
    };
  } catch (e) {
    const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = /abort/i.test(msg);
    return {
      ok: false,
      status: 0,
      bytes: 0,
      elapsedMs,
      error: aborted ? "超时" : msg,
      via: "browser",
    };
  } finally {
    clearTimeout(timer);
  }
}
