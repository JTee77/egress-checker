/**
 * 前端 invoke(...) 的参数形状必须与 Rust `#[tauri::command]` 的参数名一致。
 *
 * Tauri 按「参数名」反序列化：`fn foo(req: FooRequest)` 必须 `invoke("foo", { req: {...} })`，
 * 平铺成 `{ id, status, body }` 会在运行时失败（且常被 catch 吞掉）。
 * 0.1.16 的 serve 就因 `cli_serve_respond` 平铺而让 POST /v1/* 永久挂起；本测试静态防回归。
 */
import { describe, expect, it } from "vitest";
import libRs from "../../src-tauri/src/lib.rs?raw";

const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Tauri 注入的参数，不来自前端 args。 */
const INJECTED = /^(?:tauri::)?(AppHandle|State|Window|WebviewWindow|Webview|Channel)\b/;

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** 按顶层逗号切分（跳过 <>、()、{}、[] 与字符串内的逗号）。 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\") {
        cur += s[++i] ?? "";
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if ("<({[".includes(ch)) depth++;
    else if (">)}]".includes(ch) && !(ch === ">" && s[i - 1] === "=")) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function rustCommands(src: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const re = /#\[tauri::command[^\]]*\]\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/g;
  for (const m of src.matchAll(re)) {
    let i = m.index! + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    const params = splitTopLevel(src.slice(start, i - 1))
      .map((p) => {
        const idx = p.indexOf(":");
        return { name: p.slice(0, idx).trim().replace(/^mut\s+/, ""), ty: p.slice(idx + 1).trim() };
      })
      .filter((p) => p.name && !INJECTED.test(p.ty))
      .map((p) => snakeToCamel(p.name));
    map.set(m[1]!, params);
  }
  return map;
}

type InvokeSite = { file: string; command: string; keys: string[] };

function invokeSites(file: string, src: string): InvokeSite[] {
  const sites: InvokeSite[] = [];
  const re = /\binvoke\s*(?:<[\s\S]*?>)?\s*\(\s*["'](\w+)["']\s*([,)])/g;
  for (const m of src.matchAll(re)) {
    let keys: string[] = [];
    if (m[2] === ",") {
      let i = m.index! + m[0].length;
      while (/\s/.test(src[i]!)) i++;
      if (src[i] === ")") {
        keys = [];
      } else {
        expect(src[i], `${file}: invoke("${m[1]}") 的参数必须是对象字面量`).toBe("{");
        const start = ++i;
        let depth = 1;
        while (i < src.length && depth > 0) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          i++;
        }
        keys = splitTopLevel(src.slice(start, i - 1)).map((entry) => {
          const km = entry.match(/^["']?([A-Za-z_$][\w$]*)["']?\s*(?::|$)/);
          expect(km, `${file}: 无法解析 invoke("${m[1]}") 的键：${entry}`).toBeTruthy();
          return km![1]!;
        });
      }
    }
    sites.push({ file, command: m[1]!, keys });
  }
  return sites;
}

describe("Tauri invoke 参数与 Rust 命令签名一致", () => {
  const commands = rustCommands(libRs);
  const sites = Object.entries(sources).flatMap(([f, s]) => invokeSites(f, s));

  it("能解析出 Rust 命令与前端调用点", () => {
    expect(commands.get("cli_serve_respond")).toEqual(["req"]);
    expect(commands.get("cli_serve_poll")).toEqual(["timeoutMs"]);
    expect(sites.some((s) => s.command === "cli_serve_respond")).toBe(true);
    expect(sites.length).toBeGreaterThan(10);
  });

  it("每个 invoke 的顶层键 == Rust 参数名（camelCase）", () => {
    const problems: string[] = [];
    for (const s of sites) {
      const want = commands.get(s.command);
      if (!want) {
        problems.push(`${s.file}: invoke("${s.command}") 在 lib.rs 里没有对应 #[tauri::command]`);
        continue;
      }
      const got = [...s.keys].sort();
      const exp = [...want].sort();
      if (JSON.stringify(got) !== JSON.stringify(exp)) {
        problems.push(
          `${s.file}: invoke("${s.command}", {${got.join(", ")}}) ≠ Rust 参数 {${exp.join(", ")}}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("cli_serve_respond 必须包成 { req: { id, status, body } }", () => {
    const boot = Object.entries(sources).find(([f]) => f.endsWith("cli/bootCli.ts"));
    expect(boot).toBeTruthy();
    expect(boot![1]).toMatch(/invoke\(\s*"cli_serve_respond"\s*,\s*\{\s*(?:\/\/[^\n]*\n\s*)*req\s*:\s*\{/);
  });
});
