/**
 * CLI 命令调度：与 GUI 共用 mihomo / runner / egress / score。
 * 无 React；结果收成 CliEnvelope。
 */
import { runNodeDiagnostics, type CheckCard, type EgressReport } from "../egress";
import {
  defaultConfig,
  discoverAndProbe,
  getProxies,
  mockNodes,
  normalizeClientId,
  type ClientId,
  type ConnectionState,
  type ProxyNode,
} from "../mihomo";
import { runEnv, testAll, testOne, type RunnerHooks } from "../runner";
import { runLightGate, scoreNodeFromCards, type NodeScoreResult } from "../score";
import { CLI_HELP_TEXT, type ParsedCli } from "./parse";
import { errEnvelope, okEnvelope, type CliEnvelope } from "./types";

function version(): string {
  try {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function requireClient(parsed: ParsedCli): ClientId | { error: CliEnvelope } {
  if (parsed.mock) return (normalizeClientId(parsed.clientId) ?? "verge") as ClientId;
  const id = normalizeClientId(parsed.clientId);
  if (!id) {
    return {
      error: errEnvelope(
        parsed.command,
        "client_required",
        "请用 --client 指定软件（verge / flclash / clashx_meta / mihomo_party / nyanpasu），或加 --mock。",
        version(),
      ),
    };
  }
  return id;
}

async function loadConnection(
  parsed: ParsedCli,
  clientId: ClientId,
): Promise<{ connection: ConnectionState; nodes: ProxyNode[] }> {
  if (parsed.mock) {
    const list = mockNodes();
    const connection: ConnectionState = {
      status: "mock",
      message: "CLI --mock 演示模式",
      config: defaultConfig(),
      currentProxy: list[0]?.name ?? null,
      usingMock: true,
      proxiesError: null,
    };
    return { connection, nodes: list };
  }
  const connection = await discoverAndProbe(undefined, clientId);
  let nodes: ProxyNode[] = [];
  if (connection.config && connection.status === "connected") {
    try {
      const r = await getProxies(connection.config);
      nodes = r.nodes;
    } catch {
      nodes = [];
    }
  }
  return { connection, nodes };
}

function collectingHooks(): {
  hooks: RunnerHooks;
  getScores: () => NodeScoreResult[];
  getCards: () => CheckCard[];
  getReport: () => EgressReport | null;
  getEnvCards: () => CheckCard[];
  getHint: () => string | null;
} {
  let scores: NodeScoreResult[] = [];
  let cards: CheckCard[] = [];
  let report: EgressReport | null = null;
  let envCards: CheckCard[] = [];
  let hint: string | null = null;

  const hooks: RunnerHooks = {
    onProgress: () => {},
    onNodeCards: (c) => {
      cards = c;
    },
    onUpsertNodeCard: (c) => {
      const i = cards.findIndex((x) => x.id === c.id);
      if (i >= 0) cards[i] = c;
      else cards.push(c);
    },
    onReport: (r) => {
      report = r;
    },
    onUpsertScore: (s) => {
      const i = scores.findIndex((x) => x.nodeName === s.nodeName);
      if (i >= 0) scores[i] = s;
      else scores.push(s);
    },
    onScores: (list) => {
      scores = list;
    },
    onHint: (m) => {
      hint = m;
    },
    onRestoreError: (m) => {
      if (m) hint = m;
    },
    onGate: () => {},
    onEnvCards: (c) => {
      envCards = c;
    },
    onUpsertEnvCard: (c) => {
      const i = envCards.findIndex((x) => x.id === c.id);
      if (i >= 0) envCards[i] = c;
      else envCards.push(c);
    },
  };

  return {
    hooks,
    getScores: () => scores,
    getCards: () => cards,
    getReport: () => report,
    getEnvCards: () => envCards,
    getHint: () => hint,
  };
}

export async function dispatchCli(parsed: ParsedCli): Promise<CliEnvelope> {
  const ver = version();
  const cmd = parsed.command;

  if (cmd === "help") {
    return okEnvelope("help", { text: CLI_HELP_TEXT }, ver);
  }

  const clientOrErr = requireClient(parsed);
  if (typeof clientOrErr === "object" && "error" in clientOrErr) {
    return clientOrErr.error;
  }
  const clientId = clientOrErr;

  try {
    if (cmd === "discover") {
      const { connection, nodes } = await loadConnection(parsed, clientId);
      return okEnvelope(
        "discover",
        {
          clientId,
          status: connection.status,
          message: connection.message,
          currentProxy: connection.currentProxy,
          usingMock: connection.usingMock,
          config: connection.config
            ? {
                host: connection.config.host,
                port: connection.config.port,
                mixedPort: connection.config.mixedPort,
                source: connection.config.source,
                sockPath: connection.config.sockPath,
                // never echo secret
              }
            : null,
          nodeCount: nodes.length,
          nodes: nodes.slice(0, 50).map((n) => ({
            name: n.name,
            type: n.type,
            region: n.region,
          })),
        },
        ver,
      );
    }

    if (cmd === "gate") {
      const { connection } = await loadConnection(parsed, clientId);
      const gate = await runLightGate(connection);
      return okEnvelope(
        "gate",
        {
          clientId,
          connectionStatus: connection.status,
          gate,
        },
        ver,
      );
    }

    if (cmd === "env") {
      const { connection } = await loadConnection(parsed, clientId);
      const bag = collectingHooks();
      await runEnv(
        {
          connection,
          mixedPort: connection.config?.mixedPort ?? null,
          exitIp: null,
        },
        bag.hooks,
      );
      return okEnvelope(
        "env",
        { clientId, cards: bag.getEnvCards() },
        ver,
      );
    }

    if (cmd === "check") {
      const target = parsed.checkTarget ?? { kind: "current" as const };
      const { connection, nodes } = await loadConnection(parsed, clientId);
      const mixedPort = connection.config?.mixedPort ?? null;
      const bag = collectingHooks();

      if (target.kind === "current") {
        const report = await runNodeDiagnostics(bag.hooks.onUpsertNodeCard, {
          mixedPort,
          mihomoConfig: connection.config,
        });
        const name = connection.currentProxy ?? "当前节点";
        const score = scoreNodeFromCards(name, report.cards, report.ranAt);
        return okEnvelope(
          "check",
          {
            target: "current",
            clientId,
            nodeName: name,
            score: {
              stars: score.stars,
              totalScore: score.totalScore,
              blurb: score.blurb,
            },
            cards: report.cards,
            note: report.note,
          },
          ver,
        );
      }

      if (target.kind === "node") {
        if (!target.name) {
          return errEnvelope(
            "check",
            "node_name_required",
            "check node 需要节点名称，例如：--cli check node \"香港\"",
            ver,
          );
        }
        const node =
          nodes.find((n) => n.name === target.name) ??
          nodes.find((n) => n.name.includes(target.name)) ??
          ({
            name: target.name,
            type: "Unknown",
            region: "未知",
            raw: { name: target.name, type: "Unknown" },
          } satisfies ProxyNode);

        await testOne(
          {
            node,
            connection,
            forceMock: parsed.mock,
            mixedPort,
            ensureGate: async () => runLightGate(connection),
          },
          bag.hooks,
        );
        const scores = bag.getScores();
        const score = scores[0];
        return okEnvelope(
          "check",
          {
            target: "node",
            clientId,
            nodeName: node.name,
            score: score
              ? {
                  stars: score.stars,
                  totalScore: score.totalScore,
                  blurb: score.blurb,
                }
              : null,
            cards: score?.cards ?? bag.getCards(),
            hint: bag.getHint(),
          },
          ver,
        );
      }

      // all
      let aborted = false;
      await testAll(
        {
          connection,
          nodes,
          forceMock: parsed.mock,
          mixedPort,
          ensureGate: async () => runLightGate(connection),
          shouldAbort: () => aborted,
        },
        bag.hooks,
      );
      const scores = bag.getScores();
      return okEnvelope(
        "check",
        {
          target: "all",
          clientId,
          count: scores.length,
          scores: scores.map((s) => ({
            nodeName: s.nodeName,
            stars: s.stars,
            totalScore: s.totalScore,
            blurb: s.blurb,
          })),
          hint: bag.getHint(),
        },
        ver,
      );
    }

    return errEnvelope("unknown", "unknown_command", `未知命令：${cmd}`, ver);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errEnvelope(cmd, "dispatch_error", message, ver);
  }
}

/** 人类可读一行摘要（--no-json）。 */
export function formatCliHuman(env: CliEnvelope): string {
  if (!env.ok) {
    return `ERROR [${env.error?.code ?? "?"}] ${env.error?.message ?? "失败"}`;
  }
  if (env.command === "help") {
    const text = (env.data as { text?: string } | undefined)?.text;
    return text ?? CLI_HELP_TEXT;
  }
  return JSON.stringify(env, null, 2);
}
