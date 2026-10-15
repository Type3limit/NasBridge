import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./ui/ThemeProvider";
import { BootSequence, TacticalBackdrop } from "./ui/TacticalChrome";
import "./styles.css";
import "./industrial.css";
import "./tactical.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <TacticalBackdrop />
      <App />
      <BootSequence />
    </ThemeProvider>
  </React.StrictMode>
);
