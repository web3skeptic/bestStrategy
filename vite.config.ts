import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  // Two deploy targets, so the base is env-driven (do NOT hardcode /game/):
  //  • Self-hosted interslavic.space/game/  → build with `npm run build:game`
  //    (VITE_BASE=/game/). nginx's `location /game/` strips the prefix before
  //    proxying to the :8768 Express server, so assets MUST be emitted as
  //    /game/assets/*; a plain base "/" build 404s every bundle there → dead UI.
  //  • Netlify / Railway / Docker (served at root) → plain `npm run build` (base "/").
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
