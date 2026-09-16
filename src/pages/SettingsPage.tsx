import { useState } from "react";
import type { ConnectionState, ControllerConfig } from "../lib/mihomo";

export function SettingsPage({
  connection,
  manual,
  busy,
  forceMock,
  onChangeManual,
  onResetManual,
  onForceMockChange,
  onRefresh,
}: {
  connection: ConnectionState;
  manual: Partial<ControllerConfig>;
  busy: boolean;
  forceMock: boolean;
  onChangeManual: (patch: Partial<ControllerConfig>) => void;
  onResetManual: () => void;
  onForceMockChange: (v: boolean) => void;
  onRefresh: (override?: Partial<ControllerConfig>) => Promise<unknown>;
}) {
  const cfg = connection.config;
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
          <p>连接 Mihomo / Clash Meta 兼容客户端（默认 Clash Verge Rev）</p>
        </div>
      </div>

      <div className="status-pill" style={{ marginBottom: 16 }}>
        <span
          className={`dot ${connection.status === "connected" ? "connected" : connection.usingMock || forceMock ? "mock" : connection.status}`}
        />
        {connection.message}
      </div>

      <div className="form-grid card" style={{ padding: 16, marginBottom: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={forceMock}
            onChange={(e) => onForceMockChange(e.target.checked)}
          />
          <span>
            <strong>Mock 演示模式</strong>
            <span className="muted"> — 使用假节点与延迟，无需 Clash</span>
          </span>
        </label>
      </div>

      <div className="form-grid card" style={{ padding: 16 }}>
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
            自动探测
          </button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          自动探测读取：
          <br />
          ~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/config.yaml
          <br />
          Unix socket：/tmp/verge/verge-mihomo.sock
          <br />
          来源：{cfg?.source ?? "—"} · mixed-port：{cfg?.mixedPort ?? "—"}
        </p>
      </div>

      <div className="note">
        请在 Clash Verge Rev 中开启 <strong>external-controller</strong> 并设置{" "}
        <strong>secret</strong>，否则无法拉取节点 / 测延迟。本应用不提供任何代理节点。
      </div>
    </div>
  );
}
