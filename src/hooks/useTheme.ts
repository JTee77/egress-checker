import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "egress-theme";
const tauriWindow = import("@tauri-apps/api/window");

function readStored(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  } catch {}
  return "system";
}

function applyThemeAttr(mode: ThemeMode) {
  document.documentElement.setAttribute("data-theme", mode);
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function syncNativeWindowTheme(mode: ThemeMode) {
  if (!isTauri()) return;

  try {
    const { getCurrentWindow } = await tauriWindow;
    await getCurrentWindow().setTheme(mode === "system" ? null : mode);
  } catch {}
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
      // Ignore unavailable storage.
    }
    void syncNativeWindowTheme(theme);
  }, [theme]);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
  }, []);

  return { theme, setTheme };
}
