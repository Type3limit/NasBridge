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
    const brand = dark ? "#ffc414" : "#8a5d00";
    return {
      ...(dark ? webDarkTheme : webLightTheme),
      colorBrandBackground: "#ffc414",
      colorBrandBackgroundHover: "#ffd54a",
      colorBrandBackgroundPressed: "#e0a800",
      colorNeutralForegroundOnBrand: "#121212",
      colorBrandForeground1: brand,
      colorBrandForeground2: brand,
      colorBrandForegroundLink: brand,
      colorBrandForegroundLinkHover: dark ? "#ffd54a" : "#6b4800",
      colorBrandStroke1: brand,
      colorBrandStroke2: dark ? "#6b5410" : "#c9a54a",
      colorBrandBackground2: dark ? "#2a2310" : "#fbefc6",
      colorNeutralBackground1: dark ? "#13171c" : "#f3f3ef",
      colorNeutralBackground2: dark ? "#181d23" : "#e9e9e3",
      colorNeutralBackground3: dark ? "#1e242b" : "#dfe0d9",
      colorNeutralBackground1Hover: dark ? "#222a32" : "#e2e2da",
      colorNeutralForeground1: dark ? "#e9edf0" : "#15181b",
      colorNeutralForeground2: dark ? "#aab3bd" : "#4a525a",
      colorNeutralForeground3: dark ? "#8a95a1" : "#5c656e",
      colorNeutralForegroundStaticInverted: dark ? "#aab3bd" : "#4a525a",
      colorNeutralStroke1: dark ? "#3a4450" : "#a9aea8",
      colorNeutralStroke2: dark ? "#2a323c" : "#cfd1ca",
      borderRadiusSmall: "0px", borderRadiusMedium: "0px", borderRadiusLarge: "0px",
      borderRadiusXLarge: "0px", fontFamilyBase: '"Bahnschrift", "DIN Alternate", "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
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
