/** Stable stdout JSON shape for --cli / 本地脚本。 */
export type CliError = {
  code: string;
  message: string;
};

export type CliEnvelope<T = unknown> = {
  ok: boolean;
  version: string;
  command: string;
  ranAt: string;
  data?: T;
  error?: CliError;
};

export type CliCommandName =
  | "help"
  | "discover"
  | "gate"
  | "check"
  | "env";

export type CheckTarget =
  | { kind: "current" }
  | { kind: "node"; name: string }
  | { kind: "all" };

export type ParsedCli = {
  /** true when argv contains --cli or a known subcommand as first token after binary */
  cliMode: boolean;
  command: CliCommandName;
  /** check 子命令目标 */
  checkTarget?: CheckTarget;
  clientId: string | null;
  mock: boolean;
  json: boolean;
  /** leftover / unknown flags for diagnostics */
  raw: string[];
};

export function okEnvelope<T>(
  command: string,
  data: T,
  version: string,
): CliEnvelope<T> {
  return {
    ok: true,
    version,
    command,
    ranAt: new Date().toISOString(),
    data,
  };
}

export function errEnvelope(
  command: string,
  code: string,
  message: string,
  version: string,
): CliEnvelope<never> {
  return {
    ok: false,
    version,
    command,
    ranAt: new Date().toISOString(),
    error: { code, message },
  };
}
