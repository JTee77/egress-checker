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
