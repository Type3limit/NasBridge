import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const proxyTarget =
  process.env.VITE_DEV_PROXY_TARGET ||
  process.env.VITE_SERVER_BASE_URL ||
  "http://127.0.0.1:9000";

const wsProxyTarget =
  process.env.VITE_DEV_WS_PROXY_TARGET ||
  proxyTarget.replace(/^http/i, "ws");

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        share: path.resolve(__dirname, "share.html")
      },
      output: {
        manualChunks(id) {
          if (id.includes("hls.js")) {
            return "hls-player";
          }
          if (id.includes("/src/components/PreviewModal")) {
            return "preview";
          }
          if (id.includes("node_modules")) {
            return "vendor";
          }
          return undefined;
        }
      }
    }
  },
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
