import { probeDelay } from "./client";
import { mockQuickResults } from "./mock";
import type { ControllerConfig, DelayResult, ProxyNode } from "./types";

const GOOGLE_URL = "https://www.google.com/generate_204";
const CF_URL = "https://cp.cloudflare.com/generate_204";
const ROUNDS = 3;

/** Port of test_single_node_stability from reference Python */
export async function testSingleNodeStability(
  config: ControllerConfig,
  node: ProxyNode,
): Promise<DelayResult> {
  const delays: number[] = [];
  let lost = 0;

  for (let i = 0; i < ROUNDS; i++) {
    const [d1, d2] = await Promise.all([
      probeDelay(config, node.name, GOOGLE_URL),
      probeDelay(config, node.name, CF_URL),
    ]);
    const valid = [d1, d2].filter((d): d is number => d != null);
    if (valid.length) delays.push(Math.min(...valid));
    else lost += 1;
  }

  const lossRate = Math.round((lost / ROUNDS) * 100);
  const avgDelay = delays.length
    ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
    : 9999;
  const jitter = delays.length > 1 ? Math.max(...delays) - Math.min(...delays) : 0;

  return {
    name: node.name,
    region: node.region,
    proto: node.type,
    avgDelay,
    jitter,
    lossRate,
    alive: delays.length > 0,
  };
}

export async function runQuickLatencyTest(
  config: ControllerConfig | null,
  nodes: ProxyNode[],
  usingMock: boolean,
  onProgress?: (done: number, total: number, latest: DelayResult) => void,
  concurrency = 6,
): Promise<DelayResult[]> {
  if (usingMock || !config) {
    const results = mockQuickResults(nodes);
    results.forEach((r, i) => onProgress?.(i + 1, results.length, r));
    return results.sort(sortDelayResults);
  }

  const results: DelayResult[] = [];
  let index = 0;

  async function worker() {
    while (index < nodes.length) {
      const i = index++;
      const node = nodes[i];
      const res = await testSingleNodeStability(config!, node);
      results.push(res);
      onProgress?.(results.length, nodes.length, res);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, nodes.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results.sort(sortDelayResults);
}

export function sortDelayResults(a: DelayResult, b: DelayResult): number {
  if (a.alive !== b.alive) return a.alive ? -1 : 1;
  if (a.lossRate !== b.lossRate) return a.lossRate - b.lossRate;
  return a.avgDelay - b.avgDelay;
}
