import { useCallback, useRef, useState } from "react";
import {
  CLIENT_STORAGE_KEY,
  defaultConfig,
  discoverAndProbe,
  getProxies,
  isClientId,
  mockNodes,
  type ClientId,
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
  const [clientId, setClientIdState] = useState<ClientId | null>(() => {
    try {
      const v = localStorage.getItem(CLIENT_STORAGE_KEY);
      return isClientId(v) ? v : null;
    } catch {
      return null;
    }
  });
  const [state, setState] = useState<ConnectionState>({
    status: "unknown",
    message: "尚未检测连接",
    config: defaultConfig(),
    currentProxy: null,
    usingMock: false,
    proxiesError: null,
  });
  const [nodes, setNodes] = useState<ProxyNode[]>([]);
  const [manual, setManual] = useState<Partial<ControllerConfig>>({});
  const [busy, setBusy] = useState(false);
  const refreshGen = useRef(0);

  const setForceMock = (v: boolean) => {
    setForceMockState(v);
    try {
      localStorage.setItem(MOCK_PREF_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const setClientId = (id: ClientId | null) => {
    setClientIdState(id);
    try {
      if (id) localStorage.setItem(CLIENT_STORAGE_KEY, id);
      else localStorage.removeItem(CLIENT_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const refresh = useCallback(
    async (override?: Partial<ControllerConfig>, mockOverride?: boolean) => {
      const gen = ++refreshGen.current;
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
            proxiesError: null,
          };
          if (gen !== refreshGen.current) return next;
          setState(next);
          setNodes(list);
          return next;
        }

        if (!clientId) {
          const next: ConnectionState = {
            status: "unknown",
            message: "请先选择客户端",
            config: { ...defaultConfig(), ...manual, ...override },
            currentProxy: null,
            usingMock: false,
            proxiesError: null,
          };
          if (gen === refreshGen.current) {
            setState(next);
            setNodes([]);
          }
          return next;
        }

        const merged = { ...manual, ...override };
        const next = await discoverAndProbe(
          Object.keys(merged).length ? merged : undefined,
          clientId,
        );

        if (gen !== refreshGen.current) return next;

        if (!next.config || next.status === "unreachable" || next.status === "unauthorized") {
          setState({ ...next, proxiesError: next.proxiesError ?? null });
          setNodes([]);
          return next;
        }

        const list = await getProxies(next.config);
        if (gen !== refreshGen.current) return next;

        setNodes(list.nodes);

        if (list.unauthorized) {
          const unauthorized: ConnectionState = {
            ...next,
            status: "unauthorized",
            message: "Secret 不正确或未配置",
            usingMock: false,
            currentProxy: null,
            proxiesError: list.error,
          };
          setState(unauthorized);
          return unauthorized;
        }

        const mergedState: ConnectionState = {
          ...next,
          usingMock: false,
          currentProxy: list.currentProxy ?? next.currentProxy,
          proxiesError: list.error,
          message: list.error
            ? `${next.message} — ${list.error}`
            : next.message,
        };
        setState(mergedState);
        return mergedState;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? "连接检测失败");
        const next: ConnectionState = {
          status: "unreachable",
          message,
          config: { ...defaultConfig(), ...manual, ...override },
          currentProxy: null,
          usingMock: false,
          proxiesError: message,
        };
        if (gen === refreshGen.current) {
          setState(next);
          setNodes([]);
        }
        return next;
      } finally {
        if (gen === refreshGen.current) {
          setBusy(false);
        }
      }
    },
    [manual, forceMock, clientId],
  );

  // Intentionally no boot auto-refresh: opening the window must not invoke Mihomo HTTP.
  // User / Pit clicks「刷新连接」on Home or Settings.

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
    clientId,
    setClientId,
    updateManual,
    resetManual,
    refresh,
    setNodes,
  };
}
