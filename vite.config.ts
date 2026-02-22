import { defineConfig } from "vite";

export default defineConfig({
  server: {
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
