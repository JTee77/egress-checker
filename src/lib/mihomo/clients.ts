/**
 * Client presets for Home picker → discovery / probe defaults.
 * Labels in 简体中文. Never log secrets.
 */

import type { ControllerConfig } from "./types";

export type ClientId = "verge" | "mihomo" | "manual";

export const CLIENT_STORAGE_KEY = "egress-checker.clientId";

export type ClientOption = {
  id: ClientId;
  label: string;
  hint: string;
};

export const CLIENT_OPTIONS: ClientOption[] = [
  {
    id: "verge",
    label: "Clash Verge / Verge Rev",
    hint: "读取 Verge config.yaml 与默认套接字",
  },
  {
    id: "mihomo",
    label: "通用 Mihomo / Clash Meta",
    hint: "默认 127.0.0.1:9090 · mixed 7890，可在设置覆盖",
  },
  {
    id: "manual",
    label: "手动（设置）",
    hint: "仅使用设置页填写的连接参数",
  },
];

/** Base defaults when no client chosen yet (UI only; discovery must not run). */
export function vergeLikeDefault(): ControllerConfig {
  return {
    host: "127.0.0.1",
    port: 9097,
    secret: "",
    mixedPort: 7897,
    source: "manual-default",
    sockPath: "/tmp/verge/verge-mihomo.sock",
  };
}

/** Partial preset applied before discovery / probe. */
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
    case "mihomo":
      return {
        host: "127.0.0.1",
        port: 9090,
        secret: "",
        mixedPort: 7890,
        source: "preset-mihomo",
        sockPath: null,
      };
    case "manual":
      return {
        source: "manual",
      };
  }
}

export function isClientId(v: unknown): v is ClientId {
  return v === "verge" || v === "mihomo" || v === "manual";
}

export function clientLabel(id: ClientId | null): string {
  if (!id) return "未选择";
  return CLIENT_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

/** Extra TCP ports to try for mihomo preset (after primary). */
export const MIHOMO_ALT_PORTS = [9091] as const;
