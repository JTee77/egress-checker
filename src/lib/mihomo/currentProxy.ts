/**
 * Resolve which node the user is actually on from the /proxies map.
 *
 * Preferred groups (Proxy, GLOBAL, 节点选择, …) are followed through nested
 * Selector / URLTest / Fallback / LoadBalance chains until a real leaf.
 * DIRECT, REJECT, PASS, and other group names are never returned.
 *
 * After a subscription switch the main picker is often renamed (「🚀 节点选择」)
 * and policy groups (NETFLIX, AI, Telegram, …) disagree on `now`. An exact
 * preferred name that chains to a leaf still wins. Otherwise a Selector whose
 * name looks like the main picker (选择 / proxy, including an emoji prefix)
 * wins — even when it only lists other groups and the real node is further
 * down the chain. If there is no such name, the Selector with the most real
 * leaves wins. Null only when that is still ambiguous, or the main picker
 * itself is sitting on DIRECT.
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

const MAX_HOPS = 8;

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

/**
 * 3 = main picker (节点选择 / proxy / …), 2 = some other「选择」group,
 * 1 = name mentions 节点 (often a region subgroup), 0 = neither.
 */
function nameRank(name: string): number {
  const lower = name.toLowerCase();
  if (
    name.includes("节点选择") ||
    name.includes("手动选择") ||
    name.includes("选择节点") ||
    name.includes("代理选择") ||
    name.includes("选择代理") ||
    lower.includes("proxy")
  ) {
    return 3;
  }
  if (name.includes("选择")) return 2;
  if (name.includes("节点")) return 1;
  return 0;
}

/** Walk `now` through nested groups until a real leaf. Cycles and DIRECT stop as null. */
function followToLeaf(
  proxies: Record<string, ProxyInfo>,
  start: string,
): string | null {
  const seen = new Set<string>();
  let current: string | undefined = start;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!current || seen.has(current)) return null;
    seen.add(current);
    if (isRealLeaf(proxies, current)) return current;
    const group: ProxyInfo | undefined = proxies[current];
    if (!group || !GROUP_TYPES.has(group.type)) return null;
    current = group.now;
  }
  return null;
}

function countRealLeaves(
  proxies: Record<string, ProxyInfo>,
  group: ProxyInfo,
): number {
  let n = 0;
  for (const name of group.all ?? []) {
    if (isRealLeaf(proxies, name)) n++;
  }
  return n;
}

interface Cand {
  leaf: string;
  leaves: number;
  rank: number;
  selector: boolean;
}

/** Highest rank, then most real leaves. Different leaves at that peak → null. */
function uniqueByRank(cands: Cand[]): string | null {
  return uniqueBy(cands, (c) => [c.rank, c.leaves]);
}

/** Most real leaves, then higher name rank. Different leaves at that peak → null. */
function uniqueBySize(cands: Cand[]): string | null {
  return uniqueBy(cands, (c) => [c.leaves, c.rank]);
}

function uniqueBy(
  cands: Cand[],
  key: (c: Cand) => [number, number],
): string | null {
  if (cands.length === 0) return null;
  let best = key(cands[0]);
  for (const c of cands) {
    const k = key(c);
    if (k[0] > best[0] || (k[0] === best[0] && k[1] > best[1])) best = k;
  }
  const top = cands.filter((c) => {
    const k = key(c);
    return k[0] === best[0] && k[1] === best[1];
  });
  const leaf = top[0].leaf;
  return top.every((c) => c.leaf === leaf) ? leaf : null;
}

export function resolveCurrentProxy(
  proxies: Record<string, ProxyInfo>,
): string | null {
  for (const g of PREFER_GROUP_NAMES) {
    if (!proxies[g]) continue;
    const leaf = followToLeaf(proxies, g);
    if (leaf) return leaf;
  }

  const strong: Cand[] = [];
  let sawStrongSelector = false;
  const resolved: Cand[] = [];

  for (const [name, p] of Object.entries(proxies)) {
    if (!GROUP_TYPES.has(p.type)) continue;
    const rank = nameRank(name);
    const selector = p.type === "Selector";
    if (selector && rank >= 2) sawStrongSelector = true;
    const leaf = followToLeaf(proxies, name);
    if (!leaf) continue;
    const cand: Cand = {
      leaf,
      leaves: countRealLeaves(proxies, p),
      rank,
      selector,
    };
    resolved.push(cand);
    if (selector && rank >= 2) strong.push(cand);
  }

  // A renamed main picker (「🚀 节点选择」) owns the answer. If every such
  // selector is on DIRECT, do not borrow a niche policy group's node.
  if (sawStrongSelector) return uniqueByRank(strong);

  if (resolved.length === 0) return null;
  const only = resolved[0].leaf;
  if (resolved.every((c) => c.leaf === only)) return only;

  const selectors = resolved.filter((c) => c.selector);
  return uniqueBySize(selectors.length > 0 ? selectors : resolved);
}
