import type { NodeCapabilities } from "./types";

/**
 * Ordered label map for the six mihomo `/proxies` capability flags. Render
 * order follows this array. To silence a flag that turns out to be noisy across
 * your subscriptions (e.g. `udp` is on for nearly every node), comment out its
 * entry here — nothing else needs to change.
 */
export const CAPABILITY_LABELS: [keyof NodeCapabilities, string][] = [
  ["udp", "UDP"],
  ["xudp", "XUDP"],
  ["uot", "UoT"],
  ["tfo", "TFO"],
  ["smux", "Mux"],
  ["mptcp", "MPTCP"],
];

/**
 * Display labels for every capability a node reports as explicitly `true`,
 * in {@link CAPABILITY_LABELS} order. Absent/undefined flags never render, so
 * a node whose subscription does not light a flag shows nothing for it.
 */
export function nodeCapabilityChips(node: NodeCapabilities): string[] {
  return CAPABILITY_LABELS.filter(([key]) => node[key] === true).map(
    ([, label]) => label,
  );
}
