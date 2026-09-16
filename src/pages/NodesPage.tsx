import { useMemo, useState } from "react";
import {
  NODE_TEST_PLANS,
  classifyByRegion,
  closeConnections,
  runQuickLatencyTest,
  switchProxy,
  type ConnectionState,
  type DelayResult,
  type NodeTestMode,
  type ProxyNode,
} from "../lib/mihomo";

export function NodesPage({
  connection,
  nodes,
  onSwitched,
}: {
  connection: ConnectionState;
  nodes: ProxyNode[];
  onSwitched?: () => void;
}) {
  const [mode, setMode] = useState<NodeTestMode>("quick");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<DelayResult[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchMsg, setSwitchMsg] = useState("");

  const plan = useMemo(
    () => NODE_TEST_PLANS.find((p) => p.mode === mode)!,
    [mode],
  );

  const regionSummary = useMemo(() => {
    return classifyByRegion(nodes)
      .map(([reg, list]) => `${reg}(${list.length})`)
      .join(" · ");
  }, [nodes]);

  const start = async () => {
    if (!plan.implemented) return;
    setRunning(true);
    setResults([]);
    setProgress("准备中…");
    try {
      const list = await runQuickLatencyTest(
        connection.config,
        nodes,
        connection.usingMock || connection.status === "mock",
        (done, total, latest) => {
          setProgress(`${done}/${total} · ${latest.name}`);
          setResults((prev) => {
            const others = prev.filter((r) => r.name !== latest.name);
            return [...others, latest].sort((a, b) => {
              if (a.alive !== b.alive) return a.alive ? -1 : 1;
              if (a.lossRate !== b.lossRate) return a.lossRate - b.lossRate;
              return a.avgDelay - b.avgDelay;
            });
          });
        },
      );
      setResults(list);
      setProgress(`完成 ${list.length} 个节点`);
    } finally {
      setRunning(false);
    }
  };

  const doSwitch = async (name: string) => {
    if (!connection.config || connection.usingMock) {
      setSwitchMsg("Mock 模式：仅演示，未真正切换");
      return;
    }
    setSwitching(name);
    setSwitchMsg("");
    try {
      const ok =
        (await switchProxy(connection.config, "Proxy", name)) ||
        (await switchProxy(connection.config, "GLOBAL", name));
      if (ok) {
        await closeConnections(connection.config);
        setSwitchMsg(`已切换到：${name}`);
        onSwitched?.();
      } else {
        setSwitchMsg("切换失败：请确认 API secret 与分组名（Proxy/GLOBAL）");
      }
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>节点</h1>
          <p>
            Mihomo API 节点列表 · 当前：{connection.currentProxy ?? "—"} · 共{" "}
            {nodes.length} 个
            {connection.usingMock ? "（演示数据）" : ""}
          </p>
          {regionSummary ? (
            <p className="muted" style={{ marginTop: 4 }}>
              地区：{regionSummary}
            </p>
          ) : null}
        </div>
      </div>

      <div className="toolbar">
        {NODE_TEST_PLANS.map((p) => (
          <button
            key={p.mode}
            type="button"
            className={`mode-chip${mode === p.mode ? " active" : ""}`}
            onClick={() => setMode(p.mode)}
            title={p.description}
          >
            {p.label}
            {!p.implemented ? " · 即将推出" : ""}
          </button>
        ))}
        <span className="spacer" />
        <button
          className="btn btn-primary"
          type="button"
          disabled={running || !plan.implemented || nodes.length === 0}
          onClick={() => void start()}
        >
          {running ? "测试中…" : "开始"}
        </button>
      </div>

      <p className="muted" style={{ marginTop: 0 }}>
        {plan.description}
        {progress ? ` · ${progress}` : ""}
        {switchMsg ? ` · ${switchMsg}` : ""}
      </p>

      {!plan.implemented ? (
        <div className="note">
          该模式的 TypeScript 接口与 UI 已预留（见 <code>NodeTestMode</code> /
          <code>NODE_TEST_PLANS</code>）。深度测速将复用 switchProxy +
          closeConnections 并在结束后恢复节点。v1 仅实现「快速延迟」。
        </div>
      ) : null}

      <table className="data">
        <thead>
          <tr>
            <th>节点</th>
            <th>地区</th>
            <th>协议</th>
            <th>平均延迟</th>
            <th>抖动</th>
            <th>丢包</th>
            <th>存活</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {(results.length ? results : nodes.map(placeholderRow)).map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td>{r.region}</td>
              <td>{r.proto}</td>
              <td>{results.length ? `${r.avgDelay} ms` : "—"}</td>
              <td>{results.length ? `${r.jitter} ms` : "—"}</td>
              <td>{results.length ? `${r.lossRate}%` : "—"}</td>
              <td>{results.length ? (r.alive ? "是" : "否") : "—"}</td>
              <td>
                <button
                  className="btn"
                  type="button"
                  disabled={switching === r.name}
                  onClick={() => void doSwitch(r.name)}
                >
                  {switching === r.name ? "切换中…" : "切换"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function placeholderRow(n: ProxyNode): DelayResult {
  return {
    name: n.name,
    region: n.region,
    proto: n.type,
    avgDelay: 0,
    jitter: 0,
    lossRate: 0,
    alive: false,
  };
}
