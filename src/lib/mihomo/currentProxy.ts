/**
 * Resolve which node the user is actually on from the /proxies map.
 *
 * The old logic blindly read `Proxy/GLOBAL/proxy.now`. That breaks under a
 * Clash Verge subscription in rule mode: mihomo always exposes a `GLOBAL`
 * pseudo-group whose `now` sits at `DIRECT` while global mode is off, so the
 * header showed "当前：DIRECT" even though the user had picked a real node in a
 * Chinese-named group like `节点选择`.
 *
 * This scans preferred user-facing groups first and only accepts a group whose
 * `now` resolves to a real leaf proxy (never DIRECT/PASS/REJECT or another
 * group). When several sub-groups disagree (rule mode with no canonical group)
 * it returns null so the UI can show "—" honestly instead of guessing.
 */
import { IGNORE_PROXY_TYPES, JUNK_NAME_KEYWORDS, type ProxyInfo } from "./types";

const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance"]);

/** User-facing selector groups, most authoritative first. */
export const PREFER_GROUP_NAMES = [
  "Proxy",
  "GLOBAL",
  "proxy",
  "SELECT",
  "节点选择",
  "手动选择",
  "自动选择",
];

function isJunkName(name: string): boolean {
  if (name.startsWith("PASS") || name.startsWith("REJECT")) return true;
  return JUNK_NAME_KEYWORDS.some((k) => name.includes(k));
}

/** A real leaf proxy: exists, not a group/pseudo type (Direct/Reject/Pass…), not junk. */
function isRealLeaf(
  proxies: Record<string, ProxyInfo>,
  name: string | undefined,
): name is string {
  if (!name) return false;
  const p = proxies[name];
  if (!p) return false;
  if (IGNORE_PROXY_TYPES.has(p.type)) return false;
  return !isJunkName(name);
}

function groupNowLeaf(
  proxies: Record<string, ProxyInfo>,
  group: string,
): string | null {
  const now = proxies[group]?.now;
  return isRealLeaf(proxies, now) ? now : null;
}

export function resolveCurrentProxy(
  proxies: Record<string, ProxyInfo>,
): string | null {
  for (const g of PREFER_GROUP_NAMES) {
    const leaf = groupNowLeaf(proxies, g);
    if (leaf) return leaf;
  }
  const distinct = new Set<string>();
  for (const p of Object.values(proxies)) {
    if (GROUP_TYPES.has(p.type) && isRealLeaf(proxies, p.now)) {
      distinct.add(p.now);
    }
  }
  return distinct.size === 1 ? [...distinct][0] : null;
}
