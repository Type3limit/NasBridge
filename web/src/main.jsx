import React from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import App from "./App";
import GlobalStarMapBackground from "./components/GlobalStarMapBackground";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <GlobalStarMapBackground />
    <FluentProvider theme={webLightTheme} style={{ background: "transparent", minHeight: "100vh" }}>
      <App />
    </FluentProvider>
  </React.StrictMode>
);
