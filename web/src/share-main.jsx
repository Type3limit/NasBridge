import React from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./ui/ThemeProvider";
import { IndustrialBackdrop } from "./ui/IndustrialChrome";
import SharePage from "./SharePage.jsx";
import "./styles.css";
import "./industrial.css";
import "./tactical-tokens.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <IndustrialBackdrop />
      <SharePage />
    </ThemeProvider>
  </React.StrictMode>
);
