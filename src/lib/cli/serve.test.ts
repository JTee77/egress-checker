import { describe, expect, it } from "vitest";
import { parseCliArgv, CLI_SERVE_DEFAULT_PORT } from "./parse";
import {
  parsedFromServeJob,
  resolveServePort,
  serveReadyEnvelope,
} from "./serve";

describe("parse serve / --port", () => {
  it("serve 进入 cliMode，默认 port 未给", () => {
    const p = parseCliArgv(["bin", "--cli", "serve", "--mock"]);
    expect(p.cliMode).toBe(true);
    expect(p.command).toBe("serve");
    expect(p.portGiven).toBe(false);
    expect(p.port).toBeNull();
    expect(p.parseError).toBeNull();
    expect(resolveServePort(p)).toBe(CLI_SERVE_DEFAULT_PORT);
  });

  it("--port / -p / --port= / 0 临时端口", () => {
    expect(parseCliArgv(["bin", "--cli", "serve", "--port", "17890"]).port).toBe(
      17890,
    );
    expect(parseCliArgv(["bin", "--cli", "serve", "-p", "0"]).port).toBe(0);
    expect(parseCliArgv(["bin", "--cli", "serve", "--port=9050"]).port).toBe(9050);
  });

  it("--port 非法 → invalid_port", () => {
    expect(parseCliArgv(["bin", "--cli", "serve", "--port", "x"]).parseError?.code).toBe(
      "invalid_port",
    );
    expect(parseCliArgv(["bin", "--cli", "serve", "--port", "99999"]).parseError?.code).toBe(
      "invalid_port",
    );
  });

  it("--port 缺值 → missing_option_value", () => {
    expect(parseCliArgv(["bin", "--cli", "serve", "--port"]).parseError?.code).toBe(
      "missing_option_value",
    );
  });

  it("--port 配非 serve → port_only_for_serve", () => {
    expect(
      parseCliArgv(["bin", "--cli", "discover", "--mock", "--port", "1"]).parseError
        ?.code,
    ).toBe("port_only_for_serve");
  });

  it("serve 多余参数 → unexpected_argument", () => {
    expect(parseCliArgv(["bin", "--cli", "serve", "extra"]).parseError?.code).toBe(
      "unexpected_argument",
    );
  });
});

describe("parsedFromServeJob", () => {
  const base = parseCliArgv(["bin", "--cli", "serve", "--mock", "--client", "verge"]);

  it("映射 discover / gate / env / check/*", () => {
    expect(parsedFromServeJob(base, { route: "discover", body: "" }).parsed.command).toBe(
      "discover",
    );
    expect(parsedFromServeJob(base, { route: "gate", body: "" }).parsed.command).toBe("gate");
    expect(parsedFromServeJob(base, { route: "env", body: "" }).parsed.command).toBe("env");
    expect(
      parsedFromServeJob(base, { route: "check/current", body: "" }).parsed.checkTarget,
    ).toEqual({ kind: "current" });
    expect(
      parsedFromServeJob(base, { route: "check/all", body: "" }).parsed.checkTarget,
    ).toEqual({ kind: "all" });
    const node = parsedFromServeJob(base, {
      route: "check/node",
      body: JSON.stringify({ name: "香港 01" }),
    });
    expect(node.early).toBeUndefined();
    expect(node.parsed.checkTarget).toEqual({ kind: "node", name: "香港 01" });
  });

  it("check/node 缺 name / 坏 JSON → early error", () => {
    expect(
      parsedFromServeJob(base, { route: "check/node", body: "{}" }).early?.error?.code,
    ).toBe("node_name_required");
    expect(
      parsedFromServeJob(base, { route: "check/node", body: "not-json" }).early?.error?.code,
    ).toBe("invalid_body");
  });

  it("保留会话级 mock / client", () => {
    const { parsed } = parsedFromServeJob(base, { route: "discover", body: "" });
    expect(parsed.mock).toBe(true);
    expect(parsed.clientId).toBe("verge");
    expect(parsed.clientGiven).toBe(true);
  });
});

describe("serveReadyEnvelope", () => {
  it("含 token、bind、routes", () => {
    const env = serveReadyEnvelope(
      {
        host: "127.0.0.1",
        port: 17890,
        token: "abc",
        baseUrl: "http://127.0.0.1:17890",
      },
      "0.1.16",
    );
    expect(env.ok).toBe(true);
    expect(env.command).toBe("serve");
    const data = env.data as Record<string, unknown>;
    expect(data.token).toBe("abc");
    expect(data.bind).toBe("127.0.0.1");
    expect(Array.isArray(data.routes)).toBe(true);
  });
});
