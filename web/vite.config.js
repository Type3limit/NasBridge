import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxyTarget =
  process.env.VITE_DEV_PROXY_TARGET ||
  process.env.VITE_SERVER_BASE_URL ||
  "http://127.0.0.1:9000";

const wsProxyTarget =
  process.env.VITE_DEV_WS_PROXY_TARGET ||
  proxyTarget.replace(/^http/i, "ws");

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: proxyTarget,
        changeOrigin: true,
        secure: false,
        ws: false
      },
      "/ws": {
        target: wsProxyTarget,
        ws: true,
        changeOrigin: true,
        secure: false
      }
    }
  }
});
