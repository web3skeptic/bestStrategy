import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";

// Native app build (`npm run build:ios` / `build:android`, consumed by Capacitor from dist-app/).
// The app bundles the game itself and talks to the live server at
// interslavic.space for online play (VITE_WS_URL is set by the script).
const NATIVE_APP = process.env.VITE_NATIVE_APP === "1";
const PUBLIC_SITE = "https://interslavic.space/game-upgradable/";

// Page tweaks for the app shell, applied to index.html at build time only:
//  • viewport-fit=cover so the existing env(safe-area-inset-*) padding works
//    under the notch / Dynamic Island (and Android's camera cutout, via
//    Capacitor's --safe-area-inset-* variables),
//  • no in-game agent chat panel (it calls same-origin HTTP APIs that don't
//    exist inside the app, and is a site-admin tool),
//  • the Replays link opens the website (Capacitor hands it to Safari); the
//    small top-left Replays chip is dropped, since on a phone it collides with
//    the title and the menu already has a full-width Replays button.
// Runs in the "pre" stage: Vite collects the page's module scripts into the
// bundle right after that, so a later stage would be too late to drop one.
function nativeAppHtml(): Plugin {
  return {
    name: "native-app-html",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html
          .replace('user-scalable=no">', 'user-scalable=no, viewport-fit=cover">')
          // Android: Capacitor reports insets as --safe-area-inset-* variables
          // (its WebView may not fill env() in edge-to-edge mode); iOS fills
          // env(). Prefer the variable, fall back to env().
          .replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,\s*0px)?\)/g,
            (_m, side) => `var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`)
          .replace(/\s*<script type="module" src="\.\/src\/chatPanel\.ts"><\/script>/, "")
          .replace(/<div class="menu-top">\s*<a class="menu-chip" href="replays">[\s\S]*?<\/a>\s*<\/div>/, "")
          .replace(/href="replays"/g, `href="${PUBLIC_SITE}replays"`);
      },
    },
  };
}

export default defineConfig({
  // Two deploy targets, so the base is env-driven (do NOT hardcode /game/):
  //  • Self-hosted interslavic.space/game/  → build with `npm run build:game`
  //    (VITE_BASE=/game/). nginx's `location /game/` strips the prefix before
  //    proxying to the :8768 Express server, so assets MUST be emitted as
  //    /game/assets/*; a plain base "/" build 404s every bundle there → dead UI.
  //  • Netlify / Railway / Docker (served at root) → plain `npm run build` (base "/").
  base: NATIVE_APP ? "./" : (process.env.VITE_BASE ?? "/game-upgradable/"),
  plugins: NATIVE_APP ? [nativeAppHtml()] : [],
  build: {
    outDir: NATIVE_APP ? "dist-app" : "dist",
    rollupOptions: {
      input: NATIVE_APP ? { main: resolve(__dirname, "index.html") } : {
        main: resolve(__dirname, "index.html"),
        replay: resolve(__dirname, "replay.html"),
        replays: resolve(__dirname, "replays.html"),
        demo: resolve(__dirname, "demo.html"),
        proposals: resolve(__dirname, "proposals.html"),
        techProposal: resolve(__dirname, "tech-proposal.html"),
        menuProposals: resolve(__dirname, "menu-proposals.html"),
        capitalProposals: resolve(__dirname, "capital-proposals.html"),
        hairProposals: resolve(__dirname, "hair-proposals.html"),
        hatProposals: resolve(__dirname, "hat-proposals.html"),
        faceProposals: resolve(__dirname, "face-proposals.html"),
        nomadProposals: resolve(__dirname, "nomad-proposals.html"),
        menuProposals2: resolve(__dirname, "menu-proposals-2.html"),
        fertileProposals: resolve(__dirname, "fertile-proposals.html"),
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
