import React from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./ui/ThemeProvider";
import LivingRoomPage from "./LivingRoomPage.jsx";
import "./player-controls.css";
import "./living-room.css";
import "./industrial.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <LivingRoomPage />
    </ThemeProvider>
  </React.StrictMode>
);
