import React from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider, webDarkTheme } from "@fluentui/react-components";
import LivingRoomPage from "./LivingRoomPage.jsx";
import "./player-controls.css";
import "./living-room.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <FluentProvider theme={webDarkTheme}>
      <LivingRoomPage />
    </FluentProvider>
  </React.StrictMode>
);
