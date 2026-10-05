import { describe, expect, it } from "vitest";
import { planRestore, restoreErrorFor, restoreFailedMessage } from "./restore";

describe("planRestore", () => {
  it("没切换 → none", () => {
    expect(planRestore(false, { group: "P", now: "A" })).toEqual({ kind: "none" });
    expect(planRestore(false, null)).toEqual({ kind: "none" });
  });
  it("切过且有快照 → restore", () => {
    expect(planRestore(true, { group: "P", now: "A" })).toEqual({
      kind: "restore",
      group: "P",
      now: "A",
    });
  });
  it("切过但快照缺 group/now → missing_snapshot", () => {
    expect(planRestore(true, null).kind).toBe("missing_snapshot");
    expect(planRestore(true, { group: "P", now: null }).kind).toBe("missing_snapshot");
    expect(planRestore(true, { group: "", now: "A" }).kind).toBe("missing_snapshot");
  });
});

describe("restoreErrorFor（GUI 红字 / CLI restoreError 同一句）", () => {
  it("none → 永远 null", () => {
    expect(restoreErrorFor({ kind: "none" }, false)).toBeNull();
  });
  it("restore 成功 → null；失败 → 带节点名", () => {
    const plan = { kind: "restore", group: "P", now: "香港 A" } as const;
    expect(restoreErrorFor(plan, true)).toBeNull();
    expect(restoreErrorFor(plan, false)).toBe("没能切回原先节点「香港 A」。");
  });
  it("missing_snapshot → 不带节点名，restored 被忽略", () => {
    expect(restoreErrorFor({ kind: "missing_snapshot" }, true)).toBe("没能切回原先节点。");
    expect(restoreFailedMessage(null)).toBe("没能切回原先节点。");
  });
});
