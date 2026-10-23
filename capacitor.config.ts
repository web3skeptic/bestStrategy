import type { CapacitorConfig } from '@capacitor/cli';

// iPhone and Android app shell for Tactical Tribes. The game itself is bundled
// in the app (dist-app/, built by `npm run build:ios` / `build:android`); online
// play connects to the live server at wss://interslavic.space/game-upgradable/ws.
const config: CapacitorConfig = {
  appId: 'space.interslavic.tacticaltribes',
  appName: 'Tactical Tribes',
  webDir: 'dist-app',
  // Matches the game's dark green menu so there's no white flash on launch.
  backgroundColor: '#0a1510',
  ios: {
    // The page handles the notch itself (viewport-fit=cover + safe-area CSS).
    contentInset: 'never',
    // A game board, not a document: no rubber-band scrolling or link previews.
    scrollEnabled: false,
    allowsLinkPreview: false,
    backgroundColor: '#0a1510',
  },
  android: {
    backgroundColor: '#0a1510',
    // Only https/wss — the game never needs plain-http content.
    allowMixedContent: false,
  },
  plugins: {
    // Edge-to-edge on Android: Capacitor reports the camera-cutout / bar insets
    // to the page as --safe-area-inset-* CSS variables (see vite.config.ts,
    // which makes the game's CSS read them).
    SystemBars: { insetsHandling: 'css' },
  },
};

export default config;
