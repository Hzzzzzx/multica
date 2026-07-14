import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Keep in sync with src/shared/local-multica-endpoints.ts (TianYuan local Multica).
const LOCAL_MULTICA_API =
  process.env.MULTICA_API_URL ||
  process.env.VITE_API_URL ||
  "http://127.0.0.1:18480";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    server: {
      // Bind IPv4 loopback only — system HTTP proxies often mishandle [::1]
      // and return 502 for /auth/dev-login, leaving Desktop stuck on the spinner.
      host: "127.0.0.1",
      port: Number(process.env.DESKTOP_RENDERER_PORT) || 5173,
      strictPort: true,
      proxy: {
        "/api": LOCAL_MULTICA_API,
        "/auth": LOCAL_MULTICA_API,
        "/ws": { target: LOCAL_MULTICA_API.replace(/^http/, "ws"), ws: true },
      },
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
      dedupe: ["react", "react-dom", "@tanstack/react-query"],
    },
  },
});
