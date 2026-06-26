import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  // Sub-path mount: set VITE_BASE=/game/ when serving behind nginx at /game/.
  base: process.env.VITE_BASE ?? "/",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        replay: resolve(__dirname, "replay.html"),
        replays: resolve(__dirname, "replays.html"),
        demo: resolve(__dirname, "demo.html"),
      },
    },
  },
  server: {
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/api": process.env.VITE_API_TARGET ?? "http://localhost:4567",
      "/ws": {
        target: (process.env.VITE_API_TARGET ?? "http://localhost:4567").replace(/^http/, "ws"),
        ws: true,
      },
    },
  },
});
