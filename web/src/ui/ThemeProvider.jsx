import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";

const ThemeContext = createContext(null);
const THEME_KEY = "nas_ui_theme";
function initialTheme() {
  try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; }
  catch { return "dark"; }
}

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(initialTheme);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    try { localStorage.setItem(THEME_KEY, mode); } catch { /* private storage */ }
  }, [mode]);
  useEffect(() => {
    const sync = event => {
      if (event.key === THEME_KEY) setMode(event.newValue === "light" ? "light" : "dark");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const theme = useMemo(() => {
    const dark = mode === "dark";
    const brand = dark ? "#f4df32" : "#796400";
    return {
      ...(dark ? webDarkTheme : webLightTheme),
      colorBrandBackground: "#f4df32",
      colorBrandBackgroundHover: "#ffeb58",
      colorBrandBackgroundPressed: "#d9c526",
      colorNeutralForegroundOnBrand: "#171913",
      colorBrandForeground1: brand,
      colorBrandForeground2: brand,
      colorBrandForegroundLink: brand,
      colorBrandForegroundLinkHover: dark ? "#fff184" : "#5f4e00",
      colorBrandStroke1: brand,
      colorBrandStroke2: dark ? "#71671f" : "#bcaa43",
      colorBrandBackground2: dark ? "#36321b" : "#f7edb8",
      colorNeutralBackground1: dark ? "#1a1d1c" : "#f9f9f2",
      colorNeutralBackground2: dark ? "#222625" : "#efefe6",
      colorNeutralBackground3: dark ? "#2a2e2c" : "#e6e7dc",
      colorNeutralBackground1Hover: dark ? "#30352f" : "#e9e9dc",
      colorNeutralForeground1: dark ? "#eceee4" : "#202520",
      colorNeutralForeground2: dark ? "#b8beb4" : "#565e52",
      colorNeutralForeground3: dark ? "#9aa293" : "#646c5e",
      colorNeutralForegroundStaticInverted: dark ? "#b8beb4" : "#565e52",
      colorNeutralStroke1: dark ? "#4a5148" : "#afb4a6",
      colorNeutralStroke2: dark ? "#363c34" : "#d0d3c6",
      borderRadiusSmall: "2px", borderRadiusMedium: "2px", borderRadiusLarge: "2px",
      borderRadiusXLarge: "2px", fontFamilyBase: '"Segoe UI", "Microsoft YaHei", sans-serif'
    };
  }, [mode]);
  return (
    <ThemeContext.Provider value={{ mode, toggle: () => setMode(value => value === "dark" ? "light" : "dark") }}>
      <FluentProvider theme={theme} className="industrialProvider">{children}</FluentProvider>
    </ThemeContext.Provider>
  );
}

export function ThemeSwitch({ compact = false }) {
  const { mode, toggle } = useContext(ThemeContext);
  return (
    <button type="button" className={`themeSwitch${compact ? " compact" : ""}`} onClick={toggle}
      aria-label={mode === "dark" ? "切换浅色主题" : "切换深色主题"} title={mode === "dark" ? "切换浅色主题" : "切换深色主题"}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        {mode === "dark" ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></> : <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>}
      </svg>
      {!compact && <span>{mode === "dark" ? "浅色模式" : "深色模式"}</span>}
    </button>
  );
}
