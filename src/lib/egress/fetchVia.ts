import { invoke } from "@tauri-apps/api/core";

const isTauri = () =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

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
