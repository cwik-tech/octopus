import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "pipeline-theme";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof localStorage === "undefined") return "light";
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== THEME_STORAGE_KEY) return;
      setTheme(localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  return [theme, setTheme] as const;
}
