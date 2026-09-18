#!/usr/bin/env node
/**
 * Simulates restoreProxy success/fail messaging for pit smoke without Mihomo.
 * Mirrors HomePage finally-block contract: fail must surface clear Chinese error.
 */

function restoreMessage({ didSwitch, snapshot, restoreOk }) {
  if (!didSwitch) return { restoreError: null, switchHint: null };
  if (snapshot?.now && snapshot?.group) {
    if (!restoreOk) {
      const errMsg = `没法自动切回原先的节点「${snapshot.now}」。请立刻到代理软件里手动选回去，否则你可能还停在别的节点上。`;
      return { restoreError: errMsg, switchHint: errMsg };
    }
    return {
      restoreError: null,
      switchHint: `已切回原先节点：${snapshot.now}`,
    };
  }
  const errMsg =
    "测全部时切换过节点，但应用没有记下原先选中的节点，没法自动切回。请到代理软件里确认当前节点。";
  return { restoreError: errMsg, switchHint: errMsg };
}

const cases = [
  {
    name: "success restore",
    input: {
      didSwitch: true,
      snapshot: { group: "Proxy", now: "香港 A" },
      restoreOk: true,
    },
    expectError: false,
    expectHintIncludes: "已切回原先节点：香港 A",
  },
  {
    name: "restore fail surfaces error",
    input: {
      didSwitch: true,
      snapshot: { group: "Proxy", now: "香港 A" },
      restoreOk: false,
    },
    expectError: true,
    expectHintIncludes: "没法自动切回原先的节点「香港 A」",
  },
  {
    name: "missing snapshot after switch",
    input: { didSwitch: true, snapshot: null, restoreOk: false },
    expectError: true,
    expectHintIncludes: "没法自动切回",
  },
  {
    name: "no switch → no restore noise",
    input: { didSwitch: false, snapshot: null, restoreOk: false },
    expectError: false,
    expectHintIncludes: null,
  },
];

let failed = 0;
for (const c of cases) {
  const out = restoreMessage(c.input);
  const hasErr = !!out.restoreError;
  const hintOk =
    c.expectHintIncludes == null
      ? !out.switchHint
      : (out.switchHint || "").includes(c.expectHintIncludes);
  const ok = hasErr === c.expectError && hintOk;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) {
    failed += 1;
    console.log("  got:", out);
  }
}

if (failed) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log("\nAll restore-message simulations passed.");
