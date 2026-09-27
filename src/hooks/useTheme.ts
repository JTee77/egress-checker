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

/**
 * 同步原生窗口主题，让 titlebar / vibrancy 跟软件主题对齐。
 * system → null（跟随系统）；非 Tauri 或 API 失败时静默忽略。
 */
async function syncNativeWindowTheme(mode: ThemeMode) {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(mode === "system" ? null : mode);
  } catch {
    /* ignore */
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
    const onChange = () => applyThemeAttr("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
  }, []);

  return { theme, setTheme };
}
