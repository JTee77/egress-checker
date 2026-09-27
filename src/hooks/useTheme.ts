import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "egress-theme";

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

/** 始终把 data-theme 写成 light|dark|system；system 时不换成 dark/light，交给 CSS。 */
function applyThemeAttr(mode: ThemeMode) {
  document.documentElement.setAttribute("data-theme", mode);
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 同步原生窗口主题，让 titlebar / vibrancy 跟软件主题对齐。
 * system → null（跟随系统）；非 Tauri 或 API 失败时静默忽略。
 *
 * 注意：macOS 上 NSVisualEffectView（windowEffects sidebar）跟窗口
 * NSAppearance 走；仅改 CSS 不会变深浅。还要：
 * 1) window/app setTheme（需 capability allow-set-theme）
 * 2) 主题切换后 clear+setEffects，逼毛玻璃按新 appearance 重建
 */
async function syncNativeWindowTheme(mode: ThemeMode) {
  if (!isTauri()) return;

  const nativeTheme = mode === "system" ? null : mode;

  try {
    const [{ getCurrentWindow, Effect, EffectState }, { setTheme: setAppTheme }] =
      await Promise.all([
        import("@tauri-apps/api/window"),
        import("@tauri-apps/api/app"),
      ]);

    const win = getCurrentWindow();
    // 窗口 + App 双写：webview chrome 与 NSApp appearance 都对齐
    await Promise.all([win.setTheme(nativeTheme), setAppTheme(nativeTheme)]);

    // 重建 vibrancy，避免 appearance 已变但旧 NSVisualEffectView 仍锁在系统深浅
    try {
      await win.clearEffects();
      await win.setEffects({
        effects: [Effect.Sidebar],
        state: EffectState.Active,
      });
    } catch {
      /* setEffects 权限或非 macOS：忽略，主题仍已写入 */
    }
  } catch {
    /* setTheme 失败（旧构建缺权限等）静默忽略 */
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const mode = readStored();
    if (typeof document !== "undefined") applyThemeAttr(mode);
    return mode;
  });

  useEffect(() => {
    applyThemeAttr(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
    void syncNativeWindowTheme(theme);
  }, [theme]);

  // system 时监听系统配色变化；仍保持 data-theme="system"（CSS 媒体查询负责换肤）
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyThemeAttr("system");
      // 系统外观变了，原生 vibrancy 通常自跟；再刷一次 effects 更稳
      void syncNativeWindowTheme("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
  }, []);

  return { theme, setTheme };
}
