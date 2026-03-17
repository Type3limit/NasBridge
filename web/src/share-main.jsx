import React from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import SharePage from "./SharePage.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <FluentProvider theme={webLightTheme}>
      <SharePage />
    </FluentProvider>
  </React.StrictMode>
);
