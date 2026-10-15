import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./ui/ThemeProvider";
import { IndustrialBackdrop } from "./ui/IndustrialChrome";
import "./styles.css";
import "./industrial.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <IndustrialBackdrop />
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
