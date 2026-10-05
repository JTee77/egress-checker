#!/usr/bin/env node
/**
 * 无 GUI 自检「测全部/测单个」结束时的切回文案。
 *
 * 直接 import 运行时真正用的 src/lib/runner/restore.ts（GUI 红字与 CLI data.restoreError
 * 共用同一份决策与文案），不再在脚本里抄一份。需要 Node ≥ 22.18（内置去 TS 类型）。
 *
 * 契约（与 runner 一致）：
 * - 没切换 → 无 restoreError
 * - 切回成功 → 无 restoreError（GUI 不额外提示）
 * - 切回失败 → 「没能切回原先节点「X」。」
 * - 切过但没记下原节点 → 「没能切回原先节点。」
 * CLI 另外把 restoreError 映射为 ok:false / error.code = restore_failed（见 docs/CLI.md）。
 */

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `需要 Node ≥ 22.18 才能直接 import TypeScript（当前 ${process.versions.node}）。`,
  );
  process.exit(2);
}

const { planRestore, restoreErrorFor } = await import(
  new URL("../src/lib/runner/restore.ts", import.meta.url).href
);

/** 模拟 runner finally：plan → （需要时）restoreProxy → restoreError。 */
function simulate({ didSwitch, snapshot, restoreOk }) {
  const plan = planRestore(didSwitch, snapshot);
  const restored = plan.kind === "restore" ? restoreOk : false;
  return { plan: plan.kind, restoreError: restoreErrorFor(plan, restored) };
}

const cases = [
  {
    name: "切回成功 → 无报错",
    input: { didSwitch: true, snapshot: { group: "Proxy", now: "香港 A" }, restoreOk: true },
    expect: { plan: "restore", restoreError: null },
  },
  {
    name: "切回失败 → 带原节点名的报错",
    input: { didSwitch: true, snapshot: { group: "Proxy", now: "香港 A" }, restoreOk: false },
    expect: { plan: "restore", restoreError: "没能切回原先节点「香港 A」。" },
  },
  {
    name: "切过但没记下原节点 → 报错",
    input: { didSwitch: true, snapshot: null, restoreOk: false },
    expect: { plan: "missing_snapshot", restoreError: "没能切回原先节点。" },
  },
  {
    name: "快照缺 now → 报错",
    input: { didSwitch: true, snapshot: { group: "Proxy", now: null }, restoreOk: true },
    expect: { plan: "missing_snapshot", restoreError: "没能切回原先节点。" },
  },
  {
    name: "没切换 → 不报错",
    input: { didSwitch: false, snapshot: null, restoreOk: false },
    expect: { plan: "none", restoreError: null },
  },
];

let failed = 0;
for (const c of cases) {
  const out = simulate(c.input);
  const ok =
    out.plan === c.expect.plan && out.restoreError === c.expect.restoreError;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) {
    failed += 1;
    console.log("  want:", c.expect);
    console.log("  got: ", out);
  }
}

if (failed) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log("\nAll restore-message simulations passed.");
