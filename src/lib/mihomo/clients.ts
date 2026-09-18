/**
 * Client presets for Home picker → discovery / probe defaults.
 * Home labels/hints: plain 简体中文 (no geek jargon on the picker).
 * Never log secrets.
 */

import type { ControllerConfig } from "./types";

export type ClientId =
  | "verge"
  | "clashx_meta"
  | "flclash"
  | "mihomo_party"
  | "nyanpasu";

export const CLIENT_STORAGE_KEY = "egress-checker.clientId";

export type ClientOption = {
  id: ClientId;
  label: string;
  hint: string;
};

export const CLIENT_OPTIONS: ClientOption[] = [
  {
    id: "verge",
    label: "Clash Verge / Clash Verge Rev",
    hint: "选好后点刷新，按该软件自动连接",
  },
  {
    id: "clashx_meta",
    label: "ClashX Meta",
    hint: "选好后点刷新，按该软件自动连接",
  },
  {
    id: "flclash",
    label: "FlClash",
    hint: "选好后点刷新，按该软件自动连接",
  },
  {
    id: "mihomo_party",
    label: "Mihomo Party",
    hint: "选好后点刷新，按该软件自动连接",
  },
  {
    id: "nyanpasu",
    label: "Clash Nyanpasu",
    hint: "选好后点刷新，按该软件自动连接",
  },
];

const ALL_IDS: ClientId[] = [
  "verge",
  "clashx_meta",
  "flclash",
  "mihomo_party",
  "nyanpasu",
];

/** Base defaults when no client chosen yet (UI only; discovery must not run). */
export function vergeLikeDefault(): ControllerConfig {
  return {
    host: "127.0.0.1",
    port: 9097,
    secret: "",
    mixedPort: 7897,
    source: "unset-default",
    sockPath: null,
  };
}

/** Partial preset applied before discovery / probe. sockPath only when known for that client. */
export function clientPreset(id: ClientId): Partial<ControllerConfig> {
  switch (id) {
    case "verge":
      return {
        host: "127.0.0.1",
        port: 9097,
        secret: "",
        mixedPort: 7897,
        source: "preset-verge",
        sockPath: "/tmp/verge/verge-mihomo.sock",
      };
    case "clashx_meta":
      return {
        host: "127.0.0.1",
        port: 9090,
        secret: "",
        mixedPort: 7890,
        source: "preset-clashx_meta",
        sockPath: null,
      };
    case "flclash":
      return {
        host: "127.0.0.1",
        port: 9090,
        secret: "",
        mixedPort: 7890,
        source: "preset-flclash",
        sockPath: null,
      };
    case "mihomo_party":
      return {
        host: "127.0.0.1",
        port: 9090,
        secret: "",
        mixedPort: 7890,
        source: "preset-mihomo_party",
        sockPath: "/tmp/mihomo-party.sock",
      };
    case "nyanpasu":
      return {
        host: "127.0.0.1",
        port: 17650,
        secret: "",
        mixedPort: 7890,
        source: "preset-nyanpasu",
        sockPath: null,
      };
  }
}

export function isClientId(v: unknown): v is ClientId {
  return typeof v === "string" && (ALL_IDS as string[]).includes(v);
}

/**
 * Map stored clientId. Known five kept; legacy mihomo/manual/unknown → null (force re-pick).
 */
export function normalizeClientId(v: unknown): ClientId | null {
  if (
    v === "verge" ||
    v === "clashx_meta" ||
    v === "flclash" ||
    v === "mihomo_party" ||
    v === "nyanpasu"
  ) {
    return v;
  }
  return null;
}

export function clientLabel(id: ClientId | null): string {
  if (!id) return "未选择";
  return CLIENT_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

/** Plain-language unreachable tip naming the selected app. */
export function clientUnreachableHint(id: ClientId): string {
  const name = clientLabel(id);
  return `请先打开并连上【${name}】，再点刷新`;
}

export const VERGE_SOCK = "/tmp/verge/verge-mihomo.sock";
export const MIHOMO_PARTY_SOCK = "/tmp/mihomo-party.sock";
