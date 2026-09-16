import { useCallback, useEffect, useState } from "react";
import {
  defaultConfig,
  discoverAndProbe,
  getProxies,
  mockNodes,
  type ConnectionState,
  type ControllerConfig,
  type ProxyNode,
} from "../lib/mihomo";

const MOCK_PREF_KEY = "egress-checker.forceMock";

function readForceMock(): boolean {
  try {
    return localStorage.getItem(MOCK_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function useConnection() {
  const [forceMock, setForceMockState] = useState<boolean>(readForceMock);
  const [state, setState] = useState<ConnectionState>({
    status: "unknown",
    message: "尚未检测连接",
    config: defaultConfig(),
    currentProxy: null,
    usingMock: false,
  });
  const [nodes, setNodes] = useState<ProxyNode[]>([]);
  const [manual, setManual] = useState<Partial<ControllerConfig>>({});
  const [busy, setBusy] = useState(false);

  const setForceMock = (v: boolean) => {
    setForceMockState(v);
    try {
      localStorage.setItem(MOCK_PREF_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const refresh = useCallback(
    async (override?: Partial<ControllerConfig>, mockOverride?: boolean) => {
      setBusy(true);
      try {
        const useMock = mockOverride ?? forceMock;
        if (useMock) {
          const cfg = { ...defaultConfig(), ...manual, ...override };
          const list = mockNodes();
          const next: ConnectionState = {
            status: "mock",
            message: "已启用 Mock 演示模式（未请求真实 Mihomo API）",
            config: cfg,
            currentProxy: list[0]?.name ?? null,
            usingMock: true,
          };
          setState(next);
          setNodes(list);
          return next;
        }

        const merged = { ...manual, ...override };
        const next = await discoverAndProbe(
          Object.keys(merged).length ? merged : undefined,
        );
        setState(next);
        if (next.config) {
          const list = await getProxies(next.config);
          setNodes(list.nodes);
          setState({
            ...next,
            usingMock: next.usingMock || list.usingMock,
            currentProxy: list.currentProxy ?? next.currentProxy,
            message:
              list.usingMock && !next.usingMock
                ? `${next.message}（节点列表回退演示数据）`
                : next.message,
            status:
              list.usingMock && next.status !== "connected"
                ? "mock"
                : next.status,
          });
        }
        return next;
      } finally {
        setBusy(false);
      }
    },
    [manual, forceMock],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateManual = (patch: Partial<ControllerConfig>) => {
    setManual((m) => ({ ...m, ...patch }));
  };

  const resetManual = () => {
    setManual({});
  };

  return {
    state,
    nodes,
    busy,
    manual,
    forceMock,
    setForceMock,
    updateManual,
    resetManual,
    refresh,
    setNodes,
  };
}
