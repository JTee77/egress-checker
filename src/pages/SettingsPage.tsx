import { useState } from "react";
import {
  clientLabel,
  type ClientId,
  type ConnectionState,
  type ControllerConfig,
} from "../lib/mihomo";

export function SettingsPage({
  connection,
  manual,
  busy,
  forceMock,
  clientId,
  onChangeManual,
  onResetManual,
  onForceMockChange,
  onRefresh,
}: {
  connection: ConnectionState;
  manual: Partial<ControllerConfig>;
  busy: boolean;
  forceMock: boolean;
  clientId: ClientId | null;
  onChangeManual: (patch: Partial<ControllerConfig>) => void;
  onResetManual: () => void;
  onForceMockChange: (v: boolean) => void;
  onRefresh: (override?: Partial<ControllerConfig>) => Promise<unknown>;
}) {
  const cfg = connection.config;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [host, setHost] = useState(manual.host ?? cfg?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(manual.port ?? cfg?.port ?? 9097));
  const [secret, setSecret] = useState(manual.secret ?? cfg?.secret ?? "");
  const [mixedPort, setMixedPort] = useState(
    String(manual.mixedPort ?? cfg?.mixedPort ?? 7897),
  );

  const apply = async () => {
    const patch: Partial<ControllerConfig> = {
      host,
      port: Number(port) || 9097,
      secret,
      mixedPort: Number(mixedPort) || 7897,
      source: "manual",
    };
    onChangeManual(patch);
    await onRefresh(patch);
  };

  const autoDetect = async () => {
    onResetManual();
    setHost("127.0.0.1");
    setPort("9097");
    setSecret("");
    setMixedPort("7897");
    await onRefresh({ source: "auto" });
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>设置</h1>
          <p>日常使用请回首页选软件并刷新；这里主要是演示与高级调试。</p>
        </div>
      </div>

      <div className="note note-compact" style={{ marginBottom: 12 }}>
        当前软件：<strong>{clientLabel(clientId)}</strong>
        {clientId
          ? " — 连接参数会按该软件自动发现，一般不用改下面内容。"
          : " — 请先回首页选择你正在用的软件。"}
      </div>

      <div className="status-pill" style={{ marginBottom: 16 }}>
        <span
          className={`dot ${connection.status === "connected" ? "connected" : connection.usingMock || forceMock ? "mock" : connection.status}`}
        />
        {connection.message}
      </div>

      {connection.proxiesError && !forceMock ? (
        <div className="note" style={{ marginBottom: 14 }}>
          {connection.proxiesError}
        </div>
      ) : null}

      <div className="form-grid card" style={{ padding: 16, marginBottom: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={forceMock}
            onChange={(e) => onForceMockChange(e.target.checked)}
          />
          <span>
            <strong>Mock 演示模式</strong>
            <span className="muted"> — 用假数据预览界面，不连真实软件</span>
          </span>
        </label>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setAdvancedOpen((v) => !v)}
          style={{ marginBottom: advancedOpen ? 12 : 0 }}
        >
          {advancedOpen ? "收起高级 / 调试" : "展开高级 / 调试（一般不用）"}
        </button>

        {advancedOpen ? (
          <div className="form-grid">
            <p className="muted" style={{ margin: "0 0 8px", fontSize: 12 }}>
              以下字段仅在自动连接失败、或你清楚自己改过控制口时使用。普通用户请回首页重选软件并刷新。
            </p>
            <div className="field">
              <label>Host</label>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                disabled={forceMock}
              />
            </div>
            <div className="field">
              <label>Port（external-controller）</label>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                disabled={forceMock}
              />
            </div>
            <div className="field">
              <label>Secret（不会写入日志 / 仓库）</label>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="off"
                disabled={forceMock}
              />
            </div>
            <div className="field">
              <label>mixed-port（经代理探针）</label>
              <input
                value={mixedPort}
                onChange={(e) => setMixedPort(e.target.value)}
                disabled={forceMock}
              />
            </div>
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy || forceMock}
                onClick={() => void apply()}
              >
                保存并测试连接
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy || forceMock}
                onClick={() => void autoDetect()}
              >
                重新自动发现
              </button>
            </div>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
              来源：{cfg?.source ?? "—"}
              <br />
              Unix 套接字：{cfg?.sockPath ?? "（无）"}
              <br />
              mixed-port：{cfg?.mixedPort ?? "—"}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
