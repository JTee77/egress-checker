import { describe, it, expect } from "vitest";
import { parseCliArgv } from "./parse";
import { okEnvelope, errEnvelope } from "./types";

describe("parseCliArgv", () => {
  it("无参数 → 非 cliMode + help", () => {
    const p = parseCliArgv(["/app/egress-checker"]);
    expect(p.cliMode).toBe(false);
    expect(p.command).toBe("help");
  });

  it("--cli help", () => {
    const p = parseCliArgv(["egress-checker", "--cli", "help"]);
    expect(p.cliMode).toBe(true);
    expect(p.command).toBe("help");
  });

  it("discover --client verge --json", () => {
    const p = parseCliArgv([
      "egress-checker",
      "--cli",
      "discover",
      "--client",
      "verge",
      "--json",
    ]);
    expect(p.command).toBe("discover");
    expect(p.clientId).toBe("verge");
    expect(p.json).toBe(true);
    expect(p.mock).toBe(false);
  });

  it("check current / all / node", () => {
    expect(
      parseCliArgv(["bin", "--cli", "check", "current"]).checkTarget,
    ).toEqual({ kind: "current" });
    expect(parseCliArgv(["bin", "--cli", "check", "all"]).checkTarget).toEqual({
      kind: "all",
    });
    expect(
      parseCliArgv(["bin", "--cli", "check", "node", "香港", "01"]).checkTarget,
    ).toEqual({ kind: "node", name: "香港 01" });
    expect(
      parseCliArgv(["bin", "--cli", "check", "新加坡"]).checkTarget,
    ).toEqual({ kind: "node", name: "新加坡" });
  });

  it("--mock --no-json", () => {
    const p = parseCliArgv(["bin", "--cli", "gate", "--mock", "--no-json"]);
    expect(p.mock).toBe(true);
    expect(p.json).toBe(false);
  });

  it("-c 短选项", () => {
    expect(
      parseCliArgv(["bin", "--cli", "env", "-c", "flclash"]).clientId,
    ).toBe("flclash");
  });
});

describe("CliEnvelope", () => {
  it("ok / err 形状稳定", () => {
    const ok = okEnvelope("discover", { x: 1 }, "0.1.12");
    expect(ok.ok).toBe(true);
    expect(ok.version).toBe("0.1.12");
    expect(ok.data).toEqual({ x: 1 });
    const err = errEnvelope("gate", "client_required", "缺 client", "0.1.12");
    expect(err.ok).toBe(false);
    expect(err.error?.code).toBe("client_required");
  });
});
