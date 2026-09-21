import { describe, it, expect } from "vitest";
import { browserFallbackAllowed } from "./fetchVia";

/**
 * 纯决策函数：生产 Tauri 绝不静默直连兜底（否则绕过代理测出假绿/假带宽）。
 * 只有纯浏览器 / 网页预览（无代理可绕）或 dev 构建才允许兜底。
 */
describe("browserFallbackAllowed", () => {
  it("非 Tauri（纯浏览器/网页预览）恒允许兜底", () => {
    expect(browserFallbackAllowed({ isTauri: false, dev: false })).toBe(true);
    expect(browserFallbackAllowed({ isTauri: false, dev: true })).toBe(true);
  });

  it("Tauri dev 构建允许（开发期可在浏览器里跑）", () => {
    expect(browserFallbackAllowed({ isTauri: true, dev: true })).toBe(true);
  });

  it("生产 Tauri 一律禁止直连兜底（防假绿 / 假带宽）", () => {
    expect(browserFallbackAllowed({ isTauri: true, dev: false })).toBe(false);
  });
});
